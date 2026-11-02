// The page's navigator.maxTouchPoints reaches the worker for real (#421): the
// adapter's load payload (built field by field: a field it does not copy is
// lost in silence, as aotsample and wasmengine once were) is handed to the
// worker's own message handler, and the worker reports what it kept.
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_UPSTREAM_CORE_URL } from "../src/upstream-worker-protocol.js";

test("pageMaxTouchPoints: page -> adapter payload -> worker state", async (t) => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const originalFetch = globalThis.fetch;
  const originalSelf = globalThis.self;
  const originalWindow = globalThis.window;
  const posted = [];
  let messageHandler = null;
  globalThis.fetch = async () => { throw new Error("intentional test fetch failure"); };
  globalThis.self = {
    location: { href: "http://127.0.0.1:8080/" },
    navigator: { userAgent: "test" },
    addEventListener(type, handler) { if (type === "message") messageHandler = handler; },
    postMessage(message) { posted.push(message); }
  };
  globalThis.window = { location: { href: "http://127.0.0.1:8080/", search: "" } };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of [["self", originalSelf], ["window", originalWindow]]) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  });
  await import(`../src/upstream-discio-worker.js?touch-points-test=${Date.now()}`);
  assert.equal(typeof messageHandler, "function");

  let id = 10;
  const workerKept = async (options) => {
    // the adapter builds the load message as the page would send it
    const adapter = new UpstreamWorkerAdapter(options);
    let message = null;
    adapter.worker = { postMessage(m) { message = m; queueMicrotask(() => adapter.handleMessage({ id: m.id, ok: true })); } };
    await adapter.load();
    // the worker's own handler takes it (the core import fails later: the
    // load's options are kept before any await)
    await messageHandler({ data: { id: id++, type: "load", payload: { ...message.payload, coreUrl: DEFAULT_UPSTREAM_CORE_URL } } });
    await messageHandler({ data: { id: id++, type: "rendererDiagnostics", payload: {} } });
    const config = posted.at(-1).runtimeConfig;
    assert.ok(config && "pageMaxTouchPoints" in config, "the worker reports the field");
    return config.pageMaxTouchPoints;
  };
  assert.equal(await workerKept({ pageMaxTouchPoints: 5 }), 5, "an iPhone or iPad");
  assert.equal(await workerKept({ pageMaxTouchPoints: 0 }), 0, "a Mac");
  assert.equal(await workerKept({}), null, "not passed: unknown, never 0");
});
