// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "wasm-dolphin.wgpu-scheduling-screening-validation.v1";
const TARGET_CORE_SECONDS = 8;
const INPUT_MARKER_COUNT = 12;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ROOT_ARTIFACTS = Object.freeze([
  "report.json",
  "tasklist.json",
  "comparison.json",
  "comparison.csv",
  "runs.csv",
]);
const RUN_ARTIFACTS = Object.freeze([
  "manifest.json",
  "summary.json",
  "samples.json",
  "samples.csv",
  "input-events.json",
  "events.jsonl",
  "console.log",
  "final.png",
]);
const ZERO_WEBGPU_COUNTERS = Object.freeze([
  "errorCount",
  "commandDroppedCount",
  "batchAbortCount",
  "batchOversizeCount",
  "uploadTimeoutCount",
  "uploadTimeoutCountAfterVerifiedLoad",
  "heldUploadStageLimitCount",
]);
const ZERO_INPUT_ERROR_COUNTERS = Object.freeze([
  "supersededCount",
  "supersededArmedCount",
  "droppedInFlightCount",
  "generationMismatchCount",
  "generationUnavailableCount",
  "expiredCount",
  "expiredInFlightCount",
]);

export async function validateWgpuSchedulingScreening({
  outDir,
  requireHardwareVisual = false,
}) {
  const root = path.resolve(outDir);
  const issues = [];
  const addIssue = (code, message, runId = null) => {
    issues.push({ code, message, ...(runId ? { runId } : {}) });
  };

  const rootArtifacts = await describeRequiredArtifacts(root, ROOT_ARTIFACTS, addIssue);
  const [report, tasklist, comparison] = await Promise.all([
    readJson(path.join(root, "report.json"), addIssue, "REPORT_JSON"),
    readJson(path.join(root, "tasklist.json"), addIssue, "TASKLIST_JSON"),
    readJson(path.join(root, "comparison.json"), addIssue, "COMPARISON_JSON"),
  ]);
  if (!report || !tasklist || !comparison) {
    return makeResult({ root, requireHardwareVisual, rootArtifacts, runs: [], issues });
  }

  validateEnvelope({ report, tasklist, comparison, addIssue });
  const taskRuns = (tasklist.blocks || []).flatMap((block) => block.runs || []);
  const reportRuns = new Map();
  for (const run of report.results || []) {
    if (!run?.runId) {
      addIssue("RUN_ID_MISSING", "Report result has no runId");
      continue;
    }
    if (reportRuns.has(run.runId)) {
      addIssue("RUN_ID_DUPLICATE", `Report contains duplicate ${run.runId}`, run.runId);
    }
    reportRuns.set(run.runId, run);
  }

  const runs = [];
  for (const task of taskRuns) {
    const reportRun = reportRuns.get(task.runId);
    if (!reportRun) {
      addIssue("RUN_MISSING", `Report is missing ${task.runId}`, task.runId);
      continue;
    }
    runs.push(await validateRun({
      root,
      task,
      reportRun,
      report,
      requireHardwareVisual,
      addIssue,
    }));
  }
  const taskIds = new Set(taskRuns.map((run) => run.runId));
  for (const runId of reportRuns.keys()) {
    if (!taskIds.has(runId)) addIssue("RUN_UNEXPECTED", `Unexpected report run ${runId}`, runId);
  }

  return makeResult({ root, requireHardwareVisual, rootArtifacts, runs, issues });
}

function validateEnvelope({ report, tasklist, comparison, addIssue }) {
  check(report.headed === true,
    "RUN_NOT_HEADED", "Scheduling evidence must use headed Chrome", addIssue);
  check(report.audioMode === "audible",
    "AUDIO_NOT_AUDIBLE", `report audioMode=${report.audioMode ?? "missing"}`, addIssue);
  check(report.qualificationEligible === true,
    "PROVENANCE_INELIGIBLE", "Report is not qualification-eligible", addIssue);
  check(Array.isArray(report.failures) && report.failures.length === 0,
    "REPORT_FAILURES", `Report failures: ${JSON.stringify(report.failures || [])}`, addIssue);
  check(Number(report.targetCoreSeconds) === TARGET_CORE_SECONDS,
    "FIXED_WORK_TARGET", `targetCoreSeconds=${report.targetCoreSeconds} expected 8`, addIssue);
  check(Number.isFinite(Number(report.durationSeconds)) && Number(report.durationSeconds) > 0,
    "DURATION_INVALID", `durationSeconds=${report.durationSeconds}`, addIssue);
  check(Number.isFinite(Number(report.sampleMs)) && Number(report.sampleMs) > 0,
    "SAMPLE_INTERVAL_INVALID", `sampleMs=${report.sampleMs}`, addIssue);

  check(tasklist.mode === "screening",
    "TASKLIST_MODE", `tasklist mode=${tasklist.mode}`, addIssue);
  check(tasklist.initialValidBlocks === 2 && tasklist.maximumValidBlocks === 2 &&
      tasklist.maximumAttemptedBlocks === 3,
    "TASKLIST_BOUNDS",
    "Tasklist must require two valid blocks with the harness retry ceiling of three attempts",
    addIssue);
  check(Array.isArray(tasklist.blocks) && tasklist.blocks.length === 2,
    "TASKLIST_BLOCK_COUNT", `blocks=${tasklist.blocks?.length ?? 0} expected 2`, addIssue);
  const expectedOrders = ["ABBA", "BAAB"];
  for (let index = 0; index < (tasklist.blocks || []).length; index += 1) {
    const block = tasklist.blocks[index];
    check(block.order?.join("") === expectedOrders[index],
      "TASKLIST_ORDER", `block ${index + 1} order=${block.order?.join("")}`, addIssue);
    check(block.status === "complete",
      "TASKLIST_BLOCK_INCOMPLETE", `${block.blockId || index} status=${block.status}`, addIssue);
    check(!block.replaces,
      "TASKLIST_REPLACEMENT", `${block.blockId || index} replaces ${block.replaces}`, addIssue);
    check(Array.isArray(block.runs) && block.runs.length === 4,
      "TASKLIST_RUN_COUNT", `${block.blockId || index} has ${block.runs?.length ?? 0} runs`, addIssue);
    for (const run of block.runs || []) {
      check(run.status === "complete",
        "TASKLIST_RUN_INCOMPLETE", `${run.runId} status=${run.status}`, addIssue, run.runId);
      check(!(run.invalidReasons || []).length,
        "TASKLIST_RUN_INVALID", `${run.runId} has invalid reasons`, addIssue, run.runId);
    }
  }
  check(!(tasklist.blocks || []).some((block) =>
      block.status === "pending" || (block.runs || []).some((run) => run.status === "pending")),
    "TASKLIST_PENDING", "Tasklist contains a pending block or run", addIssue);
  check((report.results || []).length === 8,
    "RUN_COUNT", `report results=${report.results?.length ?? 0} expected 8`, addIssue);
  check(comparison.attemptedBlocks === 2 && comparison.validBlockCount === 2 &&
      comparison.invalidBlockCount === 0,
    "COMPARISON_INCOMPLETE",
    `comparison attempted/valid/invalid=${comparison.attemptedBlocks}/` +
      `${comparison.validBlockCount}/${comparison.invalidBlockCount}`,
    addIssue);
}

async function validateRun({
  root,
  task,
  reportRun,
  report,
  requireHardwareVisual,
  addIssue,
}) {
  const runId = task.runId;
  const runDir = path.join(root, runId);
  const issue = (code, message) => addIssue(code, message, runId);
  const artifacts = await describeRequiredArtifacts(runDir, RUN_ARTIFACTS, issue, runId);
  const [manifest, summary, samples, inputEvents, consoleText] = await Promise.all([
    readJson(path.join(runDir, "manifest.json"), issue, "MANIFEST_JSON", runId),
    readJson(path.join(runDir, "summary.json"), issue, "SUMMARY_JSON", runId),
    readJson(path.join(runDir, "samples.json"), issue, "SAMPLES_JSON", runId),
    readJson(path.join(runDir, "input-events.json"), issue, "INPUT_EVENTS_JSON", runId),
    readText(path.join(runDir, "console.log"), issue, "CONSOLE_LOG", runId),
  ]);
  if (!manifest || !summary || !Array.isArray(samples)) {
    return { runId, artifacts, valid: false };
  }

  check(reportRun.valid === true && summary.valid === true && manifest.result?.valid === true,
    "RUN_INVALID", "Report, summary, or manifest marks the run invalid", issue);
  check(!(reportRun.invalidReasons || []).length && !(summary.invalidReasons || []).length,
    "INVALID_REASONS", "Run has invalid reasons", issue);
  check(Array.isArray(summary.failures) && summary.failures.length === 0,
    "RUN_FAILURES", `Summary failures: ${JSON.stringify(summary.failures || [])}`, issue);
  check(reportRun.qualification?.eligible === true && manifest.qualification?.eligible === true,
    "RUN_PROVENANCE_INELIGIBLE", "Run is not qualification-eligible", issue);
  check(task.arm === reportRun.arm && task.arm === summary.arm &&
      task.armName === reportRun.armName && task.armName === summary.armName,
    "ARM_MISMATCH", "Tasklist, report, and summary arm identity differs", issue);

  validateAudioMode({ reportRun, manifest, summary, issue });
  validateFixture({ manifest, issue });
  validateFixedWork({ report, reportRun, manifest, summary, issue });
  validateBackend({ manifest, summary, issue });
  validateCausalFairness({ summary, issue });
  validateInputToVisible({ task, summary, issue });
  validateRawInputEvents({ manifest, summary, inputEvents, issue });
  validateReplayIntegrity({ manifest, summary, consoleText, issue });
  validateHardwareVisual({
    task,
    summary,
    required: requireHardwareVisual || task.params?.wgpuvisual === "1",
    issue,
  });
  await validateProvenanceBundle({ runDir, manifest, issue });

  const screenshot = artifacts.find((artifact) => artifact.name === "final.png");
  check(manifest.result?.screenshotFile === "final.png",
    "SCREENSHOT_MANIFEST", "Manifest does not name final.png", issue);
  check(manifest.result?.inputEventsFile === "input-events.json",
    "INPUT_EVENTS_MANIFEST", "Manifest does not name input-events.json", issue);
  check(screenshot?.validPng === true,
    "SCREENSHOT_INVALID", "final.png is missing or not a PNG", issue);
  check(samples.length >= 2 && summary.sampleCount === samples.length,
    "SAMPLE_COUNT", `summary/samples count=${summary.sampleCount}/${samples.length}`, issue);

  return {
    runId,
    artifacts,
    valid: true,
    audioUnderrunDelta:
      Number(summary.metrics?.causalFairness?.audio?.deltas?.underrunCount),
    inputMarker: summary.metrics?.causalFairness?.inputMarker || null,
    visualSampleSource: summary.final?.visualSampleSource || "none",
  };
}

function validateAudioMode({ reportRun, manifest, summary, issue }) {
  for (const [label, value] of [
    ["report result", reportRun.audioMode],
    ["manifest", manifest.benchmark?.audioMode],
    ["summary", summary.audioMode],
  ]) {
    check(value === "audible", "AUDIO_NOT_AUDIBLE", `${label} audioMode=${value ?? "missing"}`, issue);
  }
  for (const [label, application] of [
    ["manifest", manifest.benchmark?.audioModeApplication],
    ["summary", summary.audioModeApplication],
  ]) {
    check(application?.applied === true && application?.muted === false,
      "AUDIO_MODE_NOT_APPLIED",
      `${label} audible application=${JSON.stringify(application || null)}`, issue);
  }
  check(reportRun.audioClaimsEligible === true && summary.audioClaimQualification?.eligible === true,
    "AUDIO_CLAIM_INELIGIBLE", "Run is not eligible for an audible-audio claim", issue);
}

function validateFixture({ manifest, issue }) {
  const fixture = manifest.fixture || {};
  check(fixture.isoVerified === true && fixture.saveStateVerified === true,
    "FIXTURE_UNVERIFIED", "ISO or save-state hash was not verified", issue);
  check(fixture.saveStateLoaded === true && fixture.battleCheckpoint?.verified === true,
    "CHECKPOINT_UNVERIFIED", "reference-battle save checkpoint was not verified", issue);
  check(manifest.benchmark?.timingStartsAfterVerifiedLoad === true,
    "TIMING_BOUNDARY", "Timing did not begin after verified load", issue);
  check(manifest.benchmark?.inputScriptMode === "post-load-only" &&
      Number(manifest.benchmark?.inputScriptEventCount) === INPUT_MARKER_COUNT &&
      Number(manifest.benchmark?.inputScriptDeliveredEventCount) === INPUT_MARKER_COUNT,
    "INPUT_SCRIPT", "Expected 12 post-load-only delivered input markers", issue);
}

function validateFixedWork({ report, reportRun, manifest, summary, issue }) {
  const snapshots = [
    ["report result", reportRun.metrics?.fixedEmulatedWork || reportRun.fixedEmulatedWork],
    ["manifest", manifest.benchmark?.fixedEmulatedWork],
    ["summary metrics", summary.metrics?.fixedEmulatedWork],
    ["summary", summary.fixedEmulatedWork],
  ];
  for (const [label, fixed] of snapshots) {
    check(fixed?.enabled === true && Number(fixed?.targetCoreSeconds) === TARGET_CORE_SECONDS,
      "FIXED_WORK_TARGET", `${label} target=${fixed?.targetCoreSeconds ?? "missing"}`, issue);
    check(fixed?.reachedTarget === true && fixed?.deltasValid === true,
      "FIXED_WORK_NOT_REACHED", `${label} did not reach a valid fixed-work target`, issue);
    check(Number(fixed?.actualCoreTickDelta) >= Number(fixed?.targetCoreTicks) &&
        Number(fixed?.actualFrameDelta) > 0 && Number(fixed?.elapsedWallSeconds) > 0,
      "FIXED_WORK_INVALID", `${label} has invalid progress deltas`, issue);
  }
  check(Number(report.targetCoreSeconds) === TARGET_CORE_SECONDS,
    "FIXED_WORK_TARGET", "Report fixed-work target is not 8 seconds", issue);
}

function validateBackend({ manifest, summary, issue }) {
  const renderer = manifest.renderer || {};
  for (const [field, expected] of [
    ["requestedVideoBackend", "WebGPU-Real"],
    ["configuredVideoBackend", "WebGPU-Real"],
    ["activeVideoBackend", "WebGPU-Real"],
    ["requestedPresenterBackend", "webgpu"],
    ["activePresenterBackend", "webgpu"],
  ]) {
    check(renderer[field] === expected,
      "BACKEND_IDENTITY", `${field}=${renderer[field]} expected ${expected}`, issue);
  }
  check(renderer.fallback == null && renderer.coreSelection?.fallbackReason == null,
    "BACKEND_FALLBACK", "Renderer or core fallback was active", issue);
  check(summary.final?.causalTelemetry?.presentation?.backend === "webgpu",
    "PRESENTER_TELEMETRY", "Final presenter telemetry is not WebGPU", issue);
}

function validateCausalFairness({ summary, issue }) {
  const fairness = summary.metrics?.causalFairness || {};
  const audio = fairness.audio?.deltas || {};
  check(isZeroCounter(audio, "underrunCount"),
    "AUDIO_UNDERRUN", `new underruns=${audio.underrunCount ?? "missing"}`, issue);

  const marker = fairness.inputMarker || {};
  check(marker.enabled === true && marker.expectedCount === INPUT_MARKER_COUNT &&
      marker.parityPassed === true,
    "INPUT_PARITY", "Input marker parity did not pass for 12 events", issue);
  for (const stage of ["applied", "polled", "armed", "submitted", "completed"]) {
    check(Number(marker.stageDeltas?.[stage]) === INPUT_MARKER_COUNT,
      "INPUT_STAGE_COUNT", `${stage}=${marker.stageDeltas?.[stage] ?? "missing"} expected 12`, issue);
  }
  for (const counter of ZERO_INPUT_ERROR_COUNTERS) {
    check(isZeroCounter(marker.errorDeltas, counter),
      "INPUT_MARKER_ERROR", `${counter}=${marker.errorDeltas?.[counter] ?? "missing"}`, issue);
  }
  check(isZeroCounter(marker.final, "pendingGeneration") &&
      isZeroCounter(marker.final, "inFlightCount"),
    "INPUT_MARKER_PENDING", "Input marker has pending or in-flight work", issue);
  check(isZeroCounter(fairness.gpuErrors, "wgpuErrorCount") &&
      isZeroCounter(fairness.gpuErrors, "gpuCompletionFailedCount"),
    "CAUSAL_GPU_ERROR", "Causal window recorded WGPU or completion errors", issue);
}

function validateRawInputEvents({ manifest, summary, inputEvents, issue }) {
  check(inputEvents?.markerReadiness?.required === true &&
      inputEvents?.markerReadiness?.ready === true,
    "INPUT_MARKER_NOT_READY", "Raw input evidence lacks a successful readiness barrier", issue);
  check(manifest.benchmark?.inputMarkerReadiness?.ready === true,
    "INPUT_MARKER_NOT_READY", "Manifest lacks a successful input readiness barrier", issue);
  check(Array.isArray(inputEvents?.events) && inputEvents.events.length === INPUT_MARKER_COUNT,
    "INPUT_EVENT_COUNT", `raw input events=${inputEvents?.events?.length ?? "missing"} expected 12`, issue);
  check(summary.postLoadInput?.mode === "post-load-only" &&
      Number(summary.postLoadInput?.scheduledEventCount) === INPUT_MARKER_COUNT &&
      Number(summary.postLoadInput?.deliveredEventCount) === INPUT_MARKER_COUNT &&
      summary.postLoadInput?.markerReadiness?.ready === true &&
      Array.isArray(summary.postLoadInput?.events) &&
      summary.postLoadInput.events.length === INPUT_MARKER_COUNT,
    "INPUT_EVENT_SUMMARY", "Summary does not preserve all 12 post-load input events", issue);
}

function validateInputToVisible({ task, summary, issue }) {
  let url;
  try {
    url = new URL(summary.url);
  } catch {
    issue("INPUT_PHOTON_URL", `Invalid summary URL ${summary.url}`);
    return;
  }
  check(task.params?.inputphoton === "1" && url.searchParams.get("inputphoton") === "1",
    "INPUT_PHOTON_NOT_REQUESTED", "inputphoton=1 is absent from tasklist or URL", issue);
  const marker = summary.final?.causalTelemetry?.input?.marker || {};
  check(marker.schema === "wasm-dolphin.input-visual-marker.v1" &&
      marker.causalVisualAttribution === true && marker.opticalMarker?.enabled === true,
    "INPUT_VISIBLE_SOURCE", "Final input marker is not browser-visible causal telemetry", issue);
  check(Array.isArray(marker.samples) && marker.samples.length >= INPUT_MARKER_COUNT &&
      marker.samples.slice(-INPUT_MARKER_COUNT).every((sample) =>
        sample?.completionKind === "gpu-queue-complete" &&
        Number.isFinite(Number(sample?.pollToCompletionMs))),
    "INPUT_VISIBLE_SAMPLES", "Final telemetry lacks 12 GPU-completed input-to-visible samples", issue);
}

function validateReplayIntegrity({ manifest, summary, consoleText, issue }) {
  const renderer = manifest.renderer || {};
  check(Array.isArray(renderer.errors) && renderer.errors.length === 0,
    "RENDERER_ERRORS", `Renderer errors: ${JSON.stringify(renderer.errors || [])}`, issue);
  check(Array.isArray(renderer.emscriptenPrintErr) && renderer.emscriptenPrintErr.length === 0,
    "WASM_STDERR", `WASM stderr: ${JSON.stringify(renderer.emscriptenPrintErr || [])}`, issue);
  check(Array.isArray(renderer.fatalStatusHistory) && renderer.fatalStatusHistory.length === 0,
    "FATAL_STATUS", "Fatal renderer status was recorded", issue);
  check(isZeroCounter(renderer.workerTransport, "requestErrorRepliesSent") &&
      isZeroCounter(renderer.workerTransport, "oneWayErrorRepliesSent"),
    "WORKER_RPC_ERROR", "Worker transport recorded error replies", issue);

  const stages = renderer.wgpuReplayClassifier?.stages || {};
  check(isZeroCounter(stages.missingResources, "total"),
    "MISSING_RESOURCE", "Replay recorded missing resources", issue);
  // A held suffix is a normal atomicity mechanism: records can wait for the
  // matching END_PASS without constituting an error. Only a split or replay
  // outside a pass violates correctness here.
  for (const counter of ["splitAtDrainCount", "recordsOutsidePass"]) {
    check(isZeroCounter(stages.passAtomicity, counter),
      "PASS_ATOMICITY", `${counter}=${stages.passAtomicity?.[counter] ?? "missing"}`, issue);
  }
  check(isZeroCounter(stages.presentSubmission, "errorCount"),
    "PRESENT_ERROR", "Present submission recorded errors", issue);

  const webgpu = summary.final?.causalTelemetry?.webgpu || {};
  for (const counter of ZERO_WEBGPU_COUNTERS) {
    check(isZeroCounter(webgpu, counter),
      "WEBGPU_COUNTER", `${counter}=${webgpu[counter] ?? "missing"}`, issue);
  }
  const association = webgpu.uploadAttribution?.passAssociation || {};
  for (const counter of ["abortedPassCount", "incompletePassCount"]) {
    check(isZeroCounter(association, counter),
      "UPLOAD_PASS_ERROR", `${counter}=${association[counter] ?? "missing"}`, issue);
  }
  check(association.currentPassOpen === false,
    "UPLOAD_PASS_OPEN", "Upload attribution ended with an open pass", issue);
  check(webgpu.replayOps?.enabled === true && Array.isArray(webgpu.replayOps?.histogram),
    "REPLAY_METRICS_MISSING", "Replay operation telemetry is absent", issue);

  const completion = summary.final?.causalTelemetry?.presentation?.gpuCompletion || {};
  check(completion.enabled === true && Number(completion.completedCount) > 0,
    "GPU_COMPLETION_MISSING", "GPU completion sampling is disabled or empty", issue);
  for (const counter of ["failedCount", "unsupportedCount"]) {
    check(isZeroCounter(completion, counter),
      "GPU_COMPLETION_ERROR", `${counter}=${completion[counter] ?? "missing"}`, issue);
  }
  check(!/(?:\[pageerror\]|\[probe-error\]|:pageerror\]|\[(?:worker:[^\]]*:)?error\])/i.test(consoleText),
    "CONSOLE_ERROR", "console.log contains an error marker", issue);
}

function validateHardwareVisual({ task, summary, required, issue }) {
  if (!required) return;
  let url;
  try {
    url = new URL(summary.url);
  } catch {
    issue("HARDWARE_VISUAL_URL", `Invalid summary URL ${summary.url}`);
    return;
  }
  check(task.params?.wgpuvisual === "1" && url.searchParams.get("wgpuvisual") === "1",
    "HARDWARE_VISUAL_NOT_REQUESTED", "wgpuvisual=1 is absent from tasklist or URL", issue);
  const telemetry = summary.final?.causalTelemetry?.webgpu?.visualCadence ||
    summary.final?.visualCadenceTelemetry || {};
  check(telemetry.schema === "wasm-dolphin.wgpu-visual-cadence.v1" && telemetry.enabled === true &&
      telemetry.source === "wgpu-downsample-readback",
    "HARDWARE_VISUAL_SOURCE", "Final visual source is not hardware WGPU readback", issue);
  check(Number(telemetry.completedSampleCount) >= 2 &&
      Number(telemetry.changedSampleCount) > 0 && Number(telemetry.latestHash) > 0,
    "HARDWARE_VISUAL_EMPTY",
    "Hardware visual readback has fewer than two samples, no changed sample, or no hash", issue);
  for (const counter of ["encodeErrorCount", "mapErrorCount"]) {
    check(isZeroCounter(telemetry, counter),
      "HARDWARE_VISUAL_ERROR", `${counter}=${telemetry[counter] ?? "missing"}`, issue);
  }
}

async function validateProvenanceBundle({ runDir, manifest, issue }) {
  const provenance = manifest.buildProvenance || {};
  check(provenance.verification?.verified === true &&
      Array.isArray(provenance.verification?.failures) &&
      provenance.verification.failures.length === 0,
    "PROVENANCE_UNVERIFIED", "Build provenance verification did not pass", issue);
  check(Array.isArray(provenance.evidenceBundle) && provenance.evidenceBundle.length > 0,
    "PROVENANCE_BUNDLE_EMPTY", "Build provenance evidence bundle is empty", issue);
  const provenanceDir = path.join(runDir, "build-provenance");
  let names = [];
  try {
    names = await readdir(provenanceDir);
  } catch {
    issue("PROVENANCE_DIR_MISSING", "build-provenance directory is missing");
  }
  check(names.length > 0,
    "PROVENANCE_DIR_EMPTY", "build-provenance directory is empty", issue);
  for (const entry of provenance.evidenceBundle || []) {
    const relative = String(entry.path || "");
    const resolved = path.resolve(runDir, relative);
    if (!relative || !resolved.startsWith(`${path.resolve(provenanceDir)}${path.sep}`)) {
      issue("PROVENANCE_PATH_INVALID", `Invalid evidence path ${relative}`);
      continue;
    }
    try {
      const bytes = await readFile(resolved);
      check(bytes.length === Number(entry.bytes),
        "PROVENANCE_SIZE", `${relative} size=${bytes.length} expected ${entry.bytes}`, issue);
      check(createHash("sha256").update(bytes).digest("hex") === entry.sha256,
        "PROVENANCE_HASH", `${relative} SHA-256 mismatch`, issue);
    } catch {
      issue("PROVENANCE_ARTIFACT_MISSING", `${relative} is missing`);
    }
  }
}

async function describeRequiredArtifacts(root, names, addIssue, runId = null) {
  return Promise.all(names.map(async (name) => {
    const filePath = path.join(root, name);
    try {
      const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
      const artifact = {
        name,
        path: filePath,
        bytes: metadata.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      if (name.endsWith(".png")) {
        artifact.validPng = bytes.length > PNG_SIGNATURE.length &&
          bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
      }
      if (metadata.size === 0) addIssue("ARTIFACT_EMPTY", `${name} is empty`, runId);
      return artifact;
    } catch (error) {
      addIssue("ARTIFACT_MISSING", `${name} is missing: ${error.message}`, runId);
      return { name, path: filePath, bytes: 0, sha256: null };
    }
  }));
}

async function readJson(filePath, addIssue, code, runId = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    addIssue(code, `${path.basename(filePath)}: ${error.message}`, runId);
    return null;
  }
}

async function readText(filePath, addIssue, code, runId = null) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    addIssue(code, `${path.basename(filePath)}: ${error.message}`, runId);
    return "";
  }
}

function makeResult({ root, requireHardwareVisual, rootArtifacts, runs, issues }) {
  return {
    schema: SCHEMA,
    ok: issues.length === 0,
    outDir: root,
    requireHardwareVisual: Boolean(requireHardwareVisual),
    expectedOrder: ["ABBA", "BAAB"],
    expectedTargetCoreSeconds: TARGET_CORE_SECONDS,
    expectedInputMarkerCount: INPUT_MARKER_COUNT,
    rootArtifacts,
    runCount: runs.length,
    runs,
    issues,
  };
}

function isZeroCounter(object, key) {
  return Object.hasOwn(object || {}, key) &&
    Number.isFinite(Number(object[key])) && Number(object[key]) === 0;
}

function check(condition, code, message, addIssue, runId = null) {
  if (!condition) addIssue(code, message, runId);
}

function parseArgs(argv) {
  const result = { outDir: "", requireHardwareVisual: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") result.outDir = requiredArg(argv, ++index, arg);
    else if (arg === "--require-hardware-visual") result.requireHardwareVisual = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.outDir) throw new Error("--out is required");
  return result;
}

function requiredArg(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function main(argv) {
  const result = await validateWgpuSchedulingScreening(parseArgs(argv));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

const invokedAsScript = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(`[wgpu-scheduling-validator] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
