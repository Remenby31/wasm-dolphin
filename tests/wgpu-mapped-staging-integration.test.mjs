// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("mapped staging slot count is explicit and flows through validation", async () => {
  const [host, adapter, worker, gate, harness] = await Promise.all([
    readSource("../src/core-host.js"),
    readSource("../src/upstream-worker-adapter.js"),
    readSource("../src/upstream-discio-worker.js"),
    readSource("../tools/perf-regression-gate.mjs"),
    readSource("../tools/menu-progress-validate.mjs"),
  ]);
  assert.match(host, /requestedWgpuMappedStagingSlotCount\(\s*window\.location\.search,\s*defaultWgpuMappedStagingSlotCount\(this\.wasmEngine\)\s*\)/);
  assert.match(host, /wgpuMappedStagingSlotCount: this\.wgpuMappedStagingSlotCount/);
  assert.match(adapter, /this\.wgpuMappedStagingSlotCount = wgpuMappedStagingSlotCountOf\(wgpuMappedStagingSlotCount\)/);
  assert.match(worker, /wgpuMappedStagingSlotCount = wgpuMappedStagingSlotCountOf\(requestedWgpuMappedStagingSlotCount\)/);
  assert.match(gate, /wgpuMappedStagingSlotCountOf\(String\(requestedMappedStagingSlots\)\)/);
  assert.match(adapter, /wgpuMappedStagingSlotCount: this\.wgpuMappedStagingSlotCount/);
  assert.match(worker, /wgpuMappedStagingSlotCount: payload\.wgpuMappedStagingSlotCount/);
  assert.match(worker, /slotCount: wgpuMappedStagingSlotCount/);
  assert.match(worker, /enabled: wgpuUploadTransport === "mapped"/);
  assert.match(worker, /recordStore: wgpuMappedStageFastEnabled \? "flat" : "objects"/);
  assert.match(gate, /"wgpustagingslots"/);
  assert.match(gate, /WGPU mapped staging slot-count mismatch/);
  assert.match(harness, /\["WGPUSTAGINGSLOTS", "wgpustagingslots"\]/);
});

test("mapped staging timing stride is explicit, sampled, and benchmark-visible", async () => {
  const [host, adapter, worker, gate, harness] = await Promise.all([
    readSource("../src/core-host.js"),
    readSource("../src/upstream-worker-adapter.js"),
    readSource("../src/upstream-discio-worker.js"),
    readSource("../tools/perf-regression-gate.mjs"),
    readSource("../tools/menu-progress-validate.mjs"),
  ]);
  assert.match(host, /requestedWgpuMappedStageTimingStride\(\s*window\.location\.search\s*\)/);
  assert.match(host, /wgpuMappedStageTimingStride: this\.wgpuMappedStageTimingStride/);
  assert.match(adapter, /Number\(wgpuMappedStageTimingStride\) === 64 \? 64 : 1/);
  assert.match(adapter, /wgpuMappedStageTimingStride: this\.wgpuMappedStageTimingStride/);
  assert.match(worker, /Number\(payload\.wgpuMappedStageTimingStride\) === 64/);
  assert.match(worker, /mappedStageTimingStride: wgpuMappedStageTimingStride/);
  assert.match(worker, /beginMappedStageTiming\(uploadRole\)/);
  assert.match(worker, /beginMappedStageTiming\(\s*WGPU_UPLOAD_ROLE\.TEXTURE_ADJACENT/);
  assert.match(worker, /wgpuMappedStageTimingStride === 1 && stageElapsedMs !== null/);
  assert.match(gate, /WGPU mapped staging timing mismatch/);
  assert.match(harness, /\["WGPUMAPPEDTIMING", "wgpumappedtiming"\]/);
});

test("upload transport flows from URL parsing through the worker load payload", async () => {
  const [host, adapter, worker] = await Promise.all([
    readSource("../src/core-host.js"),
    readSource("../src/upstream-worker-adapter.js"),
    readSource("../src/upstream-discio-worker.js"),
  ]);
  assert.match(host, /requestedWgpuUploadTransport\(\s*window\.location\.search,\s*defaultWgpuUploadTransport\(this\.wasmEngine\)\s*\)/);
  assert.match(host, /wgpuUploadTransport: this\.wgpuUploadTransport/);
  assert.match(adapter, /wgpuUploadTransport === "mapped" \? "mapped" : "queue"/);
  assert.match(adapter, /wgpuUploadTransport: this\.wgpuUploadTransport/);
  assert.match(worker, /wgpuUploadTransport: payload\.wgpuUploadTransport/);
  assert.match(worker, /requestedWgpuUploadTransport === "mapped" \? "mapped" : "queue"/);
});

test("mapped staging fast path is opt-in and flows through the worker load payload", async () => {
  const [host, adapter, worker, gate, harness] = await Promise.all([
    readSource("../src/core-host.js"),
    readSource("../src/upstream-worker-adapter.js"),
    readSource("../src/upstream-discio-worker.js"),
    readSource("../tools/perf-regression-gate.mjs"),
    readSource("../tools/menu-progress-validate.mjs"),
  ]);
  assert.match(host, /requestedWgpuMappedStageFast\(window\.location\.search\)/);
  assert.match(host, /wgpuMappedStageFast: this\.wgpuMappedStageFast/);
  assert.match(adapter, /this\.wgpuMappedStageFast = Boolean\(wgpuMappedStageFast\)/);
  assert.match(adapter, /wgpuMappedStageFast: this\.wgpuMappedStageFast/);
  assert.match(worker, /wgpuMappedStageFast: payload\.wgpuMappedStageFast/);
  assert.match(
    worker,
    /wgpuMappedStageFastEnabled =[\s\S]*?wgpuUploadTransport === "mapped" && Boolean\(requestedWgpuMappedStageFast\)/
  );
  assert.match(worker, /wgpuMappedStageFastEnabled[\s\S]*?\.stageBufferFast\(/);
  assert.match(worker, /wgpuMappedStageFastEnabled[\s\S]*?\.stageTextureFast\(/);
  assert.match(worker, /flatRecords: wgpuMappedStageFastEnabled/);
  assert.match(worker, /if \(sparse\?\.handled\) return sparse;[\s\S]*?stageBufferFast/);
  assert.match(gate, /"wgpustagefast"/);
  assert.match(gate, /mappedStaging\?\.recordStore/);
  assert.match(gate, /record store mismatch: requested=flat/);
  assert.match(harness, /\["WGPUSTAGEFAST", "wgpustagefast"\]/);
});

test("mapped drain coalescing is opt-in, bounded, and generation-fenced", async () => {
  const [host, adapter, worker, gate, harness] = await Promise.all([
    readSource("../src/core-host.js"),
    readSource("../src/upstream-worker-adapter.js"),
    readSource("../src/upstream-discio-worker.js"),
    readSource("../tools/perf-regression-gate.mjs"),
    readSource("../tools/menu-progress-validate.mjs"),
  ]);
  assert.match(host, /requestedWgpuMappedDrainCoalescing\(/);
  assert.match(host, /wgpuMappedDrainCoalescing: this\.wgpuMappedDrainCoalescing/);
  assert.match(adapter, /this\.wgpuMappedDrainCoalescing = Boolean\(wgpuMappedDrainCoalescing\)/);
  assert.match(worker, /wgpuMappedDrainCoalescing: payload\.wgpuMappedDrainCoalescing/);
  assert.match(worker, /wgpuUploadTransport === "mapped" && Boolean\(requestedWgpuMappedDrainCoalescing\)/);
  assert.match(worker, /pendingBytes: mappedSnapshot\?\.pendingBytes \?\? 0/);
  assert.match(worker, /pendingRecords: mappedSnapshot\?\.pendingUploads \?\? 0/);
  assert.match(worker, /pendingAgeMs: mappedSnapshot\?\.oldestPendingAgeMs \?\? 0/);
  assert.match(worker, /scheduleWgpuMappedDrainDeadline\(mappedDrainDecision\)/);
  assert.match(worker, /generation: wgpuMappedStagingGeneration/);
  assert.match(worker, /submitPendingWgpuMappedUploads\("coalescing-deadline"\)/);
  assert.match(worker, /WGPU_MAPPED_DRAIN_FORCE_REASONS\.FINALIZATION/);
  assert.match(worker, /case "validationFinalizeWgpuMappedDrain"/);
  assert.match(worker, /await finalizeWgpuMappedDrain/);
  assert.match(worker, /Promise\.all\(pendingRemaps\)/);
  assert.match(worker, /WGPU mapped drain finalization did not quiesce/);
  assert.match(
    gate,
    /"validationFinalizeWgpuMappedDrain"[\s\S]*?postRunFinalizedTelemetry = \{[\s\S]*?causalTelemetry: finalized\.causalTelemetry/
  );
  assert.match(gate, /mappedDrainFinalization\?\.quiesced/);
  assert.match(gate, /params: Object\.fromEntries\(url\.searchParams\.entries\(\)\)/);
  assert.match(gate, /was enabled but never deferred work/);
  assert.match(gate, /was enabled but never submitted mapped work/);
  assert.match(gate, /mappedDrainFinalization/);
  assert.match(gate, /retained uploads beyond 8 ms/);
  assert.match(worker, /WGPU_MAPPED_DRAIN_FORCE_REASONS\.DESTROY/);
  assert.match(
    worker,
    /case WGPU_CMD_OP_DESTROY:[\s\S]*?submitEnc\("destroy"\)[\s\S]*?m\.delete\(id\)/
  );
  assert.match(gate, /WGPU mapped drain coalescing mismatch/);
  assert.match(harness, /\["WGPUDRAINCOALESCE", "wgpudraincoalesce"\]/);
});

test("mapped uploads are copied into a bounded pool and queue writes stay isolated", async () => {
  const worker = await readSource("../src/upstream-discio-worker.js");
  assert.match(worker, /WGPU_MAPPED_STAGING_SLOT_COUNT = 3/);
  assert.match(worker, /let wgpuMappedStagingSlotBytes = 16 \* 1024 \* 1024/);
  assert.match(worker, /if \(wgpuUploadTransport === "mapped"\) \{[\s\S]*?\.stageBuffer\(\{/);
  assert.match(worker, /if \(wgpuUploadTransport === "mapped"\) \{[\s\S]*?\.stageTexture\(\{/);
  assert.match(worker, /\} else \{[\s\S]*?q\.writeBuffer\(/);
  assert.match(worker, /\} else \{[\s\S]*?q\.writeTexture\(/);
  assert.match(worker, /mappedStagingCopyCount/);
  assert.match(worker, /mappedStagingCapacityWaitCount/);
  assert.match(worker, /mappedStagingRemapFailureCount/);
});

test("submission orders upload before render and capacity never falls back", async () => {
  const worker = await readSource("../src/upstream-discio-worker.js");
  assert.match(
    worker,
    /q\.submit\(\[\s*\.\.\.\(mappedBatch\?\.ordinary \? \[mappedBatch\.ordinary\.commandBuffer\] : \[\]\),\s*\.\.\.\(mappedBatch\?\.compute \? \[mappedBatch\.compute\.commandBuffer\] : \[\]\),\s*renderCommandBuffer,\s*\]\)/
  );
  assert.match(
    worker,
    /queue\.submit\(\[\s*\.\.\.\(batch \? \[batch\.commandBuffer\] : \[\]\),\s*\.\.\.\(computeBatch \? \[computeBatch\.commandBuffer\] : \[\]\),\s*\]\)/
  );
  assert.match(
    worker,
    /if \(mappedCapacityHold\) \{[\s\S]*?if \(pass\) \{[\s\S]*?markWgpuReplayFatal/
  );
  assert.match(
    worker,
    /The current upload record is deliberately still owned by the ring/
  );
  assert.match(worker, /rejectMappedBatch\(mappedBatch, e\)/);
  assert.match(worker, /wgpuMappedStagingPool\?\.invalidate\("WebGPU device lost"\)/);
});

test("performance validation fails closed when the mapped arm executes queue transport", async () => {
  const gate = await readSource("../tools/perf-regression-gate.mjs");
  assert.match(gate, /"wgpuuploadtransport"/);
  assert.match(gate, /WGPU upload transport mismatch: requested=/);
  assert.match(gate, /observedWgpu\?\.uploadTransport/);
  assert.match(gate, /evaluateWgpuRuntimeConfigEvidence/);
});

// A count the page accepts must reach the worker's load payload unchanged:
// before, the adapter dropped every value but 4 back to 3.
test("?wgpustagingslots=6 reaches the worker's load payload through the adapter", async (t) => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const { requestedWgpuMappedStagingSlotCount } = await import("../src/wgpu-replay-diagnostics.js");
  const adapter = new UpstreamWorkerAdapter({ wgpuMappedStagingSlotCount: requestedWgpuMappedStagingSlotCount("?wgpustagingslots=6") });
  let posted = null;
  adapter.worker = {
    postMessage(message) {
      posted = message;
      queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
    }
  };
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://127.0.0.1:8080/?wgpustagingslots=6", search: "?wgpustagingslots=6" } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  await adapter.load();
  assert.equal(posted.payload.wgpuMappedStagingSlotCount, 6);
});

// The stall loggers are opt-in: ?stalllog=1 is read once by the host, which
// gates [main-stall], and must reach the worker's load payload through the
// adapter (which rebuilds that payload field by field) to gate [signal-stall].
test("?stalllog=1 gates both stall loggers and flows through the worker load payload", async () => {
  const [host, adapter, worker] = await Promise.all([
    readSource("../src/core-host.js"),
    readSource("../src/upstream-worker-adapter.js"),
    readSource("../src/upstream-discio-worker.js"),
  ]);
  assert.match(host, /this\.stallLog = new URLSearchParams\(window\.location\.search\)\.get\("stalllog"\) === "1"/);
  assert.match(host, /stallLog: this\.stallLog/);
  assert.match(host, /if \(this\.stallLog && !this\._mainStallFirstLogged/);
  assert.match(host, /if \(this\.stallLog && \(isNewWorst \|\| this\._mainStallCount % 5 === 0\)\)/);
  // main-profiler reads the counters: they stay unconditional.
  assert.match(host, /if \(loopMs > 20\) \{\s*this\._mainStallCount = /);
  assert.match(adapter, /stallLog = false,/);
  assert.match(adapter, /this\.stallLog = Boolean\(stallLog\)/);
  assert.match(adapter, /stallLog: this\.stallLog/);
  assert.match(worker, /stallLog: payload\.stallLog/);
  assert.match(worker, /stallLog: requestedStallLog = false/);
  assert.match(worker, /stallLogEnabled = Boolean\(requestedStallLog\)/);
  assert.match(worker, /if \(stallLogEnabled && \(isNewWorst \|\| signalStallCount % 5 === 0\)\)/);
});

for (const [search, expected] of [["?stalllog=1", true], ["", false]]) {
  test(`stallLog=${expected} reaches the worker's load payload through the adapter`, async (t) => {
    const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
    const adapter = new UpstreamWorkerAdapter(
      new URLSearchParams(search).get("stalllog") === "1" ? { stallLog: true } : {}
    );
    let posted = null;
    adapter.worker = {
      postMessage(message) {
        posted = message;
        queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
      }
    };
    const originalWindow = globalThis.window;
    globalThis.window = { location: { href: `http://127.0.0.1:8080/${search}`, search } };
    t.after(() => {
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    });
    await adapter.load();
    assert.equal(posted.payload.stallLog, expected);
  });
}

test("mapped staging slot size flows from the page to the pool and the artifacts", async () => {
  const [host, adapter, worker, gate, harness] = await Promise.all([
    readSource("../src/core-host.js"),
    readSource("../src/upstream-worker-adapter.js"),
    readSource("../src/upstream-discio-worker.js"),
    readSource("../tools/perf-regression-gate.mjs"),
    readSource("../tools/menu-progress-validate.mjs"),
  ]);
  assert.match(host, /requestedWgpuMappedStagingSlotMib\(\s*window\.location\.search,\s*defaultWgpuMappedStagingSlotMib\(this\.wasmEngine\)\s*\)/);
  assert.match(host, /wgpuMappedStagingSlotMib: this\.wgpuMappedStagingSlotMib/);
  assert.match(adapter, /this\.wgpuMappedStagingSlotMib = wgpuMappedStagingSlotMibOf\(wgpuMappedStagingSlotMib\)/);
  assert.match(adapter, /wgpuMappedStagingSlotMib: this\.wgpuMappedStagingSlotMib/);
  assert.match(worker, /wgpuMappedStagingSlotMib: payload\.wgpuMappedStagingSlotMib/);
  assert.match(worker, /wgpuMappedStagingSlotMibOf\(requestedWgpuMappedStagingSlotMib\) \* 1024 \* 1024/);
  assert.match(worker, /slotSize: wgpuMappedStagingSlotBytes/);
  assert.match(worker, /slotBytes: wgpuMappedStagingSlotBytes/);
  assert.match(gate, /"wgpustagingslotmib"/);
  assert.match(gate, /WGPU mapped staging slot-size mismatch/);
  assert.match(harness, /\["WGPUSTAGINGSLOTMIB", "wgpustagingslotmib"\]/);
});

test("?wgpustagingslotmib=4 reaches the worker's load payload through the adapter", async (t) => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const { requestedWgpuMappedStagingSlotMib } = await import("../src/wgpu-replay-diagnostics.js");
  const adapter = new UpstreamWorkerAdapter({ wgpuMappedStagingSlotMib: requestedWgpuMappedStagingSlotMib("?wgpustagingslotmib=4") });
  let posted = null;
  adapter.worker = {
    postMessage(message) {
      posted = message;
      queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
    }
  };
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://127.0.0.1:8080/?wgpustagingslotmib=4", search: "?wgpustagingslotmib=4" } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  await adapter.load();
  assert.equal(posted.payload.wgpuMappedStagingSlotMib, 4);
});

test("both upload paths take the queue through writeWgpuUploadThroughQueue and are counted", async () => {
  const worker = await readSource("../src/upstream-discio-worker.js");
  const calls = worker.match(/queueWgpuUploadReason\(stageReason, Boolean\(pass\)\);\s*if \(queueReason &&\s*writeWgpuUploadThroughQueue\(\{\s*submitPending: submitPendingForQueueUpload,/g) ?? [];
  assert.equal(calls.length, 2);
  assert.equal((worker.match(/noteQueueWgpuUpload\(queueReason, uploadBytes\)/g) ?? []).length, 2);
  // Sparse and compute UBO staging keep their own shadow state: never the queue.
  assert.match(worker, /const queueReason = stageAccepted \|\| !viaPool/);
  // Inside a pass only the staged batch is submitted, never the render encoder.
  assert.match(worker, /if \(enc && !pass\) submitEnc\("staging-oversize"\);\s*else flushMappedUploadsOnly\("staging-oversize"\);/);
  assert.match(worker, /stagingOversize: webGpuCausalStats\.mappedStagingOversizeCount/);
  assert.match(worker, /stagingPassCapacityQueue: webGpuCausalStats\.mappedStagingPassCapacityQueueCount/);
  // Per-pass bytes are a metric: nothing per pass without ?metrics=1.
  assert.match(worker, /if \(causalMetricsEnabled\) \{\s*recordWgpuPassUploadBytes\(passUploadBytes\);\s*passUploadBytes = 0;\s*\}/);
  assert.match(worker, /if \(causalMetricsEnabled && pass && replayRecordAccepted &&/);
});
