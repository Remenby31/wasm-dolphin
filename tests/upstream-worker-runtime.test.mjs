import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_UPSTREAM_CORE_SHA256 } from "../src/default-core.js";
import { DEFAULT_UPSTREAM_CORE_URL } from "../src/upstream-worker-protocol.js";

test("worker suppresses only one-way successes and legacy mode restores acknowledgements", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalSelf = globalThis.self;
  const posted = [];
  let messageHandler = null;

  globalThis.fetch = async () => {
    throw new Error("intentional transport-test fetch failure");
  };
  globalThis.self = {
    location: { href: "http://127.0.0.1:8080/" },
    addEventListener(type, handler) {
      if (type === "message") messageHandler = handler;
    },
    postMessage(message, transfer = []) {
      posted.push({ message, transfer });
    }
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSelf === undefined) {
      delete globalThis.self;
    } else {
      globalThis.self = originalSelf;
    }
  });

  await import(`../src/upstream-discio-worker.js?transport-test=${Date.now()}`);
  assert.equal(typeof messageHandler, "function");

  await messageHandler({
    data: { type: "setInputMask", payload: { mask: 1 }, oneWay: true }
  });
  assert.equal(posted.length, 0, "successful one-way reply should be suppressed");

  await messageHandler({ data: { id: 1, type: "setInputMask", payload: { mask: 2 } } });
  assert.deepEqual(posted.pop(), {
    message: { id: 1, ok: true },
    transfer: []
  });

  const throwingPayload = {};
  Object.defineProperty(throwingPayload, "mask", {
    get() {
      throw new Error("intentional one-way failure");
    }
  });
  await messageHandler({
    data: { type: "setInputMask", payload: throwingPayload, oneWay: true }
  });
  assert.deepEqual(posted.at(-1), {
    message: { id: undefined, ok: false, error: "intentional one-way failure" },
    transfer: []
  });

  await messageHandler({ data: { id: 2, type: "rendererDiagnostics", payload: {} } });
  const diagnostics = posted.at(-1).message.workerTransport;
  assert.equal(diagnostics.oneWayRequestsReceived, 2);
  assert.equal(diagnostics.oneWaySuccessRepliesSuppressed, 1);
  assert.equal(diagnostics.oneWayErrorRepliesSent, 1);
  assert.equal(diagnostics.estimatedOneWaySuccessReplyJsonBytesAvoided, 11);

  await messageHandler({
    data: {
      id: 3,
      type: "load",
      payload: {
        coreUrl: DEFAULT_UPSTREAM_CORE_URL,
        expectedCoreSha256: DEFAULT_UPSTREAM_CORE_SHA256,
        legacyOneWayAck: true,
        coreSelection: {
          requestedCoreSha256: "f".repeat(64),
          requestedCoreUrl: "http://127.0.0.1:8080/build/core-candidates/missing/dolphin-core-upstream.js",
          activeCoreSha256: "untrusted-host-value",
          activeCoreUrl: "http://invalid.example/untrusted.js",
          fallbackReason: "Core WASM fetch returned 404",
          fallbackBeforeCanvasTransfer: true
        }
      }
    }
  });
  assert.equal(posted.at(-1).message.ok, false, "test load should fail before core import");

  await messageHandler({ data: { id: 4, type: "rendererDiagnostics", payload: {} } });
  assert.deepEqual(posted.at(-1).message.coreSelection, {
    requestedCoreSha256: "f".repeat(64),
    requestedCoreUrl: "http://127.0.0.1:8080/build/core-candidates/missing/dolphin-core-upstream.js",
    activeCoreSha256: DEFAULT_UPSTREAM_CORE_SHA256,
    activeCoreUrl: new URL(DEFAULT_UPSTREAM_CORE_URL, globalThis.self.location.href).href,
    fallbackReason: "Core WASM fetch returned 404",
    fallbackBeforeCanvasTransfer: true
  });

  await messageHandler({
    data: { type: "setAudioMuted", payload: { muted: true }, oneWay: true }
  });
  assert.deepEqual(posted.at(-1), {
    message: { id: undefined, ok: true },
    transfer: []
  });
});
