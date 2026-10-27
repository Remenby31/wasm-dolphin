import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WGPU_FATAL_PAGE_REASONS,
  createWgpuFatalReporter,
  handleWgpuDeviceLoss,
  wgpuFatalPageReason,
} from "../src/wgpu-device-lifecycle.js";

test("active WebGPU device loss fails closed and invalidates producer geometry", () => {
  const device = {};
  const calls = [];
  const result = handleWgpuDeviceLoss({
    activeDevice: device,
    lostDevice: device,
    info: { message: "adapter reset" },
    recordError: (...args) => calls.push(["error", ...args]),
    markFatal: (...args) => calls.push(["fatal", ...args]),
    cancelReplay: () => calls.push(["cancel"]),
    clearReplayState: () => calls.push(["clear"]),
    invalidateGeometry: () => calls.push(["invalidate"]),
    clearActiveDevice: () => calls.push(["device-null"]),
    setBackend: (backend) => calls.push(["backend", backend]),
    postStatus: (message) => calls.push(["status", message]),
  });

  assert.deepEqual(result, { handled: true, detail: "adapter reset" });
  assert.deepEqual(calls, [
    ["error", "device-lost", "adapter reset"],
    ["fatal", "device-lost", "adapter reset"],
    ["cancel"],
    ["clear"],
    ["invalidate"],
    ["device-null"],
    ["backend", "webgpu-lost"],
    ["status", "WebGPU device lost: adapter reset"],
  ]);
});

test("stale WebGPU device loss cannot tear down a replacement device", () => {
  const calls = [];
  const result = handleWgpuDeviceLoss({
    activeDevice: {},
    lostDevice: {},
    info: { reason: "destroyed" },
    recordError: () => calls.push("error"),
    markFatal: () => calls.push("fatal"),
    cancelReplay: () => calls.push("cancel"),
    clearReplayState: () => calls.push("clear"),
    invalidateGeometry: () => calls.push("invalidate"),
    clearActiveDevice: () => calls.push("device-null"),
    setBackend: () => calls.push("backend"),
    postStatus: () => calls.push("status"),
  });

  assert.deepEqual(result, { handled: false, detail: "destroyed" });
  assert.deepEqual(calls, []);
});

test("device loss normalizes absent browser diagnostics", () => {
  const device = {};
  const details = [];
  handleWgpuDeviceLoss({
    activeDevice: device,
    lostDevice: device,
    recordError: (_scope, detail) => details.push(detail),
    markFatal: (_scope, detail) => details.push(detail),
  });
  assert.deepEqual(details, ["unknown", "unknown"]);
});

test("worker loss integration stops replay and reapplies the geometry epoch", async () => {
  const worker = await readFile(
    new URL("../src/upstream-discio-worker.js", import.meta.url),
    "utf8"
  );
  assert.match(worker, /device\.lost\.then\(\(info\) => \{[\s\S]*?handleWgpuDeviceLoss\(\{/);
  assert.match(worker, /cancelReplay: cancelWgpuReplayPump/);
  assert.match(worker, /clearReplayState: clearWgpuReplayStateAfterDeviceLoss/);
  assert.match(
    worker,
    /invalidateGeometry: \(\) =>[\s\S]*?setWebGpuGeometryPackEnabled\?\.\(wgpuGeometryPackEnabled \? 1 : 0\)/
  );
  assert.match(worker, /function drainWebGpuCmdRing[\s\S]*?if \(wgpuReplayFatal\) return/);
  assert.match(worker, /recordRendererError\("submit-error"[\s\S]*?markWgpuReplayFatal\("submit-error"/);
  assert.match(
    worker,
    /wgpuReplayOpMetrics\.finishReplay\([\s\S]*?if \(wgpuReplayFatal\) break;[\s\S]*?read = \(read \+ 1\)/
  );
});

// Every fatal replay error leaves the ring FAILED: the page hears of it by
// the device-loss path, once, with a precise reason.
const workerSource = () => readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");

test("every scope the worker fails the ring with has a page reason", async () => {
  const worker = await workerSource();
  const scopes = new Set([...worker.matchAll(/markWgpuReplayFatal\(\s*"([^"]+)"/g)].map((m) => m[1]));
  scopes.delete("device-lost");
  assert.deepEqual([...scopes].sort(), Object.keys(WGPU_FATAL_PAGE_REASONS).sort());
  // A scope passed as a variable would escape the list above.
  assert.doesNotMatch(worker.replace(/function markWgpuReplayFatal\(scope, detail\)/, ""), /markWgpuReplayFatal\(\s*[^"\s]/);
});

test("the worker tells the page from markWgpuReplayFatal, the device loss from its handler", async () => {
  const worker = await workerSource();
  assert.match(worker, /function markWgpuReplayFatal\(scope, detail\) \{[\s\S]*?wgpuRendererRuntime\.emergencyFail\(errorCode\);[\s\S]*?if \(scope !== "device-lost"\) \{\s*wgpuFatalReporter\.report\(\{\s*internalResolution: wgpuInternalResolution,\s*reason: wgpuFatalPageReason\(scope\),\s*detail: wgpuReplayFatal\.detail,\s*cause: "renderer-error",/);
  assert.doesNotMatch(worker, /self\.postMessage\(\{ type: "wgpu-device-lost"/);
  // A new device is a new renderer session.
  assert.match(worker, /wgpuReplayFatal = null;\n  wgpuFatalReporter\.reset\(\);/);
});

async function pageSees(message) {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const { EmulatorHost } = await import("../src/core-host.js");
  const lost = [];
  const host = {
    enhancements: { internalResolution: message.internalResolution },
    scaleLostCeiling: 4,
    onStatus: () => {},
    onGpuDeviceLost: (e) => lost.push(e),
  };
  const adapter = new UpstreamWorkerAdapter({ onGpuDeviceLost: (e) => EmulatorHost.prototype.handleGpuDeviceLost.call(host, e) });
  adapter.handleMessage(message);
  return { lost, host };
}

// One test over every cause (the list must match the worker's, test above):
// the page hears a renderer error at the same scale, a lost device lower.
test("every fatal replay error reaches the page as a renderer error, at the same scale; a lost device steps down", async () => {
  for (const [scope, reason] of Object.entries(WGPU_FATAL_PAGE_REASONS)) {
    assert.equal(wgpuFatalPageReason(scope), reason);
    const posted = [];
    createWgpuFatalReporter((m) => posted.push(m)).report({ internalResolution: 2, reason, detail: `${scope} detail`, cause: "renderer-error" });
    assert.deepEqual(posted, [{ type: "wgpu-device-lost", internalResolution: 2, reason, detail: `${scope} detail`, cause: "renderer-error" }], scope);
    const { lost, host } = await pageSees(posted[0]);
    assert.deepEqual(lost, [{ internalResolution: 2, fallback: null, reason, detail: `${scope} detail`, cause: "renderer-error" }], scope);
    assert.equal(host.scaleLostCeiling, 4, scope);
  }
  assert.deepEqual(Object.values(WGPU_FATAL_PAGE_REASONS).filter((r) => r.startsWith("ring-")), ["ring-ownership", "ring-attach"]);
  // A lost device (cause absent from an older worker too): 1x above 1x, null at 1x.
  const posted = [];
  createWgpuFatalReporter((m) => posted.push(m)).report({ internalResolution: 2, reason: "unknown", detail: "gone" });
  assert.equal(posted[0].cause, "device-lost");
  const lostAt2 = await pageSees(posted[0]);
  assert.deepEqual(lostAt2.lost, [{ internalResolution: 2, fallback: 1, reason: "unknown", detail: "gone", cause: "device-lost" }]);
  assert.equal(lostAt2.host.scaleLostCeiling, 1);
  const older = await pageSees({ type: "wgpu-device-lost", internalResolution: 1, reason: "destroyed", detail: "" });
  assert.deepEqual(older.lost, [{ internalResolution: 1, fallback: null, reason: "destroyed", detail: "", cause: "device-lost" }]);
});

test("one message per renderer session: the first cause wins, a new device starts again", () => {
  const posted = [];
  const reporter = createWgpuFatalReporter((m) => posted.push(m));
  assert.equal(reporter.report({ internalResolution: 3, reason: "staging-capacity", detail: "full" }), true);
  assert.equal(reporter.report({ internalResolution: 3, reason: "destroyed", detail: "lost after" }), false);
  assert.equal(reporter.report({ internalResolution: 3, reason: "submit-error", detail: "again" }), false);
  assert.deepEqual(posted.map((m) => m.reason), ["staging-capacity"]);
  assert.deepEqual(reporter.reported, { internalResolution: 3, reason: "staging-capacity", detail: "full", cause: "device-lost" });
  reporter.reset();
  assert.equal(reporter.report({ internalResolution: 1, reason: "destroyed", detail: "" }), true);
  assert.equal(posted.length, 2);
  assert.equal(wgpuFatalPageReason("something-new"), "something-new");
  assert.equal(wgpuFatalPageReason(""), "unknown");
});
