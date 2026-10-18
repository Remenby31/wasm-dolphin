import assert from "node:assert/strict";
import test from "node:test";

import { UpstreamWorkerAdapter } from "../src/upstream-worker-adapter.js";
import {
  DEFAULT_UPSTREAM_CORE_SHA256,
  DEFAULT_UPSTREAM_CORE_URL
} from "../src/upstream-worker-protocol.js";

test("adapter marks only known fire-and-forget calls as one-way", () => {
  const posted = [];
  const adapter = new UpstreamWorkerAdapter();
  adapter.worker = {
    postMessage(message, transfer) {
      posted.push({ message, transfer });
    }
  };

  adapter.post("setInputMask", { mask: 3 });
  adapter.post("unknownFutureRequest", { value: 1 });

  assert.deepEqual(posted[0], {
    message: { type: "setInputMask", payload: { mask: 3 }, oneWay: true },
    transfer: []
  });
  assert.deepEqual(posted[1], {
    message: { type: "unknownFutureRequest", payload: { value: 1 } },
    transfer: []
  });
  assert.equal(adapter.transportTelemetry().oneWayRequestsPosted, 1);
});

test("adapter request/reply promises retain numeric IDs and resolution semantics", async () => {
  let posted;
  const adapter = new UpstreamWorkerAdapter();
  adapter.worker = {
    postMessage(message, transfer) {
      posted = { message, transfer };
    }
  };

  const responsePromise = adapter.request("runFrame", { sample: true });
  assert.deepEqual(posted, {
    message: { id: 1, type: "runFrame", payload: { sample: true } },
    transfer: []
  });
  adapter.handleMessage({ id: 1, ok: true, frame: 7 });
  assert.deepEqual(await responsePromise, { id: 1, ok: true, frame: 7 });
  assert.equal(adapter.pending.size, 0);
});

test("adapter accounts for legacy acknowledgements and preserved one-way errors", () => {
  const adapter = new UpstreamWorkerAdapter({ legacyOneWayAck: true });

  adapter.handleMessage({ id: undefined, ok: true });
  adapter.handleMessage({ id: undefined, ok: false, error: "input failed" });

  assert.deepEqual(adapter.transportTelemetry(), {
    schema: "wasm-dolphin.worker-transport.v1",
    legacyOneWayAck: true,
    oneWayRequestsPosted: 0,
    requestMessagesPosted: 0,
    unmatchedSuccessRepliesReceived: 1,
    unmatchedErrorRepliesReceived: 1,
    unknownMessagesReceived: 0
  });
});

test("adapter counts worker messages nobody handles instead of dropping them silently", () => {
  const adapter = new UpstreamWorkerAdapter();
  adapter.handleMessage({ type: "somethingNew", payload: {} });
  adapter.handleMessage({ id: 99, ok: true });
  assert.equal(adapter.transportTelemetry().unknownMessagesReceived, 2);
});

test("adapter forwards WebGPU runtime options in the load payload", async (t) => {
const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://127.0.0.1:8080/" } };
  t.after(() => {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  });

  let posted = null;
  const adapter = new UpstreamWorkerAdapter({
    collectMetrics: true,
    wgpuReplayBudgetMs: 6,
    wgpuPowerPreference: "low-power",
    wgpuSparseUbo: true,
    wgpuGeometryPack: true,
    wgpuGeometryRange: true,
    wgpuUploadArenaMiB: 64,
    wgpuRendererWorkerProbe: "canary",
    wgpuProducerProfile: true,
    wgpuTailGate: true
  });
  adapter.worker = {
    postMessage(message, transfer) {
      posted = { message, transfer };
      queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
    }
  };

  await adapter.load();

  assert.equal(posted.message.type, "load");
  assert.deepEqual(
    {
      wgpuReplayBudgetMs: posted.message.payload.wgpuReplayBudgetMs,
      wgpuPowerPreference: posted.message.payload.wgpuPowerPreference,
      wgpuSparseUbo: posted.message.payload.wgpuSparseUbo,
      wgpuGeometryPack: posted.message.payload.wgpuGeometryPack,
      wgpuGeometryRange: posted.message.payload.wgpuGeometryRange,
      wgpuUploadArenaMiB: posted.message.payload.wgpuUploadArenaMiB,
      wgpuRendererWorkerProbe: posted.message.payload.wgpuRendererWorkerProbe,
      wgpuProducerProfile: posted.message.payload.wgpuProducerProfile,
      wgpuTailGate: posted.message.payload.wgpuTailGate
    },
    {
      wgpuReplayBudgetMs: 6,
      wgpuPowerPreference: "low-power",
      wgpuSparseUbo: true,
      wgpuGeometryPack: true,
      wgpuGeometryRange: true,
      wgpuUploadArenaMiB: 64,
      wgpuRendererWorkerProbe: "canary",
      wgpuProducerProfile: true,
      wgpuTailGate: true
    }
  );
  assert.deepEqual(posted.transfer, []);
});

test("adapter keeps sparse UBO copy-forward default-off", () => {
  assert.equal(new UpstreamWorkerAdapter().wgpuSparseUbo, false);
});

test("candidate preflight rollback records requested and active core before canvas transfer", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const candidateSha256 = "f".repeat(64);
  const candidateUrl = `./build/core-candidates/${candidateSha256}/dolphin-core-upstream.js`;
  const pageUrl = "http://127.0.0.1:8080/?coreid=" + candidateSha256;
  let posted = null;
  const statuses = [];
  const order = [];

  globalThis.window = { location: { href: pageUrl } };
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  });

  const adapter = new UpstreamWorkerAdapter({
    coreUrl: candidateUrl,
    expectedCoreSha256: candidateSha256,
    xfbFastPaths: 3,
    transferCanvas() {
      order.push("canvas-transfer");
      return null;
    },
    onStatus(message) {
      statuses.push(message);
      if (/rolling back/i.test(message)) order.push("fallback");
    }
  });
  adapter.worker = {
    postMessage(message, transfer) {
      posted = { message, transfer };
      queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
    }
  };

  await adapter.load();

  assert.match(statuses[0], /rolling back to pinned baseline.*404/i);
  assert.deepEqual(order, ["fallback", "canvas-transfer"]);
  assert.deepEqual(posted.message.payload.coreSelection, {
    requestedCoreSha256: candidateSha256,
    requestedCoreUrl: new URL(candidateUrl, pageUrl).href,
    activeCoreSha256: DEFAULT_UPSTREAM_CORE_SHA256,
    activeCoreUrl: new URL(DEFAULT_UPSTREAM_CORE_URL, pageUrl).href,
    fallbackReason: "Core WASM fetch returned 404",
    fallbackBeforeCanvasTransfer: true
  });
  assert.equal(posted.message.payload.xfbFastPaths, 3);
});

test("geometry ranging remains disabled unless packed geometry is enabled", () => {
  const disabled = new UpstreamWorkerAdapter({
    wgpuGeometryPack: false,
    wgpuGeometryRange: true
  });
  assert.equal(disabled.wgpuGeometryPack, false);
  assert.equal(disabled.wgpuGeometryRange, false);

  const enabled = new UpstreamWorkerAdapter({
    wgpuGeometryPack: true,
    wgpuGeometryRange: true
  });
  assert.equal(enabled.wgpuGeometryRange, true);
});

test("producer profiling requires both its URL request and metrics collection", () => {
  assert.equal(new UpstreamWorkerAdapter({
    collectMetrics: false,
    wgpuProducerProfile: true,
  }).wgpuProducerProfile, false);
  assert.equal(new UpstreamWorkerAdapter({
    collectMetrics: true,
    wgpuProducerProfile: true,
  }).wgpuProducerProfile, true);
});

test("draw profiling preserves its raw request for worker-side fail-closed validation", () => {
  assert.equal(new UpstreamWorkerAdapter({
    collectMetrics: false,
    wgpuDrawProfile: true,
  }).wgpuDrawProfile, true);
});
