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
  const { installDolphinPthreadChannels, precompileDolphinJitModule, setDolphinJitReadyHeapForTest } = await import(
    `${workerUrl.href}?compile-request-test=${stamp}`
  );
  const { canonicalWasmBlockKey } = await import("../src/jit-cache-identity.js");
  const cpu = fakePthreadWorker();
  await installDolphinPthreadChannels(
    { PThread: { runningWorkers: [cpu], unusedWorkers: [] } },
    { jitCacheEnabled: true }
  );
  const request = cpu.listeners.find(({ name }) => name === "handleDolphinJitCompileRequest").listener;
  // the core's heap: shared, with the ready table at 0x1000 and the block bytes elsewhere
  const heap = new Uint8Array(new SharedArrayBuffer(0x20000));
  setDolphinJitReadyHeapForTest(heap);
  const READY = 0x1000;
  const plusOne = Uint8Array.from(Buffer.from("0061736d0100000001060160017f017f03020100070501016600000a09010700200041016a0b", "hex"));
  const plusKey = await canonicalWasmBlockKey(plusOne);
  const slot = parseInt(plusKey.split(":")[1].slice(0, 4), 16);
  heap.set(plusOne, 0x18000);
  const view = heap.subarray(0x18000, 0x18000 + plusOne.length);
  const before = cpu.messages.length;
  await Promise.all([
    request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: plusKey, bytes: view, kind: "block", readyPtr: READY, readySlot: slot } }),
    request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: plusKey, bytes: view, kind: "block", readyPtr: READY, readySlot: slot } })
  ]);
  assert.equal(Atomics.load(heap, READY + slot), 1);
  assert.equal(cpu.messages.length, before, "nothing is posted to the CPU thread");
  // kept alive: the same Module comes back, so the CPU thread's own compile of these bytes hits V8's cache
  const kept = await precompileDolphinJitModule(plusKey, plusOne);
  assert.ok(kept.module instanceof WebAssembly.Module);
  assert.equal(new WebAssembly.Instance(kept.module).exports.f(7), 8);
  assert.equal((await precompileDolphinJitModule(plusKey, plusOne)).module, kept.module);

  // a forged block key or bytes the engine rejects: not cached, still marked done
  const forged = `wasm-block-sha256-v1:${"0".repeat(64)}`;
  heap[READY + 7] = 0;
  await request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: forged, bytes: plusOne, kind: "block", readyPtr: READY, readySlot: 7 } });
  assert.equal(Atomics.load(heap, READY + 7), 1);
  assert.deepEqual(await precompileDolphinJitModule(forged, plusOne), { reason: "key-mismatch" });
  const bad = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0x0a, 1]);
  heap[READY + 9] = 0;
  await request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: "k-bad", bytes: bad, kind: "block", readyPtr: READY, readySlot: 9 } });
  assert.equal(Atomics.load(heap, READY + 9), 1);
  assert.deepEqual(await precompileDolphinJitModule("k-bad", bad), { reason: "compile" });
  // out-of-range table addresses are ignored, never written
  await request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: plusKey, bytes: plusOne, kind: "block", readyPtr: 0x1ffff, readySlot: 5 } });
  setDolphinJitReadyHeapForTest(null);
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
