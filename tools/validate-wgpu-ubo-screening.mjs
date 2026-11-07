// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildComparisonTasklist,
  validateComparisonConfig,
} from "./perf-artifacts.mjs";
import { parseWgpuProducerStateStats } from "../src/wgpu-pass-state-cache.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REQUIRED_ZERO_WEBGPU_COUNTERS = [
  "errorCount",
  "commandDroppedCount",
  "batchAbortCount",
  "batchOversizeCount",
  "uploadTimeoutCount",
  "heldUploadStageLimitCount",
];
const FIXED_WORK_PRIMARY_METRIC = "metrics.fixedEmulatedWork.throughputGameSpeedPercent";

export async function validateWgpuUboScreening({ outDir, configPath }) {
  const root = path.resolve(outDir);
  const config = validateComparisonConfig(await readJson(configPath));
  const [report, tasklist, comparison] = await Promise.all([
    readJson(path.join(root, "report.json")),
    readJson(path.join(root, "tasklist.json")),
    readJson(path.join(root, "comparison.json")),
  ]);
  const issues = [];
  const addIssue = (code, message, runId = null) => {
    issues.push({ code, message, ...(runId ? { runId } : {}) });
  };

  validateExperimentEnvelope({ config, report, tasklist, comparison, addIssue });

  const expectedTasklist = buildComparisonTasklist(config);
  const expectedRuns = expectedTasklist.blocks.flatMap((block) => block.runs);
  const actualRuns = new Map((report.results || []).map((run) => [run.runId, run]));
  const runReports = [];

  for (const expected of expectedRuns) {
    const result = actualRuns.get(expected.runId);
    if (!result) {
      addIssue("RUN_MISSING", `Report is missing ${expected.runId}`, expected.runId);
      continue;
    }
    runReports.push(await validateRun({
      root,
      config,
      expected,
      result,
      durationSeconds: Number(report.durationSeconds),
      sampleMs: Number(report.sampleMs),
      targetCoreSeconds: Number(report.targetCoreSeconds),
      addIssue,
    }));
  }

  for (const runId of actualRuns.keys()) {
    if (!expectedRuns.some((run) => run.runId === runId)) {
      addIssue("RUN_UNEXPECTED", `Report contains unexpected run ${runId}`, runId);
    }
  }

  return {
    schema: "wasm-dolphin.wgpu-ubo-screening-validation.v1",
    ok: issues.length === 0,
    outDir: root,
    configPath: path.resolve(configPath),
    expectedOrder: expectedTasklist.blocks.map((block) => ({
      blockId: block.blockId,
      order: block.order.join(""),
    })),
    runCount: runReports.length,
    issues,
    runs: runReports,
    manualChecks: runReports.map((run) => ({
      runId: run.runId,
      screenshot: run.screenshot.path,
      sha256: run.screenshot.sha256,
      instruction:
        "Open final.png and confirm it shows the loaded reference-battle battle rather than a menu, black frame, or green frame.",
    })),
  };
}

function validateExperimentEnvelope({ config, report, tasklist, comparison, addIssue }) {
  check(report.headed === true, "RUN_NOT_HEADED", "Balanced WGPU evidence must use headed Chrome", addIssue);
  check(report.qualificationEligible === true,
    "PROVENANCE_INELIGIBLE", "Runs were not eligible for clean headed provenance qualification", addIssue);
  check(!(report.failures || []).length,
    "REPORT_FAILURES", `Gate report contains failures: ${(report.failures || []).join("; ")}`, addIssue);
  check(config.mode === "screening", "CONFIG_MODE", `Expected screening mode, got ${config.mode}`, addIssue);
  check(config.primaryMetric === FIXED_WORK_PRIMARY_METRIC,
    "PRIMARY_METRIC", `Expected ${FIXED_WORK_PRIMARY_METRIC}, got ${config.primaryMetric}`, addIssue);
  check(config.blockCount === 2 && config.maxBlockCount === 2,
    "CONFIG_BLOCKS", "WGPU screening must contain exactly two four-run blocks", addIssue);
  check(Number.isFinite(Number(report.durationSeconds)) && Number(report.durationSeconds) > 0,
    "DURATION_INVALID", `Invalid report durationSeconds=${report.durationSeconds}`, addIssue);
  check(Number.isFinite(Number(report.sampleMs)) && Number(report.sampleMs) > 0,
    "SAMPLE_INTERVAL_INVALID", `Invalid report sampleMs=${report.sampleMs}`, addIssue);
  check(Number.isFinite(Number(report.targetCoreSeconds)) && Number(report.targetCoreSeconds) > 0,
    "FIXED_WORK_TARGET_INVALID",
    `Invalid report targetCoreSeconds=${report.targetCoreSeconds}`, addIssue);
  check(tasklist.initialValidBlocks === 2 && tasklist.maximumValidBlocks === 2,
    "TASKLIST_BLOCKS", "Tasklist does not preserve the bounded two-block screening design", addIssue);
  check(tasklist.blocks?.length === 2,
    "TASKLIST_ATTEMPTS", `Expected exactly 2 attempted blocks, got ${tasklist.blocks?.length ?? 0}`, addIssue);
  check(tasklist.blocks?.[0]?.order?.join("") === "ABBA",
    "TASKLIST_ORDER", "Block 1 must use ABBA order", addIssue);
  check(tasklist.blocks?.[1]?.order?.join("") === "BAAB",
    "TASKLIST_ORDER", "Block 2 must use BAAB order", addIssue);
  for (const block of tasklist.blocks || []) {
    check(block.status === "complete", "TASKLIST_BLOCK_INVALID",
      `${block.blockId || "unknown block"} status is ${block.status}`, addIssue);
    for (const run of block.runs || []) {
      check(run.status === "complete", "TASKLIST_RUN_INVALID",
        `${run.runId || "unknown run"} status is ${run.status}`, addIssue, run.runId);
    }
  }
  check(comparison.attemptedBlocks === 2 && comparison.validBlockCount === 2 && comparison.invalidBlockCount === 0,
    "COMPARISON_INCOMPLETE",
    `Expected 2 valid/0 invalid blocks; got ${comparison.validBlockCount}/${comparison.invalidBlockCount}`,
    addIssue);
  check((report.results || []).length === 8,
    "RUN_COUNT", `Expected 8 balanced runs, got ${(report.results || []).length}`, addIssue);
}

async function validateRun({
  root,
  config,
  expected,
  result,
  durationSeconds,
  sampleMs,
  targetCoreSeconds,
  addIssue,
}) {
  const runId = expected.runId;
  const runDir = path.join(root, runId);
  const [manifest, summary, samples, consoleText, screenshot] = await Promise.all([
    readJson(path.join(runDir, "manifest.json")),
    readJson(path.join(runDir, "summary.json")),
    readJson(path.join(runDir, "samples.json")),
    readFile(path.join(runDir, "console.log"), "utf8"),
    describePng(path.join(runDir, "final.png")),
  ]);
  const issue = (code, message) => addIssue(code, message, runId);
  const expectedArm = expected.arm === "A" ? config.armA : config.armB;

  check(result.valid === true && summary.valid === true && manifest.result?.valid === true,
    "RUN_INVALID", "Gate, summary, or manifest marks the run invalid", issue);
  check(result.qualification?.eligible === true && manifest.qualification?.eligible === true,
    "RUN_PROVENANCE_INELIGIBLE", "Run or manifest provenance is not qualification-eligible", issue);
  check(!(result.invalidReasons || []).length && !(summary.invalidReasons || []).length,
    "INVALID_REASONS", "Run contains invalidation reasons", issue);
  check(!(summary.failures || []).length,
    "RUN_FAILURES", `Run contains failures: ${(summary.failures || []).join("; ")}`, issue);
  check(result.arm === expected.arm && summary.arm === expected.arm,
    "ARM_MISMATCH", `Expected arm ${expected.arm}, got ${result.arm}/${summary.arm}`, issue);
  check(result.armName === expectedArm.name && summary.armName === expectedArm.name,
    "ARM_NAME_MISMATCH", `Expected arm name ${expectedArm.name}`, issue);

  validateParams({ expected, manifest, summary, issue });
  validateFixture({ manifest, issue });
  const renderer = manifest.renderer || {};
  validateBackend({ renderer, summary, issue });
  validateRuntimeErrors({ renderer, summary, consoleText, issue });
  validatePresentationReadbacks({ renderer, summary, issue });
  const cache = validateUboCache({ expected, summary, samples, issue });
  const timing = validateSamples({
    samples,
    summary,
    durationSeconds,
    sampleMs,
    targetCoreSeconds,
    manifest,
    issue,
  });

  check(manifest.result?.screenshotFile === "final.png",
    "SCREENSHOT_MANIFEST", "Manifest does not record final.png", issue);
  check(screenshot.validPng && screenshot.bytes > PNG_SIGNATURE.length,
    "SCREENSHOT_INVALID", "final.png is missing, empty, or not a PNG", issue);

  return {
    runId,
    blockId: expected.blockId,
    arm: expected.arm,
    armName: expected.armName,
    cache,
    timing,
    classifier: renderer.wgpuReplayClassifier?.classifier || null,
    firstEfbPassReadback:
      renderer.wgpuReplayClassifier?.stages?.firstEfbPassReadback || null,
    readback: summarizeReadbacks(renderer),
    screenshot,
  };
}

function validateParams({ expected, manifest, summary, issue }) {
  const experiment = manifest.experiment || {};
  check(experiment.runId === expected.runId && experiment.blockId === expected.blockId,
    "EXPERIMENT_ID", "Manifest experiment identity does not match the tasklist", issue);
  const url = new URL(summary.url);
  for (const [key, value] of Object.entries(expected.params)) {
    check(String(experiment.params?.[key]) === String(value),
      "MANIFEST_PARAM", `Manifest ${key}=${experiment.params?.[key]} expected ${value}`, issue);
    check(url.searchParams.get(key) === String(value),
      "URL_PARAM", `URL ${key}=${url.searchParams.get(key)} expected ${value}`, issue);
  }
  check(url.searchParams.get("nojitcache") === "1",
    "CACHE_ISOLATION", "cacheState=disabled must produce nojitcache=1", issue);
}

function validateFixture({ manifest, issue }) {
  const fixture = manifest.fixture || {};
  check(fixture.isoVerified === true && fixture.saveStateVerified === true,
    "FIXTURE_UNVERIFIED", "ISO or save-state hash was not verified", issue);
  check(fixture.saveStateLoaded === true && fixture.battleCheckpoint?.verified === true,
    "CHECKPOINT_UNVERIFIED", "reference-battle fixed checkpoint was not loaded and verified", issue);
  check(manifest.benchmark?.timingStartsAfterVerifiedLoad === true,
    "TIMING_BOUNDARY", "Timing did not start after the verified save load", issue);
  check(manifest.benchmark?.inputScriptMode === "none",
    "INPUT_SCRIPT", "WGPU screening must not drive menus or character select", issue);
}

function validateBackend({ renderer, summary, issue }) {
  for (const [field, expected] of [
    ["requestedVideoBackend", "WebGPU-Real"],
    ["configuredVideoBackend", "WebGPU-Real"],
    ["activeVideoBackend", "WebGPU-Real"],
    ["expectedVideoBackend", "WebGPU-Real"],
    ["requestedPresenterBackend", "webgpu"],
    ["activePresenterBackend", "webgpu"],
    ["expectedRequestedPresenterBackend", "webgpu"],
    ["expectedActivePresenterBackend", "webgpu"],
  ]) {
    check(renderer[field] === expected,
      "BACKEND_IDENTITY", `${field}=${renderer[field]} expected ${expected}`, issue);
  }
  check(renderer.fallback == null && renderer.coreSelection?.fallbackReason == null,
    "BACKEND_FALLBACK", "Renderer or core fallback was active", issue);
  check(summary.final?.causalTelemetry?.presentation?.backend === "webgpu",
    "PRESENTER_TELEMETRY", "Final causal telemetry did not report the WebGPU presenter", issue);
}

function validateRuntimeErrors({ renderer, summary, consoleText, issue }) {
  check(Array.isArray(renderer.errors) && renderer.errors.length === 0,
    "RENDERER_ERRORS", `Renderer errors: ${JSON.stringify(renderer.errors || [])}`, issue);
  check(Array.isArray(renderer.emscriptenPrintErr) && renderer.emscriptenPrintErr.length === 0,
    "WASM_STDERR", `Emscripten printErr: ${JSON.stringify(renderer.emscriptenPrintErr || [])}`, issue);
  check(Array.isArray(renderer.fatalStatusHistory) && renderer.fatalStatusHistory.length === 0,
    "FATAL_STATUS", `Fatal statuses: ${JSON.stringify(renderer.fatalStatusHistory || [])}`, issue);
  check(isZeroCounter(renderer.workerTransport, "requestErrorRepliesSent") &&
      isZeroCounter(renderer.workerTransport, "oneWayErrorRepliesSent"),
    "WORKER_RPC_ERROR", "Worker transport recorded error replies", issue);

  const classifier = renderer.wgpuReplayClassifier?.stages || {};
  if (renderer.wgpuReplayClassifier?.stages) {
    check(isZeroCounter(classifier.missingResources, "total"),
      "MISSING_RESOURCE", "WGPU replay classifier recorded missing resources", issue);
    check(isZeroCounter(classifier.passAtomicity, "splitAtDrainCount") &&
        isZeroCounter(classifier.passAtomicity, "recordsOutsidePass"),
      "PASS_ATOMICITY", "WGPU replay split a pass or replayed state outside a pass", issue);
    check(isZeroCounter(classifier.presentSubmission, "errorCount"),
      "PRESENT_ERROR", "WGPU present submission recorded an error", issue);
  }

  const webgpu = summary.final?.causalTelemetry?.webgpu || {};
  for (const counter of REQUIRED_ZERO_WEBGPU_COUNTERS) {
    check(isZeroCounter(webgpu, counter),
      "WEBGPU_COUNTER", `${counter}=${webgpu[counter]} expected 0`, issue);
  }
  const association = webgpu.uploadAttribution?.passAssociation || {};
  check(isZeroCounter(association, "abortedPassCount") &&
      isZeroCounter(association, "incompletePassCount") && association.currentPassOpen === false,
    "UPLOAD_PASS_ERROR", "Upload attribution ended with an aborted, incomplete, or open pass", issue);
  check(!/(?:\[pageerror\]|\[probe-error\]|:pageerror\]|\[(?:worker:[^\]]*:)?error\])/i.test(consoleText),
    "CONSOLE_ERROR", "console.log contains a page, worker, probe, or console error marker", issue);
}

function validatePresentationReadbacks({ renderer, summary, issue }) {
  const chain = renderer.wgpuReplayClassifier?.stages?.presentationChain || {};
  if (!renderer.wgpuReplayClassifier?.stages) {
    const cadence = summary.final?.causalTelemetry?.webgpu?.visualCadence || {};
    check(cadence.schema === "wasm-dolphin.wgpu-visual-cadence.v1" &&
        cadence.enabled === true && cadence.source === "wgpu-downsample-readback",
      "READBACK_MISSING", "Hardware WGPU visual cadence readback is unavailable", issue);
    check(Number(cadence.completedSampleCount) >= 2 &&
        Number(cadence.changedSampleCount) > 0 && Number(cadence.latestHash) > 0,
      "RGB_READBACK_ZERO", "Hardware WGPU visual cadence is empty or frozen", issue);
    check(isZeroCounter(cadence, "encodeErrorCount") && isZeroCounter(cadence, "mapErrorCount"),
      "READBACK_ERROR", "Hardware WGPU cadence reported an encode or map error", issue);
    return;
  }
  for (const kind of ["xfb", "backbuffer"]) {
    const stage = chain[kind] || {};
    check(Number(stage.readbackCount || 0) > 0,
      "READBACK_MISSING", `${kind} readbackCount=${stage.readbackCount || 0}`, issue);
    check(Number(stage.nonzeroColorReadbackCount || 0) > 0 &&
        Number(stage.lastNonzeroColorBytes || 0) > 0 && Number(stage.lastMaxByte || 0) > 0,
      "RGB_READBACK_ZERO",
      `${kind} did not finish with a nonzero RGB readback (${stage.lastNonzeroColorBytes || 0} bytes)`,
      issue);
  }
}

function validateUboCache({ expected, summary, samples, issue }) {
  const enabled = expected.params.wgpuubocache === "1";
  const final = summary.final || samples.at(-1) || {};
  const webgpu = final.causalTelemetry?.webgpu || {};
  const helper = parseWgpuProducerStateStats(final.helper || "");
  const lookups = numericTriple(webgpu.producerUboCacheLookups);
  const hits = numericTriple(webgpu.producerUboCacheHits);
  const callsSuppressed = numericTriple(webgpu.producerUboUploadCallsSuppressed);
  const bytesSuppressed = numericTriple(webgpu.producerUboUploadBytesSuppressed);
  const lookupTotal = sum(lookups);
  const hitTotal = sum(hits);

  check(Boolean(webgpu.producerUboCacheAvailable),
    "UBO_CACHE_UNAVAILABLE", "Producer UBO cache is unavailable", issue);
  check(Boolean(webgpu.producerUboCacheEnabled) === enabled,
    "UBO_CACHE_MODE", `producerUboCacheEnabled=${webgpu.producerUboCacheEnabled} expected ${enabled}`, issue);
  check(Boolean(webgpu.producerUboCacheMetricsEnabled),
    "UBO_METRICS_DISABLED", "Producer UBO cache metrics were not enabled", issue);
  check(helper !== null && helper.uboCacheEnabled === enabled && helper.uboCacheMetricsEnabled,
    "UBO_HELPER_MISSING", "Helper text is missing or disagrees with the UBO cache mode", issue);
  check(helper !== null && helper.commandDroppedCount === 0 && helper.batchAbortCount === 0 &&
      helper.batchOversizeCount === 0 && helper.uploadTimeoutCount === 0,
    "UBO_HELPER_REPLAY_ERROR", "Helper text reports a replay drop, abort, oversize, or upload timeout", issue);
  check(helper !== null && helper.commandDroppedCount === Number(webgpu.commandDroppedCount) &&
      helper.batchAbortCount === Number(webgpu.batchAbortCount) &&
      helper.batchOversizeCount === Number(webgpu.batchOversizeCount) &&
      helper.uploadTimeoutCount === Number(webgpu.uploadTimeoutCount),
    "REPLAY_COUNTER_DISAGREEMENT", "Helper and causal replay-error counters disagree", issue);
  // Helper text is refreshed every frame, while causal telemetry is retained
  // for up to one sampling interval. The helper may therefore be newer, but
  // monotonic producer counters must never trail the retained causal sample.
  check(helper !== null &&
      arraysAtLeast(helper.uboCacheLookups, lookups) &&
      arraysAtLeast(helper.uboCacheHits, hits) &&
      arraysAtLeast(helper.uboUploadCallsSuppressed, callsSuppressed) &&
      arraysAtLeast(helper.uboUploadBytesSuppressed, bytesSuppressed),
    "UBO_COUNTER_REGRESSION", "Fresh helper UBO counters trail causal telemetry", issue);

  for (let index = 0; index < 3; index += 1) {
    check(hits[index] <= lookups[index],
      "UBO_HITS_EXCEED_LOOKUPS", `class ${index}: ${hits[index]} hits > ${lookups[index]} lookups`, issue);
    check(callsSuppressed[index] === hits[index],
      "UBO_SUPPRESSION_MISMATCH",
      `class ${index}: suppressed calls ${callsSuppressed[index]} != hits ${hits[index]}`,
      issue);
  }

  if (enabled) {
    check(lookupTotal > 0 && hitTotal > 0,
      "UBO_CACHE_NO_SIGNAL", `cache-on lookups=${lookupTotal}, hits=${hitTotal}`, issue);
    check(sum(bytesSuppressed) > 0,
      "UBO_CACHE_NO_BYTES", "cache-on run suppressed no upload bytes", issue);
  } else {
    check(hitTotal === 0,
      "UBO_CACHE_OFF_HIT", `cache-off run reported ${hitTotal} hits`, issue);
    check(sum(callsSuppressed) === 0 && sum(bytesSuppressed) === 0,
      "UBO_CACHE_OFF_SUPPRESSION", "cache-off run reported suppressed calls or bytes", issue);
  }

  return {
    enabled,
    classOrder: webgpu.producerUboCacheClassOrder || ["vs", "ps", "gs"],
    lookups,
    hits,
    callsSuppressed,
    bytesSuppressed,
    lookupTotal,
    hitTotal,
    bytesSuppressedTotal: sum(bytesSuppressed),
  };
}

function validateSamples({
  samples,
  summary,
  manifest,
  durationSeconds,
  sampleMs,
  targetCoreSeconds,
  issue,
}) {
  const actualCount = Array.isArray(samples) ? samples.length : 0;
  check(actualCount >= 2,
    "SAMPLE_COUNT", `samples.json has ${actualCount}; expected at least baseline and terminal samples`, issue);
  check(summary.sampleCount === actualCount && summary.timedWindow?.sampleCount === actualCount,
    "SUMMARY_SAMPLE_COUNT",
    `summary sample counts ${summary.sampleCount}/${summary.timedWindow?.sampleCount} expected ${actualCount}`,
    issue);
  check(summary.metrics?.fullTimedWindow?.gameSpeed?.count === actualCount - 1 &&
      summary.metrics?.fullTimedWindow?.coreFps?.count === actualCount - 1,
    "DERIVED_SAMPLE_COUNT", "Game-speed or core-FPS window is missing a timed delta", issue);

  const fixedWork = summary.metrics?.fixedEmulatedWork || summary.fixedEmulatedWork || {};
  const manifestFixedWork = manifest.benchmark?.fixedEmulatedWork || {};
  check(fixedWork.enabled === true && manifestFixedWork.enabled === true,
    "FIXED_WORK_DISABLED", "Summary or manifest did not enable fixed emulated work", issue);
  check(fixedWork.reachedTarget === true && manifestFixedWork.reachedTarget === true,
    "FIXED_WORK_NOT_REACHED", "Run did not reach its fixed emulated-work target", issue);
  check(Number(fixedWork.targetCoreSeconds) === targetCoreSeconds &&
      Number(manifestFixedWork.targetCoreSeconds) === targetCoreSeconds,
    "FIXED_WORK_TARGET_MISMATCH",
    `Run target ${fixedWork.targetCoreSeconds}/${manifestFixedWork.targetCoreSeconds} expected ${targetCoreSeconds}`,
    issue);
  check(Number(fixedWork.wallTimeCapSeconds) === durationSeconds &&
      Number(manifestFixedWork.wallTimeCapSeconds) === durationSeconds,
    "FIXED_WORK_CAP_MISMATCH",
    `Run wall cap ${fixedWork.wallTimeCapSeconds}/${manifestFixedWork.wallTimeCapSeconds} expected ${durationSeconds}`,
    issue);
  check(Number(fixedWork.actualCoreTickDelta) >= Number(fixedWork.targetCoreTicks) &&
      Number(fixedWork.actualFrameDelta) > 0,
    "FIXED_WORK_DELTA", "Fixed-work tick/frame deltas do not cover the requested work", issue);
  check(Number.isFinite(Number(fixedWork.throughputGameSpeedPercent)) &&
      Number.isFinite(Number(fixedWork.throughputCoreFps)) &&
      Number(fixedWork.elapsedWallSeconds) > 0 &&
      Number(fixedWork.elapsedWallSeconds) <= durationSeconds + Math.max(0.25, sampleMs / 1000),
    "FIXED_WORK_THROUGHPUT", "Fixed-work throughput or elapsed-wall metric is invalid", issue);

  let previousElapsed = -Infinity;
  let previousFrame = -Infinity;
  let previousTicks = -Infinity;
  let readable = 0;
  let changed = 0;
  for (const [index, sample] of (samples || []).entries()) {
    const elapsed = Number(sample.elapsedSeconds);
    const frame = Number(sample.frame);
    const ticks = Number(sample.coreTicks);
    check(Number.isFinite(elapsed) && elapsed >= previousElapsed,
      "SAMPLE_TIME_ORDER", `sample ${index} elapsedSeconds=${sample.elapsedSeconds}`, issue);
    check(Number.isFinite(frame) && frame >= previousFrame,
      "SAMPLE_FRAME_ORDER", `sample ${index} frame=${sample.frame}`, issue);
    check(Number.isFinite(ticks) && ticks >= previousTicks,
      "SAMPLE_TICK_ORDER", `sample ${index} coreTicks=${sample.coreTicks}`, issue);
    if (index > 0) {
      check(Number.isFinite(Number(sample.coreFps)) && Number.isFinite(Number(sample.gameSpeed)),
        "TIMING_SAMPLE_MISSING", `sample ${index} lacks derived coreFps/gameSpeed`, issue);
    }
    if (sample.visibleHash && !sample.visibleError) readable += 1;
    if (sample.visibleChanged) changed += 1;
    previousElapsed = elapsed;
    previousFrame = frame;
    previousTicks = ticks;
  }
  check(Number(samples.at(-1)?.elapsedSeconds || 0) >= Number(fixedWork.elapsedWallSeconds || 0),
    "TIMED_WINDOW_SHORT",
    `Final elapsed ${samples.at(-1)?.elapsedSeconds}s precedes fixed-work elapsed ${fixedWork.elapsedWallSeconds}s`,
    issue);
  check(Number(samples.at(-1)?.frame || 0) > Number(samples[0]?.frame || 0) &&
      Number(samples.at(-1)?.coreTicks || 0) > Number(samples[0]?.coreTicks || 0),
    "CORE_NO_PROGRESS", "Core frame/tick counters did not advance", issue);
  check(readable === actualCount && changed > 0,
    "CANVAS_SAMPLES", `Readable canvas samples=${readable}, changed samples=${changed}`, issue);
  return {
    minimumCount: 2,
    actualCount,
    readableCanvasSamples: readable,
    changedCanvasSamples: changed,
    fixedEmulatedWork: fixedWork,
  };
}

function summarizeReadbacks(renderer) {
  const chain = renderer.wgpuReplayClassifier?.stages?.presentationChain || {};
  return Object.fromEntries(["xfb", "backbuffer"].map((kind) => [kind, {
    readbackCount: Number(chain[kind]?.readbackCount || 0),
    nonzeroColorReadbackCount: Number(chain[kind]?.nonzeroColorReadbackCount || 0),
    lastNonzeroColorBytes: Number(chain[kind]?.lastNonzeroColorBytes || 0),
    lastMaxByte: Number(chain[kind]?.lastMaxByte || 0),
  }]));
}

async function describePng(filePath) {
  try {
    const bytes = await readFile(filePath);
    const metadata = await stat(filePath);
    return {
      path: filePath,
      bytes: metadata.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      validPng: bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
    };
  } catch (error) {
    return {
      path: filePath,
      bytes: 0,
      sha256: null,
      validPng: false,
      error: error.message || String(error),
    };
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

function numericTriple(value) {
  return [0, 1, 2].map((index) => Number(value?.[index] || 0));
}

function arraysAtLeast(fresh, retained) {
  return fresh.length === retained.length &&
    fresh.every((value, index) => Number(value) >= Number(retained[index]));
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function isZeroCounter(object, key) {
  return Object.hasOwn(object || {}, key) && Number.isFinite(Number(object[key])) && Number(object[key]) === 0;
}

function check(condition, code, message, addIssue, runId = null) {
  if (!condition) addIssue(code, message, runId);
}

async function main(argv) {
  const args = parseArgs(argv);
  const result = await validateWgpuUboScreening(args);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

function parseArgs(argv) {
  const result = { outDir: "", configPath: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") result.outDir = requiredArg(argv, ++index, arg);
    else if (arg === "--config") result.configPath = requiredArg(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.outDir) throw new Error("--out is required");
  if (!result.configPath) throw new Error("--config is required");
  return result;
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
    console.error(`[wgpu-ubo-validator] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
