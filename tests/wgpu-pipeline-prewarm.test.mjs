import assert from "node:assert/strict";
import test from "node:test";

import {
  PipelinePrewarm, PREWARM_FORMAT, descriptorFromSpec, parsePrewarmFile, pipelineSpec,
  requestedWgpuPipelinePrewarm, specKey, wgslHash
} from "../src/wgpu-pipeline-prewarm.js";

// An OPFS directory in memory: the calls PipelinePrewarm makes.
function fakeRoot() {
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

function recorder(root = null, timers = []) {
  const p = new PipelinePrewarm({ root, setTimer: (fn) => (timers.push(fn), timers.length) });
  p.noteShader(1, VS);
  p.noteShader(2, FS);
  return p;
}

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
  assert.notEqual(p.keyFor({ ...desc, primitive: { ...desc.primitive, cullMode: "none" } }, ids).key, a.key);
  assert.notEqual(p.keyFor(desc, { ...ids, samplingKey: "1/1" }).key, a.key);
  assert.equal(p.keyFor({ ...desc, vertex: { ...desc.vertex, module: { id: "trivial" } } }, ids), null);
  assert.equal(p.keyFor(desc, { ...ids, fsId: 42 }), null);
});

test("recorded pipelines are saved per game and read back at the next boot", async () => {
  const root = fakeRoot();
  const timers = [];
  const p = recorder(root, timers);
  await p.load("GXXE01");
  p.record(p.keyFor(desc, ids));
  p.record(p.keyFor(desc, ids));
  assert.equal(p.stats.recorded, 1);
  assert.equal(timers.length, 1, "one delayed flush");
  await timers[0]();
  await new Promise((r) => setImmediate(r));
  const saved = JSON.parse(root.files.get("GXXE01.json"));
  assert.equal(saved.format, PREWARM_FORMAT);
  assert.equal(saved.pipelines.length, 1);
  assert.deepEqual(Object.values(saved.shaders).sort(), [FS, VS].sort());

  const next = new PipelinePrewarm({ root });
  const loaded = await next.load("GXXE01");
  assert.equal(loaded.pipelines.length, 1);
  assert.equal(next.stats.loaded, 1);
  assert.equal(await new PipelinePrewarm({ root }).load("OTHER1"), null, "another game has its own list");
});

test("a damaged or edited file is not compiled", () => {
  assert.equal(parsePrewarmFile("{"), null);
  assert.equal(parsePrewarmFile(JSON.stringify({ format: 999, shaders: {}, pipelines: [] })), null);
  const vs = wgslHash(VS), fs = wgslHash(FS);
  const good = { vs, fs, samplingKey: "0/0", buffers: [], primitive: {}, depthStencil: null, targets: [], multisample: null };
  const parsed = parsePrewarmFile(JSON.stringify({
    format: PREWARM_FORMAT,
    shaders: { [vs]: VS, [fs]: FS + " // edited" },
    pipelines: [good, { ...good, samplingKey: "x" }]
  }));
  assert.equal(parsed.pipelines.length, 0, "a text that no longer matches its hash drops its pipelines");
});

test("prewarm compiles with createRenderPipelineAsync, hands each pipeline out once, drops failures", async () => {
  const root = fakeRoot();
  const p = recorder(root, []);
  await p.load("GXXE01");
  const a = p.keyFor(desc, ids);
  const b = p.keyFor({ ...desc, primitive: { ...desc.primitive, cullMode: "none" } }, ids);
  p.record(a); p.record(b);
  await p.flush();

  const next = new PipelinePrewarm({ root, setTimer: () => 1 });
  await next.load("GXXE01");
  let inFlight = 0, peak = 0;
  const device = {
    createShaderModule: ({ code }) => ({ code }),
    createRenderPipelineAsync: async (d) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      if (d.primitive.cullMode === "none") throw new Error("does not build here");
      return { built: d };
    }
  };
  const stats = await next.prewarm(device, (key) => ({ layoutFor: key }), { concurrency: 4 });
  assert.equal(stats.compiled, 1);
  assert.equal(stats.failed, 1);
  assert.ok(peak <= 4);
  next.noteShader(1, VS); next.noteShader(2, FS);
  const key = next.keyFor(desc, ids).key;
  const pipe = next.take(key);
  assert.equal(pipe.built.vertex.module.code, VS);
  assert.deepEqual(pipe.built.layout, { layoutFor: "0/0" });
  assert.equal(next.take(key), null, "handed out once");
  assert.equal(next.known.size, 1, "the failed pipeline leaves the list");
  assert.ok(next.dirty);
});

test("a device without createRenderPipelineAsync compiles nothing", async () => {
  const p = recorder();
  p.record(p.keyFor(desc, ids));
  const stats = await p.prewarm({ createShaderModule() { throw new Error("not called"); } }, () => null);
  assert.equal(stats.compiled, 0);
});

test("the default timer works as a method call (a worker's setTimeout needs its global this)", async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function (fn, ms) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return realSetTimeout(fn, ms);
  };
  try {
    const p = new PipelinePrewarm({ root: fakeRoot() });
    p.noteShader(1, VS); p.noteShader(2, FS);
    await p.load("GXXE01");
    assert.doesNotThrow(() => p.record(p.keyFor(desc, ids)));
    assert.ok(p.flushTimer);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("?wgpuprewarm=0 reaches the worker (page -> adapter -> load handler -> loadCore)", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  assert.match(read("src/core-host.js"), /this\.wgpuPipelinePrewarm = requestedWgpuPipelinePrewarm\(window\.location\.search\);/);
  assert.match(read("src/core-host.js"), /wgpuPipelinePrewarm: this\.wgpuPipelinePrewarm,/);
  assert.match(read("src/upstream-worker-adapter.js"), /wgpuPipelinePrewarm: this\.wgpuPipelinePrewarm,/);
  const worker = read("src/upstream-discio-worker.js");
  assert.match(worker, /wgpuPipelinePrewarm: payload\.wgpuPipelinePrewarm,/);
  assert.match(worker, /wgpuPipelinePrewarm: requestedWgpuPipelinePrewarm = true,/);
});
