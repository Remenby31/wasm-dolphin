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
  parseWasmImports
} from "../src/aot-compiler-worker.js";

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
