import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { coreIntegrityOf, createWgpuIntegrity, INTEGRITY_FATAL, MISSING_KEYS, SKIP, skippedDrawCause } from "../src/wgpu-integrity.js";

const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");

test("a skipped draw is counted by its first missing resource, in the replay's order", () => {
  // (hasPass, hasPipeline, bindGroupsValid, needsVertexBuffer, vertexBufferValid, indexed, indexBufferValid)
  assert.equal(skippedDrawCause(true, true, true, true, true, true, true), -1);
  assert.equal(skippedDrawCause(false, false, false, true, false, true, false), SKIP.NO_PASS);
  assert.equal(skippedDrawCause(true, false, false, true, true, true, true), SKIP.PIPELINE);
  assert.equal(skippedDrawCause(true, true, false, true, false, true, true), SKIP.BIND_GROUP);
  assert.equal(skippedDrawCause(true, true, true, true, false, true, true), SKIP.VERTEX_BUFFER);
  assert.equal(skippedDrawCause(true, true, true, false, false, true, true), -1, "a pipeline without vertex buffers needs none");
  assert.equal(skippedDrawCause(true, true, true, true, true, true, false), SKIP.INDEX_BUFFER);
  assert.equal(skippedDrawCause(true, true, true, true, true, false, false), -1, "a non-indexed draw needs no index buffer");
});

test("counters: skips by cause, missing resources by kind, notes, and counters owned elsewhere", () => {
  const integrity = createWgpuIntegrity();
  integrity.skip(SKIP.PIPELINE);
  integrity.skip(SKIP.NO_PASS);
  integrity.skip(SKIP.NO_PASS);
  integrity.skip(-1);
  integrity.missing("color-texture");
  integrity.missing("sampler");
  integrity.missing("texture");
  integrity.missing("a-kind-nobody-knows");
  integrity.note("uncapturedErrors");
  integrity.note("deviceLosses");
  integrity.note("replayFatal");
  integrity.note("unknown-name");
  const s = integrity.snapshot({ droppedRecords: 3 });
  assert.equal(s.skipPipelineFailed, 1);
  assert.equal(s.skipNoPass, 2);
  assert.equal(s.skipBindGroup + s.skipVertexBuffer + s.skipIndexBuffer, 0);
  assert.equal(s.missingColorTarget, 1);
  assert.equal(s.missingBindGroupResource, 2);
  assert.equal(s.missingOther, 1);
  assert.equal(s.uncapturedErrors + s.deviceLosses + s.replayFatal, 3);
  assert.equal(s.droppedRecords, 3);
  assert.ok(!("unknown-name" in s));
  // every counter the module owns is fatal
  for (const k of Object.keys(s)) assert.ok(INTEGRITY_FATAL.includes(k), k);
  for (const name of ["skipPipelineFailed", "skipNoPass", "missingColorTarget", "droppedRecords", "batchAborts", "batchOversize", "uploadTimeouts", "stagingUnsafe", "geometryCacheCollisions", "geometryCacheFailed"])
    assert.ok(INTEGRITY_FATAL.includes(name), name);
});

test("the core's own counters come from its state stats line, null for what an older core does not print", () => {
  const pick = (o) => ({ droppedRecords: o.droppedRecords, batchAborts: o.batchAborts, batchOversize: o.batchOversize, uploadTimeouts: o.uploadTimeouts });
  assert.deepEqual(pick(coreIntegrityOf("wgstate:1 pipe:12 bg:3,4,5 vb:6 ib:7 wgdrop:2 wgbabort:1 wgboversize:0 wguploadto:4")),
    { droppedRecords: 2, batchAborts: 1, batchOversize: 0, uploadTimeouts: 4 });
  assert.deepEqual(pick(coreIntegrityOf("wgstate:1 pipe:12 bg:3,4,5 vb:6 ib:7 wgdrop:0")),
    { droppedRecords: 0, batchAborts: null, batchOversize: null, uploadTimeouts: null });
  assert.deepEqual(pick(coreIntegrityOf(undefined)), { droppedRecords: null, batchAborts: null, batchOversize: null, uploadTimeouts: null });
  // 0207: causes, renderer sites, draws skipped, failed uploads; null before 0207
  const old = coreIntegrityOf("wgdrop:0 wgbabort:2 wgboversize:0 wguploadto:0");
  for (const k of ["abortExplicit", "gfxAbortPrepare", "drawSkippedNoPipeline", "uploadAllocFailed", "uploadFailedUbo", "uploadTextureFailed"]) assert.equal(old[k], null, k);
  const now = coreIntegrityOf("wgdrop:0 wgbabort:3 wgboversize:0 wguploadto:0 wgabortc:1,0,2,0,0 wggfxabort:0,0,0,0,0,0,0,2,0,0,0 wgdrawskip:5 wgupfail:0,0,1,0,0,0,0,0,0 wgubo:1");
  assert.equal(now.abortRequiredPublication, 1);
  assert.equal(now.abortExplicit, 2);
  assert.equal(now.abortOversize, 0);
  assert.equal(now.gfxAbortPrepare, 2);
  assert.equal(now.gfxAbortScissor, 0);
  assert.equal(now.drawSkippedNoPipeline, 5);
  assert.equal(now.uploadAllocFailed, 0);
  assert.equal(now.uploadFailedUbo, 1);
  assert.equal(now.uploadFailedGeometry, 0);
  assert.equal(now.uploadTextureFailed, 0);
  for (const k of Object.keys(now)) if (k.startsWith("abort") || k.startsWith("gfxAbort") || k.startsWith("uploadFailed") || k === "drawSkippedNoPipeline" || k === "uploadAllocFailed" || k === "uploadTextureFailed")
    assert.ok(!INTEGRITY_FATAL.includes(k), `${k}: detail, not fatal (batchAborts is)`);
});

test("the worker counts every branch that abandons a draw or misses a resource", () => {
  // a draw skipped with a pass open: both sites, each counted
  assert.equal([...worker.matchAll(/webGpuExecStats\.skipDraw = /g)].length, 2);
  assert.equal([...worker.matchAll(/webGpuExecStats\.skipDraw = \(webGpuExecStats\.skipDraw \|\| 0\) \+ 1;\n\s+wgpuIntegrity\.skip\(skippedDrawCause\(true, /g)].length, 2);
  // a draw with no pass open (BEGIN_PASS without its color target): counted
  for (const op of ["draw", "draw-indexed"])
    assert.match(worker, new RegExp(`wgpuIntegrity\\.skip\\(SKIP\\.NO_PASS\\);\\n\\s+wgpuReplayClassifier\\?\\.recordStateOutsidePass\\(\\{ op: "${op}",`), op);
  assert.equal([...worker.matchAll(/recordStateOutsidePass\(\{ op: "draw/g)].length, 2, "no other draw branch outside a pass");
  // every missing resource goes through the counter, one known kind per site
  assert.equal([...worker.matchAll(/recordMissingResource\(/g)].length, 1, "only noteMissingResource tells the classifier");
  const kinds = [...worker.matchAll(/noteMissingResource\("([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 16);
  for (const k of kinds) assert.ok(k in MISSING_KEYS, k);
  assert.match(worker, /"uncapturederror", \(event\) => \{\n\s+wgpuIntegrity\.note\("uncapturedErrors"\);/);
  assert.match(worker, /if \(!loss\.handled\) return;\n\s+wgpuIntegrity\.note\("deviceLosses"\);/);
  assert.match(worker, /wgpuReplayFatal = \{ scope: String\(scope\), detail: String\(detail \|\| "unknown"\) \};\n\s+wgpuIntegrity\.note\("replayFatal"\);/);
  assert.match(worker, /case "validationReadIntegrity":\n\s+return readWgpuIntegrity\(\);/);
  // always on: neither metrics=1 nor the harness hooks gate it
  const read = worker.slice(worker.indexOf("function readWgpuIntegrity()"), worker.indexOf("function harnessGeometryCacheStats()"));
  assert.ok(read.length > 0 && !/harnessEnabled|causalMetricsEnabled/.test(read));
  assert.match(read, /\.\.\.coreIntegrityOf\(api\?\.getWebGpuStateCacheStats\?\.\(\)\)/);
  for (const field of ["stagingUnsafe", "stagingCapacityWaits", "presentRejected", "geometryCacheCollisions", "geometryCacheFailed", "presents"])
    assert.match(read, new RegExp(`${field}[,:]`), field);
});
