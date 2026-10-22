import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  DELIVER_BEFORE_WARM,
  WARM_STATE_PTR,
  compileAndWarm,
  compileFailureReason,
  createAotCompilerClient,
  createWarmer,
  parseWasmImports,
  tierUpCalls
} from "../src/aot-compiler-worker.js";
import { assembleRegion, paddedUleb, regionModuleWarm } from "../src/aot-region-module.js";

// Minimal module builder, enough for the shapes the JIT emits: env.* function
// imports, a shared env.memory, functions taking the state pointer.
function uleb(out, v) {
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
}
function name(out, s) {
  uleb(out, s.length);
  for (const c of s) out.push(c.charCodeAt(0));
}
function section(out, id, content) {
  out.push(id);
  uleb(out, content.length);
  out.push(...content);
}
// bodies: arrays of opcodes (no locals); every function is (i32) -> i32.
function buildModule({ memory = null, funcImports = 0, bodies, exportAll = true, table = null }) {
  const out = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  section(out, 1, [1, 0x60, 1, 0x7f, 1, 0x7f]);
  const imports = [];
  for (let i = 0; i < funcImports; i++) {
    const e = [];
    name(e, "env");
    name(e, `h${i}`);
    e.push(0, 0);
    imports.push(e);
  }
  if (memory) {
    const e = [];
    name(e, "env");
    name(e, "memory");
    e.push(2, memory.shared ? 3 : 1);
    uleb(e, memory.initial);
    uleb(e, memory.maximum);
    imports.push(e);
  }
  if (table) {
    const e = [];
    name(e, "env");
    name(e, "table");
    e.push(1, 0x70, 0);
    uleb(e, table.initial);
    imports.push(e);
  }
  const imp = [];
  uleb(imp, imports.length);
  for (const e of imports) imp.push(...e);
  section(out, 2, imp);
  const fn = [];
  uleb(fn, bodies.length);
  for (let i = 0; i < bodies.length; i++) fn.push(0);
  section(out, 3, fn);
  const exp = [];
  const exported = exportAll ? bodies.map((_, i) => i) : [];
  uleb(exp, exported.length);
  for (const i of exported) {
    name(exp, i === 0 ? "f" : `f${i}`);
    exp.push(0);
    uleb(exp, funcImports + i);
  }
  section(out, 7, exp);
  if (table) {
    // active segment at offset 0 of the imported table: every function
    const elem = [1, 0, 0x41, 0, 0x0b];
    uleb(elem, bodies.length);
    for (let i = 0; i < bodies.length; i++) uleb(elem, funcImports + i);
    section(out, 9, elem);
  }
  const code = [];
  uleb(code, bodies.length);
  for (const body of bodies) {
    const b = [0, ...body, 0x0b];
    uleb(code, b.length);
    code.push(...b);
  }
  section(out, 10, code);
  return new Uint8Array(out);
}

const i32const = (v) => {
  const o = [0x41];
  // signed LEB128
  v |= 0;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && b & 0x40)) {
      o.push(b);
      return o;
    }
    o.push(b | 0x80);
  }
};
// store state[0..] = 0xAB.. through the state pointer, store at absolute
// addresses, call import 0, return pc
const WRITER_BODY = [
  0x20, 0, ...i32const(0x0abababab), 0x36, 2, 0, // i32.store state[0]
  ...i32const(0x200), ...i32const(0x1234567), 0x36, 2, 0, // i32.store [0x200]
  ...i32const(0x30000), ...i32const(-1), 0x36, 2, 0, // i32.store [0x30000]
  0x20, 0, 0x10, 0, 0x1a, // call h0(state), drop
  ...i32const(0x80003000)
];
const MEMORY = { shared: true, initial: 8, maximum: 16 };
const INFINITE_LOOP_BODY = [0x03, 0x40, 0x0c, 0, 0x0b, ...i32const(0)];

const digest = (memory) => createHash("sha256").update(new Uint8Array(memory.buffer)).digest("hex");

function nodeWorkerFactory() {
  return () => {
    const w = new Worker(new URL("./helpers/aot-compiler-node-worker.mjs", import.meta.url));
    return {
      addEventListener(type, listener) {
        if (type === "message") w.on("message", (data) => listener({ data }));
        if (type === "error") w.on("error", listener);
      },
      postMessage: (m) => w.postMessage(m),
      terminate: () => w.terminate()
    };
  };
}

test("parseWasmImports reads memory and table limits the JS reflection API hides", () => {
  const bytes = buildModule({ memory: MEMORY, funcImports: 2, bodies: [[...i32const(1)]], table: { initial: 3 } });
  assert.deepEqual(parseWasmImports(bytes), [
    { module: "env", name: "h0", kind: "function" },
    { module: "env", name: "h1", kind: "function" },
    { module: "env", name: "memory", kind: "memory", initial: 8, maximum: 16, shared: true },
    { module: "env", name: "table", kind: "table", element: 0x70, initial: 3, maximum: undefined, shared: false }
  ]);
  assert.throws(() => parseWasmImports(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), TypeError);
});

test("scratch warm-up runs every entry point and never writes the real memory", async () => {
  const bytes = buildModule({ memory: MEMORY, funcImports: 1, bodies: [WRITER_BODY, WRITER_BODY] });
  // The emulator's memory: same shape, filled with a known pattern.
  const real = new WebAssembly.Memory(MEMORY);
  new Uint8Array(real.buffer).fill(0x5a);
  const before = digest(real);

  const warmer = createWarmer();
  const { module, warmed, calls } = await compileAndWarm(bytes, { warm: true }, warmer);
  assert.equal(warmed, true);
  assert.equal(calls, 2, "both exported functions were called");

  // The writes happened, in scratch memory only.
  const [scratch] = warmer.scratchMemories();
  assert.notEqual(scratch, real);
  const view = new DataView(scratch.buffer);
  assert.equal(view.getUint32(WARM_STATE_PTR, true), 0xabababab);
  assert.equal(view.getUint32(0x200, true), 0x1234567);
  assert.equal(digest(real), before, "real memory is byte-identical after warm-up");

  // The warmed Module still runs correctly on the real memory.
  const calledWith = [];
  const instance = new WebAssembly.Instance(module, {
    env: { memory: real, h0: (s) => calledWith.push(s) }
  });
  assert.equal(instance.exports.f(0x100) >>> 0, 0x80003000);
  assert.deepEqual(calledWith, [0x100]);
  assert.equal(new DataView(real.buffer).getUint32(0x100, true), 0xabababab);
});

test("warm-up reaches functions only listed in an imported table", async () => {
  const bytes = buildModule({
    memory: MEMORY,
    funcImports: 1,
    bodies: [WRITER_BODY, WRITER_BODY, WRITER_BODY],
    exportAll: false,
    table: { initial: 3 }
  });
  const warmer = createWarmer();
  const result = await compileAndWarm(bytes, { warm: true }, warmer);
  assert.equal(result.calls, 3);
});

test("the compiler worker receives bytes only and hands back a Module the caller instantiates", async (t) => {
  const posted = [];
  const factory = nodeWorkerFactory();
  const client = createAotCompilerClient({
    createWorker: () => {
      const w = factory();
      const post = w.postMessage;
      w.postMessage = (m) => {
        posted.push(m);
        post(m);
      };
      return w;
    }
  });
  t.after(() => client.terminate());
  const real = new WebAssembly.Memory(MEMORY);
  const before = digest(real);
  const bytes = buildModule({ memory: MEMORY, funcImports: 1, bodies: [WRITER_BODY] });
  const result = await client.compile(bytes);
  assert.equal(result.offThread, true);
  assert.equal(result.warmed, true);
  assert.ok(result.module instanceof WebAssembly.Module);
  // Nothing but plain data crossed to the worker: no Memory, no Table, no function.
  const seen = [];
  const walk = (value) => {
    if (value === null || typeof value !== "object") {
      assert.notEqual(typeof value, "function");
      return;
    }
    assert.ok(!(value instanceof WebAssembly.Memory) && !(value instanceof WebAssembly.Table) && !(value instanceof WebAssembly.Instance));
    if (ArrayBuffer.isView(value) || value instanceof SharedArrayBuffer) return seen.push(value);
    for (const v of Object.values(value)) walk(v);
  };
  posted.forEach(walk);
  // the job's bytes and the watchdog's 4-byte status word, nothing else
  assert.ok(seen.every((v) => v instanceof Uint8Array || (v instanceof SharedArrayBuffer && v.byteLength === 4)));
  assert.equal(digest(real), before);
  const instance = new WebAssembly.Instance(result.module, { env: { memory: real, h0: () => 0 } });
  assert.equal(instance.exports.f(0x40) >>> 0, 0x80003000);
  const stats = client.stats();
  assert.equal(stats.done, 1);
  assert.equal(stats.warmed, 1);
  assert.equal(stats.inPlace, 0);
});

test("a warm-up that never returns costs one respawn, not the job", async (t) => {
  const events = [];
  const client = createAotCompilerClient({
    createWorker: nodeWorkerFactory(),
    warmTimeoutMs: 300,
    onEvent: (e) => events.push(e.type)
  });
  t.after(() => client.terminate());
  const hang = buildModule({ memory: MEMORY, bodies: [INFINITE_LOOP_BODY] });
  const fine = buildModule({ memory: MEMORY, funcImports: 1, bodies: [WRITER_BODY] });
  const [a, b] = await Promise.all([client.compile(hang), client.compile(fine)]);
  assert.equal(a.warmed, false);
  assert.ok(a.module instanceof WebAssembly.Module);
  assert.equal(b.warmed, true);
  const stats = client.stats();
  assert.equal(stats.timeouts, 1);
  assert.equal(stats.respawns, 1);
  assert.deepEqual(events, ["warm-timeout"]);
});

test("engine rejects come back as CompileError, and no worker means compile in place", async (t) => {
  const client = createAotCompilerClient({ createWorker: nodeWorkerFactory() });
  t.after(() => client.terminate());
  await assert.rejects(client.compile(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0x0a, 1])), WebAssembly.CompileError);

  const fallback = createAotCompilerClient({
    createWorker: () => {
      throw new Error("no Worker here");
    }
  });
  const bytes = buildModule({ memory: MEMORY, funcImports: 1, bodies: [WRITER_BODY] });
  const result = await fallback.compile(bytes);
  assert.equal(result.offThread, false);
  assert.ok(result.module instanceof WebAssembly.Module);
  assert.equal(fallback.stats().inPlace, 1);
});

test("a state handed over by the core is copied into scratch memory before each call", async () => {
  // reads state[4] and stores it to [0x400]: the copy happened before the call
  const body = [...i32const(0x400), 0x20, 0, 0x28, 2, 4, 0x36, 2, 0, ...i32const(0)];
  const bytes = buildModule({ memory: MEMORY, bodies: [body] });
  const warmer = createWarmer();
  const state = new Uint8Array(16);
  new DataView(state.buffer).setInt32(4, -2147483648, true);
  warmer.setWarmState({ statePtr: 0x2000, state });
  await compileAndWarm(bytes, { warm: true }, warmer);
  const [scratch] = warmer.scratchMemories();
  assert.equal(new DataView(scratch.buffer).getInt32(0x400, true), -2147483648);
});

test("boot loads are delivered before their warm-up, which still runs", async (t) => {
  const client = createAotCompilerClient({ createWorker: nodeWorkerFactory() });
  t.after(() => client.terminate());
  const bytes = buildModule({ memory: MEMORY, funcImports: 1, bodies: [WRITER_BODY] });
  const first = await client.compile(bytes, { deliver: DELIVER_BEFORE_WARM });
  assert.equal(first.warmed, false);
  assert.equal(first.warmQueued, true);
  await client.drain();
  assert.equal(client.stats().warmed, 1);
});

test("failure reasons follow the JIT contract: compile/link blacklist, anything else is transient", () => {
  assert.equal(compileFailureReason(new WebAssembly.CompileError("x")), "compile");
  assert.equal(compileFailureReason(new WebAssembly.LinkError("x")), "link");
  assert.equal(compileFailureReason(new RangeError("Out of memory")), "oom");
});

test("a background warm-up that hangs is caught too, and later jobs still complete", async (t) => {
  const client = createAotCompilerClient({ createWorker: nodeWorkerFactory(), warmTimeoutMs: 300 });
  t.after(() => client.terminate());
  const hang = buildModule({ memory: MEMORY, bodies: [INFINITE_LOOP_BODY] });
  const fine = buildModule({ memory: MEMORY, funcImports: 1, bodies: [WRITER_BODY] });
  const delivered = await client.compile(hang, { deliver: DELIVER_BEFORE_WARM });
  assert.ok(delivered.module instanceof WebAssembly.Module);
  // drain() waits for the background warm-up; the watchdog ends it
  await client.drain();
  assert.equal(client.stats().timeouts, 1);
  const later = await client.compile(fine);
  assert.equal(later.warmed, true);
  assert.equal(client.stats().respawns, 1);
});

// A Worker under the test's control: what it was sent, and replies on demand.
function fakeWorkerFactory({ failToLoad = false } = {}) {
  const made = [];
  const factory = () => {
    const listeners = {};
    const w = {
      sent: [],
      terminated: false,
      addEventListener(type, fn) {
        (listeners[type] ??= []).push(fn);
      },
      emit(type, data) {
        for (const fn of listeners[type] ?? []) fn({ data });
      },
      postMessage(m) {
        w.sent.push(m);
      },
      terminate() {
        w.terminated = true;
      }
    };
    made.push(w);
    if (failToLoad) queueMicrotask(() => w.emit("error"));
    return w;
  };
  return { factory, made };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const manualClock = () => {
  const timers = [];
  return {
    timers,
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => {},
    fire: () => timers.splice(0).forEach((fn) => fn())
  };
};

test("a reply that never comes is compiled in place after the job's deadline", async (t) => {
  const { factory, made } = fakeWorkerFactory();
  const clock = manualClock();
  const client = createAotCompilerClient({ createWorker: factory, jobTimeoutMs: 0, ...clock });
  t.after(() => client.terminate());
  const bytes = buildModule({ memory: MEMORY, funcImports: 1, bodies: [WRITER_BODY] });
  const pending = client.compile(bytes);
  await settle();
  assert.equal(made[0].sent.find((m) => m.type === "aot-compile").jobs.length, 1);
  made[0].emit("messageerror"); // the reply could not be read
  clock.fire(); // the watchdog's next poll
  const result = await pending;
  assert.equal(result.offThread, false);
  assert.ok(result.module instanceof WebAssembly.Module);
  assert.equal(client.stats().lost, 1);
  assert.equal(client.stats().messageErrors, 1);
});

test("replies settle by id whatever their order, and a replaced worker's messages are ignored", async (t) => {
  const { factory, made } = fakeWorkerFactory();
  const clock = manualClock();
  const client = createAotCompilerClient({ createWorker: factory, warmTimeoutMs: 0, ...clock });
  t.after(() => client.terminate());
  const a = buildModule({ memory: MEMORY, bodies: [[...i32const(1)]] });
  const b = buildModule({ memory: MEMORY, bodies: [[...i32const(2)]] });
  const pa = client.compile(a);
  const pb = client.compile(b);
  await settle();
  const [ja, jb] = made[0].sent.find((m) => m.type === "aot-compile").jobs;
  const mb = new WebAssembly.Module(b);
  made[0].emit("message", { type: "aot-compiled", results: [{ id: jb.id, module: mb, warmed: true }], totals: { warmed: 1, warmCalls: 1, warmMs: 1, maxWarmMs: 1 } });
  assert.equal((await pb).module, mb);
  // the worker gets stuck warming job a: replaced, a goes to the new worker
  const statusBuffer = made[0].sent.find((m) => m.type === "aot-init").status;
  Atomics.store(new Int32Array(statusBuffer), 0, ja.id);
  clock.fire();
  clock.fire();
  assert.equal(made[0].terminated, true);
  assert.equal(made.length, 2);
  // the dead worker's late reply and totals change nothing
  made[0].emit("message", { type: "aot-compiled", results: [{ id: ja.id, module: mb }], totals: { warmed: 99, warmCalls: 99, warmMs: 99, maxWarmMs: 99 } });
  assert.equal(client.stats().warmed, 1);
  await settle();
  const resent = made[1].sent.find((m) => m.type === "aot-compile").jobs;
  assert.deepEqual(resent.map((j) => [j.id, j.warm]), [[ja.id, false]]);
  const ma = new WebAssembly.Module(a);
  made[1].emit("message", { type: "aot-compiled", results: [{ id: ja.id, module: ma }], totals: {} });
  assert.equal((await pa).module, ma);
});

test("a worker that fails to load: compile in place, try again later, give up after a few failures", async (t) => {
  const { factory, made } = fakeWorkerFactory({ failToLoad: true });
  let time = 0;
  const realNow = performance.now;
  performance.now = () => time;
  t.after(() => {
    performance.now = realNow;
  });
  const client = createAotCompilerClient({ createWorker: factory, retryAfterMs: 1000, maxWorkerFailures: 2, ...manualClock() });
  t.after(() => client.terminate());
  const bytes = buildModule({ memory: MEMORY, bodies: [[...i32const(1)]] });
  const first = client.compile(bytes);
  await settle();
  assert.equal((await first).offThread, false);
  assert.equal(made.length, 1);
  // within the back-off: no new worker
  assert.equal((await client.compile(bytes)).offThread, false);
  assert.equal(made.length, 1);
  // after it: one more try, which fails too, and that is final
  time = 2000;
  const third = client.compile(bytes);
  await settle();
  assert.equal((await third).offThread, false);
  assert.equal(made.length, 2);
  time = 10_000;
  assert.equal((await client.compile(bytes)).offThread, false);
  assert.equal(made.length, 2);
  assert.equal(client.stats().offThread, false);
  assert.equal(client.stats().workerFailures, 2);
});

test("after a few stuck warm-ups, warm-ups stop for the session", async (t) => {
  const client = createAotCompilerClient({ createWorker: nodeWorkerFactory(), warmTimeoutMs: 200, maxWarmTimeouts: 1 });
  t.after(() => client.terminate());
  const hang = buildModule({ memory: MEMORY, bodies: [INFINITE_LOOP_BODY] });
  await client.compile(hang);
  assert.equal(client.stats().timeouts, 1);
  const again = await client.compile(hang); // would hang again: not warmed at all
  assert.equal(again.warmed, false);
  assert.equal(client.stats().timeouts, 1);
  assert.equal(client.stats().warmDisabled, true);
});

test("the warm state reaches the worker's scratch memory end to end", async (t) => {
  // traps unless state[4] holds the magic: warmed without a trap only if the
  // state the client was given was copied before the call
  const MAGIC = 0x5a17;
  const body = [0x20, 0, 0x28, 2, 4, ...i32const(MAGIC), 0x47, 0x04, 0x40, 0x00, 0x0b, ...i32const(0)];
  const bytes = buildModule({ memory: MEMORY, bodies: [body] });
  const client = createAotCompilerClient({ createWorker: nodeWorkerFactory() });
  t.after(() => client.terminate());
  await client.compile(bytes);
  await client.drain();
  assert.equal(client.stats().warmTraps, 1, "zeroed state: the check traps");
  const state = new Uint8Array(8);
  new DataView(state.buffer).setInt32(4, MAGIC, true);
  client.setWarmState({ statePtr: 0x3000, state });
  await client.compile(buildModule({ memory: MEMORY, bodies: [body, [...i32const(3)]] }));
  await client.drain();
  assert.equal(client.stats().warmTraps, 1, "with the core's state: no new trap");
});

test("bytes viewed on a SharedArrayBuffer are copied before they leave", async (t) => {
  const { factory, made } = fakeWorkerFactory();
  const client = createAotCompilerClient({ createWorker: factory, ...manualClock() });
  t.after(() => client.terminate());
  const bytes = buildModule({ memory: MEMORY, bodies: [[...i32const(1)]] });
  const heap = new Uint8Array(new SharedArrayBuffer(4096));
  heap.set(bytes, 100);
  void client.compile(heap.subarray(100, 100 + bytes.length)).catch(() => {});
  await settle();
  const job = made[0].sent.find((m) => m.type === "aot-compile").jobs[0];
  assert.ok(!(job.bytes.buffer instanceof SharedArrayBuffer));
  assert.equal(job.bytes.buffer.byteLength, bytes.length);
  assert.deepEqual(job.bytes, bytes);
});

// 48 real blocks the core's JIT emitted for the cpufuzz homebrew (MIT, ours),
// read back from the IndexedDB JIT cache of a headless session.
test("real JIT blocks: compiled and warmed off-thread, real memory untouched, no stuck warm-up", async (t) => {
  const { decodePrebuiltCache } = await import("../src/prebuilt-jit-cache-format.js");
  const { verifyCanonicalWasmBlockKey } = await import("../src/jit-cache-identity.js");
  const { readFileSync } = await import("node:fs");
  const { entries } = decodePrebuiltCache(readFileSync(new URL("./fixtures/jit-blocks-cpufuzz.bin", import.meta.url)));
  assert.equal(entries.length, 48);
  for (const { hash, bytes } of entries) assert.equal(await verifyCanonicalWasmBlockKey(hash, bytes), true);
  const memoryDesc = parseWasmImports(entries[0].bytes).find((i) => i.kind === "memory");
  assert.deepEqual(memoryDesc, { module: "env", name: "memory", kind: "memory", initial: 24576, maximum: 24576, shared: true });
  // the emulator's memory: same shape, a known pattern in the first pages
  const real = new WebAssembly.Memory({ initial: 24576, maximum: 24576, shared: true });
  const probe = new Uint8Array(real.buffer, 0, 1 << 20);
  probe.fill(0x5a);
  const before = createHash("sha256").update(probe).digest("hex");

  const client = createAotCompilerClient({ createWorker: nodeWorkerFactory(), warmTimeoutMs: 2000 });
  t.after(() => client.terminate());
  const results = await Promise.all(entries.map(({ bytes }) => client.compile(bytes)));
  await client.drain();
  assert.ok(results.every((r) => r.module instanceof WebAssembly.Module && r.offThread));
  const stats = client.stats();
  assert.equal(stats.timeouts, 0);
  assert.equal(stats.warmed, 48);
  assert.ok(stats.warmCalls >= 48);
  assert.equal(createHash("sha256").update(new Uint8Array(real.buffer, 0, 1 << 20)).digest("hex"), before);
});

test("a worker that keeps losing replies is replaced, so the boot never waits a deadline per job", async (t) => {
  const { factory, made } = fakeWorkerFactory();
  const clock = manualClock();
  let time = 0;
  const realNow = performance.now;
  performance.now = () => time;
  t.after(() => {
    performance.now = realNow;
  });
  const client = createAotCompilerClient({ createWorker: factory, jobTimeoutMs: 100, maxConsecutiveLost: 3, retryAfterMs: 1000, ...clock });
  t.after(() => client.terminate());
  const bytes = buildModule({ memory: MEMORY, bodies: [[...i32const(1)]] });
  const jobs = [client.compile(bytes), client.compile(bytes), client.compile(bytes)];
  await settle();
  time = 200; // the worker never answers
  clock.fire();
  const results = await Promise.all(jobs);
  assert.ok(results.every((r) => r.offThread === false));
  assert.equal(client.stats().lost, 3);
  assert.equal(client.stats().workerFailures, 1);
  assert.equal(made[0].terminated, true);
  // within the back-off, new jobs compile in place at once
  assert.equal((await client.compile(bytes)).offThread, false);
  assert.equal(made.length, 1);
});

test("an idle compiler worker is stopped, and the next job starts a new one (not a respawn)", async (t) => {
  const { factory, made } = fakeWorkerFactory();
  const clock = manualClock();
  const client = createAotCompilerClient({ createWorker: factory, idleStopMs: 1000, ...clock });
  t.after(() => client.terminate());
  const bytes = buildModule({ memory: MEMORY, bodies: [[...i32const(1)]] });
  const first = client.compile(bytes, { warm: false });
  await settle();
  const job = made[0].sent.find((m) => m.type === "aot-compile").jobs[0];
  made[0].emit("message", { type: "aot-compiled", results: [{ id: job.id, module: new WebAssembly.Module(bytes) }], totals: {} });
  await first;
  // busy again before the delay: the stop is cancelled
  made[0].emit("message", { type: "aot-idle", totals: {} });
  const second = client.compile(bytes, { warm: false });
  await settle();
  clock.timers.splice(0); // the idle timer was cancelled by the new job; drop it unfired
  const job2 = made[0].sent.filter((m) => m.type === "aot-compile").at(-1).jobs[0];
  made[0].emit("message", { type: "aot-compiled", results: [{ id: job2.id, module: new WebAssembly.Module(bytes) }], totals: {} });
  await second;
  assert.equal(made[0].terminated, false);
  // idle for good: stopped
  made[0].emit("message", { type: "aot-idle", totals: {} });
  clock.fire();
  assert.equal(made[0].terminated, true);
  assert.equal(client.stats().idleStops, 1);
  // the next job starts a new worker, counted as a start, not a respawn
  client.compile(bytes, { warm: false }).catch(() => {}); // left pending; terminate() rejects it
  await settle();
  assert.equal(made.length, 2);
  assert.equal(client.stats().respawns, 0);
  assert.equal(client.stats().offThread, true);
});

test("the worker announces idleness once nothing compiles or waits for a warm-up", async (t) => {
  const seen = [];
  const factory = nodeWorkerFactory();
  const client = createAotCompilerClient({
    createWorker: () => {
      const w = factory();
      const add = w.addEventListener;
      w.addEventListener = (type, fn) => add(type, (e) => { if (type === "message") seen.push(e.data?.type); fn(e); });
      return w;
    },
    idleStopMs: 200
  });
  t.after(() => client.terminate());
  await client.compile(buildModule({ memory: MEMORY, funcImports: 1, bodies: [WRITER_BODY] }));
  await client.drain();
  assert.ok(seen.includes("aot-idle"));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(client.stats().idleStops, 1);
});

test("cached blocks take warm slots from one budget, with or without a block store", async (t) => {
  const originalSelf = globalThis.self;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  // a fresh worker module: no block store opened (as without CacheStorage)
  const { takeDolphinJitWarmSlot } = await import(`../src/upstream-discio-worker.js?warm-slot-test=${Date.now()}`);
  for (let i = 0; i < 20000; i += 1) assert.equal(takeDolphinJitWarmSlot(), true, `slot ${i}`);
});


test("a module declaring a small memory minimum warms on a small scratch memory, and still runs on the emulator's", async () => {
  // shared memory import min 1 page, max 24576 (the core's maximum)
  const SMALL = { shared: true, initial: 1, maximum: 24576 };
  const bytes = buildModule({ memory: SMALL, funcImports: 1, bodies: [WRITER_BODY] });
  const warmer = createWarmer();
  const result = await compileAndWarm(bytes, { warm: true }, warmer);
  assert.equal(result.warmed, true);
  const [scratch] = warmer.scratchMemories();
  // grown only to hold the warm state, far from the 1.5 GiB of the core's shape
  assert.ok(scratch.buffer.byteLength <= 4 * 65536, `${scratch.buffer.byteLength} bytes`);
  assert.equal(new DataView(scratch.buffer).getUint32(WARM_STATE_PTR, true), 0xabababab, "the warm call ran");
  // the emulator's memory (min = max = 24576) satisfies the import
  const real = new WebAssembly.Memory({ shared: true, initial: 24576, maximum: 24576 });
  const instance = new WebAssembly.Instance(result.module, { env: { memory: real, h0: () => 0 } });
  assert.equal(instance.exports.f(0x100) >>> 0, 0x80003000);
});

test("after-warm jobs (the core's requests) arm the idle stop without drain(), with real timers", async (t) => {
  const client = createAotCompilerClient({ createWorker: nodeWorkerFactory(), idleStopMs: 150 });
  t.after(() => client.terminate());
  const result = await client.compile(buildModule({ memory: MEMORY, funcImports: 1, bodies: [WRITER_BODY] }));
  assert.equal(result.warmed, true);
  await new Promise((r) => setTimeout(r, 600));
  const stats = client.stats();
  assert.equal(stats.idleStops, 1);
  assert.equal(stats.warmDisabled, false, "an idle stop does not disable warm-ups");
  // and the next job runs on a new worker, warmed
  assert.equal((await client.compile(buildModule({ memory: MEMORY, funcImports: 1, bodies: [WRITER_BODY] }))).warmed, true);
  assert.equal(client.stats().respawns, 0);
});

test("scratch growth: a memory that cannot grow, or a state too far away, still warms (calls trap, code exists)", async () => {
  // max 1 page: the state at 0x10000 does not fit and the memory cannot grow
  const tiny = buildModule({ memory: { shared: true, initial: 1, maximum: 1 }, bodies: [WRITER_BODY] });
  const warmer = createWarmer();
  const r = await compileAndWarm(tiny, { warm: true }, warmer);
  assert.equal(r.warmed, true);
  assert.equal(warmer.stats.traps, 1);
  assert.equal(warmer.scratchMemories()[0].buffer.byteLength, 65536);
  // a warm state 64 MiB away is past the growth cap: not grown
  const far = createWarmer();
  far.setWarmState({ statePtr: 64 << 20, state: new Uint8Array(16) });
  const small = buildModule({ memory: { shared: true, initial: 1, maximum: 24576 }, bodies: [WRITER_BODY] });
  assert.equal((await compileAndWarm(small, { warm: true }, far)).warmed, true);
  assert.equal(far.scratchMemories()[0].buffer.byteLength, 65536);
});

test("a worker that cannot be created after an idle stop counts as a failure, and the next start is not mistaken for a restart", async (t) => {
  let fail = false;
  let time = 0;
  const realNow = performance.now;
  performance.now = () => time;
  t.after(() => {
    performance.now = realNow;
  });
  const { factory, made } = fakeWorkerFactory();
  const clock = manualClock();
  const client = createAotCompilerClient({
    createWorker: () => {
      if (fail) throw new Error("no worker");
      return factory();
    },
    idleStopMs: 1, retryAfterMs: 1000, ...clock
  });
  t.after(() => client.terminate());
  const bytes = buildModule({ memory: MEMORY, bodies: [[...i32const(1)]] });
  const p = client.compile(bytes, { warm: false });
  await settle();
  const job = made[0].sent.find((m) => m.type === "aot-compile").jobs[0];
  made[0].emit("message", { type: "aot-compiled", results: [{ id: job.id, module: new WebAssembly.Module(bytes) }], totals: {} });
  await p;
  made[0].emit("message", { type: "aot-idle", totals: {} });
  clock.fire(); // idle stop
  fail = true;
  assert.equal((await client.compile(bytes, { warm: false })).offThread, false);
  assert.equal(client.stats().workerFailures, 1);
  fail = false;
  time = 5000; // past the back-off
  client.compile(bytes, { warm: false }).catch(() => {});
  await settle();
  assert.equal(made.length, 2);
  assert.equal(client.stats().respawns, 1, "a start after a failure is a respawn, not an idle restart");
});

function sleb(v) {
  const out = [];
  v |= 0;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}

// Region tier-up: V8 moves a function to its top tier once ~13 M bytes of its
// Liftoff code ran, counted in the module shared by every thread, and a
// `return` charges the whole function. A fragment of the "region-warm"
// section is called with state.pc = its entry and downcount 0 until that
// budget is spent, on a scratch memory where env.ram_base points at MEM1.
const TU = { PC: 0, COUNT: 4, DC: 12 };
const TU_RAM_BASE = 0x1300000;
function tierUpRegion({ trap = false, warmSection = true } = {}) {
  const get = [0x20, 0x00];
  const load = (off) => [...get, 0x28, 0x02, off];
  const store = (off, value) => [...get, ...value, 0x36, 0x02, off];
  const k = (v) => [0x41, ...sleb(v)];
  const code = [0x00];
  const relocs = [];
  const push = (...bytes) => code.push(...bytes);
  // if (state.pc == 0x1000) { count++; read MEM1's last word; downcount -= 5;
  //   if (downcount <= 0) return 0; } state.pc = 0x1000; return_call dispatch
  push(...load(TU.PC), ...k(0x1000), 0x46, 0x04, 0x40);
  if (trap) push(0x00);
  push(...store(TU.COUNT, [...load(TU.COUNT), ...k(1), 0x6a]));
  // i32.load of MEM1's last word: the memarg offset holds the session's RAM
  // address (a heap site, patch 0084), here ~19 MB as in a real session.
  push(...k(0x1800000 - 4), 0x28, 0x02); relocs.push({ offset: code.length, kind: "heap", name: "ram_base" });
  push(...paddedUleb(TU_RAM_BASE), 0x1a);
  push(...store(TU.DC, [...load(TU.DC), ...k(5), 0x6b]));
  push(...load(TU.DC), ...k(0), 0x4c, 0x04, 0x40, ...k(0), 0x0f, 0x0b); // i32.le_s: return 0
  push(0x0b);
  push(...store(TU.PC, k(0x1000)), ...get, 0x12); relocs.push({ offset: code.length, kind: "dispatch" }); push(...paddedUleb(0));
  push(0x0b);
  const fragment = { entry: 0x1000, entries: [0x1000], code: Uint8Array.from(code), relocs };
  return assembleRegion([fragment], { helpers: {}, pcOffset: TU.PC, ...(warmSection ? { downcountOffset: TU.DC } : {}), memoryPages: 1024, heapBases: [TU_RAM_BASE, TU_RAM_BASE + 0x1800000] });
}

test("region-warm: the section lists each fragment's entry and size, and a module without a downcount offset has none", () => {
  const { bytes } = tierUpRegion();
  const plan = regionModuleWarm(new WebAssembly.Module(bytes));
  assert.equal(plan.pcOffset, TU.PC);
  assert.equal(plan.downcountOffset, TU.DC);
  assert.equal(plan.fragments.length, 1);
  assert.equal(plan.fragments[0].entry, 0x1000);
  assert.ok(plan.fragments[0].size > 20);
  assert.equal(regionModuleWarm(new WebAssembly.Module(tierUpRegion({ warmSection: false }).bytes)), null);
});

test("tierUpCalls spends V8's 13 M budget with margin: 5.6 KB (tiered between 3 000 and 3 250 calls in Node) gets more, huge functions 5", () => {
  assert.ok(tierUpCalls(5594) >= 3250);
  assert.equal(tierUpCalls(16 * 1024), Math.ceil((Math.floor(13e6 / 12288) + 1) * 1.25));
  assert.equal(tierUpCalls(8 << 20), Math.ceil(5 * 1.25));
  assert.ok(tierUpCalls(50) > tierUpCalls(1000));
});

test("a region's tier-up calls each fragment from its entry until its budget is spent, on scratch memory covering MEM1 at the session's address", () => {
  const { bytes } = tierUpRegion();
  const module = new WebAssembly.Module(bytes);
  const warmer = createWarmer();
  const run = warmer.startTierUp(module, bytes);
  assert.ok(run, "a module with a region-warm section starts a tier-up");
  const size = run.plan.fragments[0].size;
  let slices = 0;
  while (!run.step(performance.now() + 1)) slices += 1;
  assert.equal(run.result.traps, 0, "MEM1's last word is inside the scratch memory: no trap");
  assert.equal(run.result.tieredUp, 1);
  assert.equal(run.result.calls, tierUpCalls(size));
  const [memory] = warmer.scratchMemories();
  const count = new DataView(memory.buffer).getUint32(WARM_STATE_PTR + TU.COUNT, true);
  assert.equal(count, tierUpCalls(size), "every call ran the entry block once and returned");
  assert.ok(slices >= 0);
});

test("a fragment that traps ends its tier-up (counted), and a module without the section has none", () => {
  const trapping = tierUpRegion({ trap: true });
  const run = createWarmer().startTierUp(new WebAssembly.Module(trapping.bytes), trapping.bytes);
  assert.equal(run.step(Infinity), true);
  assert.equal(run.result.traps, 1);
  assert.equal(run.result.tieredUp, 0);
  const plain = tierUpRegion({ warmSection: false });
  assert.equal(createWarmer().startTierUp(new WebAssembly.Module(plain.bytes), plain.bytes), null);
});
