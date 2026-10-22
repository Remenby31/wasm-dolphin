import assert from "node:assert/strict";
import test from "node:test";

import {
  PipelinePrewarm, PREWARM_FORMAT, PREWARM_IDLE_SESSIONS, descriptorFromSpec, parsePrewarmFile, pipelineSpec,
  requestedWgpuPipelinePrewarm, specKey, wgslHash
} from "../src/wgpu-pipeline-prewarm.js";

// An OPFS directory in memory: the calls PipelinePrewarm makes.
export function fakeRoot() {
  const files = new Map();
  const dir = {
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name) && !create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      if (!files.has(name)) files.set(name, "");
      return {
        async getFile() { return { text: async () => files.get(name) }; },
        async createWritable() {
          let data = "";
          return { write: async (d) => { data += d; }, close: async () => { files.set(name, data); } };
        }
      };
    }
  };
  return { files, getDirectoryHandle: async () => dir };
}

// Timers the test fires by hand.
function manualTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimer: (fn) => { pending.set(next, fn); return next++; },
    clearTimer: (id) => { pending.delete(id); },
    async fire() { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) await fn(); await new Promise((r) => setImmediate(r)); }
  };
}

const VS = "@vertex fn main() -> @builtin(position) vec4f { return vec4f(); }";
const FS = "@fragment fn main() -> @location(0) vec4f { return vec4f(1); }";
const vsModule = { id: "vs" }, fsModule = { id: "fs" }, layout = { id: "layout" };
const desc = {
  label: "dolphin-pcfg-7", layout,
  vertex: { module: vsModule, buffers: [{ arrayStride: 12, stepMode: "vertex", attributes: [{ shaderLocation: 0, format: "float32x3", offset: 0 }] }] },
  fragment: { module: fsModule, targets: [{ format: "rgba8unorm", writeMask: 15 }] },
  primitive: { topology: "triangle-list", frontFace: "cw", cullMode: "back" },
  depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "greater-equal" },
  multisample: { count: 1 }
};
const ids = { vsId: 1, fsId: 2, vsModule, fsModule, samplingKey: "0/0" };
const noCull = { ...desc, primitive: { ...desc.primitive, cullMode: "none" } };

function recorder(root = null, timers = manualTimers()) {
  const p = new PipelinePrewarm({ root, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  p.noteShader(1, VS);
  p.noteShader(2, FS);
  return p;
}

// A session that records `descs` for GXXE01 under `core`, saved.
async function session(root, descs, core = "core-a") {
  const timers = manualTimers();
  const p = recorder(root, timers);
  await p.load("GXXE01", core);
  for (const d of descs) p.record(p.keyFor(d, ids));
  await p.flush();
  return p;
}

const asyncDevice = ({ fail = () => null } = {}) => {
  const device = {
    inFlight: 0, peak: 0,
    createShaderModule: ({ code }) => ({ code }),
    createRenderPipelineAsync: async (d) => {
      device.inFlight += 1; device.peak = Math.max(device.peak, device.inFlight);
      await new Promise((r) => setImmediate(r));
      device.inFlight -= 1;
      const error = fail(d);
      if (error) throw error;
      return { built: d };
    }
  };
  return device;
};

test("wgpuprewarm is on unless the page says 0", () => {
  assert.equal(requestedWgpuPipelinePrewarm(""), true);
  assert.equal(requestedWgpuPipelinePrewarm("?video=wgpu&wgpuprewarm=1"), true);
  assert.equal(requestedWgpuPipelinePrewarm("?wgpuprewarm=0"), false);
});

test("a spec carries the descriptor as data and rebuilds the same descriptor", () => {
  const spec = pipelineSpec(desc, { vs: wgslHash(VS), fs: wgslHash(FS), samplingKey: "0/0" });
  const back = descriptorFromSpec(JSON.parse(JSON.stringify(spec)), { vsModule, fsModule, layout, label: desc.label });
  assert.deepEqual(back, desc);
  assert.notEqual(wgslHash(VS), wgslHash(FS));
});

test("the key ignores labels and ids but not state; diagnostic modules have none", () => {
  const p = recorder();
  const a = p.keyFor(desc, ids);
  assert.equal(p.keyFor({ ...desc, label: "other" }, ids).key, a.key);
  p.noteShader(9, VS);
  assert.equal(p.keyFor(desc, { ...ids, vsId: 9 }).key, a.key, "same WGSL under another producer id");
  assert.notEqual(p.keyFor(noCull, ids).key, a.key);
  assert.notEqual(p.keyFor(desc, { ...ids, samplingKey: "1/1" }).key, a.key);
  assert.equal(p.keyFor({ ...desc, vertex: { ...desc.vertex, module: { id: "trivial" } } }, ids), null);
  assert.equal(p.keyFor(desc, { ...ids, fsId: 42 }), null);
});

test("saved once the burst is over (trailing debounce), per game, read back at the next boot", async () => {
  const root = fakeRoot();
  const timers = manualTimers();
  const p = recorder(root, timers);
  await p.load("GXXE01", "core-a");
  p.record(p.keyFor(desc, ids));
  p.record(p.keyFor(noCull, ids));
  p.record(p.keyFor(desc, ids));
  assert.equal(p.stats.recorded, 2);
  assert.equal(timers.pending.size, 1, "one pending save, pushed back by each new pipeline");
  assert.equal(root.files.size, 0);
  await timers.fire();
  const saved = JSON.parse(root.files.get("GXXE01.json"));
  assert.equal(saved.format, PREWARM_FORMAT);
  assert.equal(saved.core, "core-a");
  assert.equal(saved.pipelines.length, 2);
  assert.deepEqual(Object.values(saved.shaders).sort(), [FS, VS].sort());

  const next = new PipelinePrewarm({ root, setTimer: () => 1, clearTimer() {} });
  assert.equal((await next.load("GXXE01", "core-a")).pipelines.length, 2);
  assert.equal(next.session, 1);
  assert.equal(await new PipelinePrewarm({ root }).load("OTHER1", "core-a"), null, "another game has its own list");
});

test("a list of another core is dropped and overwritten", async () => {
  const root = fakeRoot();
  await session(root, [desc, noCull], "core-a");
  const timers = manualTimers();
  const p = recorder(root, timers);
  assert.equal(await p.load("GXXE01", "core-b"), null);
  assert.equal(p.known.size, 0);
  p.record(p.keyFor(desc, ids));
  await p.flush();
  const saved = JSON.parse(root.files.get("GXXE01.json"));
  assert.equal(saved.core, "core-b");
  assert.equal(saved.pipelines.length, 1);
});

test("a pipeline unused for PREWARM_IDLE_SESSIONS sessions leaves the list; one in use stays", async () => {
  const root = fakeRoot();
  await session(root, [desc, noCull]);
  for (let i = 0; i < PREWARM_IDLE_SESSIONS; i += 1) {
    const timers = manualTimers();
    const p = recorder(root, timers);
    await p.load("GXXE01", "core-a");
    const used = p.keyFor(desc, ids);
    p.take(used.key);
    p.record(used); // the replay built it: used this session
    await p.flush();
  }
  const last = JSON.parse(root.files.get("GXXE01.json"));
  const p = new PipelinePrewarm({ root, setTimer: () => 1, clearTimer() {} });
  const loaded = await p.load("GXXE01", "core-a");
  assert.equal(last.pipelines.length, 2, "still on disk after the last session");
  assert.equal(loaded.pipelines.length, 1, "but too old to compile");
  assert.equal(loaded.pipelines[0].spec.primitive.cullMode, "back");
});

test("a damaged or edited file is not compiled", async () => {
  assert.equal(parsePrewarmFile("{"), null);
  assert.equal(parsePrewarmFile(JSON.stringify({ format: 1, shaders: {}, pipelines: [] })), null);
  const vs = wgslHash(VS), fs = wgslHash(FS);
  const spec = { vs, fs, samplingKey: "0/0", buffers: [], primitive: {}, depthStencil: null, targets: [], multisample: null };
  const text = JSON.stringify({ format: PREWARM_FORMAT, core: "", session: 0,
    shaders: { [vs]: VS, [fs]: FS + " // edited" }, pipelines: [{ spec, seen: 0 }, { spec: { ...spec, samplingKey: "x" }, seen: 0 }] });
  const parsed = parsePrewarmFile(text);
  assert.equal(parsed.pipelines.length, 1, "malformed entries are dropped at parse");
  const root = fakeRoot();
  root.files.set("GXXE01.json", text);
  const p = new PipelinePrewarm({ root, setTimer: () => 1, clearTimer() {} });
  await p.load("GXXE01", "");
  const stats = await p.prewarm(asyncDevice(), () => layout);
  assert.equal(stats.compiled, 0, "a text that no longer matches its hash is not compiled");
  assert.equal(stats.dropped, 1);
});

test("prewarm compiles with createRenderPipelineAsync and hands each pipeline out once", async () => {
  const root = fakeRoot();
  await session(root, [desc, noCull]);
  const p = recorder(root);
  await p.load("GXXE01", "core-a");
  const device = asyncDevice();
  const stats = await p.prewarm(device, (key) => ({ layoutFor: key }), { concurrency: 4 });
  assert.equal(stats.compiled, 2);
  assert.ok(device.peak <= 4);
  const key = p.keyFor(desc, ids).key;
  const pipe = p.take(key);
  assert.equal(pipe.built.vertex.module.code, VS);
  assert.deepEqual(pipe.built.layout, { layoutFor: "0/0" });
  assert.equal(p.take(key), null, "handed out once");
});

test("only a validation rejection removes a pipeline; an internal error keeps it", async () => {
  const root = fakeRoot();
  await session(root, [desc, noCull]);
  const p = recorder(root);
  await p.load("GXXE01", "core-a");
  const fail = (d) => d.primitive.cullMode === "none"
    ? Object.assign(new Error("invalid"), { name: "GPUPipelineError", reason: "validation" })
    : Object.assign(new Error("out of memory"), { name: "GPUPipelineError", reason: "internal" });
  const stats = await p.prewarm(asyncDevice({ fail }), () => layout);
  assert.equal(stats.failed, 2);
  assert.equal(p.known.size, 1);
  assert.equal([...p.known.values()][0].spec.primitive.cullMode, "back");
});

test("a lost device or a core reload stops the run without touching the list", async () => {
  const root = fakeRoot();
  await session(root, [desc, noCull]);
  const p = recorder(root);
  await p.load("GXXE01", "core-a");
  let alive = true;
  let layoutCalls = 0;
  const device = asyncDevice({ fail: () => { alive = false; return new Error("device lost"); } });
  const stats = await p.prewarm(device, () => { layoutCalls += 1; return layout; }, { alive: () => alive, concurrency: 1 });
  assert.equal(layoutCalls, 1, "nothing is built for a dead device");
  assert.equal(stats.compiled, 0);
  assert.equal(p.known.size, 2);
  p.stop();
  assert.equal(p.ready.size, 0);
});

test("a pipeline the replay built before its prewarm finished is not kept twice", async () => {
  const root = fakeRoot();
  await session(root, [desc, noCull]);
  const p = recorder(root);
  await p.load("GXXE01", "core-a");
  const key = p.keyFor(desc, ids).key;
  const run = p.prewarm(asyncDevice(), () => layout, { concurrency: 2 });
  assert.equal(p.take(key), null, "the replay needs it now: miss");
  const stats = await run;
  assert.equal(stats.lateDiscarded, 1);
  assert.equal(p.ready.has(key), false);
  assert.equal(stats.compiled, 1);
});

test("a device without createRenderPipelineAsync compiles nothing", async () => {
  const p = recorder();
  p.record(p.keyFor(desc, ids));
  const stats = await p.prewarm({ createShaderModule() { throw new Error("not called"); } }, () => null);
  assert.equal(stats.compiled, 0);
});

test("the default timers work as method calls (a worker's setTimeout needs its global this)", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const strict = (fn) => function (...args) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return fn(...args);
  };
  globalThis.setTimeout = strict(realSetTimeout);
  globalThis.clearTimeout = strict(realClearTimeout);
  try {
    const p = new PipelinePrewarm({ root: fakeRoot() });
    p.noteShader(1, VS); p.noteShader(2, FS);
    await p.load("GXXE01", "core-a");
    assert.doesNotThrow(() => { p.record(p.keyFor(desc, ids)); p.record(p.keyFor(noCull, ids)); });
    assert.ok(p.flushTimer);
    await p.flush();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});
