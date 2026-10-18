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

test("a deferred compile request is answered to every pthread, a rejected one too", async (t) => {
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
  const { installDolphinPthreadChannels } = await import(
    `${workerUrl.href}?compile-request-test=${Date.now()}`
  );
  const { canonicalWasmBlockKey } = await import("../src/jit-cache-identity.js");
  const cpu = fakePthreadWorker();
  const other = fakePthreadWorker();
  await installDolphinPthreadChannels(
    { PThread: { runningWorkers: [cpu, other], unusedWorkers: [] } },
    { jitCacheEnabled: true }
  );
  const request = cpu.listeners.find(({ name }) => name === "handleDolphinJitCompileRequest").listener;
  // (i32) -> i32 identity, the smallest valid module
  const bytes = Uint8Array.from(Buffer.from("0061736d0100000001060160017f017f03020100070501016600000a0601040020000b", "hex"));
  const key = await canonicalWasmBlockKey(bytes);
  await request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key, bytes, kind: "block" } });
  for (const worker of [cpu, other]) {
    const add = worker.messages.find((m) => m.type === "dolphin-jit-cache-add");
    assert.equal(add.hash, key);
    assert.ok(add.module instanceof WebAssembly.Module);
    assert.equal(new WebAssembly.Instance(add.module).exports.f(7), 7);
  }
  const bad = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0x0a, 1]);
  await request({ currentTarget: cpu, data: { type: "dolphin-jit-compile-request", key: "k-bad", bytes: bad, kind: "block" } });
  for (const worker of [cpu, other]) {
    assert.deepEqual(
      worker.messages.find((m) => m.type === "dolphin-jit-compile-failed"),
      { type: "dolphin-jit-compile-failed", key: "k-bad", reason: "compile" }
    );
  }
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
