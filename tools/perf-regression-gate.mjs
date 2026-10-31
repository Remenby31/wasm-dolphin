import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CAUSAL_TELEMETRY_SCHEMA_VERSION,
  flattenCausalTelemetry
} from "../src/causal-telemetry.js";

import {
  FIXED_BATTLE_FIXTURE,
  requireReferenceSha256,
  PERF_EVENT_SCHEMA_VERSION,
  assertBattleCheckpoint,
  assertRunProvenance,
  assertServedArtifactIdentity,
  buildComparisonTasklist,
  buildReplacementBlock,
  collectRunMetadata,
  classifyGateOutcome,
  describeFile,
  evaluateAudioClaimQualification,
  evaluateCandidateCoreBundle,
  evaluatePrebuiltJitCacheEvidence,
  evaluateMetricsModeEvidence,
  evaluateCoreSelectionEvidence,
  evaluateJitCacheReadiness,
  evaluateSoftwareRasterInstrumentationEvidence,
  evaluateWgpuGeometryRangeEvidence,
  evaluateWgpuRuntimeConfigEvidence,
  evaluateWgpuSemanticQualificationEvidence,
  evaluateWgpuDiagnosticLogFilterEvidence,
  evaluateWgpuOutputContractEvidence,
  evaluateWgpuProducerProfileEvidence,
  evaluateWgpuDrawProfileEvidence,
  evaluateWgpuSparseUboEvidence,
  evaluateWgpuUboComputeProjectionEvidence,
  evaluateWgpuTailGateEvidence,
  evaluateWgpuRendererWorkerProbeEvidence,
  validateWgpuUploadProbeFinalization,
  evaluateWgpuDirtyRangeProjection,
  evaluateQualificationProvenance,
  evaluateRunValidity,
  expectedBattleCheckpointForParams,
  extractLocalModuleSpecifiers,
  findFatalRuntimeEvidence,
  fixedWorkPollDelayMs,
  flattenWgpuDirtyRangeProjection,
  parseBattleCheckpoint,
  parsePostLoadInputScript,
  parseProfileMetrics,
  parseWgpuProducerProfileStats,
  parseWgpuDrawProfileStats,
  normalizePerfAudioMode,
  recordsToCsv,
  resolveCoreArtifactPath,
  selectedCoreServedPaths,
  selectNextFixedWorkBenchmarkAction,
  selectNextPostLoadBenchmarkAction,
  serializePostLoadInputScript,
  summarizeCausalFairness,
  summarizePostLoadInputDelivery,
  summarizeFixedEmulatedWork,
  summarizeComparison,
  summarizeJitMetrics,
  summarizeTimedMetricWindows,
  validateComparisonConfig,
  validateLockedBuildProvenance,
  verifyFileFixture,
} from "./perf-artifacts.mjs";
import { buildPerfScenarioUrl } from "./benchmark-url.mjs";
import {
  launchWithWindowsCpuAffinity,
  parseWindowsCpuAffinityMask,
} from "./windows-process-affinity.mjs";
import { describePrebuiltJitCache } from "./prebuilt-jit-cache-provenance.mjs";
import { wgpuMappedStagingSlotCountOf, wgpuMappedStagingSlotMibOf } from "../src/wgpu-replay-diagnostics.js";

const root = process.cwd();
const cli = parseArgs(process.argv.slice(2));
const FIXED_WORK_POLL_INTERVAL_MS = 100;
const INPUT_MARKER_POLL_INTERVAL_MS = 10;

await main().catch((error) => {
  console.error(`[perf-gate] ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const romPath = path.resolve(requiredFixturePath(cli.rom || process.env.ROM, "disc image", "--rom or ROM"));
  const saveStatePath = path.resolve(
    requiredFixturePath(cli.saveState || process.env.SAVE_STATE_PATH, "reference-battle save state", "--save-state or SAVE_STATE_PATH")
  );
  rejectMenuDrivingConfiguration();

  const outDir = resolveOutDir(cli.outDir || process.env.OUT_DIR || `perf-regression-gate-${Date.now()}`);
  const baseUrl = cli.baseUrl || process.env.BASE_URL || "http://127.0.0.1:8082/";
  const durationSeconds = cli.duration ?? numberEnv("DURATION", 60);
  const sampleMs = cli.sampleMs ?? numberEnv("SAMPLE_MS", 1000);
  const targetCoreSeconds = optionalPositiveNumber(
    cli.targetCoreSeconds ?? process.env.PERF_TARGET_CORE_SECONDS,
    "--target-core-seconds or PERF_TARGET_CORE_SECONDS"
  );
  if (targetCoreSeconds != null && (!(durationSeconds > 0) || !(sampleMs > 0))) {
    throw new Error("Fixed emulated work requires positive duration and sample interval values");
  }
  const postLoadInputScript = parsePostLoadInputScript(
    cli.perfInputScript ?? process.env.PERF_INPUT_SCRIPT,
    { durationSeconds }
  );
  const postLoadInputScriptCanonical = serializePostLoadInputScript(postLoadInputScript);
  const inputMaxLatenessMs = numberEnv("PERF_INPUT_MAX_LATENESS_MS", 100);
  const inputMarkerTimeoutMs = numberEnv("PERF_INPUT_MARKER_TIMEOUT_MS", 2500);
  const jitCacheReadyTimeoutMs = numberEnv("PERF_JIT_CACHE_READY_TIMEOUT_MS", 120_000);
  if (inputMaxLatenessMs < 0 || inputMarkerTimeoutMs <= 0 || jitCacheReadyTimeoutMs <= 0) {
    throw new Error(
      "Input lateness must be non-negative; marker and JIT-cache readiness timeouts must be positive"
    );
  }
  const settleSeconds = numberEnv("SETTLE_SECONDS", 2);
  const tolerance = cli.tolerance ?? numberEnv("PERF_DROP_TOLERANCE", 0.05);
  const strict = cli.strict || process.env.PERF_STRICT === "1";
  const targetMode = normalizeTargetMode(cli.targetMode || process.env.PERF_TARGET_MODE || "fail");
  const requireBaseline = cli.requireBaseline || process.env.PERF_REQUIRE_BASELINE === "1";
  const baselinePath = cli.baseline || process.env.PERF_BASELINE || "";
  const headed = process.env.PERF_PROBE_HEADED === "1";
  const audioMode = normalizePerfAudioMode(process.env.PERF_AUDIO_MODE);
  const browserCpuAffinity = parseWindowsCpuAffinityMask(process.env.PERF_CPU_AFFINITY_MASK);
  const continueInvalidCheckpoint = process.env.PERF_CONTINUE_INVALID_CHECKPOINT === "1";
  const corePath = resolveCoreArtifactPath(root, baseUrl);

  if (requireBaseline && !baselinePath) {
    throw new Error("PERF_BASELINE or --baseline is required in regression-guard mode");
  }

  await mkdir(outDir, { recursive: true });
  const [romFixture, saveFixture, coreArtifact] = await Promise.all([
    verifyFileFixture(romPath, {
      label: "disc image",
      expectedSha256: requireReferenceSha256("iso"),
    }),
    verifyFileFixture(saveStatePath, {
      label: "reference-battle save state",
      expectedSha256: requireReferenceSha256("state"),
    }),
    describeFile(corePath, { hash: true }),
  ]);
  const stagedSave = await stageSaveState(saveStatePath, saveFixture.sha256);
  const saveStateUrl = `/.omx/perf-fixtures/${path.basename(stagedSave)}`;
  const comparisonConfig = await readComparisonConfig(cli.comparisonConfig || process.env.PERF_COMPARISON_CONFIG);
  const baseline = await readBaseline(baselinePath);
  const { chromium } = await importPlaywright();
  const localServer = await ensureAppServer(baseUrl);

  try {
    await verifyServedFixture(new URL(saveStateUrl, baseUrl), saveFixture.sha256);
    const servedApplication = await verifyServedApplication(baseUrl, coreArtifact, corePath);
    const buildProvenance = await collectBuildProvenance(coreArtifact, corePath);
    const context = {
      baseUrl,
      buildProvenance,
      chromium,
      continueInvalidCheckpoint,
      coreArtifact,
      corePath,
      durationSeconds,
      headed,
      audioMode,
      browserCpuAffinity,
      inputMarkerTimeoutMs,
      jitCacheReadyTimeoutMs,
      inputMaxLatenessMs,
      outDir,
      postLoadInputScript,
      postLoadInputScriptCanonical,
      romFixture,
      romPath,
      sampleMs,
      saveFixture,
      saveStatePath,
      saveStateUrl,
      servedApplication,
      settleSeconds,
      strict,
      targetCoreSeconds,
      targetMode,
    };

    const execution = comparisonConfig
      ? await runComparison(comparisonConfig, context)
      : await runSinglePass(context);
    const comparison = comparisonConfig
      ? execution.comparison
      : compareToBaseline(execution.results, baseline, tolerance);
    const runFailures = execution.results.flatMap((result) =>
      (result.failures || []).map((failure) => `${result.name}: ${failure}`)
    );
    const targetFailures = execution.results.flatMap((result) =>
      (result.targetFailures || []).map((failure) => `${result.name}: ${failure}`)
    );
    const invalidFailures = execution.results.flatMap((result) =>
      (result.invalidReasons || []).map((reason) => `${result.name}: ${reason}`)
    );
    const comparisonFailures = [];
    const comparisonWarnings = [];
    if (comparisonConfig) {
      if (comparisonConfig.overheadGate && comparison.overheadGatePassed !== true) {
        comparisonFailures.push("Comparison failed the configured overhead or semantic-work gate");
      }
      if (comparison.outcome === "INFRASTRUCTURE_INCONCLUSIVE") {
        comparisonFailures.push("Comparison stopped because the invalid-block limit was exceeded");
      } else if (["NEEDS_MORE_BLOCKS", "INCONCLUSIVE", "INCOMPLETE"].includes(comparison.outcome)) {
        comparisonWarnings.push(`Comparison outcome: ${comparison.outcome}; no promotion is allowed`);
      }
    } else {
      comparisonFailures.push(...comparison.failures);
      comparisonWarnings.push(...comparison.warnings);
    }
    const failures = [...new Set([...invalidFailures, ...runFailures, ...comparisonFailures])];
    const warnings = [
      ...execution.results.flatMap((result) => result.warnings || []),
      ...comparisonWarnings,
      ...(headed ? [] : ["Runs were headless and cannot qualify performance or audio/compositor claims"]),
      ...(audioMode === "muted"
        ? ["PERF_AUDIO_MODE=muted; audible audio claims are ineligible"]
        : []),
    ];
    const qualificationEligible = execution.results.length > 0 && execution.results.every(
      (result) => result.qualification?.eligible === true
    );
    const gateOutcome = classifyGateOutcome({
      failureCount: failures.length,
      qualificationEligible,
      comparisonMode: comparisonConfig?.mode || null,
      statisticalGatePassed: Boolean(comparisonConfig && comparison.statisticalGatePassed),
      targetPassed: targetFailures.length === 0,
    });
    const audioClaimQualification = evaluateAudioClaimQualification({
      audioMode,
      headed,
      qualificationEligible,
    });
    comparison.audioMode = audioMode;
    comparison.audioClaimsEligible = audioClaimQualification.eligible;
    comparison.audioClaimQualification = audioClaimQualification;
    if (comparisonConfig) {
      comparison.qualificationEligible = qualificationEligible;
      comparison.promotable = gateOutcome.promotable;
      comparison.qualificationPassed = gateOutcome.qualificationPassed;
      await writeFile(path.join(outDir, "comparison.json"), JSON.stringify(comparison, null, 2));
    }
    const report = {
      schemaVersion: 2,
      verdict: gateOutcome.verdict,
      qualificationPassed: gateOutcome.qualificationPassed,
      qualificationEligible,
      audioMode,
      audioClaimsEligible: audioClaimQualification.eligible,
      audioClaimQualification,
      generatedAt: new Date().toISOString(),
      scene: FIXED_BATTLE_FIXTURE.sceneLabel,
      baseUrl,
      durationSeconds,
      targetCoreSeconds,
      sampleMs,
      settleSeconds,
      headed,
      browserCpuAffinity: {
        requestedMask: browserCpuAffinity.requestedMask,
        enabled: browserCpuAffinity.enabled,
        runs: execution.results.map((result) => ({
          name: result.name,
          ...result.browserCpuAffinity,
        })),
      },
      tolerance,
      strict,
      targetMode,
      requireBaseline,
      baselinePath: baselinePath || null,
      fixture: {
        rom: romFixture,
        saveState: saveFixture,
        stagedSaveStateUrl: saveStateUrl,
        core: coreArtifact,
      },
      servedApplication,
      tasklistPath: execution.tasklistPath || null,
      failures,
      warnings,
      results: execution.results,
      comparison,
    };
    await writeFile(path.join(outDir, "runs.csv"), runSummaryCsv(execution.results));
    await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = gateOutcome.exitCode;
  } finally {
    if (localServer) await new Promise((resolve) => localServer.close(resolve));
  }
}

async function runSinglePass(context) {
  const results = [];
  for (const scenario of selectedScenarios()) {
    results.push(await runScenario(scenario, context));
  }
  return { results, tasklistPath: null };
}

async function runComparison(configValue, context) {
  const config = validateComparisonConfig(configValue);
  const tasklist = buildComparisonTasklist(config);
  const tasklistPath = path.join(context.outDir, "tasklist.json");
  const results = [];
  let nextBlockIndex = 0;
  let replacementNumber = 0;
  let validBlockCount = 0;
  const baseScenario = selectedScenarios()[0];

  await writeFile(tasklistPath, JSON.stringify(tasklist, null, 2));
  while (
    validBlockCount < tasklist.maximumValidBlocks &&
    nextBlockIndex < tasklist.blocks.length &&
    results.length / 4 < tasklist.maximumAttemptedBlocks
  ) {
    if (validBlockCount >= tasklist.initialValidBlocks) {
      const current = summarizeComparison(config, results);
      if (!["NEEDS_MORE_BLOCKS", "INCOMPLETE", "INFRASTRUCTURE_INCONCLUSIVE"]
          .includes(current.outcome)) break;
    }
    const block = tasklist.blocks[nextBlockIndex++];
    block.status = "running";
    await writeFile(tasklistPath, JSON.stringify(tasklist, null, 2));
    const blockResults = [];
    for (const task of block.runs) {
      task.status = "running";
      await writeFile(tasklistPath, JSON.stringify(tasklist, null, 2));
      const scenario = {
        ...baseScenario,
        name: task.runId,
        required: false,
        params: { ...baseScenario.params, ...task.params },
        experiment: task,
      };
      if (task.cacheState === "disabled") scenario.params.nojitcache = "1";
      const result = await runScenario(scenario, context);
      results.push(result);
      blockResults.push(result);
      task.status = result.valid ? "complete" : "invalid";
      task.invalidReasons = result.invalidReasons;
      await writeFile(tasklistPath, JSON.stringify(tasklist, null, 2));
    }
    const blockReport = summarizeComparison(config, blockResults).blocks[0];
    block.status = blockReport?.valid ? "complete" : "invalid";
    block.invalidReasons = blockReport?.invalidReasons || ["Block did not produce a comparison result"];
    if (block.status === "complete") {
      validBlockCount += 1;
    } else {
      if (results.length / 4 < tasklist.maximumAttemptedBlocks) {
        replacementNumber += 1;
        const replacement = buildReplacementBlock(config, block, replacementNumber);
        tasklist.blocks.splice(nextBlockIndex, 0, replacement);
      }
    }
    await writeFile(tasklistPath, JSON.stringify(tasklist, null, 2));
  }

  const comparison = summarizeComparison(config, results);
  await writeFile(path.join(context.outDir, "comparison.json"), JSON.stringify(comparison, null, 2));
  await writeFile(path.join(context.outDir, "comparison.csv"), comparisonCsv(comparison, results, config));
  tasklist.status = comparison.outcome;
  tasklist.finishedAt = new Date().toISOString();
  await writeFile(tasklistPath, JSON.stringify(tasklist, null, 2));
  return { results, comparison, tasklistPath };
}

function withAudioClaimQualification(qualification, context) {
  return {
    ...qualification,
    audioClaims: evaluateAudioClaimQualification({
      audioMode: context.audioMode,
      headed: context.headed,
      qualificationEligible: qualification.eligible,
    }),
  };
}

async function applyHarnessAudioMode(page, audioMode) {
  const application = await page.evaluate(async (requestedMode) => {
    const audio = window.__audio;
    if (!audio || typeof audio.setMuted !== "function") {
      return {
        requestedMode,
        applied: false,
        muted: null,
        reason: "audio-controller-unavailable",
      };
    }
    await audio.setMuted(requestedMode === "muted");
    return {
      requestedMode,
      applied: true,
      muted: Boolean(audio.muted),
      available: Boolean(audio.available),
      contextState: audio.context?.state || null,
    };
  }, audioMode);
  if (!application.applied) {
    throw new Error(`Failed to apply PERF_AUDIO_MODE=${audioMode}: ${application.reason}`);
  }
  const expectedMuted = audioMode === "muted";
  if (application.muted !== expectedMuted) {
    throw new Error(
      `PERF_AUDIO_MODE=${audioMode} activation mismatch: muted=${application.muted}`
    );
  }
  return application;
}

async function runScenario(scenario, context) {
  const scenarioDir = path.join(context.outDir, scenario.name);
  await mkdir(scenarioDir, { recursive: true });
  const consoleLines = [];
  const consoleErrors = [];
  const samples = [];
  const inputEvents = [];
  const invalidReasons = [];
  let browser = null;
  let page = null;
  let browserLaunch = null;
  let manifest = null;
  let saveStateLoad = null;
  let renderer = null;
  let finalScreenshotCaptured = false;
  let postTimedReplayQuiescence = null;
  let postRunFinalizedTelemetry = null;
  let postRunCorrectness = null;
  let finalScreenshotSemantics = "post-timed-window";
  let inputMarkerReadiness = {
    required: context.postLoadInputScript.length > 0,
    ready: context.postLoadInputScript.length === 0,
    waitedMs: 0,
  };
  let audioModeApplication = {
    requestedMode: context.audioMode,
    applied: false,
    muted: null,
  };
  const { url, uploadProbeMode } = buildPerfScenarioUrl(
    context.baseUrl,
    scenario.params
  );
  scenario = {
    ...scenario,
    params: Object.fromEntries(url.searchParams.entries()),
  };
  const jitCacheReadinessRequired =
    scenario.params.wasmjit !== "0" && scenario.params.nojitcache !== "1";
  let jitCacheReadiness = {
    required: jitCacheReadinessRequired,
    ready: !jitCacheReadinessRequired,
    reason: jitCacheReadinessRequired ? "not-observed" : "disabled-by-scenario",
  };
  const fixedWorkPollIntervalMs = uploadProbeMode ? 10 : FIXED_WORK_POLL_INTERVAL_MS;
  let fixedEmulatedWork = {
    enabled: context.targetCoreSeconds != null,
    targetCoreSeconds: context.targetCoreSeconds,
    wallTimeCapSeconds: context.durationSeconds,
    pollIntervalMs: context.targetCoreSeconds != null ? fixedWorkPollIntervalMs : null,
    reachedTarget: false,
  };
  url.searchParams.set("probe", `${scenario.name}-${Date.now()}`);

  try {
    browserLaunch = await launchBrowser(
      context.chromium,
      context.headed,
      context.browserCpuAffinity
    );
    browser = browserLaunch.browser;
    page = browserLaunch.persistentProfileDir
      ? await browser.newPage()
      : await browser.newPage({ viewport: { width: 1280, height: 900 } });
    if (browserLaunch.persistentProfileDir) {
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    const recordConsole = (scope, message) => {
      const line = `[${scope}${message.type()}] ${message.text()}`;
      consoleLines.push(line);
      if (message.type() === "error") consoleErrors.push(line);
    };
    page.on("console", (message) => recordConsole("", message));
    page.on("pageerror", (error) => {
      const line = `[pageerror] ${error.stack || error.message}`;
      consoleLines.push(line);
      consoleErrors.push(line);
    });
    page.on("worker", (worker) => {
      const label = `worker:${worker.url()?.split("/").pop() || "?"}`;
      worker.on("console", (message) => recordConsole(`${label}:`, message));
      worker.on("pageerror", (error) => {
        const line = `[${label}:pageerror] ${error.stack || error.message}`;
        consoleLines.push(line);
        consoleErrors.push(line);
      });
    });
    const browserVersion = typeof browser.version === "function"
      ? browser.version()
      : browser.browser?.()?.version?.() || null;
    manifest = await collectRunMetadata({
      root,
      url: url.href,
      browserName: "chromium",
      browserChannel: browserLaunch.actualChannel,
      browserVersion,
      browserExecutable: browserLaunch.executablePath,
      headed: context.headed,
      durationSeconds: context.durationSeconds,
      sampleMs: context.sampleMs,
      screenshotEverySeconds: 0,
      captureScreenshots: true,
      showDebugPanel: false,
      romPath: context.romPath,
      corePath: context.corePath,
      saveStateUrl: context.saveStateUrl,
      saveStatePath: context.saveStatePath,
      saveStateAt: 0,
      inputScript: context.postLoadInputScriptCanonical || "none",
      sceneLabel: FIXED_BATTLE_FIXTURE.sceneLabel,
      artifactDescriptions: {
        rom: context.romFixture,
        core: context.coreArtifact,
        saveState: context.saveFixture,
      },
    });
    manifest.schemaVersion = 2;
    manifest.browser.requestedChannel = browserLaunch.requestedChannel;
    manifest.browser.actualChannel = browserLaunch.actualChannel;
    manifest.browser.executablePath = browserLaunch.executablePath;
    manifest.browser.launchSource = browserLaunch.source;
    manifest.browser.launchArgs = browserLaunch.args;
    manifest.browser.cpuAffinity = browserLaunch.cpuAffinity;
    manifest.benchmark.inputScriptMode = context.postLoadInputScript.length
      ? "post-load-only"
      : "none";
    manifest.benchmark.audioMode = context.audioMode;
    manifest.benchmark.audioModeApplication = audioModeApplication;
    manifest.benchmark.inputScriptEventCount = context.postLoadInputScript.length;
    manifest.benchmark.inputScriptScheduleOrigin = context.postLoadInputScript.length
      ? "after-first-timed-sample"
      : null;
    manifest.benchmark.inputMaxLatenessMs = context.inputMaxLatenessMs;
    manifest.benchmark.inputMarkerTimeoutMs = context.inputMarkerTimeoutMs;
    manifest.benchmark.jitCacheReadyTimeoutMs = context.jitCacheReadyTimeoutMs;
    manifest.benchmark.inputMarkerDispatchPolicy = context.postLoadInputScript.length
      ? "one-in-flight-through-marker-completion"
      : null;
    manifest.benchmark.timingStartsAfterVerifiedLoad = true;
    manifest.benchmark.settleSeconds = context.settleSeconds;
    manifest.benchmark.fixedEmulatedWork = fixedEmulatedWork;
    manifest.benchmark.cacheState = scenario.experiment?.cacheState || (
      browserLaunch.persistentProfileDir ? "persistent-reuse" : "cold-ephemeral"
    );
    manifest.benchmark.continueInvalidCheckpoint = context.continueInvalidCheckpoint;
    manifest.browser.profileId = browserLaunch.persistentProfileDir
      ? `persistent:${browserLaunch.persistentProfileDir}`
      : `${manifest.benchmark.cacheState}:${scenario.experiment?.runId || scenario.name}:${manifest.startedAt}`;
    manifest.buildProvenance = structuredClone(context.buildProvenance.buildProvenance);
    manifest.buildProvenance.evidenceBundle = await packageBuildProvenance(
      scenarioDir,
      context.buildProvenance.rawEvidenceFiles
    );
    manifest.buildProvenance.verification = validateLockedBuildProvenance(manifest.buildProvenance);
    manifest.hostCore = context.buildProvenance.hostCore;
    manifest.eventSchema = { version: PERF_EVENT_SCHEMA_VERSION };
    manifest.causalTelemetrySchema = { version: CAUSAL_TELEMETRY_SCHEMA_VERSION };
    manifest.upstream = context.buildProvenance.upstream;
    manifest.patches = context.buildProvenance.patches;
    manifest.toolchain = context.buildProvenance.toolchain;
    manifest.servedApplication = context.servedApplication;
    manifest.experiment = scenario.experiment || null;
    manifest.fixture = {
      sceneLabel: FIXED_BATTLE_FIXTURE.sceneLabel,
      isoVerified: true,
      saveStateVerified: true,
      saveStateLoaded: false,
      battleCheckpoint: { verified: false },
      expectedIsoSha256: context.romFixture.sha256,
      expectedSaveStateSha256: context.saveFixture.sha256,
    };
    await writeFile(path.join(scenarioDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    manifest.browser.userAgent = await page.evaluate(() => navigator.userAgent);
    manifest.browser.webgpuAdapter = await readWebGpuAdapter(page);
    manifest.qualification = withAudioClaimQualification(
      evaluateQualificationProvenance(manifest),
      context
    );
    await page.setInputFiles("#romInput", context.romPath);
    await page.click("#screen");
    await waitForMount(page, scenarioDir);
    audioModeApplication = await applyHarnessAudioMode(page, context.audioMode);
    manifest.benchmark.audioModeApplication = audioModeApplication;
    const readiness = await waitForCoreReady(page);
    const pauseResponse = await pauseForBattleCheckpoint(page);
    const replayQuiescence = await finalizeWgpuReplay(page, {
      required: expectedDolphinVideoBackend(scenario.params.video) === "WebGPU-Real",
    });
    const attemptedAt = new Date().toISOString();
    const response = await loadStateFileWithTimeout(page, context.saveStateUrl);
    saveStateLoad = {
      attemptedAt,
      readiness,
      pauseResponse,
      replayQuiescence,
      response,
      loaded: Boolean(response?.loaded),
    };
    if (!saveStateLoad.loaded) {
      throw new Error(`Save-state load failed: ${response?.error || JSON.stringify(response)}`);
    }
    renderer = withExpectedRendererIdentity(await readRendererDiagnostics(page), scenario.params);
    manifest.renderer = renderer;
    const observedBattleCheckpoint = parseBattleCheckpoint(response);
    let battleCheckpoint;
    try {
      battleCheckpoint = assertBattleCheckpoint(
        observedBattleCheckpoint,
        expectedBattleCheckpointForParams(scenario.params)
      );
    } catch (error) {
      if (!context.continueInvalidCheckpoint) throw error;
      invalidReasons.push(error.message || String(error));
      battleCheckpoint = {
        ...observedBattleCheckpoint,
        verified: false,
        diagnosticContinuation: true,
        error: error.message || String(error)
      };
    }
    manifest.fixture.battleCheckpoint = battleCheckpoint;
    await resumeAfterBattleCheckpoint(page);
    saveStateLoad.postLoadProgress = await waitForPostLoadProgress(page);
    renderer = withExpectedRendererIdentity(await readRendererDiagnostics(page), scenario.params);
    manifest.renderer = renderer;
    await page.waitForTimeout(context.settleSeconds * 1000);
    const fixedWorkEnabled = context.targetCoreSeconds != null;
    if (context.postLoadInputScript.length > 0) {
      inputMarkerReadiness = await waitForInputMarkerReady(page, {
        pollIntervalMs: INPUT_MARKER_POLL_INTERVAL_MS,
        timeoutMs: context.inputMarkerTimeoutMs,
      });
      if (!inputMarkerReadiness.ready) {
        throw new Error(
          `Input marker telemetry was not ready before the timed window after ` +
          `${inputMarkerReadiness.waitedMs} ms`
        );
      }
    }
    let fixedSceneMeasurementBoundary = null;
    let probeMeasurementBoundary = null;
    if (fixedWorkEnabled || uploadProbeMode) {
      fixedSceneMeasurementBoundary = await establishFixedSceneMeasurementBoundary(
        page,
        context.saveStateUrl,
        expectedBattleCheckpointForParams(scenario.params),
        {
          jitCacheReadinessRequired,
          jitCacheReadyTimeoutMs: context.jitCacheReadyTimeoutMs,
          wgpuReplayRequired:
            expectedDolphinVideoBackend(scenario.params.video) === "WebGPU-Real",
        }
      );
      jitCacheReadiness = fixedSceneMeasurementBoundary.jitCacheReadiness;
      manifest.benchmark.jitCacheReadiness = jitCacheReadiness;
      manifest.benchmark.fixedSceneMeasurementBoundary = {
        reloadedSaveState: true,
        checkpoint: fixedSceneMeasurementBoundary.checkpoint,
        progress: fixedSceneMeasurementBoundary.progress,
        signature: fixedSceneMeasurementBoundary.signature,
        replayQuiescence: fixedSceneMeasurementBoundary.replayQuiescence,
      };
    }
    if (uploadProbeMode) {
      const begun = await requestWorkerRpc(
        page,
        "validationBeginWgpuRendererProbeMeasurement",
        { timeoutMs: 10_000 },
        20_000
      );
      const boundarySnapshot = begun?.snapshot;
      if (!boundarySnapshot?.passed || boundarySnapshot.observedRecordCount !== 0 ||
          boundarySnapshot.consumedRecordCount !== 0 || boundarySnapshot.backlog !== 0) {
        throw new Error(`Upload probe measurement boundary is invalid: ${JSON.stringify(boundarySnapshot)}`);
      }
      begun.observedAtMs = await page.evaluate(() => performance.now());
      probeMeasurementBoundary = begun;
      manifest.benchmark.rendererWorkerProbeMeasurementBoundary = {
        schema: boundarySnapshot.schema,
        initialRead: boundarySnapshot.initialRead,
        initialUploadRead: boundarySnapshot.initialUploadRead,
        coreTicks: begun.coreTicks,
        frame: begun.frame,
        reloadedSaveState: true,
        checkpoint: fixedSceneMeasurementBoundary.checkpoint,
      };
    }
    manifest.fixture.saveStateLoaded = true;
    manifest.fixture.loadResult = saveStateLoad;
    manifest.benchmark.inputMarkerReadiness = inputMarkerReadiness;
    manifest.benchmark.timingStartedAt = new Date().toISOString();
    await writeFile(path.join(scenarioDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    if (fixedSceneMeasurementBoundary) {
      const resumed = await resumeAfterBattleCheckpoint(page);
      fixedSceneMeasurementBoundary.progress.observedAtMs = Number(resumed.transitionAtMs);
      fixedSceneMeasurementBoundary.resumed = resumed;
      manifest.benchmark.fixedSceneMeasurementBoundary.resumed = {
        coreTicks: Number(resumed.coreTicks),
        frame: Number(resumed.frame),
        transitionAtMs: Number(resumed.transitionAtMs),
        observedAtMs: Number(resumed.observedAtMs),
      };
    }
    const startedAt = Date.now();
    const wallTimeCapMs = context.durationSeconds * 1000;
    const totalSamples = fixedWorkEnabled
      ? Math.floor(wallTimeCapMs / context.sampleMs)
      : Math.ceil(wallTimeCapMs / context.sampleMs);
    let sampleIndex = 0;
    let inputIndex = 0;
    let fixedWorkBaseline = fixedWorkEnabled && fixedSceneMeasurementBoundary
      ? fixedWorkObservation(fixedSceneMeasurementBoundary.progress)
      : null;
    if (fixedWorkBaseline) {
      manifest.benchmark.timingBaselineEstablishedAt = new Date().toISOString();
      fixedEmulatedWork = summarizeFixedEmulatedWork({
        targetCoreSeconds: context.targetCoreSeconds,
        coreTicksPerSecond:
          Number(fixedSceneMeasurementBoundary.progress.coreTicksPerSecond) || 0,
        baseline: fixedWorkBaseline,
        observation: fixedWorkBaseline,
        wallTimeCapSeconds: context.durationSeconds,
        pollIntervalMs: fixedWorkPollIntervalMs,
      });
      manifest.benchmark.fixedEmulatedWork = fixedEmulatedWork;
    }
    const collectTimedSample = async (elapsedSeconds) => {
      const sample = deriveCoreRates(
        await readSample(page, elapsedSeconds),
        samples.at(-1),
        Number(saveStateLoad.response?.coreTicksPerSecond) || 0
      );
      const record = {
        ...sample,
        ...parseProfileMetrics(sample.helper, sample.profile),
        ...(parseWgpuProducerProfileStats(sample.helper) ?? {}),
        ...(parseWgpuDrawProfileStats(sample.helper) ?? {}),
        ...flattenCausalTelemetry(sample.causalTelemetry),
        ...flattenWgpuDirtyRangeProjection(
          sample.causalTelemetry?.webgpu?.dirtyRangeProjection
        )
      };
      samples.push(record);
      return record;
    };
    while (fixedWorkEnabled || sampleIndex <= totalSamples || inputIndex < context.postLoadInputScript.length) {
      const schedule = {
        sampleIndex,
        totalSamples,
        sampleMs: context.sampleMs,
        inputIndex,
        inputEvents: context.postLoadInputScript,
      };
      const action = fixedWorkEnabled
        ? selectNextFixedWorkBenchmarkAction({ ...schedule, wallTimeCapMs })
        : selectNextPostLoadBenchmarkAction(schedule);
      const deadline = startedAt + action.atMs;
      let progressAtAction = null;
      if (fixedWorkBaseline) {
        const progress = await waitForFixedEmulatedWorkProgress(page, {
          baseline: fixedWorkBaseline,
          coreTicksPerSecond: fixedEmulatedWork.coreTicksPerSecond,
          deadlineMs: deadline,
          pollIntervalMs: fixedWorkPollIntervalMs,
          liveWorkerProgress: fixedWorkEnabled,
          targetCoreSeconds: context.targetCoreSeconds,
          wallTimeCapSeconds: context.durationSeconds,
        });
        progressAtAction = progress;
        fixedEmulatedWork = progress.summary;
        manifest.benchmark.fixedEmulatedWork = fixedEmulatedWork;
        if (progress.summary.reachedTarget) {
          const elapsedSeconds = (Date.now() - startedAt) / 1000;
          await collectTimedSample(elapsedSeconds);
          break;
        }
      } else {
        await page.waitForTimeout(Math.max(0, deadline - Date.now()));
      }
      const elapsedSeconds = (Date.now() - startedAt) / 1000;

      if (action.type === "wall-time-cap") {
        await collectTimedSample(elapsedSeconds);
        fixedEmulatedWork = progressAtAction.summary;
        manifest.benchmark.fixedEmulatedWork = fixedEmulatedWork;
        break;
      }

      if (action.type === "input") {
        const dispatchStartedSeconds = elapsedSeconds;
        const markerBaseline = await readInputMarkerBarrierState(page);
        if (action.event.action === "down") await page.keyboard.down(action.event.key);
        else await page.keyboard.up(action.event.key);
        const deliveredSeconds = (Date.now() - startedAt) / 1000;
        const markerBarrier = await waitForInputMarkerCompletion(page, markerBaseline, {
          pollIntervalMs: INPUT_MARKER_POLL_INTERVAL_MS,
          timeoutMs: context.inputMarkerTimeoutMs,
        });
        inputEvents.push({
          action: action.event.action,
          key: action.event.key,
          sourceIndex: action.event.index,
          scheduledSeconds: action.event.second,
          dispatchStartedSeconds,
          deliveredSeconds,
          latenessMs: Math.max(0, deliveredSeconds * 1000 - action.atMs),
          afterBaselineSample: samples.length > 0,
          markerBarrier,
        });
        inputIndex += 1;
        continue;
      }

      const sample = await collectTimedSample(elapsedSeconds);
      if (sampleIndex === 0) {
        if (!manifest.benchmark.timingBaselineEstablishedAt) {
          manifest.benchmark.timingBaselineEstablishedAt = new Date().toISOString();
        }
        if (!context.continueInvalidCheckpoint) assertRunProvenance(manifest);
      } else if (fixedWorkEnabled) {
        fixedEmulatedWork = action.atMs >= wallTimeCapMs && progressAtAction
          ? progressAtAction.summary
          : summarizeFixedEmulatedWork({
            targetCoreSeconds: context.targetCoreSeconds,
            coreTicksPerSecond: fixedEmulatedWork.coreTicksPerSecond,
            baseline: fixedWorkBaseline,
            observation: fixedWorkObservation(sample),
            wallTimeCapSeconds: context.durationSeconds,
            pollIntervalMs: fixedWorkPollIntervalMs,
          });
        manifest.benchmark.fixedEmulatedWork = fixedEmulatedWork;
      }
      if (sampleIndex % Math.max(1, Math.round(10000 / context.sampleMs)) === 0) {
        console.log(
          `[perf-gate] ${scenario.name} t=${elapsedSeconds.toFixed(1)} ` +
          `frame=${sample.frame} present=${sample.presentFps} core=${sample.coreFps} ` +
          `visual=${sample.visualFps} speed=${sample.gameSpeed}`
        );
      }
      sampleIndex += 1;
      if (fixedWorkEnabled && (fixedEmulatedWork.reachedTarget || action.atMs >= wallTimeCapMs)) {
        break;
      }
    }
    const timedWindowEndedAt = new Date().toISOString();
    const timedFinalSample = samples.at(-1) || null;
    const mappedDrainFinalizationMode =
      String(scenario.params?.wgpudraincoalesce ?? "0") === "1" ||
      String(scenario.params?.wgpuubocomputeprojection ?? "0") === "1" ||
      String(scenario.params?.wgpuubocompute ?? "0") === "1";
    const hardwareWgpuRun =
      expectedDolphinVideoBackend(scenario.params.video) === "WebGPU-Real";
    const postRunFinalizationRequired =
      uploadProbeMode || mappedDrainFinalizationMode || hardwareWgpuRun;
    let postRunPause = null;
    if (postRunFinalizationRequired) {
      postRunPause = await requestWorkerRpc(page, "validationSetCorePaused", { paused: true });
      if (!postRunPause?.paused || postRunPause?.coreStateName !== "Paused") {
        throw new Error(
          `WGPU core did not pause for post-run finalization: ${JSON.stringify(postRunPause)}`
        );
      }
    }
    if (uploadProbeMode || mappedDrainFinalizationMode) {
      const finalized = await requestWorkerRpc(
        page,
        uploadProbeMode
          ? "validationFinalizeWgpuRendererProbe"
          : "validationFinalizeWgpuMappedDrain",
        { timeoutMs: 10_000 },
        20_000
      );
      if (!finalized?.causalTelemetry) {
        throw new Error("WGPU finalization did not return causal telemetry");
      }
      if (mappedDrainFinalizationMode && !finalized?.mappedDrainFinalization?.quiesced) {
        throw new Error("WGPU mapped drain finalization did not return quiescent evidence");
      }
      postRunFinalizedTelemetry = {
        causalTelemetry: finalized.causalTelemetry,
        flattened: {
          ...flattenCausalTelemetry(finalized.causalTelemetry),
          ...flattenWgpuDirtyRangeProjection(
            finalized.causalTelemetry?.webgpu?.dirtyRangeProjection
          ),
        },
      };
      if (uploadProbeMode) {
        const snapshot = finalized?.snapshot;
        if (!snapshot?.quiesced || !snapshot?.passed) {
          throw new Error(`Upload probe did not finalize cleanly: ${JSON.stringify(snapshot)}`);
        }
        const finalizationEvidence = validateWgpuUploadProbeFinalization({
          requested: scenario.params.wgpurenderprobe,
          finalized,
        });
        if (!finalizationEvidence.valid) {
          throw new Error(
            `Upload probe finalization telemetry is invalid: ${finalizationEvidence.failures.join("; ")}`
          );
        }
        manifest.benchmark.rendererWorkerProbeFinalization = {
          paused: true,
          quiesced: true,
          schema: snapshot.schema,
          observedRecordCount: snapshot.observedRecordCount,
          totalUploadBytes: snapshot.totalUploadBytes,
          streamDigest: snapshot.streamDigest,
        };
      } else {
        manifest.benchmark.mappedDrainFinalization = {
          paused: true,
          quiesced: true,
          deferred: Boolean(
            finalized.causalTelemetry.webgpu?.mappedDrainCoalescing?.state?.deferred
          ),
          pendingUploads:
            finalized.causalTelemetry.webgpu?.mappedStaging?.pendingUploads ?? null,
          activeBatches: finalized.mappedDrainFinalization.activeBatches,
          remappingSlots: finalized.mappedDrainFinalization.remappingSlots,
          activeCapacityWait: finalized.mappedDrainFinalization.activeCapacityWait,
          deferredBoundaries:
            finalized.causalTelemetry.webgpu?.mappedDrainCoalescing?.telemetry
              ?.deferredBoundaries ?? null,
          actualSubmissions:
            finalized.causalTelemetry.webgpu?.mappedDrainCoalescing?.telemetry
              ?.actualSubmissions ?? null,
        };
      }
    }
    manifest.benchmark.inputScriptDeliveredEventCount = inputEvents.length;
    if (hardwareWgpuRun) {
      const replayQuiescence = await finalizeWgpuReplay(page, {
        required: true,
      });
      postTimedReplayQuiescence = {
        timedMetricsFrozen: true,
        paused: true,
        ...replayQuiescence,
      };
      manifest.benchmark.postTimedReplayQuiescence = postTimedReplayQuiescence;
      finalScreenshotSemantics = "post-timed-replay-quiescence";
    }
    const compositorSettledAtMs = hardwareWgpuRun
      ? await waitForAnimationFrames(page, 2)
      : null;
    postRunCorrectness = {
      schema: "wasm-dolphin.post-run-correctness.v1",
      separatedFromTimedWindow: true,
      timedWindowEndedAt,
      timedSampleCount: samples.length,
      timedFinalObservedAtMs: timedFinalSample?.observedAtMs ?? null,
      timedFinalCoreTicks: timedFinalSample?.coreTicks ?? null,
      pause: postRunPause,
      replayQuiescence: postTimedReplayQuiescence,
      compositorAnimationFrames: hardwareWgpuRun ? 2 : 0,
      compositorSettledAtMs,
      finalizedTelemetry: postRunFinalizedTelemetry,
    };
    manifest.benchmark.postRunCorrectness = postRunCorrectness;
    manifest.benchmark.finalScreenshotSemantics = finalScreenshotSemantics;
    finalScreenshotCaptured = await saveScreenshot(page, scenarioDir, "final.png");
    postRunCorrectness.screenshot = {
      file: "final.png",
      captured: finalScreenshotCaptured,
      capturedAt: new Date().toISOString(),
    };
    if (hardwareWgpuRun && !finalScreenshotCaptured) {
      throw new Error("Hardware WGPU post-run correctness screenshot was not captured");
    }
    await page.waitForTimeout(100);
    renderer = withExpectedRendererIdentity(await readRendererDiagnostics(page), scenario.params);
    manifest.renderer = renderer;
  } catch (error) {
    invalidReasons.push(error.message || String(error));
    consoleLines.push(`[probe-error] ${error.stack || error.message}`);
    if (page && !page.isClosed() && !renderer) {
      try {
        renderer = withExpectedRendererIdentity(await readRendererDiagnostics(page), scenario.params);
      } catch (diagnosticError) {
        consoleLines.push(
          `[renderer-diagnostics-error] ${diagnosticError.stack || diagnosticError.message}`
        );
      }
    }
    if (browser) {
      const pages = typeof browser.contexts === "function"
        ? browser.contexts().flatMap((browserContext) => browserContext.pages())
        : typeof browser.pages === "function"
          ? browser.pages()
          : page ? [page] : [];
      if (pages[0]) await saveScreenshot(pages[0], scenarioDir, "error.png");
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (!samples.length) invalidReasons.push("no timed samples were collected");
  invalidReasons.push(
    ...evaluateMetricsModeEvidence({
      requested: scenario.params.metrics,
      diagnostics: renderer?.metrics,
      samples,
    }).failures
  );
  const softwareRasterInstrumentation = evaluateSoftwareRasterInstrumentationEvidence({
    required: scenario.params.video === "software" && String(scenario.params.metrics) === "1",
    samples,
  });
  invalidReasons.push(...softwareRasterInstrumentation.failures);
  const wgpuProducerProfile = evaluateWgpuProducerProfileEvidence({
    requested: scenario.params.wgpuprodprofile,
    metrics: scenario.params.metrics,
    samples,
  });
  invalidReasons.push(...wgpuProducerProfile.failures);
  const wgpuDrawProfile = evaluateWgpuDrawProfileEvidence({
    requested: scenario.params.wgpudrawprofile,
    metrics: scenario.params.metrics,
    video: scenario.params.video,
    samples,
  });
  invalidReasons.push(...wgpuDrawProfile.failures);
  const metricsEnabled = String(scenario.params.metrics) === "1";
  const requestedTailGate = scenario.params.wgputailgate;
  const wgpuTailGate = metricsEnabled
    ? evaluateWgpuTailGateEvidence({ requested: requestedTailGate, samples })
    : evaluateMetricsOffWgpuTailGate({
        requested: requestedTailGate,
        runtimeConfig: renderer?.runtimeConfig,
      });
  invalidReasons.push(...wgpuTailGate.failures);
  invalidReasons.push(...evaluateCoreSelectionEvidence({
    url: url.href,
    artifactSha256: context.coreArtifact?.sha256,
    diagnostics: renderer,
  }).failures);
  invalidReasons.push(...evaluateWgpuOutputContractEvidence({
    video: scenario.params.video,
    requestedProbe: scenario.params.wgpurenderprobe,
    diagnostics: renderer,
  }).failures);
  invalidReasons.push(...evaluateWgpuDiagnosticLogFilterEvidence({
    requested: scenario.params.wgpudiagquiet,
    diagnostics: renderer,
  }).failures);
  if (!saveStateLoad?.loaded) invalidReasons.push("fixed battle save did not load before timing");
  const postLoadInputDelivery = summarizePostLoadInputDelivery(inputEvents, {
    expectedCount: context.postLoadInputScript.length,
    maxLatenessMs: context.inputMaxLatenessMs,
  });
  invalidReasons.push(...postLoadInputDelivery.failures);
  if (fixedEmulatedWork.enabled && fixedEmulatedWork.deltasValid !== true) {
    invalidReasons.push("fixed emulated work did not produce valid non-negative tick/frame/time deltas");
  }
  if (fixedEmulatedWork.enabled && fixedEmulatedWork.reachedTarget !== true) {
    invalidReasons.push(
      `fixed emulated work target was not reached before the ${context.durationSeconds}s wall-time cap`
    );
  }
  if (!finalScreenshotCaptured && samples.length) invalidReasons.push("final screenshot was not captured");
  const fatalEvidence = findFatalRuntimeEvidence({
    consoleLines,
    statuses: samples.flatMap((sample) => [sample.status, sample.statusPill]).filter(Boolean),
    renderer: renderer || {},
  });
  invalidReasons.push(...fatalEvidence.map((entry) => `fatal runtime evidence: ${entry}`));

  const summary = summarizeScenario(
    scenario,
    url.href,
    samples,
    scenarioDir,
    consoleLines,
    consoleErrors,
    invalidReasons,
    { expectedInputEvents: context.postLoadInputScript.length, renderer }
  );
  summary.metrics.softwareRasterInstrumentation = softwareRasterInstrumentation;
  summary.metrics.wgpuProducerProfile = wgpuProducerProfile;
  summary.metrics.wgpuDrawProfile = wgpuDrawProfile;
  summary.metrics.wgpuTailGate = wgpuTailGate;
  summary.metrics.fixedEmulatedWork = fixedEmulatedWork;
  summary.fixedEmulatedWork = fixedEmulatedWork;
  summary.postTimedReplayQuiescence = postTimedReplayQuiescence;
  summary.postRunCorrectness = postRunCorrectness;
  summary.finalScreenshotSemantics = finalScreenshotSemantics;
  summary.fixedSceneMeasurementBoundary =
    manifest?.benchmark?.fixedSceneMeasurementBoundary ?? null;
  if (uploadProbeMode) {
    const probe =
      postRunFinalizedTelemetry?.causalTelemetry?.webgpu?.rendererWorkerProbe ??
      summary.final?.causalTelemetry?.webgpu?.rendererWorkerProbe;
    summary.uploadProbeWorkload = {
      requested: scenario.params.wgpurenderprobe,
      coreSha256: context.coreArtifact?.sha256 ?? null,
      saveStateSha256: context.saveFixture?.sha256 ?? null,
      checkpointTicks:
        manifest.benchmark?.rendererWorkerProbeMeasurementBoundary?.checkpoint?.loadedCheckpointTicks ??
        manifest.benchmark?.rendererWorkerProbeMeasurementBoundary?.checkpoint?.coreTicks ?? null,
      checkpointPpcPc:
        manifest.benchmark?.rendererWorkerProbeMeasurementBoundary?.checkpoint?.loadedCheckpointPpcPc ??
        manifest.benchmark?.rendererWorkerProbeMeasurementBoundary?.checkpoint?.ppcPc ?? null,
      actualCoreTickDelta: fixedEmulatedWork.actualCoreTickDelta,
      actualFrameDelta: fixedEmulatedWork.actualFrameDelta,
      observedRecordCount: probe?.observedRecordCount ?? null,
      totalUploadBytes: probe?.totalUploadBytes ?? null,
      submissionCount: probe?.submissionCount ?? null,
      opHistogram: Array.isArray(probe?.opHistogram) ? [...probe.opHistogram] : null,
      submitDigests: Array.isArray(probe?.submitDigests) ? [...probe.submitDigests] : null,
      streamDigest: probe?.streamDigest ?? null,
    };
  }
  summary.postLoadInput = {
    mode: context.postLoadInputScript.length ? "post-load-only" : "none",
    scheduledEventCount: context.postLoadInputScript.length,
    deliveredEventCount: inputEvents.length,
    markerReadiness: inputMarkerReadiness,
    events: inputEvents,
    delivery: postLoadInputDelivery,
  };
  summary.jitCacheReadiness = jitCacheReadiness;
  summary.audioMode = context.audioMode;
  summary.browserCpuAffinity = browserLaunch?.cpuAffinity || {
    enabled: context.browserCpuAffinity.enabled,
    requested: context.browserCpuAffinity.enabled
      ? { processId: process.pid, mask: context.browserCpuAffinity.requestedMask }
      : null,
    snapshot: null,
    applied: null,
    restored: null,
  };
  summary.audioModeApplication = audioModeApplication;
  summary.audioClaimQualification = evaluateAudioClaimQualification({
    audioMode: context.audioMode,
    headed: context.headed,
    qualificationEligible: false,
  });
  summary.audioClaimsEligible = false;
  if (manifest) {
    manifest.finishedAt = new Date().toISOString();
    manifest.benchmark.fixedEmulatedWork = fixedEmulatedWork;
    if (renderer) manifest.renderer = renderer;
    manifest.fixture.saveStateLoaded = Boolean(saveStateLoad?.loaded);
    manifest.fixture.loadResult = saveStateLoad;
    manifest.qualification = withAudioClaimQualification(
      evaluateQualificationProvenance(manifest),
      context
    );
    try {
      assertRunProvenance(manifest);
    } catch (error) {
      if (!summary.invalidReasons.includes(error.message)) summary.invalidReasons.push(error.message);
      summary.valid = false;
    }
    manifest.result = {
      valid: summary.valid,
      invalidReasons: summary.invalidReasons,
      sampleCount: samples.length,
      summaryFile: "summary.json",
      samplesFile: "samples.json",
      eventsFile: "events.jsonl",
      inputEventsFile: "input-events.json",
      consoleFile: "console.log",
      screenshotFile: finalScreenshotCaptured ? "final.png" : null,
      screenshotSemantics: finalScreenshotSemantics,
      fixedEmulatedWork,
      jitCacheReadiness,
      audioMode: context.audioMode,
      audioClaimsEligible: manifest.qualification.audioClaims.eligible,
    };
    summary.qualification = manifest.qualification;
    summary.audioClaimsEligible = manifest.qualification.audioClaims.eligible;
    summary.audioClaimQualification = manifest.qualification.audioClaims;
    await writeFile(path.join(scenarioDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }
  await Promise.all([
    writeFile(path.join(scenarioDir, "console.log"), consoleLines.join("\n")),
    writeFile(path.join(scenarioDir, "samples.json"), JSON.stringify(samples, null, 2)),
    writeFile(path.join(scenarioDir, "samples.csv"), recordsToCsv(samples)),
    writeFile(path.join(scenarioDir, "input-events.json"), JSON.stringify({
      markerReadiness: inputMarkerReadiness,
      events: inputEvents,
    }, null, 2)),
    writeFile(
      path.join(scenarioDir, "events.jsonl"),
      runEventsJsonl(manifest, saveStateLoad, inputEvents, samples)
    ),
    writeFile(path.join(scenarioDir, "summary.json"), JSON.stringify(summary, null, 2)),
  ]);
  return summary;
}

function evaluateMetricsOffWgpuTailGate({ requested, runtimeConfig } = {}) {
  if (requested == null) return { required: false, failures: [] };
  const expectedEnabled = String(requested) === "1";
  const tailGate = runtimeConfig?.tailGate;
  const failures = [];
  if (expectedEnabled) {
    failures.push("wgputailgate=1 requires metrics=1");
  }
  if (tailGate?.requested !== expectedEnabled || tailGate?.enabled !== expectedEnabled) {
    failures.push(
      `WGPU tail gate runtime mismatch: requested=${expectedEnabled ? 1 : 0} ` +
      `capturedRequested=${tailGate?.requested == null
        ? "unavailable"
        : tailGate.requested ? 1 : 0} ` +
      `active=${tailGate?.enabled == null ? "unavailable" : tailGate.enabled ? 1 : 0}`
    );
  }
  return {
    required: true,
    expectedEnabled,
    activated: tailGate?.enabled === true,
    schema: tailGate?.schema ?? null,
    runtimeConfig: tailGate ?? null,
    failures,
  };
}

function summarizeScenario(
  scenario,
  url,
  samples,
  scenarioDir,
  consoleLines,
  consoleErrors,
  invalidReasons,
  { expectedInputEvents = 0, renderer = null } = {}
) {
  const timedWindow = samples;
  const windows = summarizeTimedMetricWindows(samples, scenario.assertAfterSeconds);
  const steadyStateWindow = windows.steadyStateWindow;
  const final = samples.at(-1) || {};
  const runtimeConfigEvidence = evaluateWgpuRuntimeConfigEvidence({
    required: scenario.params?.video === "wgpu",
    runtimeConfig: renderer?.runtimeConfig,
    params: scenario.params,
  });
  const observedWgpu = final.causalTelemetry?.webgpu ?? runtimeConfigEvidence.runtimeConfig;
  const helperText = timedWindow.map((sample) => sample.helper || "").join(" | ");
  const fullTimedWindow = windows.fullTimedWindow.metrics;
  const steadyState = steadyStateWindow.metrics;
  const causalFairness = summarizeCausalFairness(timedWindow, { expectedInputEvents });
  const dirtyRangeProjection = evaluateWgpuDirtyRangeProjection(timedWindow);
  const sparseUbo = evaluateWgpuSparseUboEvidence({
    requested: scenario.params?.wgpuubosparse,
    samples: timedWindow,
  });
  const uboComputeProjection = evaluateWgpuUboComputeProjectionEvidence({
    requested: scenario.params?.wgpuubocomputeprojection,
    samples: timedWindow,
  });
  const metrics = {
    fullTimedWindow,
    steadyState,
    jit: summarizeJitMetrics(timedWindow),
    // Compatibility aliases now explicitly point at the complete timed
    // window. Consumers that exclude warmup must request steadyState.*.
    gameSpeed: fullTimedWindow.gameSpeed,
    coreFps: fullTimedWindow.coreFps,
    presentationFps: fullTimedWindow.presentationFps,
    visualFps: fullTimedWindow.visualFps,
    minPresentFps: fullTimedWindow.presentationFps?.min || 0,
    minCoreFps: fullTimedWindow.coreFps?.min || 0,
    minGameSpeed: fullTimedWindow.gameSpeed?.min || 0,
    maxGapMs: maxRegex(timedWindow.map((sample) => sample.gap || "").join(" "), /(\d+(?:\.\d+)?)\s+max/g),
    maxXfbDtMs: Math.max(0, ...timedWindow.map((sample) => sample.coreXfbMaxIntervalMs || 0)),
    maxGlError: lastMatch(helperText, /glerr:(0x[0-9a-f]+)/gi) || "unknown",
    emitfail: maxRegex(helperText, /emitfail:(\d+)/g),
    compilefail: maxRegex(helperText, /compilefail:(\d+)/g),
    presentationUnderrun: maxRegex(helperText, /underrun:(\d+)/g),
    // Deprecated alias retained so existing artifact readers do not break.
    underrun: maxRegex(helperText, /underrun:(\d+)/g),
    drop: maxRegex(helperText, /drop:(\d+)/g),
    causalFairness,
    wgpuDirtyRangeProjection: dirtyRangeProjection,
    wgpuSparseUbo: sparseUbo,
    wgpuUboComputeProjection: uboComputeProjection,
    wgpuOwnershipTrace: final.causalTelemetry?.webgpu?.ownershipTrace ?? null,
    visibleChangedCount: timedWindow.filter((sample) => sample.visibleChanged).length,
    readableCanvasSamples: timedWindow.filter((sample) => sample.visibleHash && !sample.visibleError).length,
  };
  const failures = [];
  failures.push(...runtimeConfigEvidence.failures);
  const warnings = [];
  const targetFailures = [];
  const targetIssue = (message) => {
    targetFailures.push(message);
    (shouldFailScenarioTargets(scenario) ? failures : warnings).push(message);
  };
  if (metrics.emitfail > 0) failures.push(`emitfail=${metrics.emitfail}`);
  if (metrics.compilefail > 0) failures.push(`compilefail=${metrics.compilefail}`);
  failures.push(...sparseUbo.failures);
  failures.push(...uboComputeProjection.failures);
  failures.push(...causalFairness.failures);
  const requestedDirtyRanges = scenario.params?.wgpudirtyranges;
  if (requestedDirtyRanges != null) {
    const expectedActive = String(requestedDirtyRanges) === "1";
    const snapshot = final.causalTelemetry?.webgpu?.dirtyRangeProjection;
    if (
      snapshot?.requested !== expectedActive ||
      snapshot?.active !== expectedActive ||
      snapshot?.enabled !== expectedActive
    ) {
      failures.push(
        `WGPU dirty-range projection mismatch: requested=${expectedActive ? 1 : 0} ` +
        `capturedRequested=${snapshot?.requested == null ? "unavailable" : snapshot.requested ? 1 : 0} ` +
        `active=${snapshot?.active == null ? "unavailable" : snapshot.active ? 1 : 0} ` +
        `enabled=${snapshot?.enabled == null ? "unavailable" : snapshot.enabled ? 1 : 0}`
      );
    }
    if (expectedActive) failures.push(...dirtyRangeProjection.failures);
  }
  if (metrics.minPresentFps < scenario.thresholds.minPresentFps) {
    targetIssue(`min present FPS ${metrics.minPresentFps} < ${scenario.thresholds.minPresentFps}`);
  }
  if (metrics.minCoreFps < scenario.thresholds.minCoreFps) {
    targetIssue(`min core FPS ${metrics.minCoreFps} < ${scenario.thresholds.minCoreFps}`);
  }
  if (metrics.minGameSpeed < scenario.thresholds.minGameSpeed) {
    targetIssue(`min game speed ${metrics.minGameSpeed}% < ${scenario.thresholds.minGameSpeed}%`);
  }
  if (metrics.maxGapMs > scenario.thresholds.maxGapMs) {
    targetIssue(`max frame gap ${metrics.maxGapMs}ms > ${scenario.thresholds.maxGapMs}ms`);
  }
  if (scenario.thresholds.requireVisibleChange && metrics.visibleChangedCount === 0) {
    targetIssue("no visible canvas hash changes during the timed window");
  }
  if (scenario.thresholds.requireNoGlError && metrics.maxGlError !== "0x0") {
    invalidReasons.push(`GL error ${metrics.maxGlError}`);
  }
  const requestedUploadTransport = scenario.params?.wgpuuploadtransport;
  if (requestedUploadTransport) {
    const activeUploadTransport = observedWgpu?.uploadTransport;
    if (activeUploadTransport !== requestedUploadTransport) {
      failures.push(
        `WGPU upload transport mismatch: requested=${requestedUploadTransport} ` +
        `active=${activeUploadTransport ?? "unavailable"}`
      );
    }
  }
  const requestedUboPack = scenario.params?.wgpuubopack;
  if (requestedUboPack != null) {
    const expectedUboPack = String(requestedUboPack) === "1";
    const activeUboPack = observedWgpu?.uboPackEnabled;
    if (activeUboPack !== expectedUboPack) {
      failures.push(
        `WGPU UBO pack mismatch: requested=${expectedUboPack ? 1 : 0} ` +
        `active=${activeUboPack == null ? "unavailable" : activeUboPack ? 1 : 0}`
      );
    }
  }
  const requestedUboMetrics = scenario.params?.wgpuubometrics;
  if (requestedUboMetrics != null) {
    const expectedUboMetrics = String(requestedUboMetrics) === "1";
    const activeUboMetrics = observedWgpu?.producerUboCacheMetricsEnabled;
    if (activeUboMetrics !== expectedUboMetrics) {
      failures.push(
        `WGPU UBO metrics mismatch: requested=${expectedUboMetrics ? 1 : 0} ` +
        `active=${activeUboMetrics == null ? "unavailable" : activeUboMetrics ? 1 : 0}`
      );
    }
    if (expectedUboMetrics &&
        observedWgpu?.producerUboChangeAvailable !== true) {
      failures.push("WGPU UBO change-attribution schema is unavailable or malformed");
    }
  }
  const requestedUniformFast = scenario.params?.wgpuuniformfast;
  if (requestedUniformFast != null) {
    const expectedUniformFast = String(requestedUniformFast) === "1";
    const activeUniformFast = observedWgpu?.producerUniformFastEnabled;
    if (activeUniformFast !== expectedUniformFast) {
      failures.push(
        `WGPU uniform fast mismatch: requested=${expectedUniformFast ? 1 : 0} ` +
        `active=${activeUniformFast == null ? "unavailable" : activeUniformFast ? 1 : 0}`
      );
    }
  }
  const requestedMappedStageFast = scenario.params?.wgpustagefast;
  const requestedMappedStageTiming = scenario.params?.wgpumappedtiming;
  const requestedMappedStagingSlots = scenario.params?.wgpustagingslots;
  if (requestedMappedStagingSlots != null) {
    const expectedMappedStagingSlots = wgpuMappedStagingSlotCountOf(String(requestedMappedStagingSlots));
    const activeMappedStagingSlots = observedWgpu?.mappedStaging?.slotCount;
    if (activeMappedStagingSlots !== expectedMappedStagingSlots) {
      failures.push(
        `WGPU mapped staging slot-count mismatch: requested=${expectedMappedStagingSlots} ` +
        `active=${activeMappedStagingSlots ?? "unavailable"}`
      );
    }
  }
  const requestedMappedStagingSlotMib = scenario.params?.wgpustagingslotmib;
  if (requestedMappedStagingSlotMib != null) {
    const expectedSlotBytes = wgpuMappedStagingSlotMibOf(requestedMappedStagingSlotMib) * 1024 * 1024;
    const activeSlotBytes = observedWgpu?.mappedStaging?.slotBytes;
    if (activeSlotBytes !== expectedSlotBytes) {
      failures.push(
        `WGPU mapped staging slot-size mismatch: requested=${expectedSlotBytes} ` +
        `active=${activeSlotBytes ?? "unavailable"}`
      );
    }
  }
  if (requestedMappedStageFast != null) {
    const expectedMappedStageFast = String(requestedMappedStageFast) === "1";
    const activeMappedStageFast = observedWgpu?.mappedStagingFastPath;
    if (activeMappedStageFast !== expectedMappedStageFast) {
      failures.push(
        `WGPU mapped staging fast-path mismatch: requested=${expectedMappedStageFast ? 1 : 0} ` +
        `active=${activeMappedStageFast == null ? "unavailable" : activeMappedStageFast ? 1 : 0}`
      );
    }
    const recordStore = observedWgpu?.mappedStaging?.recordStore;
    if (expectedMappedStageFast && recordStore !== "flat") {
      failures.push(
        `WGPU mapped staging record store mismatch: requested=flat ` +
        `active=${recordStore ?? "unavailable"}`
      );
    }
  }
  if (requestedMappedStageTiming != null) {
    const expectedMappedStageTiming = String(requestedMappedStageTiming) === "64" ? 64 : 1;
    const activeMappedStageTiming =
      observedWgpu?.uploadAttribution?.mappedStageTiming?.stride;
    if (activeMappedStageTiming !== expectedMappedStageTiming) {
      failures.push(
        `WGPU mapped staging timing mismatch: requested=${expectedMappedStageTiming} ` +
        `active=${activeMappedStageTiming ?? "unavailable"}`
      );
    }
  }
  const requestedMappedDrainCoalescing = scenario.params?.wgpudraincoalesce;
  if (requestedMappedDrainCoalescing != null) {
    const expectedMappedDrainCoalescing = String(requestedMappedDrainCoalescing) === "1";
    const activeMappedDrainCoalescing =
      final.causalTelemetry?.webgpu?.mappedDrainCoalescingEnabled;
    if (activeMappedDrainCoalescing !== expectedMappedDrainCoalescing) {
      failures.push(
        `WGPU mapped drain coalescing mismatch: requested=${expectedMappedDrainCoalescing ? 1 : 0} ` +
        `active=${activeMappedDrainCoalescing == null ? "unavailable" : activeMappedDrainCoalescing ? 1 : 0}`
      );
    }
    if (expectedMappedDrainCoalescing) {
      const coalescing = final.causalTelemetry?.webgpu?.mappedDrainCoalescing;
      const staging = final.causalTelemetry?.webgpu?.mappedStaging;
      if (coalescing?.state?.deferred !== false) {
        failures.push("WGPU mapped drain coalescing ended with a deferred batch");
      }
      if ((staging?.pendingUploads ?? -1) !== 0) {
        failures.push("WGPU mapped staging ended with pending uploads");
      }
      if ((coalescing?.telemetry?.generationMismatches ?? -1) !== 0) {
        failures.push("WGPU mapped drain coalescing observed a generation mismatch");
      }
      if ((coalescing?.telemetry?.timerStale ?? -1) !== 0) {
        failures.push("WGPU mapped drain coalescing observed a stale timer callback");
      }
      if ((coalescing?.telemetry?.actualDeadlineOverrunMaxMs ?? Number.POSITIVE_INFINITY) > 4) {
        failures.push("WGPU mapped drain coalescing exceeded its 4 ms submit deadline tolerance");
      }
      if ((coalescing?.telemetry?.actualSubmissionAgeMaxMs ?? Number.POSITIVE_INFINITY) > 8) {
        failures.push("WGPU mapped drain coalescing retained uploads beyond 8 ms");
      }
      if ((coalescing?.telemetry?.deferredBoundaries ?? 0) === 0) {
        failures.push("WGPU mapped drain coalescing was enabled but never deferred work");
      }
      if ((coalescing?.telemetry?.actualSubmissions ?? 0) === 0) {
        failures.push("WGPU mapped drain coalescing was enabled but never submitted mapped work");
      }
    }
  }
  const requestedPackageProjection = scenario.params?.wgpupackageprojection;
  if (requestedPackageProjection != null) {
    const expectedPackageProjection = String(requestedPackageProjection) === "1";
    const projection = final.causalTelemetry?.webgpu?.passPackageProjection;
    const activePackageProjection = projection?.active;
    if (activePackageProjection !== expectedPackageProjection) {
      failures.push(
        `WGPU pass-package projection mismatch: requested=${expectedPackageProjection ? 1 : 0} ` +
        `active=${activePackageProjection == null ? "unavailable" : activePackageProjection ? 1 : 0}`
      );
    }
    if (expectedPackageProjection && projection?.runtimeEligible !== false) {
      failures.push("WGPU passive pass-package projection must remain runtimeEligible=false");
    }
    if (expectedPackageProjection && activePackageProjection === true) {
      const projectionHazards = [
        ["unsupported", projection?.records?.unsupported],
        ["malformed", projection?.records?.malformed],
        ["nested passes", projection?.records?.nestedPasses],
        ["state outside pass", projection?.records?.stateOutsidePass],
        ["incomplete passes", projection?.boundaries?.incompletePasses],
      ];
      if (!(Number(projection?.legacy?.records) > 0)) {
        failures.push("WGPU pass-package projection observed zero records");
      }
      if (!(Number(projection?.projected?.completePassPackages) > 0)) {
        failures.push("WGPU pass-package projection observed zero complete passes");
      }
      for (const [label, value] of projectionHazards) {
        if (!Number.isFinite(Number(value)) || Number(value) !== 0) {
          failures.push(
            `WGPU pass-package projection ${label} must be zero; got ${value ?? "unavailable"}`
          );
        }
      }
    }
  }
  const requestedOwnershipTrace = scenario.params?.wgpuownershiptrace;
  if (requestedOwnershipTrace != null) {
    const expectedOwnershipTrace = String(requestedOwnershipTrace) === "1";
    const trace = final.causalTelemetry?.webgpu?.ownershipTrace;
    if (
      trace?.requested !== expectedOwnershipTrace ||
      trace?.active !== expectedOwnershipTrace ||
      trace?.enabled !== expectedOwnershipTrace
    ) {
      failures.push(
        `WGPU ownership trace mismatch: requested=${expectedOwnershipTrace ? 1 : 0} ` +
        `capturedRequested=${trace?.requested == null ? "unavailable" : trace.requested ? 1 : 0} ` +
        `active=${trace?.active == null ? "unavailable" : trace.active ? 1 : 0}`
      );
    }
    if (expectedOwnershipTrace) {
      if (trace?.setterAvailable !== true || trace?.setterInvoked !== true) {
        failures.push("WGPU ownership trace native setter evidence unavailable");
      }
      if (trace?.registered !== true) {
        failures.push("WGPU ownership trace ring was not registered");
      }
      if (!(Number(trace?.observedRecords) > 0)) {
        failures.push("WGPU ownership trace observed zero records");
      }
      for (const [label, value] of [
        ["native dropped", trace?.nativeDropped],
        ["record epoch mismatches", trace?.recordEpochMismatchCount],
        ["ordering violations", trace?.monotonicOrderingViolationCount],
        ["malformed headers", trace?.malformedHeaderCount],
        ["malformed descriptors", trace?.malformedDescriptorCount],
      ]) {
        if (!Number.isFinite(Number(value)) || Number(value) !== 0) {
          failures.push(`WGPU ownership trace ${label}=${value ?? "unavailable"}`);
        }
      }
      const eventHistogram = trace?.eventHistogram;
      const attributionHistogram = trace?.commandAttributionHistogram;
      const publicationHistogram = trace?.commandPublicationHistogram;
      if (!Array.isArray(eventHistogram) || eventHistogram.length < 11) {
        failures.push("WGPU ownership trace event histogram unavailable");
      } else {
        for (const [label, index] of [
          ["epoch", 1],
          ["command", 2],
          ["commit", 3],
          ["load requested", 7],
          ["pending reserved", 9],
          ["pass begin", 10],
        ]) {
          if (!(Number(eventHistogram[index]) > 0)) {
            failures.push(`WGPU ownership trace observed zero ${label} events`);
          }
        }
      }
      if (!Array.isArray(attributionHistogram) || attributionHistogram.length !== 4) {
        failures.push("WGPU ownership trace attribution histogram unavailable");
      }
      if (!Array.isArray(publicationHistogram) || publicationHistogram.length !== 4) {
        failures.push("WGPU ownership trace publication histogram unavailable");
      }
      const commandEvents = Number(eventHistogram?.[2]);
      const attributedCommands = Array.isArray(attributionHistogram)
        ? attributionHistogram.reduce((sum, value) => sum + Number(value || 0), 0)
        : Number.NaN;
      const publishedCommands = Array.isArray(publicationHistogram)
        ? publicationHistogram.reduce((sum, value) => sum + Number(value || 0), 0)
        : Number.NaN;
      if (!Number.isFinite(commandEvents) || attributedCommands !== commandEvents) {
        failures.push("WGPU ownership trace attribution counts do not conserve commands");
      }
      if (!Number.isFinite(commandEvents) || publishedCommands !== commandEvents) {
        failures.push("WGPU ownership trace publication counts do not conserve commands");
      }
    }
  }
  failures.push(...evaluateWgpuGeometryRangeEvidence({
    requested: scenario.params?.wgpugeomrange,
    packRequested: scenario.params?.wgpugeompack,
    telemetry: observedWgpu,
  }).failures);
  failures.push(...evaluateWgpuSemanticQualificationEvidence({
    requested: scenario.params?.wgpusemantic,
    telemetry: final.causalTelemetry?.webgpu,
    loadedCheckpointGeneration:
      final.causalTelemetry?.core?.loadedCheckpointGeneration,
  }).failures);
  failures.push(...evaluateWgpuRendererWorkerProbeEvidence({
    requested: scenario.params?.wgpurenderprobe,
    telemetry: final.causalTelemetry?.webgpu,
  }).failures);
  const requestedAudioTransport = scenario.params?.audiotransport;
  if (requestedAudioTransport) {
    const activeAudioTransport = final.causalTelemetry?.audio?.activeTransport;
    if (activeAudioTransport !== requestedAudioTransport) {
      failures.push(
        `audio transport mismatch: requested=${requestedAudioTransport} ` +
        `active=${activeAudioTransport ?? "unavailable"} ` +
        `fallback=${final.causalTelemetry?.audio?.transportFallbackReason || "none"}`
      );
    }
  }
  if (!String(final.mountNote || "").includes("Dolphin")) invalidReasons.push("Dolphin did not mount");
  if (consoleLines.some((line) => /\[probe-error\]/i.test(line)) && !invalidReasons.length) {
    invalidReasons.push("probe error was recorded");
  }
  const runValidity = evaluateRunValidity({ invalidReasons, failures, consoleErrors });
  return {
    name: scenario.name,
    runId: scenario.experiment?.runId || scenario.name,
    blockId: scenario.experiment?.blockId || null,
    arm: scenario.experiment?.arm || null,
    armName: scenario.experiment?.armName || null,
    valid: runValidity.valid,
    invalidReasons: runValidity.invalidReasons,
    required: scenario.required,
    url,
    outDir: scenarioDir,
    manifestPath: path.join(scenarioDir, "manifest.json"),
    screenshot: path.join(scenarioDir, "final.png"),
    samplesPath: path.join(scenarioDir, "samples.json"),
    eventsPath: path.join(scenarioDir, "events.jsonl"),
    summaryPath: path.join(scenarioDir, "summary.json"),
    sampleCount: samples.length,
    timedWindow: {
      ...windows.fullTimedWindow,
    },
    steadyStateWindow: {
      ...steadyStateWindow,
    },
    thresholds: scenario.thresholds,
    metrics,
    final,
    failures,
    targetFailures,
    warnings,
  };
}

function selectedScenarios() {
  const softwareParams = {
    core: "upstream",
    video: process.env.VIDEO || "software",
    cpu: process.env.CPU || "dual",
    speed: process.env.SPEED || "1",
    present: process.env.PRESENT || "full",
    presenter: process.env.PRESENTER || "webgpu",
    pacing: process.env.PACING || "tick",
    wasmjit: process.env.WASMJIT ?? "1",
    jittier: process.env.JITTIER || "guarded",
    jitwarmup: process.env.JITWARMUP || "700",
    oc: process.env.OC || "1",
    queue: process.env.QUEUE_SIZE || "2",
    fastsw: process.env.FASTSW || "1",
    metrics: process.env.METRICS || "1",
  };
  for (const name of ["disable", "regalloc", "smearcompile", "blockmerge", "shortprefix", "fastmemhoist", "nogamepad", "nojitcache", "xfbfast", "gpucomplete", "inputlatency", "inputphoton", "inputphotonsize", "inputphotonx", "inputphotony", "audiotransport", "ppcprof", "wgpustatecache", "wgpuubocache", "wgpuubometrics", "wgpuuniformfast", "wgpupackageprojection", "wgpuuploadrunprojection", "wgpuubocomputeprojection", "wgpuubocompute", "wgpuownershiptrace", "wgpusemantic", "wgpuubopack", "wgpuubosparse", "wgpugeompack", "wgpugeomrange", "wgpuuploadmb", "wgpuuploadtransport", "wgpustagingslots", "wgpustagingslotmib", "wgpustagefast", "wgpumappedtiming", "wgpudraincoalesce", "wgpurenderprobe", "wgpudirtyranges", "wgpuprodprofile", "wgputailgate", "wgpudiagquiet", "wgpureplayms", "wgpupower", "swtevfast", "swtevshadow"]) {
    const envName = name.toUpperCase();
    if (process.env[envName] != null) softwareParams[name] = process.env[envName];
  }
  const blankUploadProbe = ["inline-upload", "worker-upload", "null-drain"].includes(
    softwareParams.wgpurenderprobe
  );
  const all = [
    {
      name: "software-stable",
      required: true,
      assertAfterSeconds: numberEnv("ASSERT_AFTER_SECONDS", 5),
      params: softwareParams,
      thresholds: {
        minPresentFps: blankUploadProbe ? 0 : numberEnv("SOFTWARE_MIN_PRESENT_FPS", 50),
        minCoreFps: numberEnv("SOFTWARE_MIN_CORE_FPS", 55),
        minGameSpeed: numberEnv("SOFTWARE_MIN_GAME_SPEED", 95),
        maxGapMs: numberEnv("SOFTWARE_MAX_GAP_MS", 90),
        requireVisibleChange: !blankUploadProbe,
        requireNoGlError: false,
      },
    },
    {
      name: "ogl-hardware",
      required: false,
      assertAfterSeconds: numberEnv("ASSERT_AFTER_SECONDS", 5),
      params: {
        ...softwareParams,
        video: "ogl",
        presenter: "webgl",
        present: "half",
        oglproxy: process.env.OGL_PROXY_MODE || "proxy",
        wasmjit: process.env.OGL_WASMJIT || "0",
        jittier: "mixed",
        queue: "8",
      },
      thresholds: {
        minPresentFps: numberEnv("OGL_MIN_PRESENT_FPS", 1),
        minCoreFps: numberEnv("OGL_MIN_CORE_FPS", 45),
        minGameSpeed: numberEnv("OGL_MIN_GAME_SPEED", 80),
        maxGapMs: numberEnv("OGL_MAX_GAP_MS", 600),
        requireVisibleChange: true,
        requireNoGlError: false,
      },
    },
  ];
  const requested = (process.env.PERF_SCENARIOS || "software-stable")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const selected = all.filter((scenario) => requested.includes(scenario.name));
  if (!selected.length) throw new Error(`PERF_SCENARIOS did not select a known scenario: ${requested.join(",")}`);
  return selected;
}

async function waitForMount(page, scenarioDir) {
  for (let second = 0; second <= 180; second += 1) {
    const mounted = await page.evaluate(() => {
      const coreMode = document.querySelector("#coreMode")?.textContent?.trim() ?? "";
      const mountNote = document.querySelector("#mountNote")?.textContent?.trim() ?? "";
      const status = document.querySelector("#statusPill")?.textContent?.trim() ?? "";
      return { mounted: coreMode === "Dolphin" && mountNote.includes("Dolphin"), coreMode, mountNote, status };
    });
    if (mounted.mounted) return;
    if (/failed|error/i.test(mounted.status)) {
      await saveScreenshot(page, scenarioDir, "mount-error.png");
      throw new Error(`Core mount failed: ${mounted.status}`);
    }
    await page.waitForTimeout(1000);
  }
  await saveScreenshot(page, scenarioDir, "mount-timeout.png");
  throw new Error("Timed out waiting for Dolphin upstream core mount");
}

async function waitForCoreReady(page) {
  let readiness = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    readiness = await page.evaluate(() => {
      const info = window.__lastFrameInfo || {};
      return {
        frame: Number(info.frame) || 0,
        coreTicks: Number(info.coreTicks) || 0,
        running: Boolean(info.running),
      };
    });
    if (readiness.running && readiness.frame >= 30 && readiness.coreTicks > 0) return readiness;
    await page.waitForTimeout(250);
  }
  throw new Error(`Core did not become ready for save-state load: ${JSON.stringify(readiness)}`);
}

async function pauseForBattleCheckpoint(page) {
  const response = await requestWorkerRpc(page, "validationSetCorePaused", { paused: true });
  if (!response?.paused || response?.coreStateName !== "Paused") {
    throw new Error(`Core did not enter paused state before fixed save load: ${JSON.stringify(response)}`);
  }
  return response;
}

async function establishFixedSceneMeasurementBoundary(
  page,
  saveStateUrl,
  expectedCheckpoint,
  {
    jitCacheReadinessRequired = false,
    jitCacheReadyTimeoutMs = 120_000,
    wgpuReplayRequired = false,
  } = {}
) {
  let pause = null;
  let jitCacheReadiness = { required: false, ready: true, reason: "disabled-by-scenario" };
  let pausedJitCacheReadiness = null;
  let jitCacheFenceAttempts = 0;
  if (jitCacheReadinessRequired) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      jitCacheFenceAttempts = attempt;
      jitCacheReadiness = await waitForStableJitCacheReadiness(page, {
        timeoutMs: jitCacheReadyTimeoutMs,
      });
      pause = await pauseForBattleCheckpoint(page);
      pausedJitCacheReadiness = await requestWorkerRpc(
        page,
        "validationReadJitCacheReadiness",
        {},
        workerRpcTimeoutMs()
      );
      const pausedEvaluation = evaluateJitCacheReadiness(pausedJitCacheReadiness);
      const countersStable =
        jitCacheReadinessSignature(pausedJitCacheReadiness) ===
        jitCacheReadinessSignature(jitCacheReadiness.final);
      if (pausedEvaluation.ready && countersStable) break;
      if (attempt === 3) {
        throw new Error(
          "JIT cache changed between the running-worker barrier and pause: " +
          JSON.stringify({ before: jitCacheReadiness.final, after: pausedJitCacheReadiness })
        );
      }
      await resumeAfterBattleCheckpoint(page);
      pause = null;
    }
  } else {
    pause = await pauseForBattleCheckpoint(page);
  }
  const replayQuiescence = await finalizeWgpuReplay(page, {
    required: wgpuReplayRequired,
  });
  const reload = await loadStateFileWithTimeout(page, saveStateUrl);
  if (!reload?.loaded) {
    throw new Error(
      `Fixed-scene measurement save reload failed: ${reload?.error || JSON.stringify(reload)}`
    );
  }
  const checkpoint = assertBattleCheckpoint(
    parseBattleCheckpoint(reload),
    expectedCheckpoint
  );
  if (Number(checkpoint.coreTicks) !== Number(expectedCheckpoint.coreTicks)) {
    throw new Error(
      `Fixed-scene measurement requires canonical tick ${expectedCheckpoint.coreTicks}, ` +
      `got ${checkpoint.coreTicks}`
    );
  }
  const progress = await requestWorkerRpc(page, "validationReadCoreProgress", {}, 5000);

  const requiredFinite = [
    "coreTicks",
    "coreTicksPerSecond",
    "frame",
    "ppcPc",
    "loadedCheckpointGeneration",
    "loadedCheckpointTicks",
    "loadedCheckpointPpcPc",
  ];
  const invalid = requiredFinite.filter((field) => !Number.isFinite(Number(progress?.[field])));
  if (invalid.length > 0 || Number(progress.coreTicksPerSecond) <= 0) {
    throw new Error(
      `Fixed-scene worker progress is incomplete: ${invalid.join(", ") || "coreTicksPerSecond"}`
    );
  }
  const mismatches = [];
  if (Number(progress.coreTicks) !== Number(checkpoint.coreTicks)) {
    mismatches.push(`coreTicks ${progress.coreTicks} != ${checkpoint.coreTicks}`);
  }
  if (Number(progress.ppcPc) !== Number(checkpoint.ppcPc)) {
    mismatches.push(`ppcPc ${progress.ppcPc} != ${checkpoint.ppcPc}`);
  }
  if (Number(progress.loadedCheckpointTicks) !== Number(checkpoint.coreTicks)) {
    mismatches.push(
      `loadedCheckpointTicks ${progress.loadedCheckpointTicks} != ${checkpoint.coreTicks}`
    );
  }
  if (Number(progress.loadedCheckpointPpcPc) !== Number(checkpoint.ppcPc)) {
    mismatches.push(
      `loadedCheckpointPpcPc ${progress.loadedCheckpointPpcPc} != ${checkpoint.ppcPc}`
    );
  }
  if (
    Number(progress.loadedCheckpointGeneration) !==
    Number(checkpoint.loadedCheckpointGeneration)
  ) {
    mismatches.push(
      `loadedCheckpointGeneration ${progress.loadedCheckpointGeneration} != ` +
      `${checkpoint.loadedCheckpointGeneration}`
    );
  }
  if (mismatches.length > 0) {
    throw new Error(`Fixed-scene measurement boundary drifted while paused: ${mismatches.join("; ")}`);
  }

  return {
    pause,
    jitCacheReadiness,
    pausedJitCacheReadiness,
    jitCacheFenceAttempts,
    replayQuiescence,
    reload,
    checkpoint,
    progress,
    signature: {
      coreTicks: checkpoint.coreTicks,
      ppcPc: checkpoint.ppcPc,
      xfbHash: checkpoint.xfbHash,
      width: checkpoint.width,
      height: checkpoint.height,
    },
  };
}

async function resumeAfterBattleCheckpoint(page) {
  const response = await page.evaluate(async ({ timeoutMs }) => {
    const host = window.__host;
    if (!host?.adapter?.request) throw new Error("Validator cannot resume the active adapter");
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Worker RPC validationSetCorePaused timed out after ${timeoutMs} ms`)),
        timeoutMs
      );
      Promise.resolve(host.adapter.request("validationSetCorePaused", { paused: false })).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
    host.adapter.applyFrame?.(result);
    host.adapter.onStatus?.("Save state loaded (Running)");
    return result;
  }, { timeoutMs: workerRpcTimeoutMs() });
  if (response?.coreStateName !== "Running") {
    throw new Error(`Core did not resume after battle checkpoint: ${JSON.stringify(response)}`);
  }
  return response;
}

async function finalizeWgpuReplay(page, { required = false } = {}) {
  const timeoutMs = Math.max(workerRpcTimeoutMs(), 30_000);
  const response = await requestWorkerRpc(
    page,
    "validationFinalizeWgpuReplay",
    { timeoutMs, requireRing: required },
    timeoutMs + 1000
  );
  const replayQuiescence = response?.replayQuiescence;
  if (
    !replayQuiescence?.quiesced ||
    replayQuiescence.backlog !== 0 ||
    replayQuiescence.readIndex !== replayQuiescence.publishedReadIndex ||
    replayQuiescence.coreStateName !== "Paused" ||
    (required && !replayQuiescence.registered)
  ) {
    throw new Error(
      `WGPU replay did not quiesce: ${JSON.stringify(replayQuiescence)}`
    );
  }
  return replayQuiescence;
}

async function readRendererDiagnostics(page) {
  const diagnostics = await requestWorkerRpc(page, "rendererDiagnostics");
  return diagnostics || {
    requestedVideoBackend: null,
    activeVideoBackend: "unknown",
    requestedPresenterBackend: null,
    activePresenterBackend: "unknown",
    errors: [],
    statusHistory: [],
  };
}

async function requestWorkerRpc(page, type, payload = {}, timeoutMs = workerRpcTimeoutMs()) {
  return page.evaluate(async ({ type, payload, timeoutMs }) => {
    const adapter = window.__host?.adapter;
    if (!adapter?.request) throw new Error(`Active adapter does not expose worker RPC ${type}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Worker RPC ${type} timed out after ${timeoutMs} ms`)),
        timeoutMs
      );
      Promise.resolve(adapter.request(type, payload)).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }, { type, payload, timeoutMs });
}

async function waitForStableJitCacheReadiness(page, { timeoutMs, pollIntervalMs = 250 }) {
  const startedAt = Date.now();
  const snapshots = [];
  let previousSignature = null;
  let stableReadySamples = 0;
  while (Date.now() - startedAt <= timeoutMs) {
    const snapshot = await requestWorkerRpc(
      page,
      "validationReadJitCacheReadiness",
      {},
      Math.min(workerRpcTimeoutMs(), timeoutMs)
    );
    const evaluation = evaluateJitCacheReadiness(snapshot);
    const signature = jitCacheReadinessSignature(snapshot);
    snapshots.push({ ...snapshot, evaluation });
    if (snapshots.length > 8) snapshots.shift();
    if (evaluation.ready && signature === previousSignature) {
      stableReadySamples += 1;
    } else {
      stableReadySamples = evaluation.ready ? 1 : 0;
    }
    if (stableReadySamples >= 2) {
      return {
        required: true,
        ready: true,
        waitedMs: Date.now() - startedAt,
        stableReadySamples,
        final: snapshot,
        snapshots,
      };
    }
    previousSignature = signature;
    await page.waitForTimeout(pollIntervalMs);
  }
  const final = snapshots.at(-1) || null;
  throw new Error(
    `JIT cache did not reach stable readiness within ${timeoutMs} ms: ${JSON.stringify(final)}`
  );
}

function jitCacheReadinessSignature(snapshot) {
  return JSON.stringify({
    cacheSize: Number(snapshot?.cacheSize),
    newCompileCount: Number(snapshot?.newCompileCount),
    idbWriteCount: Number(snapshot?.idbWriteCount),
    lazyFillAddedEntries: Number(snapshot?.lazyFillAddedEntries),
    pthreadBarrierGeneration: Number(snapshot?.pthreadBarrierGeneration),
    pthreadBarrierAcked: Number(snapshot?.pthreadBarrierAcked),
    pthreadRequiredBarrierAcked: Number(snapshot?.pthreadRequiredBarrierAcked),
  });
}

async function loadStateFileWithTimeout(page, saveUrl) {
  return page.evaluate(async ({ saveUrl, timeoutMs }) => {
    if (typeof window.__loadStateFile !== "function") {
      throw new Error("Fixed-state loader is unavailable");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Worker RPC loadStateFile timed out after ${timeoutMs} ms`)),
        timeoutMs
      );
      Promise.resolve(window.__loadStateFile(saveUrl)).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }, { saveUrl, timeoutMs: Math.max(workerRpcTimeoutMs(), 30000) });
}

function workerRpcTimeoutMs() {
  return Math.max(1000, numberEnv("PERF_WORKER_RPC_TIMEOUT_MS", 10000));
}

function withExpectedRendererIdentity(diagnostics, params = {}) {
  const expectedVideoBackend = expectedDolphinVideoBackend(params.video);
  const expectedRequestedPresenterBackend = normalizePresenterIdentity(params.presenter);
  const uploadProbe = ["inline-upload", "worker-upload", "null-drain"].includes(
    params.wgpurenderprobe
  );
  const expectedActivePresenterBackend = uploadProbe
    ? "wgpu-upload-probe"
    : expectedVideoBackend === "OGL" ? "ogl" : expectedRequestedPresenterBackend;
  return {
    ...diagnostics,
    expectedVideoBackend,
    expectedRequestedPresenterBackend,
    expectedActivePresenterBackend,
  };
}

function expectedDolphinVideoBackend(value) {
  const normalized = String(value || "software").toLowerCase();
  if (normalized === "ogl") return "OGL";
  if (normalized === "null") return "Null";
  if (normalized === "webgpu") return "WebGPU";
  if (["wgpu", "webgpu-real", "webgpu2"].includes(normalized)) return "WebGPU-Real";
  return "Software Renderer";
}

function normalizePresenterIdentity(value) {
  const normalized = String(value || "webgl").toLowerCase();
  if (["webgpu", "wgpu"].includes(normalized)) return "webgpu";
  if (["2d", "canvas"].includes(normalized)) return "2d";
  return "webgl";
}

async function waitForPostLoadProgress(page) {
  let first = null;
  let latest = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    latest = await page.evaluate(() => {
      const info = window.__lastFrameInfo || {};
      return {
        frame: Number(info.frame) || 0,
        coreTicks: Number(info.coreTicks) || 0,
        running: Boolean(info.running),
      };
    });
    if (latest.running && latest.frame > 0 && latest.coreTicks > 0) {
      if (first && (latest.frame !== first.frame || latest.coreTicks !== first.coreTicks)) {
        return { first, latest };
      }
      first ||= latest;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Core made no verified progress after save-state load: ${JSON.stringify({ first, latest })}`);
}

async function readSample(page, elapsedSeconds) {
  return page.evaluate((elapsedSeconds) => {
    const read = (selector) => document.querySelector(selector)?.textContent?.trim() ?? "";
    const info = window.__lastFrameInfo || {};
    const observedAtMs = performance.now();
    const screen = document.querySelector("#screen");
    const state = (window.__perfGateState ??= { canvas: document.createElement("canvas"), context: null, lastHash: 0 });
    let visibleHash = 0;
    let visibleError = "";
    try {
      state.canvas.width = 96;
      state.canvas.height = 72;
      state.context ??= state.canvas.getContext("2d", { alpha: false, willReadFrequently: true });
      state.context.drawImage(screen, 0, 0, state.canvas.width, state.canvas.height);
      const bytes = state.context.getImageData(0, 0, state.canvas.width, state.canvas.height).data;
      let hash = 2166136261;
      for (let index = 0; index < bytes.length; index += 16) {
        hash ^= bytes[index];
        hash = Math.imul(hash, 16777619);
        hash ^= bytes[index + 1] ?? 0;
        hash = Math.imul(hash, 16777619);
        hash ^= bytes[index + 2] ?? 0;
        hash = Math.imul(hash, 16777619);
      }
      visibleHash = hash >>> 0;
    } catch (error) {
      visibleError = error instanceof Error ? error.message : String(error);
    }
    const visibleChanged = Boolean(visibleHash && state.lastHash && visibleHash !== state.lastHash);
    if (visibleHash) state.lastHash = visibleHash;
    return {
      elapsedSeconds,
      observedAtMs,
      frame: Number(info.frame) || Number(read("#frameCounter")) || 0,
      presentFps: Number(info.presentationFps) || Number(read("#fpsCounter")) || 0,
      visualFps: Number(info.visualChangeFps) || Number(read("#visualFpsCounter")) || 0,
      coreFps: read("#coreFpsCounter"),
      gameSpeed: read("#gameSpeedCounter"),
      gap: read("#presentationGapCounter"),
      wasmJit: read("#ppcWasmJit"),
      ppcWasmBlockCompileCount: Number(info.ppcWasmBlockCompileCount) || 0,
      ppcWasmBlockRunCount: Number(info.ppcWasmBlockRunCount) || 0,
      helper: info.ppcWasmHelperStats || read("#ppcWasmHelperStats"),
      profile: info.frameProfileStats || read("#frameProfileStats"),
      coreTicks: Number(info.coreTicks) || Number(read("#coreTicks")) || 0,
      coreTicksPerSecond: Number(info.coreTicksPerSecond) || 0,
      ppcPc: Number(info.ppcPc) || read("#ppcPc"),
      status: read("#adapterStatus"),
      statusPill: read("#statusPill"),
      coreMode: read("#coreMode"),
      gameTitle: read("#gameTitle"),
      mountNote: read("#mountNote"),
      input: read("#inputSource"),
      visibleHash,
      visibleError,
      visibleChanged,
      causalTelemetry: info.causalTelemetry || window.__causalTelemetry || null,
    };
  }, elapsedSeconds);
}

function fixedWorkObservation(value) {
  return {
    coreTicks: Number(value?.coreTicks),
    frame: Number(value?.frame),
    observedAtMs: Number(value?.observedAtMs),
  };
}

async function readInputMarkerBarrierState(page) {
  return page.evaluate(() => {
    const info = window.__lastFrameInfo || {};
    const telemetry = info.causalTelemetry || window.__causalTelemetry || null;
    const marker = telemetry?.input?.marker || null;
    return {
      available: marker?.enabled === true,
      appliedCount: Number(marker?.appliedCount) || 0,
      completedCount: Number(marker?.markerCompletedCount) || 0,
      supersededCount: Number(marker?.supersededCount) || 0,
      generationMismatchCount: Number(marker?.generationMismatchCount) || 0,
      generationUnavailableCount: Number(marker?.generationUnavailableCount) || 0,
    };
  });
}

async function waitForInputMarkerReady(page, { pollIntervalMs, timeoutMs }) {
  const startedAt = Date.now();
  let final = await readInputMarkerBarrierState(page);
  while (final.available !== true && Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(pollIntervalMs);
    final = await readInputMarkerBarrierState(page);
  }
  return {
    required: true,
    ready: final.available === true,
    waitedMs: Date.now() - startedAt,
    final,
  };
}

async function waitForInputMarkerCompletion(page, baseline, { pollIntervalMs, timeoutMs }) {
  if (baseline?.available !== true) {
    return { available: false, completed: false, waitedMs: 0, baseline, final: baseline };
  }
  const startedAt = Date.now();
  let final = baseline;
  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(pollIntervalMs);
    final = await readInputMarkerBarrierState(page);
    if (
      final.available === true &&
      final.appliedCount > baseline.appliedCount &&
      final.completedCount > baseline.completedCount
    ) {
      return {
        available: true,
        completed: true,
        waitedMs: Date.now() - startedAt,
        baseline,
        final,
      };
    }
  }
  return {
    available: true,
    completed: false,
    waitedMs: Date.now() - startedAt,
    timeoutMs,
    baseline,
    final,
  };
}

async function readFixedWorkProgress(page, { liveWorkerProgress = false } = {}) {
  if (liveWorkerProgress) {
    const progress = await requestWorkerRpc(page, "validationReadCoreProgress", {}, 5000);
    return {
      coreTicks: Number(progress?.coreTicks) || 0,
      frame: Number(progress?.frame) || 0,
      observedAtMs: Number(progress?.observedAtMs),
    };
  }
  return page.evaluate(() => {
    const info = window.__lastFrameInfo || {};
    return {
      coreTicks: Number(info.coreTicks) || 0,
      frame: Number(info.frame) || 0,
      observedAtMs: performance.now(),
    };
  });
}

async function waitForFixedEmulatedWorkProgress(page, {
  baseline,
  coreTicksPerSecond,
  deadlineMs,
  pollIntervalMs,
  liveWorkerProgress = false,
  targetCoreSeconds,
  wallTimeCapSeconds,
}) {
  while (true) {
    const delayMs = fixedWorkPollDelayMs({
      nowMs: Date.now(),
      deadlineMs,
      pollIntervalMs,
    });
    if (delayMs > 0) await page.waitForTimeout(delayMs);
    const observation = await readFixedWorkProgress(page, { liveWorkerProgress });
    const summary = summarizeFixedEmulatedWork({
      targetCoreSeconds,
      coreTicksPerSecond,
      baseline,
      observation,
      wallTimeCapSeconds,
      pollIntervalMs,
    });
    if (summary.reachedTarget || Date.now() >= deadlineMs) {
      return { observation, summary };
    }
  }
}

function deriveCoreRates(sample, previous, fallbackTicksPerSecond = 0) {
  if (!previous) return { ...sample, coreFps: null, gameSpeed: null };
  const elapsed = Number(sample.elapsedSeconds) - Number(previous.elapsedSeconds);
  const frameDelta = Number(sample.frame) - Number(previous.frame);
  const tickDelta = Number(sample.coreTicks) - Number(previous.coreTicks);
  if (elapsed <= 0 || frameDelta < 0 || tickDelta < 0) return sample;
  const coreTicksPerSecond = sample.coreTicksPerSecond || fallbackTicksPerSecond;
  return {
    ...sample,
    coreTicksPerSecond,
    coreFps: frameDelta / elapsed,
    gameSpeed:
      coreTicksPerSecond > 0
        ? (tickDelta * 100) / (coreTicksPerSecond * elapsed)
        : sample.gameSpeed,
  };
}

async function readWebGpuAdapter(page) {
  return page.evaluate(async () => {
    if (!navigator.gpu) return { available: false };
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { available: true, selected: false };
      const info = adapter.info || {};
      return {
        available: true,
        selected: true,
        vendor: info.vendor || null,
        architecture: info.architecture || null,
        device: info.device || null,
        description: info.description || null,
        features: [...adapter.features].sort(),
        limits: {
          maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
          maxBufferSize: adapter.limits.maxBufferSize,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        },
      };
    } catch (error) {
      return { available: true, selected: false, error: error.message || String(error) };
    }
  });
}

async function launchBrowser(chromium, headed, cpuAffinity) {
  // Persistent profiles are opt-in and caller-owned. Closing the context
  // releases Chrome after each run but deliberately leaves origin storage on disk.
  const requestedPersistentProfile = process.env.PERF_PERSIST_DIR?.trim();
  const persistentProfileDir = requestedPersistentProfile
    ? path.resolve(requestedPersistentProfile)
    : null;
  if (persistentProfileDir) await mkdir(persistentProfileDir, { recursive: true });
  const disableBackgroundThrottling =
    process.env.PERF_DISABLE_BACKGROUND_THROTTLING === "1";
  const args = [
    "--autoplay-policy=no-user-gesture-required",
    "--enable-webgl",
    "--enable-unsafe-webgpu",
  ];
  if (disableBackgroundThrottling) {
    args.push(
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows"
    );
  } else {
    args.push("--enable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling");
  }
  if (process.env.PERF_PROBE_AGGRESSIVE_GPU === "1") {
    args.push("--ignore-gpu-blocklist", "--use-angle=d3d11");
  }
  const webGpuPowerOverride = process.env.PERF_WEBGPU_POWER_OVERRIDE?.trim();
  const supportedPowerOverrides = new Set([
    "default-low-power",
    "default-high-performance",
    "force-low-power",
    "force-high-performance",
  ]);
  if (webGpuPowerOverride) {
    if (!supportedPowerOverrides.has(webGpuPowerOverride)) {
      throw new Error(
        `Invalid PERF_WEBGPU_POWER_OVERRIDE "${webGpuPowerOverride}". ` +
        `Use ${[...supportedPowerOverrides].join(", ")}.`
      );
    }
    args.push(`--use-webgpu-power-preference=${webGpuPowerOverride}`);
  }
  const launched = await launchWithWindowsCpuAffinity(async () => {
    const requestedChannel = process.env.BROWSER_CHANNEL || "chrome";
    const configuredExecutable = process.env.BROWSER_EXECUTABLE
      ? path.resolve(process.env.BROWSER_EXECUTABLE)
      : findInstalledBrowserExecutable(requestedChannel);
    if (configuredExecutable) {
      try {
        const launchOptions = {
          executablePath: configuredExecutable,
          headless: !headed,
          args,
        };
        const browser = persistentProfileDir
          ? await chromium.launchPersistentContext(persistentProfileDir, launchOptions)
          : await chromium.launch(launchOptions);
        return {
          browser,
          requestedChannel,
          actualChannel: process.env.BROWSER_EXECUTABLE ? "custom-executable" : requestedChannel,
          executablePath: configuredExecutable,
          args: [...args],
          source: process.env.BROWSER_EXECUTABLE ? "configured-executable" : "installed-executable",
          persistentProfileDir,
        };
      } catch (error) {
        console.warn(`Unable to launch ${configuredExecutable}; falling back to bundled Chromium: ${error.message}`);
      }
    }
    const executablePath = path.resolve(chromium.executablePath());
    const launchOptions = { executablePath, headless: !headed, args };
    const browser = persistentProfileDir
      ? await chromium.launchPersistentContext(persistentProfileDir, launchOptions)
      : await chromium.launch(launchOptions);
    return {
      browser,
      requestedChannel,
      actualChannel: "bundled-chromium",
      executablePath,
      args: [...args],
      source: "playwright-bundled",
      persistentProfileDir,
    };
  }, cpuAffinity);
  return { ...launched.value, cpuAffinity: launched.cpuAffinity };
}

function findInstalledBrowserExecutable(channel) {
  const candidates = [];
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    const suffix = /edge/i.test(channel)
      ? path.join("Microsoft", "Edge", "Application", "msedge.exe")
      : path.join("Google", "Chrome", "Application", "chrome.exe");
    candidates.push(...roots.map((base) => path.join(base, suffix)));
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    );
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

async function importPlaywright() {
  const configured = process.env.PLAYWRIGHT_MODULE
    ? path.resolve(process.env.PLAYWRIGHT_MODULE)
    : null;
  if (configured) {
    if (!existsSync(configured)) throw new Error(`PLAYWRIGHT_MODULE does not exist: ${configured}`);
    return import(pathToFileURL(configured).href);
  }
  const local = path.join(root, ".omx", "browser-probe", "node_modules", "playwright", "index.mjs");
  return existsSync(local) ? import(pathToFileURL(local).href) : import("playwright");
}

async function ensureAppServer(baseUrl) {
  try {
    const response = await fetch(baseUrl, { cache: "no-store" });
    if (response.ok) return null;
  } catch {
    // Start the repository server below when the requested origin is local.
  }
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error(`Unable to reach BASE_URL ${baseUrl}`);
  }
  const { server } = await import("./serve.mjs");
  const port = Number.parseInt(url.port || "80", 10);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, url.hostname, resolve);
  });
  return server;
}

async function stageSaveState(saveStatePath, sha256) {
  const directory = path.join(root, ".omx", "perf-fixtures");
  const destination = path.join(directory, `${sha256}.sav`);
  await mkdir(directory, { recursive: true });
  if (path.resolve(saveStatePath) !== path.resolve(destination)) await copyFile(saveStatePath, destination);
  await verifyFileFixture(destination, { label: "staged reference-battle save state", expectedSha256: sha256 });
  return destination;
}

async function verifyServedFixture(url, expectedSha256) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Save-state fixture is not served at ${url.href}: HTTP ${response.status}`);
  const sha256 = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
  if (sha256 !== expectedSha256) {
    throw new Error(`Served save-state SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`);
  }
}

async function verifyServedApplication(baseUrl, coreArtifact, corePath) {
  const selectedCore = selectedCoreServedPaths(root, corePath);
  const roots = [
    "index.html",
    "src/app.js",
    "src/upstream-discio-worker.js",
    "cores/dolphin/dolphin-core-upstream.js",
  ];
  for (const selectedPath of [selectedCore.js, selectedCore.wasm]) {
    if (!roots.includes(selectedPath)) roots.push(selectedPath);
  }
  const optionalRuntimeAssets = [selectedCore.prebuilt];
  for (const asset of optionalRuntimeAssets) {
    if (existsSync(path.join(root, ...asset.split("/")))) roots.push(asset);
  }
  const paths = await collectLocalServedClosure(roots);
  const expectedArtifacts = {};
  const servedArtifacts = {};
  for (const relativePath of paths) {
    const localPath = path.join(root, ...relativePath.split("/"));
    expectedArtifacts[relativePath] = relativePath === selectedCore.wasm
      ? coreArtifact
      : await describeFile(localPath, { hash: true });
    const url = new URL(relativePath, baseUrl);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Served application artifact missing: ${url.href} returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    servedArtifacts[relativePath] = {
      url: url.href,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  const identity = assertServedArtifactIdentity(expectedArtifacts, servedArtifacts);
  let prebuiltJitCache = {
    present: false,
    path: selectedCore.prebuilt,
    verified: true,
  };
  if (paths.includes(selectedCore.prebuilt)) {
    const blob = await readFile(path.join(root, ...selectedCore.prebuilt.split("/")));
    const evidence = {
      path: selectedCore.prebuilt,
      ...describePrebuiltJitCache(blob),
    };
    const validation = evaluatePrebuiltJitCacheEvidence({
      evidence,
      expectedSha256: coreArtifact.sha256,
    });
    if (!validation.verified) {
      throw new Error(`Selected prebuilt JIT cache identity failed: ${validation.failures.join("; ")}`);
    }
    prebuiltJitCache = { present: true, ...evidence, verified: true };
  }
  const manifestText = JSON.stringify(
    Object.fromEntries(paths.map((relativePath) => [relativePath, {
      bytes: expectedArtifacts[relativePath].bytes,
      sha256: expectedArtifacts[relativePath].sha256,
    }])),
    null,
    2
  );
  const rootResponse = await fetch(baseUrl, { cache: "no-store" });
  return {
    ...identity,
    baseUrl,
    roots,
    dependencyCount: paths.length,
    prebuiltJitCache,
    manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
    isolationHeaders: {
      coop: rootResponse.headers.get("cross-origin-opener-policy"),
      coep: rootResponse.headers.get("cross-origin-embedder-policy"),
    },
  };
}

async function collectLocalServedClosure(rootPaths) {
  const queued = [...new Set(rootPaths.map(normalizeServedPath))];
  const discovered = new Set();
  while (queued.length) {
    const relativePath = queued.shift();
    if (discovered.has(relativePath)) continue;
    const localPath = path.resolve(root, ...relativePath.split("/"));
    if (!localPath.startsWith(`${path.resolve(root)}${path.sep}`) && localPath !== path.resolve(root)) {
      throw new Error(`Served dependency escapes repository root: ${relativePath}`);
    }
    if (!existsSync(localPath)) throw new Error(`Served dependency is missing locally: ${relativePath}`);
    discovered.add(relativePath);
    const extension = path.extname(relativePath).toLowerCase();
    if (![".html", ".js", ".mjs"].includes(extension)) continue;
    const source = await readFile(localPath, "utf8");
    for (const specifier of extractLocalModuleSpecifiers(source, relativePath)) {
      const dependency = resolveServedSpecifier(relativePath, specifier);
      if (!discovered.has(dependency)) queued.push(dependency);
    }
  }
  return [...discovered].sort();
}

function resolveServedSpecifier(importer, specifier) {
  const clean = specifier.split(/[?#]/, 1)[0];
  const joined = clean.startsWith("/")
    ? clean.slice(1)
    : path.posix.join(path.posix.dirname(importer), clean);
  return normalizeServedPath(joined);
}

function normalizeServedPath(value) {
  const normalized = path.posix.normalize(String(value).replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new Error(`Invalid served dependency path: ${value}`);
  }
  return normalized;
}

async function collectBuildProvenance(coreArtifact, corePath) {
  const normalizedCorePath = path.relative(root, corePath).replaceAll("\\", "/");
  const candidateMatch = /^build\/core-candidates\/([0-9a-f]{64})\/dolphin-core-upstream\.wasm$/i.exec(
    normalizedCorePath
  );
  const candidatePrefix = candidateMatch ? `build/core-candidates/${candidateMatch[1].toLowerCase()}` : null;
  const buildInfoRelative = candidatePrefix ? `${candidatePrefix}/dolphin-core-upstream.build.json` : [
    "cores/dolphin/dolphin-core-upstream.build.json",
    "cores/dolphin/build-info.json",
  ].find((candidate) => existsSync(path.join(root, ...candidate.split("/")))) ||
    "cores/dolphin/dolphin-core-upstream.build.json";
  const evidenceSpecs = {
    buildInfo: { relativePath: buildInfoRelative, committed: false },
    sourceLock: { relativePath: candidatePrefix ? `${candidatePrefix}/dolphin-source.lock.json` : "provenance/dolphin-source.lock.json", headPath: "provenance/dolphin-source.lock.json", committed: true },
    abiManifest: { relativePath: candidatePrefix ? `${candidatePrefix}/dolphin-core-abi-v1.json` : "provenance/dolphin-core-abi-v1.json", headPath: candidatePrefix ? null : "provenance/dolphin-core-abi-v1.json", committed: true, candidateBundleMember: Boolean(candidatePrefix) },
    toolchainLock: { relativePath: candidatePrefix ? `${candidatePrefix}/wasm-toolchain.lock.json` : "provenance/wasm-toolchain.lock.json", headPath: "provenance/wasm-toolchain.lock.json", committed: true },
    vendorSnapshot: { relativePath: candidatePrefix ? `${candidatePrefix}/dolphin-vendor-snapshot-v1.json` : "provenance/dolphin-vendor-snapshot-v1.json", headPath: "provenance/dolphin-vendor-snapshot-v1.json", committed: true },
    nagaCargoLock: { relativePath: candidatePrefix ? `${candidatePrefix}/Cargo.lock` : "tools/naga-spirv-wgsl/Cargo.lock", headPath: "tools/naga-spirv-wgsl/Cargo.lock", committed: true, json: false },
  };
  const loadedEntries = await Promise.all(
    Object.entries(evidenceSpecs).map(async ([key, spec]) => [key, await loadBuildEvidence(spec)])
  );
  const loaded = Object.fromEntries(loadedEntries);
  const jsPath = candidatePrefix ? path.join(root, candidatePrefix, "dolphin-core-upstream.js") :
    path.join(root, "cores", "dolphin", "dolphin-core-upstream.js");
  const actualArtifacts = {
    js: { ...(await describeBuildArtifact(jsPath, "lf-normalized")), path: "cores/dolphin/dolphin-core-upstream.js" },
    wasm: {
      path: "cores/dolphin/dolphin-core-upstream.wasm",
      size: coreArtifact.bytes,
      rawSize: coreArtifact.bytes,
      sha256: coreArtifact.sha256,
      hashMode: "raw",
    },
  };
  const evidenceFiles = Object.fromEntries(
    Object.entries(loaded).map(([key, entry]) => [key, entry.metadata])
  );
  const locked = {
    buildInfo: loaded.buildInfo.value,
    sourceLock: loaded.sourceLock.value,
    abiManifest: loaded.abiManifest.value,
    toolchainLock: loaded.toolchainLock.value,
    vendorSnapshot: loaded.vendorSnapshot.value,
  };
  const actualContractSources = Object.fromEntries(
    await Promise.all((locked.abiManifest?.contractSources || []).map(async (entry) => {
      const relativePath = normalizeEvidencePath(entry?.path);
      return [
        relativePath,
        await describeBuildArtifact(
          path.join(root, ...relativePath.split("/")),
          entry?.hashMode || "raw"
        ),
      ];
    }))
  );
  const untrustedEnvironmentOverrides = Object.fromEntries(
    [
      "DOLPHIN_BUILD_INFO_PATH",
      "HOST_CORE_ABI_VERSION",
      "UPSTREAM_DOLPHIN_SHA",
      "PATCH_HASHES",
      "EMSCRIPTEN_VERSION",
      "EMSCRIPTEN_DIGEST",
      "CMAKE_VERSION",
      "CMAKE_DIGEST",
      "NINJA_VERSION",
      "NINJA_DIGEST",
      "RUST_VERSION",
      "RUST_DIGEST",
      "NAGA_VERSION",
      "NAGA_DIGEST",
    ].filter((name) => process.env[name] != null).map((name) => [name, String(process.env[name]).slice(0, 500)])
  );
  const buildProvenance = {
    source: buildInfoRelative,
    locked,
    actualArtifacts,
    actualContractSources,
    evidenceFiles,
    untrustedEnvironmentOverrides,
    verification: null,
  };
  if (candidatePrefix) {
    const candidateManifestPath = `${candidatePrefix}/manifest.json`;
    const candidateManifest = await loadBuildEvidence({ relativePath: candidateManifestPath, committed: false });
    const bundleFiles = {};
    for (const entry of candidateManifest.value?.files || []) {
      const candidateFile = path.join(root, candidatePrefix, String(entry?.name || ""));
      bundleFiles[entry.name] = existsSync(candidateFile)
        ? (await describeFile(candidateFile)).sha256
        : null;
    }
    const prebuiltPath = path.join(root, candidatePrefix, "prebuilt-jit-cache.bin");
    const prebuiltEntry = candidateManifest.value?.files?.find(
      (entry) => entry?.name === "prebuilt-jit-cache.bin"
    );
    const prebuiltEvidence = existsSync(prebuiltPath)
      ? {
          path: `${candidatePrefix}/prebuilt-jit-cache.bin`,
          ...describePrebuiltJitCache(await readFile(prebuiltPath)),
        }
      : null;
    const prebuiltValidation = prebuiltEvidence || prebuiltEntry
      ? evaluatePrebuiltJitCacheEvidence({
          evidence: prebuiltEvidence,
          expectedSha256: coreArtifact.sha256,
          manifestEntry: prebuiltEntry,
          requireManifestEntry: true,
        })
      : { verified: true, evidence: null, failures: [] };
    const bundleValidation = evaluateCandidateCoreBundle({
      manifest: candidateManifest.value,
      expectedSha256: coreArtifact.sha256,
      files: bundleFiles,
    });
    const candidateFailures = [...bundleValidation.failures, ...prebuiltValidation.failures];
    buildProvenance.candidateBundle = {
      path: candidateManifestPath,
      ...bundleValidation,
      verified: candidateFailures.length === 0,
      failures: candidateFailures,
      prebuiltJitCache: prebuiltValidation,
    };
  }
  buildProvenance.verification = validateLockedBuildProvenance(buildProvenance);
  return {
    buildProvenance,
    rawEvidenceFiles: Object.entries(loaded)
      .filter(([, entry]) => entry.raw != null)
      .map(([key, entry]) => ({ key, relativePath: entry.metadata.path, raw: entry.raw })),
    hostCore: { abiVersion: locked.abiManifest?.abiVersion ?? null },
    upstream: { dolphinSha: locked.sourceLock?.upstream?.commit ?? null },
    patches: { hashes: (locked.sourceLock?.patches || []).map((patch) => patch.sha256) },
    toolchain: locked.toolchainLock || null,
  };
}

async function loadBuildEvidence({ relativePath, headPath = relativePath, committed, json = true, candidateBundleMember = false }) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  if (!existsSync(absolutePath)) {
    return {
      raw: null,
      value: null,
      metadata: {
        path: relativePath,
        exists: false,
        bytes: null,
        sha256: null,
        normalizedSha256: null,
        trackedAtHead: false,
        matchesHead: false,
        committedRequired: committed,
      },
    };
  }
  const raw = await readFile(absolutePath, "utf8");
  let value = null;
  if (json) {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid build evidence ${relativePath}: ${error.message}`);
    }
  }
  const rawBuffer = Buffer.from(raw);
  const normalizedBuffer = Buffer.from(raw.replace(/\r\n/g, "\n"));
  const head = headPath ? spawnSync("git", ["show", `HEAD:${headPath}`], {
    cwd: root,
    encoding: "buffer",
    windowsHide: true,
  }) : { status: 1, stdout: Buffer.alloc(0) };
  const headNormalized = head.status === 0
    ? Buffer.from(head.stdout.toString("utf8").replace(/\r\n/g, "\n"))
    : null;
  const normalizedSha256 = sha256Buffer(normalizedBuffer);
  return {
    raw,
    value,
    metadata: {
      path: relativePath,
      exists: true,
      bytes: rawBuffer.byteLength,
      sha256: sha256Buffer(rawBuffer),
      normalizedSha256,
      trackedAtHead: head.status === 0,
      matchesHead: Boolean(headNormalized && sha256Buffer(headNormalized) === normalizedSha256),
      committedRequired: committed,
      candidateBundleMember,
    },
  };
}

function normalizeEvidencePath(value) {
  const normalized = path.posix.normalize(String(value || "").replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid build evidence path: ${value}`);
  }
  return normalized;
}

async function describeBuildArtifact(filePath, hashMode) {
  const relativePath = path.relative(root, filePath).replaceAll("\\", "/");
  if (!existsSync(filePath)) {
    return { path: relativePath, size: null, rawSize: null, sha256: null, hashMode };
  }
  const bytes = await readFile(filePath);
  const hashBytes = hashMode === "lf-normalized"
    ? Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"))
    : bytes;
  return {
    path: relativePath,
    size: hashBytes.byteLength,
    rawSize: bytes.byteLength,
    sha256: sha256Buffer(hashBytes),
    hashMode,
  };
}

async function packageBuildProvenance(scenarioDir, rawEvidenceFiles) {
  const destinationDir = path.join(scenarioDir, "build-provenance");
  await mkdir(destinationDir, { recursive: true });
  const packaged = [];
  for (const entry of rawEvidenceFiles || []) {
    const name = `${entry.key}-${path.basename(entry.relativePath)}`;
    const destination = path.join(destinationDir, name);
    await writeFile(destination, entry.raw);
    packaged.push({
      key: entry.key,
      sourcePath: entry.relativePath,
      path: `build-provenance/${name}`,
      bytes: Buffer.byteLength(entry.raw),
      sha256: sha256Buffer(Buffer.from(entry.raw)),
    });
  }
  return packaged;
}

function sha256Buffer(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForAnimationFrames(page, count, timeoutMs = 5000) {
  let timeoutHandle;
  try {
    return await Promise.race([
      page.evaluate(async (frameCount) => {
        for (let index = 0; index < frameCount; index += 1) {
          await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        }
        return performance.now();
      }, count),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Compositor settle timed out after ${timeoutMs} ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function saveScreenshot(page, scenarioDir, name) {
  try {
    await page.screenshot({ path: path.join(scenarioDir, name), timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function readComparisonConfig(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(await readFile(resolved, "utf8"));
  return validateComparisonConfig(parsed);
}

async function readBaseline(filePath) {
  if (!filePath) return null;
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

function compareToBaseline(results, baselineReport, tolerance) {
  const failures = [];
  const warnings = [];
  if (!baselineReport) return { failures, warnings, compared: [] };
  const baselineByName = new Map((baselineReport.results || []).map((result) => [result.name, result]));
  const compared = [];
  for (const result of results) {
    const base = baselineByName.get(result.name);
    if (!base) {
      warnings.push(`${result.name}: missing from baseline`);
      continue;
    }
    const checks = [
      { key: "minPresentFps", direction: "min" },
      { key: "minCoreFps", direction: "min" },
      { key: "minGameSpeed", direction: "min" },
      { key: "visibleChangedCount", direction: "min" },
      { key: "maxGapMs", direction: "max" },
    ];
    const row = { name: result.name, metrics: {} };
    for (const { key, direction } of checks) {
      const before = Number(base.metrics?.[key] || 0);
      const after = Number(result.metrics?.[key] || 0);
      const allowed = direction === "min" ? before * (1 - tolerance) : before * (1 + tolerance);
      row.metrics[key] = { before, after, allowed, direction };
      if (before > 0 && ((direction === "min" && after < allowed) || (direction === "max" && after > allowed))) {
        failures.push(`${result.name}: ${key} regressed from ${before} to ${after}`);
      }
    }
    compared.push(row);
  }
  return { failures, warnings, compared };
}

function comparisonCsv(comparison, results, config) {
  const runRows = results.map((run) => ({
    recordType: "run",
    runId: run.runId,
    blockId: run.blockId,
    arm: run.arm,
    armName: run.armName,
    valid: run.valid,
    audioMode: run.audioMode,
    audioClaimsEligible: run.audioClaimsEligible,
    invalidReasons: run.invalidReasons,
    primaryMetric: config.primaryMetric,
    primaryValue: readPath(run, config.primaryMetric),
    wgpuSparseUboEligibleDelta: run.metrics.wgpuSparseUbo?.deltas?.eligibleCalls,
    wgpuSparseUboStagedBytesDelta: run.metrics.wgpuSparseUbo?.deltas?.stagedBytes,
    wgpuSparseUboAvoidedBytesDelta:
      run.metrics.wgpuSparseUbo?.deltas?.avoidedStagedBytes,
  }));
  const blockRows = comparison.blocks.map((block) => ({
    recordType: "block",
    blockId: block.blockId,
    valid: block.valid,
    invalidReasons: block.invalidReasons,
    meanA: block.meanA,
    meanB: block.meanB,
    rawEffect: block.rawEffect,
    effectPercent: block.effectPercent,
  }));
  return recordsToCsv([...runRows, ...blockRows]);
}

function runSummaryCsv(results) {
  return recordsToCsv(results.map((run) => ({
    runId: run.runId,
    blockId: run.blockId,
    arm: run.arm,
    armName: run.armName,
    valid: run.valid,
    qualificationEligible: run.qualification?.eligible,
    audioMode: run.audioMode,
    audioClaimsEligible: run.audioClaimsEligible,
    invalidReasons: run.invalidReasons,
    fullGameSpeedMean: run.metrics.fullTimedWindow?.gameSpeed?.mean,
    fullCoreFpsMean: run.metrics.fullTimedWindow?.coreFps?.mean,
    fullPresentationFpsMean: run.metrics.fullTimedWindow?.presentationFps?.mean,
    fullVisualFpsMean: run.metrics.fullTimedWindow?.visualFps?.mean,
    steadyGameSpeedMean: run.metrics.steadyState?.gameSpeed?.mean,
    steadyCoreFpsMean: run.metrics.steadyState?.coreFps?.mean,
    steadyPresentationFpsMean: run.metrics.steadyState?.presentationFps?.mean,
    steadyVisualFpsMean: run.metrics.steadyState?.visualFps?.mean,
    fixedWorkTargetCoreSeconds: run.metrics.fixedEmulatedWork?.targetCoreSeconds,
    fixedWorkActualCoreTickDelta: run.metrics.fixedEmulatedWork?.actualCoreTickDelta,
    fixedWorkActualFrameDelta: run.metrics.fixedEmulatedWork?.actualFrameDelta,
    fixedWorkElapsedWallSeconds: run.metrics.fixedEmulatedWork?.elapsedWallSeconds,
    fixedWorkReachedTarget: run.metrics.fixedEmulatedWork?.reachedTarget,
    fixedWorkThroughputGameSpeedPercent:
      run.metrics.fixedEmulatedWork?.throughputGameSpeedPercent,
    fixedWorkThroughputCoreFps: run.metrics.fixedEmulatedWork?.throughputCoreFps,
    wgpuProducerProfileActivated: run.metrics.wgpuProducerProfile?.activated,
    wgpuProducerProfileSchemaVersion: run.metrics.wgpuProducerProfile?.schemaVersion,
    wgpuProducerProfileEpoch: run.metrics.wgpuProducerProfile?.epoch,
    wgpuProducerProfilePhaseOrder: run.metrics.wgpuProducerProfile?.phaseOrder,
    wgpuProducerProfilePeriods: run.metrics.wgpuProducerProfile?.periods,
    wgpuProducerProfileDeltaCalls: run.metrics.wgpuProducerProfile?.deltas?.calls,
    wgpuProducerProfileDeltaSamples: run.metrics.wgpuProducerProfile?.deltas?.samples,
    wgpuProducerProfileDeltaSampleTotalNs:
      run.metrics.wgpuProducerProfile?.deltas?.sampleTotalNs,
    wgpuProducerProfileDeltaEstimatedTotalNs:
      run.metrics.wgpuProducerProfile?.deltas?.estimatedTotalNs,
    wgpuProducerProfileFinalSampleMaxNs:
      run.metrics.wgpuProducerProfile?.final?.sampleMaxNs,
    wgpuTailGateActivated: run.metrics.wgpuTailGate?.activated,
    wgpuTailGateExpectedEnabled: run.metrics.wgpuTailGate?.expectedEnabled,
    wgpuTailGateSchemaVersion: run.metrics.wgpuTailGate?.schemaVersion,
    wgpuTailGateEpoch: run.metrics.wgpuTailGate?.epoch,
    wgpuTailGatePeriod: run.metrics.wgpuTailGate?.period,
    wgpuTailGateDeltaPayloadSamples: run.metrics.wgpuTailGate?.deltas?.payloadSamples,
    wgpuTailGateDeltaFlushNeededSamples:
      run.metrics.wgpuTailGate?.deltas?.flushNeededSamples,
    wgpuTailGateDeltaRefreshNeededSamples:
      run.metrics.wgpuTailGate?.deltas?.refreshNeededSamples,
    wgpuTailGateDeltaBothCleanSamples: run.metrics.wgpuTailGate?.deltas?.bothCleanSamples,
    wgpuTailGateDeltaDirtyAtSkip: run.metrics.wgpuTailGate?.deltas?.dirtyAtSkip,
    wgpuTailGateFinalRequested: run.metrics.wgpuTailGate?.final?.requested,
    wgpuTailGateFinalAvailable: run.metrics.wgpuTailGate?.final?.available,
    wgpuTailGateFinalEnabled: run.metrics.wgpuTailGate?.final?.enabled,
    wgpuTailGateFinalPayloadSamples: run.metrics.wgpuTailGate?.final?.payloadSamples,
    wgpuTailGateFinalFlushNeededSamples:
      run.metrics.wgpuTailGate?.final?.flushNeededSamples,
    wgpuTailGateFinalRefreshNeededSamples:
      run.metrics.wgpuTailGate?.final?.refreshNeededSamples,
    wgpuTailGateFinalBothCleanSamples: run.metrics.wgpuTailGate?.final?.bothCleanSamples,
    wgpuTailGateFinalDirtyAtSkip: run.metrics.wgpuTailGate?.final?.dirtyAtSkip,
    wgpuSparseUboSchema: run.metrics.wgpuSparseUbo?.schema,
    wgpuSparseUboExpectedActive: run.metrics.wgpuSparseUbo?.expectedActive,
    wgpuSparseUboActivated: run.metrics.wgpuSparseUbo?.activated,
    wgpuSparseUboSampleCount: run.metrics.wgpuSparseUbo?.sampleCount,
    wgpuSparseUboEligibleDelta: run.metrics.wgpuSparseUbo?.deltas?.eligibleCalls,
    wgpuSparseUboBaselineDelta: run.metrics.wgpuSparseUbo?.deltas?.baselineCalls,
    wgpuSparseUboSparseDelta: run.metrics.wgpuSparseUbo?.deltas?.sparseCalls,
    wgpuSparseUboEqualDelta: run.metrics.wgpuSparseUbo?.deltas?.equalCalls,
    wgpuSparseUboFullFallbackDelta:
      run.metrics.wgpuSparseUbo?.deltas?.fullFallbackCalls,
    wgpuSparseUboCapacityMissDelta: run.metrics.wgpuSparseUbo?.deltas?.capacityMisses,
    wgpuSparseUboFullBytesDelta: run.metrics.wgpuSparseUbo?.deltas?.fullBytes,
    wgpuSparseUboStagedBytesDelta: run.metrics.wgpuSparseUbo?.deltas?.stagedBytes,
    wgpuSparseUboAvoidedBytesDelta:
      run.metrics.wgpuSparseUbo?.deltas?.avoidedStagedBytes,
    wgpuSparseUboCopyForwardBytesDelta:
      run.metrics.wgpuSparseUbo?.deltas?.copyForwardBytes,
    wgpuSparseUboOverlayRangesDelta: run.metrics.wgpuSparseUbo?.deltas?.overlayRanges,
    wgpuSparseUboOverlayBytesDelta: run.metrics.wgpuSparseUbo?.deltas?.overlayBytes,
    wgpuSparseUboPredictedGpuCopyBytesDelta:
      run.metrics.wgpuSparseUbo?.deltas?.predictedGpuCopyBytes,
    manifestPath: run.manifestPath,
    summaryPath: run.summaryPath,
    samplesPath: run.samplesPath,
    eventsPath: run.eventsPath,
  })));
}

function runEventsJsonl(manifest, saveStateLoad, inputEvents, samples) {
  const events = [];
  if (manifest) {
    events.push({
      schemaVersion: 1,
      event: "run-manifest",
      startedAt: manifest.startedAt,
      runId: manifest.experiment?.runId || null,
      blockId: manifest.experiment?.blockId || null,
      arm: manifest.experiment?.arm || null,
    });
  }
  if (saveStateLoad) {
    events.push({ schemaVersion: 1, event: "save-state-loaded", ...saveStateLoad });
  }
  if (manifest?.benchmark?.timingStartedAt) {
    events.push({
      schemaVersion: 1,
      event: "timing-started",
      at: manifest.benchmark.timingStartedAt,
      afterVerifiedLoad: true,
    });
  }
  const timedEvents = [
    ...inputEvents.map((inputEvent) => ({
      schemaVersion: 1,
      event: "post-load-input",
      ...inputEvent,
      sortSeconds: inputEvent.deliveredSeconds,
      sortOrder: 1,
    })),
    ...samples.map((sample, index) => ({
      schemaVersion: 1,
      event: "sample",
      index,
      ...sample,
      sortSeconds: sample.elapsedSeconds,
      sortOrder: 0,
    })),
  ].sort((left, right) =>
    left.sortSeconds - right.sortSeconds || left.sortOrder - right.sortOrder
  );
  events.push(...timedEvents.map(({ sortSeconds, sortOrder, ...event }) => event));
  return events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
}

function rejectMenuDrivingConfiguration() {
  const inputScript = process.env.INPUT_SCRIPT;
  if (inputScript != null && !/^(?:\s*|none|off)$/i.test(inputScript)) {
    throw new Error("perf:gate only supports INPUT_SCRIPT=none; menu/character-select scripts are forbidden");
  }
  if (process.env.SAVE_STATE_AT != null && Number(process.env.SAVE_STATE_AT) !== 0) {
    throw new Error("perf:gate requires SAVE_STATE_AT=0 so timing begins after the fixed battle loads");
  }
}

function shouldFailScenarioTargets(scenario) {
  if (cli.strict || process.env.PERF_STRICT === "1") return true;
  return normalizeTargetMode(cli.targetMode || process.env.PERF_TARGET_MODE || "fail") === "fail" && scenario.required;
}

function normalizeTargetMode(value) {
  if (value === "fail" || value === "warn") return value;
  throw new Error(`Invalid target mode "${value}". Use "fail" or "warn".`);
}

function requiredFixturePath(value, label, source) {
  if (!value) throw new Error(`${label} is required; set ${source}`);
  return value;
}

function resolveOutDir(value) {
  if (path.isAbsolute(value)) return value;
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === ".omx" || normalized.startsWith(".omx/")
    ? path.join(root, ...normalized.split("/"))
    : path.join(root, ".omx", value);
}

function maxRegex(text, regex) {
  let max = 0;
  for (const match of text.matchAll(regex)) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value)) max = Math.max(max, value);
  }
  return max;
}

function lastMatch(text, regex) {
  let latest = "";
  for (const match of text.matchAll(regex)) latest = match[1];
  return latest;
}

function readPath(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], value);
}

function numberEnv(name, fallback) {
  const value = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(value) ? value : fallback;
}

function optionalPositiveNumber(value, source) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number.parseFloat(String(value));
  if (!Number.isFinite(number) || !(number > 0)) {
    throw new Error(`${source} requires a positive finite numeric value`);
  }
  return number;
}

function parseArgs(args) {
  const parsed = {
    baseline: "",
    baseUrl: "",
    comparisonConfig: "",
    duration: undefined,
    outDir: "",
    perfInputScript: undefined,
    requireBaseline: false,
    rom: "",
    sampleMs: undefined,
    saveState: "",
    strict: false,
    targetCoreSeconds: undefined,
    targetMode: "",
    tolerance: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--baseline") parsed.baseline = requiredArg(args, ++index, arg);
    else if (arg === "--base-url") parsed.baseUrl = requiredArg(args, ++index, arg);
    else if (arg === "--comparison-config") parsed.comparisonConfig = requiredArg(args, ++index, arg);
    else if (arg === "--duration") parsed.duration = numberArg(args, ++index, arg);
    else if (arg === "--out-dir") parsed.outDir = requiredArg(args, ++index, arg);
    else if (arg === "--perf-input-script") parsed.perfInputScript = requiredArg(args, ++index, arg);
    else if (arg === "--require-baseline") parsed.requireBaseline = true;
    else if (arg === "--rom") parsed.rom = requiredArg(args, ++index, arg);
    else if (arg === "--sample-ms") parsed.sampleMs = numberArg(args, ++index, arg);
    else if (arg === "--save-state") parsed.saveState = requiredArg(args, ++index, arg);
    else if (arg === "--strict") parsed.strict = true;
    else if (arg === "--target-core-seconds") parsed.targetCoreSeconds = numberArg(args, ++index, arg);
    else if (arg === "--target-mode") parsed.targetMode = requiredArg(args, ++index, arg);
    else if (arg === "--tolerance") parsed.tolerance = numberArg(args, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requiredArg(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function numberArg(args, index, flag) {
  const value = Number.parseFloat(requiredArg(args, index, flag));
  if (!Number.isFinite(value)) throw new Error(`${flag} requires a numeric value`);
  return value;
}
