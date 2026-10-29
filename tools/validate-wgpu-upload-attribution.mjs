// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requestedWgpuReplayBudgetMs } from "../src/wgpu-replay-diagnostics.js";

const ATTRIBUTION_SCHEMAS = Object.freeze({
  "wasm-dolphin.wgpu-upload-attribution.v1": Object.freeze([
    "unknown", "ubo", "utility-uniform", "vertex", "index", "texture-adjacent",
  ]),
  "wasm-dolphin.wgpu-upload-attribution.v2": Object.freeze([
    "unknown", "ubo", "utility-uniform", "vertex", "index", "texture-adjacent", "geometry",
  ]),
});
const REPLAY_SCHEMA = "wasm-dolphin.wgpu-replay-op-metrics.v1";
const BUCKET_LABELS = Object.freeze([
  "<=64", "<=256", "<=1024", "<=4096", "<=16384", "<=65536", ">65536",
]);
const OP_UPLOAD_BUFFER = 6;
const OP_UPLOAD_TEXTURE = 8;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ROOT_ARTIFACTS = Object.freeze([
  "report.json", "tasklist.json", "comparison.json", "comparison.csv", "runs.csv",
]);
const RUN_ARTIFACTS = Object.freeze([
  "manifest.json", "summary.json", "samples.json", "samples.csv", "events.jsonl",
  "console.log", "final.png",
]);

export async function validateWgpuUploadAttribution({ outDir }) {
  const root = path.resolve(outDir);
  const issues = [];
  const addIssue = (code, message, runId = null) => {
    issues.push({ code, message, ...(runId ? { runId } : {}) });
  };

  const rootArtifacts = await describeArtifacts(root, ROOT_ARTIFACTS, addIssue);
  const report = await readJsonIfPresent(path.join(root, "report.json"), addIssue, "REPORT_JSON");
  const tasklist = await readJsonIfPresent(path.join(root, "tasklist.json"), addIssue, "TASKLIST_JSON");
  const comparison = await readJsonIfPresent(
    path.join(root, "comparison.json"), addIssue, "COMPARISON_JSON"
  );
  if (!report || !tasklist || !comparison) {
    return result(root, issues, rootArtifacts, [], report, tasklist, comparison);
  }

  check(report.headed === true, "RUN_NOT_HEADED", "Evidence must use headed Chrome", addIssue);
  check(report.qualificationEligible === true, "PROVENANCE_INELIGIBLE",
    "Report is not eligible for clean provenance qualification", addIssue);

  const reportRuns = new Map();
  for (const entry of report.results || []) {
    const runId = entry.runId || entry.name;
    if (!runId) {
      addIssue("RUN_ID_MISSING", "Report result has no runId or name");
      continue;
    }
    reportRuns.set(runId, entry);
  }
  const taskRuns = (tasklist.blocks || []).flatMap((block) => block.runs || []);
  const expectedIds = taskRuns.length
    ? taskRuns.map((entry) => entry.runId)
    : [...reportRuns.keys()];
  const runs = [];
  for (const runId of expectedIds) {
    if (!reportRuns.has(runId)) {
      addIssue("RUN_MISSING", `Report is missing ${runId}`, runId);
      continue;
    }
    runs.push(await validateRun(root, runId, addIssue));
  }
  for (const runId of reportRuns.keys()) {
    if (!expectedIds.includes(runId)) addIssue("RUN_UNEXPECTED", `Unexpected run ${runId}`, runId);
  }

  return result(root, issues, rootArtifacts, runs, report, tasklist, comparison);
}

async function validateRun(root, runId, addIssue) {
  const runDir = path.join(root, runId);
  const artifacts = await describeArtifacts(runDir, RUN_ARTIFACTS, addIssue, runId);
  const provenance = await describeDirectory(path.join(runDir, "build-provenance"));
  check(provenance.exists && provenance.fileCount > 0, "ARTIFACT_MISSING",
    "build-provenance is missing or empty", addIssue, runId);

  const [manifest, summary, samples] = await Promise.all([
    readJsonIfPresent(path.join(runDir, "manifest.json"), addIssue, "MANIFEST_JSON", runId),
    readJsonIfPresent(path.join(runDir, "summary.json"), addIssue, "SUMMARY_JSON", runId),
    readJsonIfPresent(path.join(runDir, "samples.json"), addIssue, "SAMPLES_JSON", runId),
  ]);
  if (!manifest || !summary || !Array.isArray(samples)) {
    return { runId, artifacts, provenance, equations: null };
  }

  validateFixtureAndBoundary(manifest, samples, addIssue, runId);
  validateBackend(manifest, summary, addIssue, runId);
  validateRgb(manifest, addIssue, runId);

  const snapshots = samples.map((sample) => sample?.causalTelemetry?.webgpu ?? null);
  const finalWebgpu = summary.final?.causalTelemetry?.webgpu ?? snapshots.at(-1);
  check(finalWebgpu != null, "ATTR_MISSING", "Final WebGPU telemetry is missing", addIssue, runId);
  const equations = finalWebgpu
    ? validateAttributionSnapshot(finalWebgpu, addIssue, runId, "final")
    : null;

  let previous = null;
  for (let index = 0; index < snapshots.length; index += 1) {
    const current = snapshots[index];
    check(current != null, "ATTR_SAMPLE_MISSING", `Sample ${index} lacks WebGPU telemetry`, addIssue, runId);
    if (!current) continue;
    validateAttributionSnapshot(current, addIssue, runId, `sample ${index}`);
    validateMonotonic(previous, current, addIssue, runId, index);
    previous = current;
  }

  const png = artifacts.find((entry) => entry.name === "final.png");
  check(png?.validPng === true, "SCREENSHOT_INVALID", "final.png is not a valid PNG", addIssue, runId);
  return { runId, artifacts, provenance, equations };
}

function validateAttributionSnapshot(webgpu, addIssue, runId, label) {
  const attr = webgpu.uploadAttribution || {};
  const replay = webgpu.replayOps || {};
  const roleOrder = ATTRIBUTION_SCHEMAS[attr.schema] || null;
  check(roleOrder !== null, "ATTR_SCHEMA",
    `${label}: attribution schema is ${attr.schema}`, addIssue, runId);
  check(attr.enabled === true, "ATTR_DISABLED", `${label}: attribution is disabled`, addIssue, runId);
  check(roleOrder !== null && equalArray(attr.roleOrder, roleOrder), "ATTR_ROLE_ORDER",
    `${label}: role order is ${JSON.stringify(attr.roleOrder)}`, addIssue, runId);
  check(equalArray(attr.sizeBucketLabels, BUCKET_LABELS), "ATTR_BUCKET_ORDER",
    `${label}: bucket order is ${JSON.stringify(attr.sizeBucketLabels)}`, addIssue, runId);
  check(replay.schema === REPLAY_SCHEMA && replay.enabled === true, "REPLAY_SCHEMA",
    `${label}: replay metrics schema/enabled mismatch`, addIssue, runId);
  check(replay.names?.[OP_UPLOAD_BUFFER] === "UPLOAD_BUFFER" &&
      replay.names?.[OP_UPLOAD_TEXTURE] === "UPLOAD_TEXTURE", "REPLAY_OPCODE_ORDER",
    `${label}: replay opcode names are not locked at 6/8`, addIssue, runId);

  const roleCount = roleOrder?.length ?? 0;
  const calls = numericVector(attr.callsByRole, roleCount, `${label} callsByRole`, addIssue, runId);
  const bytes = numericVector(attr.bytesByRole, roleCount, `${label} bytesByRole`, addIssue, runId);
  const maxima = numericVector(
    attr.maxBytesByRole, roleCount, `${label} maxBytesByRole`, addIssue, runId
  );
  const bucketCalls = numericMatrix(
    attr.bucketCallsByRole, roleCount, BUCKET_LABELS.length,
    `${label} bucketCallsByRole`, addIssue, runId
  );
  const bucketBytes = numericMatrix(
    attr.bucketBytesByRole, roleCount, BUCKET_LABELS.length,
    `${label} bucketBytesByRole`, addIssue, runId
  );
  const totalCalls = safeCounter(attr.totalCalls);
  const totalBytes = safeCounter(attr.totalBytes);
  const roleCalls = sum(calls);
  const roleBytes = sum(bytes);
  check(totalCalls !== null && totalCalls === roleCalls, "ATTR_ROLE_SUM",
    `${label}: totalCalls=${attr.totalCalls}, sum(callsByRole)=${roleCalls}`, addIssue, runId);
  check(totalBytes !== null && totalBytes === roleBytes, "ATTR_ROLE_SUM",
    `${label}: totalBytes=${attr.totalBytes}, sum(bytesByRole)=${roleBytes}`, addIssue, runId);
  for (let role = 0; role < roleCount; role += 1) {
    check(sum(bucketCalls[role]) === calls[role], "ATTR_BUCKET_SUM",
      `${label}: ${roleOrder[role]} bucket calls=${sum(bucketCalls[role])}, role calls=${calls[role]}`,
      addIssue, runId);
    check(sum(bucketBytes[role]) === bytes[role], "ATTR_BUCKET_SUM",
      `${label}: ${roleOrder[role]} bucket bytes=${sum(bucketBytes[role])}, role bytes=${bytes[role]}`,
      addIssue, runId);
    check(maxima[role] <= bytes[role] && (calls[role] !== 0 || maxima[role] === 0),
      "ATTR_MAX_INVALID", `${label}: invalid maximum for ${roleOrder[role]}`, addIssue, runId);
  }

  const queueCalls = replay.queueUploadCalls || [];
  const queueBytes = replay.queueUploadBytes || [];
  const histogram = replay.histogram || [];
  const copyCalls = replay.uploadCopyCalls || [];
  const copyBytes = replay.uploadCopyBytes || [];
  const op6Calls = safeCounter(queueCalls[OP_UPLOAD_BUFFER]);
  const op8Calls = safeCounter(queueCalls[OP_UPLOAD_TEXTURE]);
  const op6Bytes = safeCounter(queueBytes[OP_UPLOAD_BUFFER]);
  const op8Bytes = safeCounter(queueBytes[OP_UPLOAD_TEXTURE]);
  const bufferRoleCalls = calls.reduce((total, value, index) =>
    total + (index === 5 ? 0 : value), 0);
  const bufferRoleBytes = bytes.reduce((total, value, index) =>
    total + (index === 5 ? 0 : value), 0);
  check(op6Calls !== null && bufferRoleCalls === op6Calls, "ATTR_OP6_RECONCILE",
    `${label}: non-texture roles calls=${bufferRoleCalls}, opcode6 calls=${op6Calls}`, addIssue, runId);
  check(op6Bytes !== null && bufferRoleBytes === op6Bytes, "ATTR_OP6_RECONCILE",
    `${label}: non-texture roles bytes=${bufferRoleBytes}, opcode6 bytes=${op6Bytes}`, addIssue, runId);
  check(op8Calls !== null && calls[5] === op8Calls, "ATTR_OP8_RECONCILE",
    `${label}: texture-adjacent calls=${calls[5]}, opcode8 calls=${op8Calls}`, addIssue, runId);
  check(op8Bytes !== null && bytes[5] === op8Bytes, "ATTR_OP8_RECONCILE",
    `${label}: texture-adjacent bytes=${bytes[5]}, opcode8 bytes=${op8Bytes}`, addIssue, runId);
  check(totalCalls !== null && op6Calls !== null && op8Calls !== null &&
      totalCalls === op6Calls + op8Calls, "ATTR_OPCODE_TOTAL",
    `${label}: total calls=${totalCalls}, opcode6+8=${Number(op6Calls) + Number(op8Calls)}`,
    addIssue, runId);
  check(totalBytes !== null && op6Bytes !== null && op8Bytes !== null &&
      totalBytes === op6Bytes + op8Bytes, "ATTR_OPCODE_TOTAL",
    `${label}: total bytes=${totalBytes}, opcode6+8=${Number(op6Bytes) + Number(op8Bytes)}`,
    addIssue, runId);
  check(calls[0] === 0 && bytes[0] === 0, "ATTR_UNKNOWN_ROLE",
    `${label}: unknown role has ${calls[0]} calls/${bytes[0]} bytes`, addIssue, runId);
  // Held-suffix staging copies payloads before their command records become
  // replayable, so copy counters can temporarily lead replay/queue counters
  // in intermediate samples. Equality is a terminal drain invariant; samples
  // are still checked for monotonicity and role/opcode conservation.
  for (const op of label === "final" ? [OP_UPLOAD_BUFFER, OP_UPLOAD_TEXTURE] : []) {
    const replayed = safeCounter(histogram[op]);
    const copiedCalls = safeCounter(copyCalls[op]);
    const queuedCalls = safeCounter(queueCalls[op]);
    const copiedBytes = safeCounter(copyBytes[op]);
    const queuedBytes = safeCounter(queueBytes[op]);
    check(replayed !== null && copiedCalls !== null && queuedCalls !== null &&
        replayed === copiedCalls && copiedCalls === queuedCalls,
      "REPLAY_UPLOAD_CALL_MISMATCH",
      `${label}: opcode${op} replay/copy/queue calls=${replayed}/${copiedCalls}/${queuedCalls}`,
      addIssue, runId);
    check(copiedBytes !== null && queuedBytes !== null && copiedBytes === queuedBytes,
      "REPLAY_UPLOAD_BYTE_MISMATCH",
      `${label}: opcode${op} copy/queue bytes=${copiedBytes}/${queuedBytes}`,
      addIssue, runId);
  }

  return {
    roleCalls: { total: totalCalls, operands: calls, sum: roleCalls },
    roleBytes: { total: totalBytes, operands: bytes, sum: roleBytes },
    opcodeCalls: { total: totalCalls, opcode6: op6Calls, opcode8: op8Calls,
      sum: Number(op6Calls) + Number(op8Calls) },
    opcodeBytes: { total: totalBytes, opcode6: op6Bytes, opcode8: op8Bytes,
      sum: Number(op6Bytes) + Number(op8Bytes) },
    bucketCallSums: bucketCalls.map(sum),
    bucketByteSums: bucketBytes.map(sum),
  };
}

function validateMonotonic(previous, current, addIssue, runId, index) {
  if (!previous) return;
  const paths = [
    ["uploadAttribution", "totalCalls"], ["uploadAttribution", "totalBytes"],
    ["uploadAttribution", "maxBytes"], ["uploadAttribution", "callsByRole"],
    ["uploadAttribution", "bytesByRole"], ["uploadAttribution", "maxBytesByRole"],
    ["uploadAttribution", "bucketCallsByRole"],
    ["uploadAttribution", "bucketBytesByRole"],
    ["uploadAttribution", "passAssociation", "completedPassCount"],
    ["uploadAttribution", "passAssociation", "abortedPassCount"],
    ["uploadAttribution", "passAssociation", "incompletePassCount"],
    ["replayOps", "histogram"], ["replayOps", "uploadCopyCalls"],
    ["replayOps", "uploadCopyBytes"], ["replayOps", "queueUploadCalls"],
    ["replayOps", "queueUploadBytes"], ["uploadTimeoutCount"],
    ["uploadTimeoutCountAfterVerifiedLoad"],
  ];
  for (const keys of paths) {
    const before = get(previous, keys);
    const after = get(current, keys);
    check(valuesAtLeast(after, before), "ATTR_COUNTER_REGRESSION",
      `sample ${index}: ${keys.join(".")} regressed`, addIssue, runId);
  }
}

function validateFixtureAndBoundary(manifest, samples, addIssue, runId) {
  const fixture = manifest.fixture || {};
  const benchmark = manifest.benchmark || {};
  check(fixture.isoVerified === true && fixture.saveStateVerified === true &&
      fixture.saveStateLoaded === true && fixture.battleCheckpoint?.verified === true,
    "FIXTURE_UNVERIFIED", "Fixed Kirby-vs-Link fixture is not verified", addIssue, runId);
  check(Number(benchmark.saveStateAt) === 0 && benchmark.inputScriptMode === "none" &&
      benchmark.timingStartsAfterVerifiedLoad === true, "TIMING_BOUNDARY",
    "Run did not directly load the fixed save before timing with input disabled", addIssue, runId);
  const boundary = fixture.loadResult?.response?.wgpuUploadTimeoutBoundary || {};
  const before = safeCounter(boundary.beforeLoad);
  const immediate = safeCounter(boundary.immediatelyAfterLoad);
  const delta = safeCounter(boundary.afterLoadDelta);
  check(fixture.loadResult?.loaded === true && boundary.enabled === true && boundary.verified === true,
    "TIMEOUT_BOUNDARY_UNVERIFIED", "Save-load timeout boundary is not verified", addIssue, runId);
  check(before !== null && immediate !== null && delta !== null && immediate >= before &&
      delta === immediate - before, "TIMEOUT_BOUNDARY_MISMATCH",
    `Boundary before=${before}, immediate=${immediate}, delta=${delta}`, addIssue, runId);

  let previousTotal = -1;
  let previousAfter = -1;
  let verifiedSampleIndex = -1;
  for (let index = 0; index < samples.length; index += 1) {
    const webgpu = samples[index]?.causalTelemetry?.webgpu || {};
    const total = safeCounter(webgpu.uploadTimeoutCount);
    const atLoad = safeCounter(webgpu.uploadTimeoutCountAtVerifiedLoad);
    const beforeVerified = safeCounter(webgpu.uploadTimeoutCountBeforeVerifiedLoad);
    const after = safeCounter(webgpu.uploadTimeoutCountAfterVerifiedLoad);
    if (webgpu.uploadTimeoutBoundaryVerified === true) {
      if (verifiedSampleIndex < 0) verifiedSampleIndex = index;
      check(total !== null && atLoad === before && beforeVerified === before && after !== null &&
          total >= atLoad && after === total - atLoad, "TIMEOUT_BOUNDARY_MISMATCH",
        `Sample ${index}: total=${total}, at=${atLoad}, before=${beforeVerified}, after=${after}`,
        addIssue, runId);
    } else {
      // The first timed read can observe the page's retained pre-load payload;
      // once a verified payload appears, reverting to an unverified boundary
      // would make the post-load timeout attribution ambiguous.
      check(verifiedSampleIndex < 0, "TIMEOUT_BOUNDARY_UNVERIFIED",
        `Sample ${index} lost the previously verified timeout boundary`, addIssue, runId);
    }
    check(total !== null && total >= previousTotal && after !== null && after >= previousAfter,
      "TIMEOUT_COUNTER_REGRESSION", `Sample ${index} timeout counters regressed`, addIssue, runId);
    previousTotal = total ?? previousTotal;
    previousAfter = after ?? previousAfter;
  }
  check(verifiedSampleIndex >= 0, "TIMEOUT_BOUNDARY_UNVERIFIED",
    "No timed sample retained the verified save-load timeout boundary", addIssue, runId);
}

function validateBackend(manifest, summary, addIssue, runId) {
  const renderer = manifest.renderer || {};
  for (const field of ["requestedVideoBackend", "configuredVideoBackend", "activeVideoBackend",
    "expectedVideoBackend"]) {
    check(renderer[field] === "WebGPU-Real", "BACKEND_IDENTITY",
      `${field}=${renderer[field]} expected WebGPU-Real`, addIssue, runId);
  }
  for (const field of ["requestedPresenterBackend", "activePresenterBackend",
    "expectedRequestedPresenterBackend", "expectedActivePresenterBackend"]) {
    check(renderer[field] === "webgpu", "BACKEND_IDENTITY",
      `${field}=${renderer[field]} expected webgpu`, addIssue, runId);
  }
  check(renderer.fallback == null && renderer.coreSelection?.fallbackReason == null,
    "BACKEND_FALLBACK", "Renderer/core fallback is active", addIssue, runId);
  const webgpu = summary.final?.causalTelemetry?.webgpu || {};
  const params = new URL(manifest.benchmark?.url || "http://invalid/").searchParams;
  const replayBudgetParam = params.get("wgpureplayms");
  // The product's own reading: 4 ms without the parameter since 2026-10-29
  const expectedReplayBudgetMs = requestedWgpuReplayBudgetMs(params.toString());
  check(webgpu.registered === true && summary.final?.causalTelemetry?.presentation?.backend === "webgpu",
    "BACKEND_TELEMETRY", "Final telemetry does not identify registered real WebGPU", addIssue, runId);
  for (const field of ["uploadTimeoutCountBeforeVerifiedLoad", "uploadTimeoutCountAfterVerifiedLoad",
    "batchAbortCount", "batchOversizeCount", "commandDroppedCount", "errorCount",
    "heldUploadStageLimitCount"]) {
    check(safeCounter(webgpu[field]) === 0, "QUALIFYING_WEBGPU_COUNTER",
      `${field}=${webgpu[field]} expected 0`, addIssue, runId);
  }
  if (webgpu.producerUploadArenaAvailable === true) {
    for (const field of ["producerUploadArenaFallbackCount",
      "producerUploadArenaLateRejectCount", "uploadArenaRingHandoffMismatchCount"]) {
      check(safeCounter(webgpu[field]) === 0, "QUALIFYING_WEBGPU_COUNTER",
        `${field}=${webgpu[field]} expected 0`, addIssue, runId);
    }
    const expectedArenaBytes = params.get("wgpuuploadmb") === "64"
      ? 64 * 1024 * 1024
      : 32 * 1024 * 1024;
    check(webgpu.producerUploadArenaRequestedBytes === expectedArenaBytes &&
        webgpu.producerUploadArenaConfiguredBytes === expectedArenaBytes &&
        webgpu.uploadArenaRingHandoffBytes === expectedArenaBytes &&
        webgpu.uploadArenaRingHandoffExpectedBytes === expectedArenaBytes &&
        webgpu.uploadArenaRingHandoffMismatch === false,
      "UPLOAD_ARENA_IDENTITY",
      `arena expected=${expectedArenaBytes} requested=${webgpu.producerUploadArenaRequestedBytes} ` +
        `configured=${webgpu.producerUploadArenaConfiguredBytes} ` +
        `handoff=${webgpu.uploadArenaRingHandoffBytes}`,
      addIssue, runId);
  }
  // ?wgpureplayms=0: the unbudgeted replay asked for explicitly; without the
  // parameter (the product's default) the 4 ms budget and its hard cap
  if (expectedReplayBudgetMs === 0) {
    check(webgpu.replayBudgetEnabled !== true, "REPLAY_BUDGET_IDENTITY",
      `wgpureplayms=0 but enabled=${webgpu.replayBudgetEnabled}`, addIssue, runId);
  } else {
    check(webgpu.replayBudgetEnabled === true &&
        safeCounter(webgpu.replayBudgetMs) === expectedReplayBudgetMs,
      "REPLAY_BUDGET_IDENTITY",
      `wgpureplayms=${replayBudgetParam ?? "(default)"} expected=${expectedReplayBudgetMs} enabled=${webgpu.replayBudgetEnabled} ` +
        `telemetryMs=${webgpu.replayBudgetMs}`,
      addIssue, runId);
    check(safeCounter(webgpu.replayBudgetStopReasons?.["record-window"]) === 0,
      "REPLAY_BUDGET_HARD_CAP",
      `record-window stops=${webgpu.replayBudgetStopReasons?.["record-window"]}`,
      addIssue, runId);
  }
  check(Array.isArray(renderer.errors) && renderer.errors.length === 0,
    "RENDERER_ERROR", `Renderer errors: ${JSON.stringify(renderer.errors)}`, addIssue, runId);
  check(Array.isArray(renderer.emscriptenPrintErr) && renderer.emscriptenPrintErr.length === 0,
    "REPLAY_ERROR", `Emscripten printErr: ${JSON.stringify(renderer.emscriptenPrintErr)}`,
    addIssue, runId);
  check(Array.isArray(renderer.fatalStatusHistory) && renderer.fatalStatusHistory.length === 0,
    "REPLAY_ERROR", `Fatal status history: ${JSON.stringify(renderer.fatalStatusHistory)}`,
    addIssue, runId);
  check(safeCounter(renderer.workerTransport?.requestErrorRepliesSent) === 0 &&
      safeCounter(renderer.workerTransport?.oneWayErrorRepliesSent) === 0,
    "REPLAY_ERROR", "Worker transport recorded error replies", addIssue, runId);
  const stages = renderer.wgpuReplayClassifier?.stages || {};
  check(safeCounter(stages.missingResources?.total) === 0, "MISSING_RESOURCE",
    `Missing resources=${stages.missingResources?.total}`, addIssue, runId);
  check(safeCounter(stages.passAtomicity?.splitAtDrainCount) === 0 &&
      safeCounter(stages.passAtomicity?.recordsOutsidePass) === 0,
    "PASS_ATOMICITY", "Replay split a pass or replayed state outside a pass", addIssue, runId);
  check(safeCounter(stages.presentSubmission?.errorCount) === 0,
    "PRESENT_ERROR", `Present errors=${stages.presentSubmission?.errorCount}`, addIssue, runId);
}

function validateRgb(manifest, addIssue, runId) {
  const stages = manifest.renderer?.wgpuReplayClassifier?.stages || {};
  const first = stages.firstEfbPassReadback || {};
  check(first.status === "pass" && Number(first.nonzeroColorBytes) > 0 && Number(first.maxByte) > 0,
    "RGB_EFB_FIRST_PASS_ZERO", "First completed EFB pass did not mutate RGB", addIssue, runId);
  const chain = stages.presentationChain || {};
  for (const [kind, code] of [["xfb", "RGB_XFB_FINAL_ZERO"], ["backbuffer", "RGB_BACKBUFFER_FINAL_ZERO"]]) {
    const stage = chain[kind] || {};
    check(Number(stage.readbackCount) > 0 && Number(stage.lastSampledBytes) > 0 &&
        Number(stage.lastNonzeroColorBytes) > 0 && Number(stage.lastMaxByte) > 0 &&
        Number(stage.lastPresentSequence) > 0, code,
      `Final ${kind} readback has ${stage.lastNonzeroColorBytes || 0} nonzero RGB bytes`, addIssue, runId);
  }
  const xfb = chain.xfb || {};
  const backbuffer = chain.backbuffer || {};
  check(Number(xfb.framebufferId) > 0 && Number(backbuffer.sourceTextureId) === Number(xfb.framebufferId),
    "RGB_CHAIN_MISMATCH",
    `backbuffer source=${backbuffer.sourceTextureId}, XFB framebuffer=${xfb.framebufferId}`,
    addIssue, runId);
}

function result(root, issues, rootArtifacts, runs, report, tasklist, comparison) {
  return {
    schema: "wasm-dolphin.wgpu-upload-attribution-validation.v1",
    ok: issues.length === 0,
    outDir: root,
    runCount: runs.length,
    issues,
    rootArtifacts,
    runs,
    envelope: {
      headed: report?.headed ?? null,
      qualificationEligible: report?.qualificationEligible ?? null,
      tasklistStatus: tasklist?.status ?? null,
      comparisonOutcome: comparison?.outcome ?? null,
    },
  };
}

async function describeArtifacts(directory, names, addIssue, runId = null) {
  const descriptions = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    try {
      const bytes = await readFile(filePath);
      const metadata = await stat(filePath);
      const description = {
        name,
        path: filePath,
        bytes: metadata.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      if (name.endsWith(".png")) {
        description.validPng = bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
      }
      descriptions.push(description);
      check(metadata.size > 0, "ARTIFACT_EMPTY", `${name} is empty`, addIssue, runId);
    } catch (error) {
      descriptions.push({ name, path: filePath, bytes: 0, sha256: null, error: String(error.message || error) });
      addIssue("ARTIFACT_MISSING", `${name} is missing`, runId);
    }
  }
  return descriptions;
}

async function describeDirectory(directory) {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(directory, { recursive: true });
    return { path: directory, exists: true, fileCount: entries.length };
  } catch {
    return { path: directory, exists: false, fileCount: 0 };
  }
}

async function readJsonIfPresent(filePath, addIssue, code, runId = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    addIssue(code, `${path.basename(filePath)}: ${error.message || error}`, runId);
    return null;
  }
}

function numericVector(value, length, label, addIssue, runId) {
  const vector = Array.isArray(value) ? value.map((entry) => safeCounter(entry)) : [];
  const valid = vector.length === length && vector.every((entry) => entry !== null);
  check(valid, "ATTR_COUNTER_TYPE", `${label} must contain ${length} safe counters`, addIssue, runId);
  return Array.from({ length }, (_, index) => vector[index] ?? 0);
}

function numericMatrix(value, rows, columns, label, addIssue, runId) {
  const matrix = Array.isArray(value) ? value : [];
  check(matrix.length === rows, "ATTR_COUNTER_TYPE", `${label} must contain ${rows} rows`, addIssue, runId);
  return Array.from({ length: rows }, (_, index) =>
    numericVector(matrix[index], columns, `${label}[${index}]`, addIssue, runId));
}

function safeCounter(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function valuesAtLeast(current, previous) {
  if (Array.isArray(previous)) {
    return Array.isArray(current) && current.length === previous.length &&
      current.every((entry, index) => valuesAtLeast(entry, previous[index]));
  }
  const a = safeCounter(current);
  const b = safeCounter(previous);
  return a !== null && b !== null && a >= b;
}

function get(object, keys) {
  return keys.reduce((value, key) => value?.[key], object);
}

function equalArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function check(condition, code, message, addIssue, runId = null) {
  if (!condition) addIssue(code, message, runId);
}

async function main(argv) {
  const args = parseArgs(argv);
  const validation = await validateWgpuUploadAttribution(args);
  console.log(JSON.stringify(validation, null, 2));
  if (!validation.ok) process.exitCode = 1;
}

function parseArgs(argv) {
  const args = { outDir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.outDir = requiredArg(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.outDir) throw new Error("--out is required");
  return args;
}

function requiredArg(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

const invokedAsScript = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(`[wgpu-upload-attribution-validator] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
