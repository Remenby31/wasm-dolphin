import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { coreIntegrityOf, createWgpuIntegrity, INTEGRITY_FATAL, skippedDrawCause } from "../src/wgpu-integrity.js";
import { parseWgpuProducerStateStats } from "../src/wgpu-pass-state-cache.js";

const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");

test("a skipped draw is counted by its first missing resource, in the replay's order", () => {
  const ok = { hasPipeline: true, bindGroupsValid: true, needsVertexBuffer: true, vertexBufferValid: true, indexed: true, indexBufferValid: true };
  assert.equal(skippedDrawCause(ok), null);
  assert.equal(skippedDrawCause({ ...ok, hasPipeline: false, bindGroupsValid: false }), "pipelinePending");
  assert.equal(skippedDrawCause({ ...ok, bindGroupsValid: false, vertexBufferValid: false }), "bindGroup");
  assert.equal(skippedDrawCause({ ...ok, vertexBufferValid: false }), "vertexBuffer");
  assert.equal(skippedDrawCause({ ...ok, needsVertexBuffer: false, vertexBufferValid: false }), null, "a pipeline without vertex buffers needs none");
  assert.equal(skippedDrawCause({ ...ok, indexBufferValid: false }), "indexBuffer");
  assert.equal(skippedDrawCause({ ...ok, indexed: false, indexBufferValid: false }), null, "a non-indexed draw needs no index buffer");
});

test("counters: skips by cause, notes, and counters owned elsewhere side by side", () => {
  const integrity = createWgpuIntegrity();
  integrity.skip("pipelinePending");
  integrity.skip("bindGroup");
  integrity.skip("bindGroup");
  integrity.skip(null);
  integrity.note("uncapturedErrors");
  integrity.note("deviceLosses");
  integrity.note("replayFatal");
  integrity.note("unknown-name");
  const s = integrity.snapshot({ droppedRecords: 3 });
  assert.deepEqual(s, {
    skipPipelinePending: 1, skipBindGroup: 2, skipVertexBuffer: 0, skipIndexBuffer: 0,
    uncapturedErrors: 1, deviceLosses: 1, replayFatal: 1, droppedRecords: 3
  });
  assert.ok(!INTEGRITY_FATAL.includes("skipPipelinePending"), "a pending pipeline is judged by its rate, not fatal");
  for (const name of ["skipBindGroup", "skipVertexBuffer", "skipIndexBuffer", "droppedRecords", "batchAborts", "batchOversize", "uploadTimeouts", "uncapturedErrors", "deviceLosses", "replayFatal", "stagingUnsafe", "geometryCacheCollisions", "geometryCacheFailed"])
    assert.ok(INTEGRITY_FATAL.includes(name), name);
});

test("the core's own counters come from its state stats line", () => {
  const line = "wgstate:1 pipe:12 bg:3,4,5 vb:6 ib:7 wgdrop:2 wgbabort:1 wgboversize:0 wguploadto:4";
  assert.deepEqual(coreIntegrityOf(parseWgpuProducerStateStats(line)),
    { droppedRecords: 2, batchAborts: 1, batchOversize: 0, uploadTimeouts: 4 });
  assert.deepEqual(coreIntegrityOf(parseWgpuProducerStateStats("wgstate:1 pipe:12 bg:3,4,5 vb:6 ib:7 wgdrop:0")),
    { droppedRecords: 0, batchAborts: 0, batchOversize: 0, uploadTimeouts: 0 }, "an older line: its parser reads 0");
  assert.deepEqual(coreIntegrityOf(null), { droppedRecords: null, batchAborts: null, batchOversize: null, uploadTimeouts: null });
});

test("the worker counts at every skip site and answers validationReadIntegrity", () => {
  assert.equal([...worker.matchAll(/webGpuExecStats\.skipDraw = \(webGpuExecStats\.skipDraw \|\| 0\) \+ 1;\n\s+wgpuIntegrity\.skip\(skippedDrawCause\(/g)].length, 2);
  assert.equal([...worker.matchAll(/webGpuExecStats\.skipDraw = /g)].length, 2, "no skip site left uncounted");
  assert.match(worker, /indexed: true, indexBufferValid/);
  assert.match(worker, /"uncapturederror", \(event\) => \{\n\s+wgpuIntegrity\.note\("uncapturedErrors"\);/);
  assert.match(worker, /if \(!loss\.handled\) return;\n\s+wgpuIntegrity\.note\("deviceLosses"\);/);
  assert.match(worker, /wgpuReplayFatal = \{ scope: String\(scope\), detail: String\(detail \|\| "unknown"\) \};\n\s+wgpuIntegrity\.note\("replayFatal"\);/);
  assert.match(worker, /case "validationReadIntegrity":\n\s+return readWgpuIntegrity\(\);/);
  // always on: neither metrics=1 nor the harness hooks gate it
  const read = worker.slice(worker.indexOf("function readWgpuIntegrity()"), worker.indexOf("function harnessGeometryCacheStats()"));
  assert.ok(read.length > 0 && !/harnessEnabled|causalMetricsEnabled/.test(read));
  assert.match(read, /\.\.\.coreIntegrityOf\(parseWgpuProducerStateStats\(api\?\.getWebGpuStateCacheStats\?\.\(\) \?\? ""\)\)/);
  for (const field of ["stagingUnsafe", "stagingCapacityWaits", "presentRejected", "geometryCacheCollisions", "geometryCacheFailed", "presents"])
    assert.match(read, new RegExp(`${field}[,:]`), field);
});
