import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handleWgpuDeviceLoss } from "../src/wgpu-device-lifecycle.js";

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
  assert.match(worker, /device\.lost\.then\(async \(info\) => \{[\s\S]*?handleWgpuDeviceLoss\(\{/);
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
