import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);
const rendererListenerNames = [
  "handleDetachedOglFrame",
  "handleWebGpuShowImage",
  "handleWebGpuCmdRing"
];

function fakePthreadWorker({ throwOnPost = false } = {}) {
  return {
    listeners: [],
    messages: [],
    addEventListener(type, listener) {
      this.listeners.push({ type, name: listener.name, listener });
    },
    postMessage(message) {
      if (throwOnPost) throw new Error("intentional cache post failure");
      this.messages.push(message);
      if (message.type === "dolphin-jit-cache-barrier") {
        const entry = this.listeners.find(
          ({ name }) => name === "handleDolphinJitPthreadBarrierAckEvent"
        );
        entry?.listener?.({
          currentTarget: this,
          data: {
            type: "dolphin-jit-cache-barrier-ack",
            generation: message.generation,
            installed: true,
            cacheSize: 0,
          },
        });
      }
    }
  };
}

function listenerNames(worker) {
  return worker.listeners.map(({ name }) => name);
}

test("pthread renderer transport is independent of the optional JIT cache channel", async (t) => {
  const originalSelf = globalThis.self;
  const statusMessages = [];
  globalThis.self = {
    location: { href: "http://127.0.0.1:8080/" },
    addEventListener() {},
    postMessage(message) {
      statusMessages.push(message);
    }
  };
  t.after(() => {
    if (originalSelf === undefined) {
      delete globalThis.self;
    } else {
      globalThis.self = originalSelf;
    }
  });

  const { installDolphinPthreadChannels } = await import(
    `${workerUrl.href}?pthread-channels-test=${Date.now()}`
  );

  const cacheDisabledRunning = fakePthreadWorker();
  const cacheDisabledUnused = fakePthreadWorker();
  await installDolphinPthreadChannels(
    {
      PThread: {
        runningWorkers: [cacheDisabledRunning],
        unusedWorkers: [cacheDisabledUnused]
      }
    },
    { jitCacheEnabled: false }
  );

  for (const worker of [cacheDisabledRunning, cacheDisabledUnused]) {
    assert.deepEqual(listenerNames(worker), rendererListenerNames);
    assert.deepEqual(worker.messages, []);
  }
  assert.deepEqual(statusMessages, []);

  const overlappingWorker = fakePthreadWorker();
  await installDolphinPthreadChannels(
    {
      PThread: {
        runningWorkers: [overlappingWorker],
        unusedWorkers: [overlappingWorker]
      }
    },
    { jitCacheEnabled: false }
  );
  assert.deepEqual(listenerNames(overlappingWorker), rendererListenerNames);

  const cacheEnabled = fakePthreadWorker();
  await installDolphinPthreadChannels(
    { PThread: { runningWorkers: [cacheEnabled], unusedWorkers: [] } },
    { jitCacheEnabled: true }
  );
  assert.deepEqual(listenerNames(cacheEnabled), [
    ...rendererListenerNames,
    "handleDolphinJitPthreadBarrierAckEvent",
    "handleDolphinJitNewCompile",
    "handleDolphinJitCompileRequest"
  ]);
  assert.equal(cacheEnabled.messages.length, 2);
  assert.equal(cacheEnabled.messages[0].type, "dolphin-jit-cache");
  assert.equal(cacheEnabled.messages[1].type, "dolphin-jit-cache-barrier");

  const cachePostFailure = fakePthreadWorker({ throwOnPost: true });
  await installDolphinPthreadChannels(
    { PThread: { runningWorkers: [cachePostFailure], unusedWorkers: [] } },
    { jitCacheEnabled: true }
  );
  assert.deepEqual(listenerNames(cachePostFailure), [
    ...rendererListenerNames,
    "handleDolphinJitPthreadBarrierAckEvent",
    "handleDolphinJitNewCompile",
    "handleDolphinJitCompileRequest"
  ]);
});

test("a compile request is precompiled, kept alive and marked ready in the core's table, never posted to the CPU thread", async (t) => {
  const originalSelf = globalThis.self;
  globalThis.self = {
    location: { href: "http://127.0.0.1:8080/" },
    addEventListener() {},
    postMessage() {}
  };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const stamp = Date.now();
  const {
    installDolphinPthreadChannels, precompileDolphinJitModule, setDolphinJitReadyHeapForTest,
    dolphinJitReadyStatsForTest, setDolphinAotCompilerForTest
  } = await import(`${workerUrl.href}?compile-request-test=${stamp}`);
  const { canonicalWasmBlockKey } = await import("../src/jit-cache-identity.js");
  const { Worker } = await import("node:worker_threads");
  const cpu = fakePthreadWorker();
  await installDolphinPthreadChannels(
    { PThread: { runningWorkers: [cpu], unusedWorkers: [] } },
    { jitCacheEnabled: true }
  );
  const request = cpu.listeners.find(({ name }) => name === "handleDolphinJitCompileRequest").listener;
  // with the compiler worker on, through a real worker thread
  let workersMade = 0;
  setDolphinAotCompilerForTest({
    enabled: true,
    createWorker: () => {
      workersMade += 1;
      const w = new Worker(new URL("./helpers/aot-compiler-node-worker.mjs", import.meta.url));
      return {
        addEventListener(type, listener) {
          if (type === "message") w.on("message", (data) => listener({ data }));
          if (type === "error") w.on("error", listener);
        },
        postMessage: (m) => w.postMessage(m),
        terminate: () => w.terminate()
      };
    }
  });
  t.after(() => setDolphinAotCompilerForTest({}));
  // the core's heap: shared, the ready table it reports at 0x1000
  const heap = new Uint8Array(new SharedArrayBuffer(0x20000));
  const READY = 0x1000;
  setDolphinJitReadyHeapForTest(heap, READY);
  t.after(() => setDolphinJitReadyHeapForTest(null));
  const plusOne = Uint8Array.from(Buffer.from("0061736d0100000001060160017f017f03020100070501016600000a09010700200041016a0b", "hex"));
  const plusKey = await canonicalWasmBlockKey(plusOne);
  const slot = parseInt(plusKey.slice(-64, -60), 16);
  heap.set(plusOne, 0x18000);
  const view = heap.subarray(0x18000, 0x18000 + plusOne.length);
  const before = cpu.messages.length;
  const marksBefore = dolphinJitReadyStatsForTest().marks;
  await Promise.all([
    request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: plusKey, bytes: view, kind: "block", readyPtr: READY, readySlot: slot } }),
    request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: plusKey, bytes: view, kind: "block", readyPtr: READY, readySlot: slot } })
  ]);
  assert.equal(Atomics.load(heap, READY + slot), 1);
  assert.equal(dolphinJitReadyStatsForTest().marks - marksBefore, 1, "two requests in flight, one compile, one mark");
  assert.equal(workersMade, 1, "compiled in the compiler worker");
  assert.equal(cpu.messages.length, before, "nothing is posted to the CPU thread");
  // kept alive: the same Module comes back, so the CPU thread's own compile of these bytes hits V8's cache
  const kept = await precompileDolphinJitModule(plusKey, plusOne);
  assert.ok(kept.module instanceof WebAssembly.Module);
  assert.equal(new WebAssembly.Instance(kept.module).exports.f(7), 8);
  assert.equal((await precompileDolphinJitModule(plusKey, plusOne)).module, kept.module);

  // a region (P4) asks without bytes: its Module is already here under the key; marked at once, no compile
  const madeBefore = workersMade, regionMarks = dolphinJitReadyStatsForTest().marks;
  Atomics.store(heap, READY + 11, 0);
  await request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: plusKey, kind: "region", readyPtr: READY, readySlot: 11 } });
  assert.equal(Atomics.load(heap, READY + 11), 1);
  assert.equal(dolphinJitReadyStatsForTest().marks - regionMarks, 1);
  assert.equal(workersMade, madeBefore, "nothing compiled for a region request");

  // a forged block key, bytes the engine rejects: not cached, still marked done
  const forged = `wasm-block-sha256-v1:${"0".repeat(64)}`;
  await request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: forged, bytes: plusOne, kind: "block", readyPtr: READY, readySlot: 7 } });
  assert.equal(Atomics.load(heap, READY + 7), 1);
  assert.deepEqual(await precompileDolphinJitModule(forged, plusOne), { reason: "key-mismatch" });
  const bad = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0x0a, 1]);
  const badKey = await canonicalWasmBlockKey(bad);
  await request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: badKey, bytes: bad, kind: "block", readyPtr: READY, readySlot: 9 } });
  assert.equal(Atomics.load(heap, READY + 9), 1);
  assert.deepEqual(await precompileDolphinJitModule(badKey, bad), { reason: "compile" });
  // keys of another schema are refused until regions define their check
  assert.deepEqual(await precompileDolphinJitModule(`region-v1:${"a".repeat(64)}`, plusOne), { reason: "bad-key" });

  // two keys sharing a slot (16 bits of SHA-256): the slot says "something
  // finished", never "this key's Module is here". Each key keeps its own
  // Module; the core always compiles its own bytes, so a collision costs one
  // synchronous compile, never a wrong module.
  const identity = Uint8Array.from(Buffer.from("0061736d0100000001060160017f017f03020100070501016600000a0601040020000b", "hex"));
  const identityKey = await canonicalWasmBlockKey(identity);
  await request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: identityKey, bytes: identity, kind: "block", readyPtr: READY, readySlot: 3 } });
  assert.equal(Atomics.load(heap, READY + 3), 1);
  assert.equal(new WebAssembly.Instance((await precompileDolphinJitModule(identityKey, identity)).module).exports.f(7), 7);
  assert.equal(new WebAssembly.Instance(kept.module).exports.f(7), 8);
  assert.deepEqual(await precompileDolphinJitModule(`wasm-block-sha256-v1:${"f".repeat(64)}`, identity), { reason: "key-mismatch" });

  // only the core's own table is ever written: another address, or a slot
  // past the end of the heap, is ignored
  const snapshot = heap.slice();
  const rejectedBefore = dolphinJitReadyStatsForTest().rejected;
  const other = Uint8Array.from(Buffer.from("0061736d0100000001060160017f017f03020100070501016600000a09010700200041026a0b", "hex"));
  const otherKey = await canonicalWasmBlockKey(other);
  await request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: otherKey, bytes: other, kind: "block", readyPtr: 0x2000, readySlot: 5 } });
  assert.equal(dolphinJitReadyStatsForTest().rejected - rejectedBefore, 1);
  setDolphinJitReadyHeapForTest(heap, heap.length - 4);
  const other2 = Uint8Array.from(Buffer.from("0061736d0100000001060160017f017f03020100070501016600000a09010700200041036a0b", "hex"));
  await request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: await canonicalWasmBlockKey(other2), bytes: other2, kind: "block", readyPtr: heap.length - 4, readySlot: 100 } });
  assert.deepEqual(heap, snapshot, "no byte of the heap changed");
});

test("without a native module cache (JSC), past the boot, a compile request is marked ready with nothing compiled or kept here", async (t) => {
  const originalSelf = globalThis.self;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const {
    installDolphinPthreadChannels, precompileDolphinJitModule, setDolphinJitReadyHeapForTest, dolphinJitReadyStatsForTest,
    setDolphinAotCompilerForTest, setWasmEngineForTest, setAotCoreBootedForTest, dolphinJitCopiesSkippedForTest
  } = await import(`${workerUrl.href}?no-native-cache-test=${Date.now()}`);
  const { canonicalWasmBlockKey } = await import("../src/jit-cache-identity.js");
  const cpu = fakePthreadWorker();
  await installDolphinPthreadChannels({ PThread: { runningWorkers: [cpu], unusedWorkers: [] } }, { jitCacheEnabled: true });
  const request = cpu.listeners.find(({ name }) => name === "handleDolphinJitCompileRequest").listener;
  let workersMade = 0;
  setDolphinAotCompilerForTest({ enabled: true, createWorker: () => { workersMade += 1; throw new Error("no compile expected"); } });
  t.after(() => setDolphinAotCompilerForTest({}));
  const heap = new Uint8Array(new SharedArrayBuffer(0x20000));
  const READY = 0x1000;
  setDolphinJitReadyHeapForTest(heap, READY);
  t.after(() => setDolphinJitReadyHeapForTest(null));
  setWasmEngineForTest("jsc");
  setAotCoreBootedForTest(true);
  t.after(() => { setWasmEngineForTest("unknown"); setAotCoreBootedForTest(false); });
  const plusOne = Uint8Array.from(Buffer.from("0061736d0100000001060160017f017f03020100070501016600000a09010700200041016a0b", "hex"));
  const key = await canonicalWasmBlockKey(plusOne);
  const slot = parseInt(key.slice(-64, -60), 16);
  const skipped = dolphinJitCopiesSkippedForTest(), marks = dolphinJitReadyStatsForTest().marks;
  await request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key, bytes: plusOne, kind: "block", readyPtr: READY, readySlot: slot } });
  assert.equal(Atomics.load(heap, READY + slot), 1, "the CPU thread is not kept waiting");
  assert.equal(dolphinJitReadyStatsForTest().marks - marks, 1);
  assert.equal(workersMade, 0, "nothing compiled");
  assert.equal(dolphinJitCopiesSkippedForTest() - skipped, 1);
  assert.equal((await precompileDolphinJitModule(key, plusOne)).reason, "no-native-cache", "and no Module kept");
  // V8 (or before the boot, whatever the engine): compiled and kept, as before
  setWasmEngineForTest("jsc");
  setAotCoreBootedForTest(false);
  setDolphinAotCompilerForTest({});
  const before = await precompileDolphinJitModule(key, plusOne);
  assert.ok(before.module instanceof WebAssembly.Module, "before the boot the Module is kept (it reaches the pthreads)");
});

test("the off-thread compiler is on by default: no parameter, worker load defaults and adapter defaults", async () => {
  const { aotCompilerRequested, jitOffThreadRequested } = await import("../src/aot-compiler-worker.js");
  assert.equal(aotCompilerRequested(""), true);
  assert.equal(aotCompilerRequested("?x=1&aotcompiler=1"), true);
  assert.equal(jitOffThreadRequested(""), true);
  assert.equal(jitOffThreadRequested("?x=1&jitoffthread=1"), true);
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const adapter = new UpstreamWorkerAdapter();
  assert.equal(adapter.aotCompiler, true);
  assert.equal(adapter.jitOffThread, true);
  // a load payload that omits them (older host) still turns both on
  const source = await readFile(workerUrl, "utf8");
  assert.match(source, /\n  jitOffThread = true,\n  aotCompiler = true,\n/);
  assert.match(source, /dolphinAotCompilerEnabled = aotCompiler !== false;/);
  assert.match(source, /setPpcWasmJitOffThread\?\.\(jitOffThread !== false && !noJitCache \? 1 : 0\)/);
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(host, /this\.jitOffThread = jitOffThreadRequested\(window\.location\.search\);/);
  assert.match(host, /this\.aotCompiler = aotCompilerRequested\(window\.location\.search\);/);
});

test("region chaining is on by default; ?regionchain=0 reaches the core through the host, the adapter and the worker (0102)", async () => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  assert.equal(new UpstreamWorkerAdapter().regionChain, true);
  assert.equal(new UpstreamWorkerAdapter({ regionChain: false }).regionChain, false);
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(host, /this\.regionChain = new URLSearchParams\(window\.location\.search\)\.get\("regionchain"\) !== "0";/);
  assert.match(host, /\n {12}regionChain: this\.regionChain,\n/);
  const adapter = await readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8");
  assert.match(adapter, /\n {6}regionChain: this\.regionChain,\n/);
  const source = await readFile(workerUrl, "utf8");
  assert.match(source, /\n {8}regionChain: payload\.regionChain,\n/);
  assert.match(source, /\n  regionChain = true,\n/);
  assert.match(source, /setJitRegionChaining: optionalCwrap\("DolphinWeb_JitSetRegionChaining", null, \["number"\]\)/);
  assert.match(source, /api\.setJitRegionChaining\?\.\(regionChain !== false \? 1 : 0\);/);
});

// The page's ?aotsample= (#187) and wasm engine (src/wasm-engine.js) reach
// the disc worker only through the adapter's init message: both were
// dropped there, the worker then sampling at 10 ms and detecting V8 by
// itself whatever the page said.
test("?aotsample= and the wasm engine reach the worker through the host, the adapter and the worker's init", async () => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const adapter = new UpstreamWorkerAdapter({ aotSampleMs: 0, wasmEngine: "jsc" });
  assert.deepEqual([adapter.aotSampleMs, adapter.wasmEngine], [0, "jsc"]);
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(host, /\n {12}aotSampleMs: this\.aotSampleMs,\n/);
  assert.match(host, /\n {12}wasmEngine: this\.wasmEngine,\n/);
  const adapterSource = await readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8");
  assert.match(adapterSource, /\n {6}aotSampleMs: this\.aotSampleMs,\n/);
  assert.match(adapterSource, /\n {6}wasmEngine: this\.wasmEngine,\n/);
  const source = await readFile(workerUrl, "utf8");
  assert.match(source, /\n {8}aotSampleMs: payload\.aotSampleMs,\n/);
  assert.match(source, /\n {8}wasmEngine: payload\.wasmEngine,\n/);
  // #215: ?regioncap=N|0 the same way.
  assert.equal(new UpstreamWorkerAdapter({ regionCap: 0 }).regionCap, 0);
  assert.match(host, /\n {12}regionCap: this\.regionCap,\n/);
  assert.match(adapterSource, /\n {6}regionCap: this\.regionCap,\n/);
  assert.match(source, /\n {8}regionCap: payload\.regionCap,\n/);
});

test("fused relaxed_madd is used where probed fused; ?fusedmadd=0 keeps the exact path, through the host, the adapter and the worker (0129)", async () => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  assert.equal(new UpstreamWorkerAdapter().fusedMadd, true);
  assert.equal(new UpstreamWorkerAdapter({ fusedMadd: false }).fusedMadd, false);
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(host, /this\.fusedMadd = new URLSearchParams\(window\.location\.search\)\.get\("fusedmadd"\) !== "0";/);
  assert.match(host, /\n {12}fusedMadd: this\.fusedMadd,\n/);
  const adapter = await readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8");
  assert.match(adapter, /\n {6}fusedMadd: this\.fusedMadd,\n/);
  const source = await readFile(workerUrl, "utf8");
  assert.match(source, /\n {8}fusedMadd: payload\.fusedMadd,\n/);
  assert.match(source, /\n  fusedMadd = true,\n/);
  assert.match(source, /_DolphinWeb_SetFusedMadd\?\.\(relaxedMadd === "fused" && fusedMadd !== false \? 1 : 0\);/);
});

test("aotcompiler=0 and jitoffthread=0 turn both off: modules compile in place, no worker starts", async (t) => {
  const { aotCompilerRequested, jitOffThreadRequested } = await import("../src/aot-compiler-worker.js");
  assert.equal(aotCompilerRequested("?aotcompiler=0"), false);
  assert.equal(jitOffThreadRequested("?jitoffthread=0"), false);
  assert.equal(aotCompilerRequested("?jitoffthread=0"), true, "each switch only cuts its own flag");
  assert.equal(jitOffThreadRequested("?aotcompiler=0"), true, "each switch only cuts its own flag");
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const adapter = new UpstreamWorkerAdapter({
    aotCompiler: aotCompilerRequested("?aotcompiler=0&jitoffthread=0"),
    jitOffThread: jitOffThreadRequested("?aotcompiler=0&jitoffthread=0")
  });
  let posted = null;
  adapter.worker = {
    postMessage(message) {
      posted = message;
      queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
    }
  };
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://127.0.0.1:8080/?aotcompiler=0&jitoffthread=0", search: "?aotcompiler=0&jitoffthread=0" } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  await adapter.load();
  assert.equal(posted.payload.aotCompiler, false);
  assert.equal(posted.payload.jitOffThread, false);
  const originalSelf = globalThis.self;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const { precompileDolphinJitModule, setDolphinAotCompilerForTest } = await import(`${workerUrl.href}?default-off-test=${Date.now()}`);
  let made = 0;
  setDolphinAotCompilerForTest({ enabled: false, createWorker: () => { made += 1; throw new Error("must not start"); } });
  const { canonicalWasmBlockKey } = await import("../src/jit-cache-identity.js");
  const bytes = Uint8Array.from(Buffer.from("0061736d0100000001060160017f017f03020100070501016600000a0601040020000b", "hex"));
  const result = await precompileDolphinJitModule(await canonicalWasmBlockKey(bytes), bytes);
  assert.ok(result.module instanceof WebAssembly.Module);
  assert.equal(made, 0);
});

test("loadCore awaits pthread cache installation before returning", async () => {
  const source = await readFile(workerUrl, "utf8");

  assert.match(
    source,
    /await installDolphinPthreadChannels\(moduleInstance, \{\s*jitCacheEnabled: !noJitCache\s*\}\);/
  );
  assert.doesNotMatch(
    source,
    /if\s*\(!noJitCache\)\s*installDolphinPthreadChannels/
  );
});
