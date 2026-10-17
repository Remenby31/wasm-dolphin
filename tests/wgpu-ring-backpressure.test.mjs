import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

import {
  WGPU_CONSUMER_ERROR_HEADER_INDEX,
  WGPU_CONSUMER_STATE_FAILED,
  WGPU_CONSUMER_STATE_HEADER_INDEX,
  WGPU_CONSUMER_STATE_RUNNING,
  WGPU_PROTOCOL_NON_DROPPING_FLAG,
  enableWgpuNonDroppingBackpressure,
  failWgpuRingConsumer,
  publishWgpuRingProgress,
} from "../src/wgpu-ring-backpressure.js";

function makeRing(words = 7) {
  const headerI32 = new Int32Array(new SharedArrayBuffer(words * 4));
  return { headerI32, protocolV3Enabled: false };
}

test("protocol v3 handoff publishes RUNNING only when the expanded header exists", () => {
  const ring = makeRing();
  assert.equal(enableWgpuNonDroppingBackpressure(ring), true);
  assert.equal(ring.protocolV3Enabled, true);
  assert.equal(
    Atomics.load(ring.headerI32, 4) & WGPU_PROTOCOL_NON_DROPPING_FLAG,
    WGPU_PROTOCOL_NON_DROPPING_FLAG
  );
  assert.equal(
    Atomics.load(ring.headerI32, WGPU_CONSUMER_STATE_HEADER_INDEX),
    WGPU_CONSUMER_STATE_RUNNING
  );
  assert.equal(Atomics.load(ring.headerI32, WGPU_CONSUMER_ERROR_HEADER_INDEX), 0);

  const v2 = makeRing(5);
  assert.equal(enableWgpuNonDroppingBackpressure(v2), false);
  assert.equal(v2.protocolV3Enabled, false);
});

test("fatal replay state wakes both producer wait sites and preserves the first error", () => {
  const ring = makeRing();
  enableWgpuNonDroppingBackpressure(ring);

  assert.equal(failWgpuRingConsumer(ring, 7), true);
  assert.equal(
    Atomics.load(ring.headerI32, WGPU_CONSUMER_STATE_HEADER_INDEX),
    WGPU_CONSUMER_STATE_FAILED
  );
  assert.equal(Atomics.load(ring.headerI32, WGPU_CONSUMER_ERROR_HEADER_INDEX), 7);
  assert.equal(failWgpuRingConsumer(ring, 9), false);
  assert.equal(Atomics.load(ring.headerI32, WGPU_CONSUMER_ERROR_HEADER_INDEX), 7);
});

test("publishing ring progress stores and notifies the producer-facing index", () => {
  const ring = makeRing();
  assert.equal(publishWgpuRingProgress(ring, 1, 123), 123);
  assert.equal(Atomics.load(ring.headerI32, 1) >>> 0, 123);
});

sourceContractTest("C++ protocol v3 blocks without fixed drop timeout and fails closed", async () => {
  const [header, source] = await Promise.all([
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.h",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.cpp",
      import.meta.url
    ), "utf8"),
  ]);

  assert.match(header, /std::atomic<u32> consumer_state/);
  assert.match(header, /std::atomic<u32> consumer_error/);
  assert.match(header, /sizeof\(CmdRingHeader\) == 28/);
  assert.match(source, /protocolVersion\s*:\s*3/);
  assert.match(source, /headerWords\s*:\s*7/);
  assert.match(source, /kProtocolNonDroppingBackpressure/);
  assert.match(source, /ConsumerFailed\(\)/);
  assert.match(source, /WaitForRingSpace/);
  assert.match(source, /WaitForUploadSpace/);

  const pushBody = /bool WebGPUCommandStream::Push\(const CmdRecord& rec\)[\s\S]*?\n\}/
    .exec(source)?.[0] ?? "";
  assert.match(pushBody, /WaitForRingSpace\(w, 1\)/);
  assert.doesNotMatch(pushBody, /kMaxSpins/);

  const batchBody = /bool WebGPUCommandStream::PushBatch\([\s\S]*?\n\}/
    .exec(source)?.[0] ?? "";
  assert.match(batchBody, /WaitForRingSpace\(w, count\)/);
  assert.doesNotMatch(batchBody, /kMaxSpins/);
});

test("worker negotiates v3 and propagates submit/device-loss failure to the ring", async () => {
  const [worker, runtime] = await Promise.all([
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../src/wgpu-renderer-runtime.js", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /wgpuRendererRuntime\.attachRing/);
  assert.match(runtime, /protocolVersion !== 2 && protocolVersion !== 3/);
  assert.match(runtime, /enableWgpuNonDroppingBackpressure\(ring\)/);
  assert.match(worker, /wgpuRendererRuntime\.emergencyFail\(errorCode\)/);

  const publishBody = /function publishWgpuReadIndex\([\s\S]*?\n\}/
    .exec(worker)?.[0] ?? "";
  assert.match(publishBody, /wgpuRendererRuntime\.publishReadIndex\(readIndex\)/);
});
