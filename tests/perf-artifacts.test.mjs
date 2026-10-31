import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS } from "../tools/dolphin-provenance.mjs";
import { CAUSAL_TELEMETRY_SCHEMA_VERSION } from "../src/causal-telemetry.js";

import {
  FIXED_BATTLE_FIXTURE,
  WGPU_PRODUCER_PROFILE_PHASE_ORDER,
  WGPU_DRAW_PROFILE_PHASE_ORDER,
  assertBattleCheckpoint,
  assertRunProvenance,
  assertServedArtifactIdentity,
  buildComparisonTasklist,
  buildReplacementBlock,
  classifyGateOutcome,
  collectRunMetadata,
  evaluateCandidateCoreBundle,
  evaluatePrebuiltJitCacheEvidence,
  evaluateMetricsModeEvidence,
  evaluateCoreSelectionEvidence,
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
  evaluateWgpuUploadProbeWorkloadEquivalence,
  validateWgpuUploadProbeFinalization,
  evaluateQualificationProvenance,
  evaluateRunValidity,
  expectedBattleCheckpointForParams,
  extractLocalModuleSpecifiers,
  findFatalRuntimeEvidence,
  fixedWorkPollDelayMs,
  parseProfileMetrics,
  parseWgpuProducerProfileStats,
  parseWgpuDrawProfileStats,
  parseWgpuTailGateStats,
  parseBattleCheckpoint,
  parsePostLoadInputScript,
  recordsToCsv,
  resolveCoreArtifactPath,
  selectedCoreServedPaths,
  selectNextFixedWorkBenchmarkAction,
  summarizeComparison,
  summarizeJitMetrics,
  summarizeNumeric,
  summarizeTimedMetricWindows,
  selectNextPostLoadBenchmarkAction,
  serializePostLoadInputScript,
  summarizeFixedEmulatedWork,
  summarizeCausalFairness,
  summarizePostLoadInputDelivery,
  validateLockedBuildProvenance,
  validateComparisonConfig,
  verifyFileFixture,
} from "../tools/perf-artifacts.mjs";

test("draw detail evidence fails closed and validates independent off/on arms", () => {
  const offSample = {
    helper: drawProfileWire({ enabled: 0, epoch: 0, multiplier: 0 }),
    causalWgpuDrawProfileRequested: false,
    causalWgpuDrawProfileAvailable: true,
  };
  assert.deepEqual(evaluateWgpuDrawProfileEvidence({
    requested: "0", metrics: "1", video: "wgpu", samples: [offSample],
  }).failures, []);

  const onSamples = [1, 2].map((multiplier) => ({
    helper: drawProfileWire({ enabled: 1, epoch: 1, multiplier }),
    causalWgpuDrawProfileRequested: true,
    causalWgpuDrawProfileAvailable: true,
  }));
  const valid = evaluateWgpuDrawProfileEvidence({
    requested: "1", metrics: "1", video: "wgpu", samples: onSamples,
  });
  assert.deepEqual(valid.failures, []);
  assert.deepEqual(valid.phaseOrder, WGPU_DRAW_PROFILE_PHASE_ORDER);
  assert.ok(valid.deltas.calls.every((value) => value > 0));
  assert.match(evaluateWgpuDrawProfileEvidence({
    requested: "1", metrics: "0", video: "wgpu", samples: onSamples,
  }).failures.join("\n"), /requires metrics=1/);
  assert.match(evaluateWgpuDrawProfileEvidence({
    requested: "1", metrics: "1", video: "software", samples: onSamples,
  }).failures.join("\n"), /requires video=wgpu/);
  assert.equal(parseWgpuDrawProfileStats(onSamples[0].helper).wgpuDrawProfileEnabled, true);
  const wrongPeriods = structuredClone(onSamples);
  wrongPeriods[1].helper = wrongPeriods[1].helper.replace(
    "wgdrd:64,64,256,64,64,64,256",
    "wgdrd:32,64,256,64,64,64,256"
  );
  assert.match(evaluateWgpuDrawProfileEvidence({
    requested: "1", metrics: "1", video: "wgpu", samples: wrongPeriods,
  }).failures.join("\n"), /periods mismatch/);
  const maxExceedsTotal = structuredClone(onSamples);
  maxExceedsTotal[1].helper = maxExceedsTotal[1].helper.replace(
    /wgdrm:\d+/, "wgdrm:999999"
  );
  assert.match(evaluateWgpuDrawProfileEvidence({
    requested: "1", metrics: "1", video: "wgpu", samples: maxExceedsTotal,
  }).failures.join("\n"), /max exceeds sampled total/);
  assert.match(evaluateWgpuDrawProfileEvidence({
    requested: "1", metrics: "1", video: "wgpu", samples: [onSamples[0], onSamples[0]],
  }).failures.join("\n"), /timed-window delta is not positive/);
  assert.match(evaluateWgpuDrawProfileEvidence({
    requested: "0", metrics: "1", video: "wgpu", samples: [{
      helper: drawProfileWire({ enabled: 0, epoch: 0, multiplier: 1 }),
      causalWgpuDrawProfileRequested: false,
      causalWgpuDrawProfileAvailable: true,
    }],
  }).failures.join("\n"), /disabled counters are nonzero/);
});

test("causal fairness uses timed counter deltas and enforces marker parity", () => {
  const sample = (audio, marker, webgpu = {}, gpuCompletion = {}) => ({
    causalAudioWorkerMixCount: audio.mix,
    causalAudioWorkerEmptyMixCount: audio.empty,
    causalAudioUnderruns: audio.underrun,
    causalAudioOverruns: audio.overrun,
    causalAudioPumpMissCount: audio.miss,
    causalAudioWorkerMixMaxMs: audio.mixMax,
    causalAudioPumpGapMaxMs: audio.gapMax,
    causalAudioMixRoundTripMaxMs: audio.roundTripMax,
    causalAudioScheduleLeadSeconds: audio.lead,
    causalAudioScheduleDriftSeconds: audio.drift,
    causalInputMarkerEnabled: true,
    causalInputMarkerAppliedCount: marker.applied,
    causalInputMarkerExactCorePollCount: marker.polled,
    causalInputMarkerArmedCount: marker.armed,
    causalInputMarkerSubmittedCount: marker.submitted,
    causalInputMarkerCompletedCount: marker.completed,
    causalInputMarkerSupersededCount: marker.superseded,
    causalInputMarkerSupersededArmedCount: marker.supersededArmed,
    causalInputMarkerExpiredCount: marker.expired,
    causalInputMarkerExpiredInFlightCount: marker.expiredInFlight,
    causalInputMarkerGenerationMismatchCount: marker.mismatch,
    causalInputMarkerGenerationUnavailableCount: marker.unavailable,
    causalInputMarkerDroppedInFlightCount: marker.dropped,
    causalWgpuErrorCount: webgpu.error ?? 0,
    causalGpuCompletionFailedCount: gpuCompletion.failed ?? 0,
  });
  const baseline = sample(
    { mix: 10, empty: 1, underrun: 2, overrun: 0, miss: 3, mixMax: 1, gapMax: 4, roundTripMax: 5, lead: 0.05, drift: -0.01 },
    { applied: 1, polled: 1, armed: 1, submitted: 1, completed: 1, superseded: 0, supersededArmed: 0, expired: 0, expiredInFlight: 0, mismatch: 0, unavailable: 0, dropped: 0 }
  );
  const final = sample(
    { mix: 20, empty: 1, underrun: 2, overrun: 0, miss: 4, mixMax: 2, gapMax: 8, roundTripMax: 9, lead: 0.08, drift: 0.02 },
    { applied: 3, polled: 3, armed: 3, submitted: 3, completed: 3, superseded: 0, supersededArmed: 0, expired: 0, expiredInFlight: 0, mismatch: 0, unavailable: 0, dropped: 0 }
  );
  const result = summarizeCausalFairness([baseline, final], { expectedInputEvents: 2 });
  assert.equal(result.audio.deltas.workerMixCount, 10);
  assert.equal(result.audio.deltas.workerEmptyMixCount, 0);
  assert.equal(result.audio.deltas.underrunCount, 0);
  assert.equal(result.audio.counterWindow.baseline.underrunCount, 2);
  assert.equal(result.audio.counterWindow.final.underrunCount, 2);
  assert.equal(result.audio.counterWindow.excludedBeforeTimedBaseline.underrunCount, 2);
  assert.equal(result.audio.extrema.pumpGapMaxMs, 8);
  assert.equal(result.inputMarker.parityPassed, true);
  assert.deepEqual(result.failures, []);
});

test("post-load input delivery keeps marker serialization separate from lateness failures", () => {
  const onTime = {
    afterBaselineSample: true,
    latenessMs: 12,
    markerBarrier: { available: true, completed: true, waitedMs: 24 },
  };
  assert.deepEqual(
    summarizePostLoadInputDelivery([onTime], { expectedCount: 1, maxLatenessMs: 100 }).failures,
    []
  );

  const delayed = summarizePostLoadInputDelivery([
    { ...onTime, latenessMs: 335 },
    {
      afterBaselineSample: true,
      latenessMs: 137,
      markerBarrier: { available: true, completed: false, waitedMs: 2500 },
    },
  ], { expectedCount: 2, maxLatenessMs: 100 });
  assert.equal(delayed.lateEventCount, 2);
  assert.equal(delayed.maxObservedLatenessMs, 335);
  assert.equal(delayed.markerBarrierTimeoutCount, 1);
  assert.match(delayed.failures.join("\n"), /lateness exceeded 100ms/);
  assert.match(delayed.failures.join("\n"), /completion barrier timed out/);

  const unavailable = summarizePostLoadInputDelivery([
    { afterBaselineSample: false, latenessMs: 0, markerBarrier: { available: false } },
  ], { expectedCount: 2 });
  assert.match(unavailable.failures.join("\n"), /delivered 1\/2/);
  assert.match(unavailable.failures.join("\n"), /before the timed baseline/);
  assert.match(unavailable.failures.join("\n"), /barrier unavailable/);
});

test("causal fairness reports audio, marker, and GPU decision failures", () => {
  const baseline = {
    causalAudioWorkerMixCount: 1,
    causalAudioWorkerEmptyMixCount: 0,
    causalAudioUnderruns: 0,
    causalInputMarkerEnabled: true,
    causalInputMarkerAppliedCount: 0,
    causalInputMarkerExactCorePollCount: 0,
    causalInputMarkerArmedCount: 0,
    causalInputMarkerSubmittedCount: 0,
    causalInputMarkerCompletedCount: 0,
    causalInputMarkerSupersededCount: 0,
    causalInputMarkerSupersededArmedCount: 0,
    causalInputMarkerExpiredCount: 0,
    causalInputMarkerExpiredInFlightCount: 0,
    causalInputMarkerGenerationMismatchCount: 0,
    causalInputMarkerGenerationUnavailableCount: 0,
    causalInputMarkerDroppedInFlightCount: 0,
    causalWgpuErrorCount: 0,
    causalGpuCompletionFailedCount: 0,
  };
  const final = {
    ...baseline,
    causalAudioWorkerMixCount: 2,
    causalAudioWorkerEmptyMixCount: 1,
    causalAudioUnderruns: 1,
    causalInputMarkerAppliedCount: 1,
    causalInputMarkerExactCorePollCount: 1,
    causalInputMarkerArmedCount: 1,
    causalInputMarkerSubmittedCount: 1,
    causalInputMarkerCompletedCount: 0,
    causalInputMarkerSupersededCount: 1,
    causalInputMarkerExpiredCount: 1,
    causalInputMarkerGenerationMismatchCount: 1,
    causalWgpuErrorCount: 1,
  };
  const result = summarizeCausalFairness([baseline, final], { expectedInputEvents: 1 });
  assert.equal(result.inputMarker.parityPassed, false);
  assert.match(result.failures.join("\n"), /audio empty mixes=1/);
  assert.match(result.failures.join("\n"), /WebAudio underruns=1/);
  assert.match(result.failures.join("\n"), /input marker parity/);
  assert.match(result.failures.join("\n"), /supersededCount=1/);
  assert.match(result.failures.join("\n"), /WGPU errors=1/);
});

test("causal fairness fails closed on missing decision counters", () => {
  const baseline = {
    causalAudioWorkerEmptyMixCount: 0,
    causalAudioUnderruns: 0,
    causalWgpuErrorCount: 0,
    causalGpuCompletionFailedCount: 0,
  };
  const result = summarizeCausalFairness([baseline, { ...baseline, causalWgpuErrorCount: undefined }]);
  assert.match(result.failures.join("\n"), /missing WGPU error counter delta/);
});

test("causal fairness fails closed when a decision counter resets", () => {
  const baseline = {
    causalAudioWorkerEmptyMixCount: 3,
    causalAudioUnderruns: 2,
    causalWgpuErrorCount: 1,
    causalGpuCompletionFailedCount: 1,
  };
  const result = summarizeCausalFairness([
    baseline,
    {
      ...baseline,
      causalAudioUnderruns: 1,
      causalGpuCompletionFailedCount: 0,
    },
  ]);
  assert.match(result.failures.join("\n"), /reset WebAudio underrun counter delta=-1/);
  assert.match(result.failures.join("\n"), /reset GPU completion error counter delta=-1/);
});

test("perf gate names presentation underruns explicitly and retains its compatibility alias", async () => {
  const source = await readFile("tools/perf-regression-gate.mjs", "utf8");
  assert.match(source, /presentationUnderrun: maxRegex\(helperText, \/underrun:/);
  assert.match(source, /Deprecated alias retained[\s\S]*?underrun: maxRegex\(helperText/);
  assert.match(source, /failures\.push\(\.\.\.causalFairness\.failures\)/);
  assert.match(source, /"wgpuprodprofile"/);
  assert.match(source, /parseWgpuProducerProfileStats\(sample\.helper\)/);
  assert.match(source, /evaluateWgpuProducerProfileEvidence/);
  assert.match(source, /wgpuProducerProfileDeltaEstimatedTotalNs/);
});

test("run metadata resolves the core selected by coreid", () => {
  const hash = "a".repeat(64);
  assert.equal(
    resolveCoreArtifactPath("repo", `http://127.0.0.1/?coreid=sha256:${hash}`),
    path.join("repo", "build", "core-candidates", hash, "dolphin-core-upstream.wasm")
  );
  assert.equal(
    resolveCoreArtifactPath("repo", "http://127.0.0.1/?video=software"),
    path.join("repo", "cores", "dolphin", "dolphin-core-upstream.wasm")
  );
  assert.throws(
    () => resolveCoreArtifactPath("repo", "http://127.0.0.1/?coreid=not-a-hash"),
    /SHA-256/
  );
});

test("served core paths follow the selected content-addressed candidate", () => {
  const hash = "a".repeat(64);
  const root = path.join("repo");
  assert.deepEqual(
    selectedCoreServedPaths(root, path.join(root, "cores", "dolphin", "dolphin-core-upstream.wasm")),
    {
      js: "cores/dolphin/dolphin-core-upstream.js",
      wasm: "cores/dolphin/dolphin-core-upstream.wasm",
      prebuilt: "cores/dolphin/prebuilt-jit-cache.bin",
    }
  );
  assert.deepEqual(
    selectedCoreServedPaths(
      root,
      path.join(root, "build", "core-candidates", hash, "dolphin-core-upstream.wasm")
    ),
    {
      js: `build/core-candidates/${hash}/dolphin-core-upstream.js`,
      wasm: `build/core-candidates/${hash}/dolphin-core-upstream.wasm`,
      prebuilt: `build/core-candidates/${hash}/prebuilt-jit-cache.bin`,
    }
  );
});

test("core selection evidence fails closed on artifact, runtime, or fallback mismatches", () => {
  const hash = "a".repeat(64);
  const valid = evaluateCoreSelectionEvidence({
    url: `http://127.0.0.1/?coreid=sha256:${hash}`,
    artifactSha256: hash,
    diagnostics: {
      coreSelection: {
        requestedCoreSha256: hash,
        activeCoreSha256: hash,
        fallbackReason: null,
      },
    },
  });
  assert.deepEqual(valid.failures, []);

  const invalid = evaluateCoreSelectionEvidence({
    url: `http://127.0.0.1/?coreid=sha256:${hash}`,
    artifactSha256: "b".repeat(64),
    diagnostics: {
      coreSelection: {
        requestedCoreSha256: hash,
        activeCoreSha256: "c".repeat(64),
        fallbackReason: "candidate-preflight-failed",
      },
    },
  });
  assert.equal(invalid.failures.length, 3);
  assert.match(invalid.failures.join("\n"), /core artifact SHA-256 mismatch/);
  assert.match(invalid.failures.join("\n"), /runtime active/);
  assert.match(invalid.failures.join("\n"), /unexpectedly fell back/);
});

test("candidate bundle evidence binds every packaged file to the selected WASM", () => {
  const hash = "a".repeat(64);
  const files = {
    "dolphin-core-upstream.wasm": hash,
    "dolphin-core-upstream.build.json": "b".repeat(64),
    "dolphin-core-abi-v1.json": "c".repeat(64),
  };
  const manifest = {
    schemaVersion: 1,
    coreId: `sha256:${hash}`,
    buildInfoSha256: files["dolphin-core-upstream.build.json"],
    files: Object.entries(files).map(([name, sha256]) => ({ name, sha256 })),
  };
  assert.deepEqual(evaluateCandidateCoreBundle({ manifest, expectedSha256: hash, files }).failures, []);
  const invalid = evaluateCandidateCoreBundle({
    manifest,
    expectedSha256: "d".repeat(64),
    files: { ...files, "dolphin-core-abi-v1.json": "e".repeat(64) },
  });
  assert.equal(invalid.verified, false);
  assert.match(invalid.failures.join("\n"), /coreId|hash mismatch|WASM hash/);
});

test("selected prebuilt cache evidence is bound to the selected WASM and manifest entry", () => {
  const hash = "a".repeat(64);
  const sha256 = "b".repeat(64);
  const evidence = {
    path: `build/core-candidates/${hash}/prebuilt-jit-cache.bin`,
    bytes: 1234,
    sha256,
    fingerprint: `dolphin-core-sha256-v1:${hash}`,
    entryKeySchema: "wasm-block-sha256-v1",
    entryCount: 8192,
    entriesVerified: true,
  };
  const manifestEntry = {
    name: "prebuilt-jit-cache.bin",
    sha256,
    bytes: 1234,
    fingerprint: evidence.fingerprint,
    entryKeySchema: evidence.entryKeySchema,
    entryCount: 8192,
    entriesVerified: true,
  };
  assert.deepEqual(evaluatePrebuiltJitCacheEvidence({
    evidence,
    expectedSha256: hash,
    manifestEntry,
  }).failures, []);

  const invalid = evaluatePrebuiltJitCacheEvidence({
    evidence: { ...evidence, fingerprint: `dolphin-core-sha256-v1:${"c".repeat(64)}` },
    expectedSha256: hash,
    manifestEntry: { ...manifestEntry, entryCount: 1 },
  });
  assert.equal(invalid.verified, false);
  assert.match(invalid.failures.join("\n"), /fingerprint|entry count/);
  assert.match(evaluatePrebuiltJitCacheEvidence({
    evidence,
    expectedSha256: hash,
    requireManifestEntry: true,
  }).failures.join("\n"), /manifest entry is missing/);
});

test("geometry range evidence requires both activation and the producer ABI", () => {
  assert.deepEqual(evaluateWgpuGeometryRangeEvidence({}).failures, []);
  assert.deepEqual(evaluateWgpuGeometryRangeEvidence({
    requested: "0",
    telemetry: { geometryRangeEnabled: false, producerGeometryRangeAvailable: false },
  }).failures, []);
  assert.deepEqual(evaluateWgpuGeometryRangeEvidence({
    requested: "1",
    telemetry: { geometryRangeEnabled: true, producerGeometryRangeAvailable: true },
  }).failures, []);
  assert.match(evaluateWgpuGeometryRangeEvidence({
    requested: "1",
    telemetry: { geometryRangeEnabled: true, producerGeometryRangeAvailable: false },
  }).failures[0], /producerAvailable=0/);
  assert.match(evaluateWgpuGeometryRangeEvidence({
    requested: "1",
    telemetry: null,
  }).failures[0], /active=unavailable/);
  // The range needs the pack (geomrange=1 with geompack=0 is inactive), and a
  // non-canonical value is the default (on), as the product reads them.
  const off = { geometryRangeEnabled: false, producerGeometryRangeAvailable: true };
  const on = { geometryRangeEnabled: true, producerGeometryRangeAvailable: true };
  assert.deepEqual(evaluateWgpuGeometryRangeEvidence({ requested: "1", packRequested: "0", telemetry: off }).failures, []);
  assert.match(evaluateWgpuGeometryRangeEvidence({ requested: "1", packRequested: "0", telemetry: on }).failures[0], /requested=0/);
  assert.deepEqual(evaluateWgpuGeometryRangeEvidence({ requested: "yes", telemetry: on }).failures, []);
});

test("metrics-off WGPU evidence requires a matching static runtime config", () => {
  const params = {
    metrics: "0",
    wgpuuploadtransport: "mapped",
    wgpuubocache: "1",
    wgpuubometrics: "0",
    wgpuuniformfast: "0",
    wgpuubopack: "0",
    wgpustagefast: "0",
    wgpustagingslots: "3",
    wgpumappedtiming: "1",
    wgpugeompack: "0",
    wgpugeomrange: "0",
    wgputailgate: "0",
  };
  const runtimeConfig = {
    schema: "wasm-dolphin.wgpu-runtime-config.v1",
    metricsEnabled: false,
    uploadTransport: "mapped",
    uboCacheEnabled: true,
    producerUboCacheMetricsEnabled: false,
    producerUniformFastEnabled: false,
    uboPackEnabled: false,
    producerUboCacheAvailable: true,
    producerUboPackAvailable: true,
    mappedStagingFastPath: false,
    mappedStaging: {
      enabled: true,
      slotCount: 3,
      recordStore: "objects",
      timing: { enabled: false, stride: 1 },
    },
    geometryPackEnabled: false,
    geometryRangeEnabled: false,
    producerGeometryRangeAvailable: true,
    tailGate: {
      schema: "wasm-dolphin.wgpu-tail-gate.v1",
      schemaVersion: 1,
      requested: false,
      available: true,
      enabled: false,
    },
  };
  const valid = evaluateWgpuRuntimeConfigEvidence({
    required: true,
    params,
    runtimeConfig,
  });
  assert.deepEqual(valid.failures, []);
  assert.match(evaluateWgpuRuntimeConfigEvidence({
    required: true,
    params,
    runtimeConfig: null,
  }).failures.join("\n"), /schema mismatch|upload transport mismatch/);
  for (const [field, value, pattern] of [
    ["uploadTransport", "queue", /upload transport mismatch/],
    ["uboCacheEnabled", false, /UBO cache mismatch/],
    ["producerUboCacheAvailable", false, /producer setter is unavailable/],
    ["geometryRangeEnabled", true, /geometry range mismatch/],
  ]) {
    assert.match(evaluateWgpuRuntimeConfigEvidence({
      required: true,
      params,
      runtimeConfig: { ...runtimeConfig, [field]: value },
    }).failures.join("\n"), pattern);
  }
  // Unforced, the engine's defaults are expected: under JavaScriptCore,
  // mapped staging and 4 slots; an artifact without the engine reads as V8.
  const { wgpuuploadtransport: _t, wgpustagingslots: _s, ...unforced } = params;
  const jsc = { ...runtimeConfig, wasmEngine: "jsc", uploadTransport: "mapped", mappedStaging: { ...runtimeConfig.mappedStaging, slotCount: 4 } };
  assert.deepEqual(evaluateWgpuRuntimeConfigEvidence({ required: true, params: unforced, runtimeConfig: jsc }).failures, []);
  assert.match(evaluateWgpuRuntimeConfigEvidence({
    required: true, params: unforced, runtimeConfig: { ...jsc, wasmEngine: "v8" },
  }).failures.join("\n"), /upload transport mismatch/);
  assert.match(evaluateWgpuRuntimeConfigEvidence({
    required: true, params: unforced, runtimeConfig: { ...jsc, wasmEngine: undefined },
  }).failures.join("\n"), /upload transport mismatch/);
  // Geometry merging is on by default since 2026-10-29: without the
  // parameters both are expected on; =0 turns each off.
  const { wgpugeompack: _pack, wgpugeomrange: _range, ...noGeometryParams } = params;
  const geometryOn = { ...runtimeConfig, geometryPackEnabled: true, geometryRangeEnabled: true };
  assert.deepEqual(evaluateWgpuRuntimeConfigEvidence({
    required: true, params: noGeometryParams, runtimeConfig: geometryOn,
  }).failures, []);
  assert.match(evaluateWgpuRuntimeConfigEvidence({
    required: true, params: noGeometryParams, runtimeConfig,
  }).failures.join("\n"), /geometry pack mismatch/);
  assert.deepEqual(evaluateWgpuRuntimeConfigEvidence({
    required: true, params: { ...noGeometryParams, wgpugeomrange: "0" },
    runtimeConfig: { ...geometryOn, geometryRangeEnabled: false },
  }).failures, []);
  // Every slot count the engine accepts (3 to 8) is accepted here too.
  const sixSlots = { ...runtimeConfig, mappedStaging: { ...runtimeConfig.mappedStaging, slotCount: 6 } };
  assert.deepEqual(evaluateWgpuRuntimeConfigEvidence({
    required: true,
    params: { ...params, wgpustagingslots: "6" },
    runtimeConfig: sixSlots,
  }).failures, []);
  assert.match(evaluateWgpuRuntimeConfigEvidence({
    required: true,
    params: { ...params, wgpustagingslots: "6" },
    runtimeConfig,
  }).failures.join("\n"), /slot/i);
});

test("WGPU semantic qualification requires complete post-load evidence", () => {
  const validTelemetry = {
    semanticRuntime: {
      requested: true,
      active: true,
      failed: false,
      evidenceValid: true,
      captureComplete: true,
      loadedCheckpointGeneration: 3,
      loadEpochCount: 1,
      currentEpochCommittedEventCount: 128,
      minimumCommittedEventCount: 128,
      qualificationReady: true,
    },
  };
  assert.deepEqual(evaluateWgpuSemanticQualificationEvidence({
    requested: "1",
    telemetry: validTelemetry,
    loadedCheckpointGeneration: 3,
  }).failures, []);
  assert.deepEqual(evaluateWgpuSemanticQualificationEvidence({
    requested: "0",
  }).failures, []);

  for (const [label, update, expected] of [
    ["capture", { captureComplete: false }, /capture did not complete/],
    ["validity", { evidenceValid: false }, /evidence is invalid/],
    ["load epoch", { loadEpochCount: 0 }, /observed no load epoch/],
    ["current epoch", { currentEpochCommittedEventCount: 127 }, /below its committed-event minimum/],
    ["qualification", { qualificationReady: false }, /qualification is not ready/],
  ]) {
    const result = evaluateWgpuSemanticQualificationEvidence({
      requested: "1",
      telemetry: {
        semanticRuntime: { ...validTelemetry.semanticRuntime, ...update },
      },
      loadedCheckpointGeneration: 3,
    });
    assert.match(result.failures.join("\n"), expected, label);
  }

  assert.match(evaluateWgpuSemanticQualificationEvidence({
    requested: "1",
    telemetry: validTelemetry,
    loadedCheckpointGeneration: 0,
  }).failures.join("\n"), /no loaded core checkpoint/);
  assert.match(evaluateWgpuSemanticQualificationEvidence({
    requested: "1",
    telemetry: validTelemetry,
    loadedCheckpointGeneration: 4,
  }).failures.join("\n"), /checkpoint generation mismatch/);
});

test("renderer worker canary evidence requires the nested-worker schema", () => {
  assert.deepEqual(evaluateWgpuRendererWorkerProbeEvidence({}).failures, []);
  const telemetry = {
    rendererWorkerProbe: {
      requested: "canary",
      active: true,
      passed: true,
      schema: "wasm-dolphin.wgpu-renderer-worker-canary.v1",
    },
  };
  assert.deepEqual(evaluateWgpuRendererWorkerProbeEvidence({
    requested: "canary",
    telemetry,
  }).failures, []);
  assert.match(evaluateWgpuRendererWorkerProbeEvidence({
    requested: "canary",
    telemetry: { rendererWorkerProbe: { requested: "canary", active: false } },
  }).failures.join("\n"), /active=0|schema mismatch/);
});

test("WGPU output contracts distinguish intentional blank probes from visible canvas runs", () => {
  const blankDiagnostics = {
    activePresenterBackend: "wgpu-upload-probe",
    outputContract: {
      schema: "wasm-dolphin.wgpu-output-contract.v1",
      disposition: "intentional-blank-probe",
      expectsVisibleCanvas: false,
      activePresenterBackend: "wgpu-upload-probe",
      probeMode: "inline-upload",
    },
  };
  assert.deepEqual(evaluateWgpuOutputContractEvidence({
    video: "wgpu",
    requestedProbe: "inline-upload",
    diagnostics: blankDiagnostics,
  }).failures, []);

  const visibleDiagnostics = {
    activePresenterBackend: "webgpu",
    outputContract: {
      schema: "wasm-dolphin.wgpu-output-contract.v1",
      disposition: "visible-canvas",
      expectsVisibleCanvas: true,
      activePresenterBackend: "webgpu",
      probeMode: null,
    },
  };
  assert.deepEqual(evaluateWgpuOutputContractEvidence({
    video: "wgpu",
    requestedProbe: "off",
    diagnostics: visibleDiagnostics,
  }).failures, []);
  assert.deepEqual(evaluateWgpuOutputContractEvidence({
    video: "wgpu",
    requestedProbe: "canary",
    diagnostics: visibleDiagnostics,
  }).failures, []);

  assert.match(evaluateWgpuOutputContractEvidence({
    video: "wgpu",
    requestedProbe: "off",
    diagnostics: blankDiagnostics,
  }).failures.join("\n"), /disposition mismatch|expectsVisibleCanvas mismatch|backend mismatch/);
  assert.match(evaluateWgpuOutputContractEvidence({
    video: "wgpu",
    requestedProbe: "inline-upload",
    diagnostics: null,
  }).failures.join("\n"), /schema mismatch/);
  assert.deepEqual(evaluateWgpuOutputContractEvidence({
    video: "software",
    diagnostics: null,
  }).failures, []);
});

test("quiet WGPU diagnostic logging requires explicit activation evidence", () => {
  const diagnostics = {
    diagnosticLogFilter: {
      schema: "wasm-dolphin.wgpu-diagnostic-log-filter.v1",
      enabled: true,
      droppedCount: 12,
      droppedByTag: { "s28ah-ps": 12 },
    },
  };
  assert.deepEqual(evaluateWgpuDiagnosticLogFilterEvidence({
    requested: "1",
    diagnostics,
  }).failures, []);
  assert.deepEqual(evaluateWgpuDiagnosticLogFilterEvidence({
    requested: "0",
    diagnostics: null,
  }).failures, []);
  assert.match(evaluateWgpuDiagnosticLogFilterEvidence({
    requested: "1",
    diagnostics: { diagnosticLogFilter: { enabled: false } },
  }).failures.join("\n"), /schema mismatch|not active|invalid|unavailable/);
});

test("WGPU producer profile parser retains raw and period-derived phase totals", () => {
  const periods = Array.from({ length: 12 }, (_, index) => index + 1);
  const calls = Array.from({ length: 12 }, (_, index) => (index + 1) * 10);
  const samples = Array.from({ length: 12 }, (_, index) => index + 1);
  const totals = Array.from({ length: 12 }, (_, index) => (index + 1) * 100);
  const maxima = Array.from({ length: 12 }, (_, index) => (index + 1) * 7);
  const parsed = parseWgpuProducerProfileStats(producerProfileWire({
    periods, calls, samples, totals, maxima,
  }));
  assert.equal(parsed.wgpuProducerProfileSchemaVersion, 1);
  assert.equal(parsed.wgpuProducerProfileEnabled, true);
  assert.equal(parsed.wgpuProducerProfileEpoch, 9);
  assert.equal(parsed.wgpuProducerProfilePhaseCount, 12);
  assert.deepEqual(parsed.wgpuProducerProfilePhaseOrder, WGPU_PRODUCER_PROFILE_PHASE_ORDER);
  assert.deepEqual(parsed.wgpuProducerProfileEstimatedTotalNs,
    totals.map((value, index) => value * periods[index]));
  assert.equal(parseWgpuProducerProfileStats("wgprod:1,1,9,12 wgprd:1,2"), null);
});

test("WGPU producer profile evidence is fail-closed and monotonic across the timed window", () => {
  const makeSample = (multiplier, overrides = {}) => {
    const periods = overrides.periods ?? Array(12).fill(8);
    const calls = overrides.calls ?? Array(12).fill(100 * multiplier);
    const samples = overrides.samples ?? Array(12).fill(10 * multiplier);
    const totals = overrides.totals ?? Array(12).fill(1_000 * multiplier);
    const maxima = overrides.maxima ?? Array(12).fill(100 * multiplier);
    return {
      helper: producerProfileWire({
        enabled: overrides.enabled ?? 1,
        epoch: overrides.epoch ?? 9,
        phaseCount: overrides.phaseCount ?? 12,
        periods,
        calls,
        samples,
        totals,
        maxima,
      }),
      causalWgpuProducerProfileRequested: true,
      causalWgpuProducerProfileAvailable: true,
    };
  };
  const valid = evaluateWgpuProducerProfileEvidence({
    requested: "1",
    metrics: "1",
    samples: [makeSample(1), makeSample(2)],
  });
  assert.deepEqual(valid.failures, []);
  assert.equal(valid.activated, true);
  assert.deepEqual(valid.deltas.calls, Array(12).fill(100));
  assert.deepEqual(valid.deltas.estimatedTotalNs, Array(12).fill(8_000));

  assert.match(evaluateWgpuProducerProfileEvidence({
    requested: "1", metrics: "0", samples: [makeSample(1)],
  }).failures.join("\n"), /requires metrics=1/);
  assert.match(evaluateWgpuProducerProfileEvidence({
    requested: "1", metrics: "1", samples: [makeSample(1), makeSample(2, { epoch: 10 })],
  }).failures.join("\n"), /epoch changed/);
  assert.match(evaluateWgpuProducerProfileEvidence({
    requested: "1", metrics: "1", samples: [makeSample(1), makeSample(2, { periods: Array(12).fill(0) })],
  }).failures.join("\n"), /periods is invalid|periods changed/);
  assert.match(evaluateWgpuProducerProfileEvidence({
    requested: "1", metrics: "1", samples: [makeSample(2), makeSample(1)],
  }).failures.join("\n"), /calls regressed|samples regressed|sampleTotalNs regressed|maxNs regressed|sampleMaxNs regressed/);
  assert.match(evaluateWgpuProducerProfileEvidence({
    requested: "1",
    metrics: "1",
    samples: [makeSample(1, { calls: Array(12).fill(1), samples: Array(12).fill(2) })],
  }).failures.join("\n"), /samples exceed calls/);
  assert.match(evaluateWgpuProducerProfileEvidence({
    requested: "1", metrics: "1", samples: [{ helper: "missing" }],
  }).failures.join("\n"), /missing or malformed/);
  assert.match(evaluateWgpuProducerProfileEvidence({
    requested: "1",
    metrics: "1",
    samples: [{
      causalWgpuProducerProfileSchema: "wasm-dolphin.wgpu-producer-profile.v1",
      causalWgpuProducerProfileRequested: true,
      causalWgpuProducerProfileAvailable: true,
      causalWgpuProducerProfileEnabled: true,
      causalWgpuProducerProfileEpoch: 9,
      causalWgpuProducerProfilePhaseCount: 12,
      causalWgpuProducerProfilePhaseOrder: [...WGPU_PRODUCER_PROFILE_PHASE_ORDER],
    }],
  }).failures.join("\n"), /periods is invalid|calls is invalid/);
});

test("WGPU tail-gate parser and evidence fail closed for both experiment arms", () => {
  const wire = (enabled, epoch, payload, flush, refresh, clean, dirty) =>
    `wgtail:1,${enabled},${epoch},256,${payload},${flush},${refresh},${clean},${dirty}`;
  assert.deepEqual(parseWgpuTailGateStats(wire(1, 7, 100, 5, 3, 92, 0)), {
    wgpuTailGateSchema: "wasm-dolphin.wgpu-tail-gate.v1",
    wgpuTailGateSchemaVersion: 1,
    wgpuTailGateEnabled: true,
    wgpuTailGateEpoch: 7,
    wgpuTailGatePeriod: 256,
    wgpuTailGatePayloadSamples: 100,
    wgpuTailGateFlushNeededSamples: 5,
    wgpuTailGateRefreshNeededSamples: 3,
    wgpuTailGateBothCleanSamples: 92,
    wgpuTailGateDirtyAtSkip: 0,
  });
  assert.equal(parseWgpuTailGateStats("wgtail:2,1,7,256,1,0,0,1,0"), null);
  assert.equal(parseWgpuTailGateStats("wgtail:1,1,7,256,1,0,0,1"), null);

  const enabled = evaluateWgpuTailGateEvidence({
    requested: "1",
    samples: [
      { helper: wire(1, 7, 100, 5, 3, 92, 0) },
      { helper: wire(1, 7, 200, 10, 6, 184, 0) },
    ],
  });
  assert.deepEqual(enabled.failures, []);
  assert.equal(enabled.activated, true);
  assert.equal(enabled.period, 256);
  assert.deepEqual(enabled.deltas, {
    payloadSamples: 100,
    flushNeededSamples: 5,
    refreshNeededSamples: 3,
    bothCleanSamples: 92,
    dirtyAtSkip: 0,
  });

  const disabled = evaluateWgpuTailGateEvidence({
    requested: "0",
    samples: [
      {
        causalWgpuTailGateSchema: "wasm-dolphin.wgpu-tail-gate.v1",
        causalWgpuTailGateSchemaVersion: 1,
        causalWgpuTailGateRequested: false,
        causalWgpuTailGateAvailable: true,
        causalWgpuTailGateEnabled: false,
        causalWgpuTailGateEpoch: 0,
        causalWgpuTailGatePeriod: 256,
        causalWgpuTailGatePayloadSamples: 0,
        causalWgpuTailGateFlushNeededSamples: 0,
        causalWgpuTailGateRefreshNeededSamples: 0,
        causalWgpuTailGateBothCleanSamples: 0,
        causalWgpuTailGateDirtyAtSkip: 0,
      },
    ],
  });
  assert.deepEqual(disabled.failures, []);
  assert.equal(disabled.final.enabled, false);

  for (const [label, result, pattern] of [
    ["enabled mismatch", evaluateWgpuTailGateEvidence({
      requested: "0", samples: [{ helper: wire(1, 7, 10, 1, 1, 8, 0) }],
    }), /enabled mismatch/],
    ["disabled counters", evaluateWgpuTailGateEvidence({
      requested: "0", samples: [{ helper: wire(0, 0, 10, 1, 1, 8, 0) }],
    }), /counters must remain zero/],
    ["epoch drift", evaluateWgpuTailGateEvidence({
      requested: "1", samples: [
        { helper: wire(1, 7, 10, 1, 1, 8, 0) },
        { helper: wire(1, 8, 20, 2, 2, 16, 0) },
      ],
    }), /epoch changed/],
    ["period", evaluateWgpuTailGateEvidence({
      requested: "1", samples: [{ helper: "wgtail:1,1,7,64,10,1,1,8,0" }],
    }), /expected 256/],
    ["no payload samples", evaluateWgpuTailGateEvidence({
      requested: "1", samples: [{ helper: wire(1, 7, 0, 0, 0, 0, 0) }],
    }), /payloadSamples must be positive/],
    ["no clean samples", evaluateWgpuTailGateEvidence({
      requested: "1", samples: [{ helper: wire(1, 7, 10, 5, 5, 0, 0) }],
    }), /bothCleanSamples must be positive/],
    ["dirty skip", evaluateWgpuTailGateEvidence({
      requested: "1", samples: [{ helper: wire(1, 7, 10, 1, 1, 8, 1) }],
    }), /dirtyAtSkip=1/],
  ]) {
    assert.match(result.failures.join("\n"), pattern, label);
  }
});

test("sparse UBO evidence gates fixed-window deltas and rejects lifetime-only claims", () => {
  const snapshot = ({ scale = 1, active = true, instanceId = active ? 7 : 0,
    stagedBytes = 100 * scale } = {}) => ({
    schema: "wasm-dolphin.wgpu-sparse-ubo.v1",
    instanceId,
    requested: active,
    active,
    coverageThreshold: 0.5,
    maxSparseRanges: 0,
    classOrder: ["vs", "ps", "gs"],
    classSizes: [4112, 1536, 64],
    shadowValid: active ? [true, true, true] : [false, false, false],
    eligibleCalls: active ? 10 * scale : 0,
    baselineCalls: active ? scale : 0,
    sparseCalls: active ? 7 * scale : 0,
    equalCalls: active ? scale : 0,
    fullFallbackCalls: active ? scale : 0,
    capacityMisses: 0,
    fullBytes: active ? 1000 * scale : 0,
    stagedBytes: active ? stagedBytes : 0,
    avoidedStagedBytes: active ? 1000 * scale - stagedBytes : 0,
    copyForwardBytes: active ? 800 * scale : 0,
    overlayRanges: active ? 20 * scale : 0,
    overlayBytes: active ? stagedBytes : 0,
    predictedGpuCopyBytes: active ? 1200 * scale : 0,
    invalidations: 0,
    invalidationReasons: {},
    callsByClass: active ? [4 * scale, 3 * scale, 3 * scale] : [0, 0, 0],
    sparseCallsByClass: active ? [3 * scale, 2 * scale, 2 * scale] : [0, 0, 0],
    stagedBytesByClass: active
      ? [Math.floor(stagedBytes * 0.4), Math.floor(stagedBytes * 0.3),
          stagedBytes - Math.floor(stagedBytes * 0.7)]
      : [0, 0, 0],
  });
  const sample = (uboSparse) => ({ causalTelemetry: { webgpu: { uboSparse } } });

  const enabled = evaluateWgpuSparseUboEvidence({
    requested: "1",
    samples: [sample(snapshot({ scale: 1 })), sample(snapshot({ scale: 2 }))],
  });
  assert.deepEqual(enabled.failures, []);
  assert.equal(enabled.activated, true);
  assert.equal(enabled.deltas.eligibleCalls, 10);
  assert.equal(enabled.deltas.sparseCalls, 7);
  assert.equal(enabled.deltas.fullBytes, 1000);
  assert.equal(enabled.deltas.stagedBytes, 100);

  assert.deepEqual(evaluateWgpuSparseUboEvidence({
    requested: "0", samples: [sample(snapshot({ active: false }))],
  }).failures, []);

  for (const [label, result, pattern] of [
    ["missing", evaluateWgpuSparseUboEvidence({
      requested: "1", samples: [{}],
    }), /missing or malformed|at least two/],
    ["one sample", evaluateWgpuSparseUboEvidence({
      requested: "1", samples: [sample(snapshot())],
    }), /at least two timed samples/],
    ["instance reset", evaluateWgpuSparseUboEvidence({
      requested: "1",
      samples: [sample(snapshot()), sample(snapshot({ scale: 2, instanceId: 8 }))],
    }), /instance changed/],
    ["no measured saving", evaluateWgpuSparseUboEvidence({
      requested: "1",
      samples: [
        sample(snapshot({ scale: 1, stagedBytes: 1000 })),
        sample(snapshot({ scale: 2, stagedBytes: 2000 })),
      ],
    }), /did not reduce mapped bytes in the timed window/],
    ["bad accounting", evaluateWgpuSparseUboEvidence({
      requested: "1",
      samples: [
        sample(snapshot()),
        sample({ ...snapshot({ scale: 2 }), eligibleCalls: 99 }),
      ],
    }), /call accounting is inconsistent|per-class calls are inconsistent/],
  ]) {
    assert.match(result.failures.join("\n"), pattern, label);
  }
});

test("UBO compute projection evidence requires passive, conserved byte and command savings", () => {
  const snapshot = ({ scale = 1, active = true, malformed = 0,
    projectedBytes = 25_600 * scale } = {}) => {
    const eligibleCalls = active ? 100 * scale : 0;
    const eligibleBytes = active ? 100_000 * scale : 0;
    const packageWork = active ? 25_000 * scale : 0;
    const packagePadding = active ? projectedBytes - packageWork : 0;
    const packages = active ? 5 * scale : 0;
    return {
      schema: "wasm-dolphin.wgpu-ubo-compute-projection.v1",
      requested: active,
      active,
      enabled: active,
      projectionOnly: true,
      replayBehaviorChanged: false,
      runtimeEligible: false,
      eligible: { calls: eligibleCalls, bytes: eligibleBytes },
      bytes: {
        payload: active ? 20_000 * scale : 0,
        descriptors: active ? 5_000 * scale : 0,
        packageWork,
        packagePadding,
        projected: active ? projectedBytes : 0,
        avoided: active ? eligibleBytes - projectedBytes : 0,
      },
      commands: {
        legacyCopy: eligibleCalls,
        projectedCopy: packages,
        avoidedCopy: eligibleCalls - packages,
        dispatches: packages,
        packages,
      },
      records: {
        total: eligibleCalls,
        full: active ? 3 * scale : 0,
        delta: active ? 50 * scale : 0,
        equal: active ? 40 * scale : 0,
        rawFull: active ? 7 * scale : 0,
        utilityRaw: active ? 5 * scale : 0,
        unknownClassRaw: active ? 2 * scale : 0,
        ranges: active ? 60 * scale : 0,
        reconstructedBytes: eligibleBytes,
      },
      packages: { records: eligibleCalls },
      malformed,
      unclassifiedResourceIdentity: 0,
    };
  };
  const sample = (uboComputeProjection) => ({
    causalTelemetry: { webgpu: { uboComputeProjection } },
  });

  const enabled = evaluateWgpuUboComputeProjectionEvidence({
    requested: "1",
    samples: [sample(snapshot()), sample(snapshot({ scale: 2 }))],
  });
  assert.deepEqual(enabled.failures, []);
  assert.equal(enabled.deltas.eligibleBytes, 100_000);
  assert.equal(enabled.deltas.projectedBytes, 25_600);
  assert.equal(enabled.deltas.projectedGpuCommands, 10);
  assert.equal(enabled.deltas.avoidedGpuCommands, 90);

  assert.deepEqual(evaluateWgpuUboComputeProjectionEvidence({
    requested: "0",
    samples: [sample(snapshot({ active: false }))],
  }).failures, []);

  for (const [label, result, pattern] of [
    ["missing", evaluateWgpuUboComputeProjectionEvidence({
      requested: "1", samples: [{}],
    }), /missing or malformed|at least two/],
    ["malformed", evaluateWgpuUboComputeProjectionEvidence({
      requested: "1",
      samples: [sample(snapshot()), sample(snapshot({ scale: 2, malformed: 1 }))],
    }), /malformed or unclassified/],
    ["no byte saving", evaluateWgpuUboComputeProjectionEvidence({
      requested: "1",
      samples: [
        sample(snapshot()),
        sample(snapshot({ scale: 2, projectedBytes: 125_600 })),
      ],
    }), /did not reduce timed package bytes/],
    ["no command saving", evaluateWgpuUboComputeProjectionEvidence({
      requested: "1",
      samples: [
        sample(snapshot()),
        sample({
          ...snapshot({ scale: 2 }),
          commands: {
            legacyCopy: 200,
            projectedCopy: 100,
            avoidedCopy: 100,
            dispatches: 100,
            packages: 100,
          },
        }),
      ],
    }), /did not reduce total timed GPU commands/],
  ]) {
    assert.match(result.failures.join("\n"), pattern, label);
  }
});

test("upload-probe evidence requires exclusive ownership and quiescent conserved work", () => {
  const opHistogram = new Array(25).fill(0);
  opHistogram[5] = 2;
  opHistogram[6] = 3;
  opHistogram[7] = 1;
  opHistogram[8] = 2;
  opHistogram[12] = 4;
  opHistogram[19] = 4;
  opHistogram[22] = 2;
  opHistogram[23] = 2;
  const probe = {
    requested: "worker-upload",
    active: true,
    passed: true,
    schema: "wasm-dolphin.wgpu-renderer-worker-upload-probe.v1",
    executorLocation: "worker",
    blankOutput: true,
    sharedHeap: true,
    protocolVersion: 3,
    claimedOwner: 2,
    claimCount: 1,
    conflictCount: 0,
    handoffAckCount: 1,
    observedRecordCount: 20,
    consumedRecordCount: 20,
    opHistogram,
    uploadRecordCount: 5,
    releasedUploadCount: 5,
    totalUploadBytes: 4096,
    invalidRecordCount: 0,
    unknownOpcodeCount: 0,
    invalidUploadSpanCount: 0,
    uploadReleaseMismatchCount: 0,
    missingResourceCount: 0,
    quiesced: true,
    backlog: 0,
    fatalCount: 0,
    consumerState: 1,
    consumerError: 0,
    streamDigest: "deadbeef",
    submitDigests: ["11111111", "22222222"],
    submissionCount: 2,
    gpuCompletionCount: 2,
    staging: { failed: false },
  };
  assert.deepEqual(evaluateWgpuRendererWorkerProbeEvidence({
    requested: "worker-upload",
    telemetry: { rendererWorkerProbe: probe },
  }).failures, []);
  const invalid = evaluateWgpuRendererWorkerProbeEvidence({
    requested: "worker-upload",
    telemetry: { rendererWorkerProbe: {
      ...probe,
      conflictCount: 1,
      consumedRecordCount: 19,
      releasedUploadCount: 4,
      backlog: 1,
      quiesced: false,
    } },
  }).failures.join("\n");
  assert.match(invalid, /ownership claim is unique/);
  assert.match(invalid, /every observed record was consumed/);
  assert.match(invalid, /every upload record was released once/);
  assert.match(invalid, /finalized at quiescence/);

  const nullProbe = {
    ...probe,
    requested: "null-drain",
    executorLocation: "null",
    claimedOwner: 3,
    submissionCount: 0,
    gpuCompletionCount: 0,
    staging: null,
  };
  assert.deepEqual(evaluateWgpuRendererWorkerProbeEvidence({
    requested: "null-drain",
    telemetry: { rendererWorkerProbe: nullProbe },
  }).failures, []);
});

test("upload-probe finalization binds forced causal telemetry to the quiesced snapshot", () => {
  const snapshot = {
    requested: "inline-upload",
    schema: "wasm-dolphin.wgpu-renderer-worker-upload-probe.v1",
    executorLocation: "inline",
    observedRecordCount: 20,
    consumedRecordCount: 20,
    totalUploadBytes: 4096,
    streamDigest: "deadbeef",
    quiesced: true,
    passed: true,
  };
  const valid = validateWgpuUploadProbeFinalization({
    requested: "inline-upload",
    finalized: {
      snapshot,
      causalTelemetry: {
        schemaVersion: CAUSAL_TELEMETRY_SCHEMA_VERSION,
        webgpu: { rendererWorkerProbe: { ...snapshot } },
      },
    },
  });
  assert.deepEqual(valid.failures, []);

  const missing = validateWgpuUploadProbeFinalization({
    requested: "inline-upload",
    finalized: { snapshot },
  });
  assert.match(missing.failures.join("\n"), /schema|both be present/);

  const disagreement = validateWgpuUploadProbeFinalization({
    requested: "inline-upload",
    finalized: {
      snapshot,
      causalTelemetry: {
        schemaVersion: CAUSAL_TELEMETRY_SCHEMA_VERSION,
        webgpu: { rendererWorkerProbe: { ...snapshot, streamDigest: "bad0cafe" } },
      },
    },
  });
  assert.match(disagreement.failures.join("\n"), /streamDigest/);
});

test("profile parser separates core, XFB, publish, and JS presentation costs", () => {
  const helper =
    "video xfb:10 coreprof xfb_dt:16.7 avg:17.1 max:41.2 decode:1.3 avg:1.4 max:2.8 " +
    "vo_sync:0.1/max4.2 vo_pub:1.5/max3.1 vo_total:1.6/max5.0 " +
    "swxfb:0.9 conv:0.8 copy:0.1 sz:640x480->480 | jit:on";
  const frame =
    "loop:0.35 pump:0.02 run:0.10 api:0.03 cap:0.50 copy:0.40 " +
    "present:1.90 draw:1.20 hash:0.08 paced:0.04 copy:73.2MB/s cap:30 shown:29";

  assert.deepEqual(parseProfileMetrics(helper, frame), {
    coreXfbIntervalMs: 16.7,
    coreXfbAverageIntervalMs: 17.1,
    coreXfbMaxIntervalMs: 41.2,
    coreXfbDecodeMs: 1.3,
    coreXfbAverageDecodeMs: 1.4,
    coreXfbMaxDecodeMs: 2.8,
    videoOutputSyncMs: 0.1,
    videoOutputMaxSyncMs: 4.2,
    videoOutputPublishMs: 1.5,
    videoOutputMaxPublishMs: 3.1,
    videoOutputTotalMs: 1.6,
    videoOutputMaxTotalMs: 5,
    softwareXfbTotalMs: 0.9,
    softwareXfbConvertMs: 0.8,
    softwareXfbCopyMs: 0.1,
    jsLoopMs: 0.35,
    jsPumpMs: 0.02,
    jsRunMs: 0.1,
    jsApiMs: 0.03,
    jsCaptureMs: 0.5,
    jsCopyMs: 0.4,
    jsPresentMs: 1.9,
    jsDrawMs: 1.2,
    jsHashMs: 0.08,
    jsPacedMs: 0.04,
    jsCopyMegabytesPerSecond: 73.2,
    jsCaptureCount: 30,
    jsPresentCount: 29,
  });
});

test("profile parser uses nulls when a backend does not emit a profile", () => {
  const parsed = parseProfileMetrics("jit:warmup", "-");
  assert.equal(parsed.coreXfbIntervalMs, null);
  assert.equal(parsed.softwareXfbTotalMs, null);
  assert.equal(parsed.jsPresentMs, null);
});

test("CSV output preserves arrays, commas, quotes, and newlines", () => {
  const csv = recordsToCsv([
    { run: 1, note: 'hello, "GPU"', histogram: [1, 2] },
    { run: 2, note: "line1\nline2", histogram: null },
  ]);
  assert.equal(
    csv,
    'run,note,histogram\n1,"hello, ""GPU""","[1,2]"\n2,"line1\nline2",\n'
  );
});

test("fixture verification rejects missing and hash-mismatched files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wasm-dolphin-fixture-"));
  const fixturePath = path.join(directory, "fixture.sav");
  try {
    await assert.rejects(
      verifyFileFixture(fixturePath, { label: "battle save", expectedSha256: "0".repeat(64) }),
      /Missing battle save/
    );
    await writeFile(fixturePath, "reference battle");
    await assert.rejects(
      verifyFileFixture(fixturePath, { label: "battle save", expectedSha256: "0".repeat(64) }),
      /SHA-256 mismatch/
    );
    const expectedSha256 = createHash("sha256").update("reference battle").digest("hex");
    const verified = await verifyFileFixture(fixturePath, { label: "battle save", expectedSha256 });
    assert.equal(verified.verified, true);
    assert.equal(verified.sha256, expectedSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixed-battle provenance rejects missing fields and premature timing", () => {
  const manifest = validManifest();
  delete manifest.artifacts.core.sha256;
  assert.throws(() => assertRunProvenance(manifest), /artifacts\.core\.sha256/);

  const premature = validManifest();
  premature.benchmark.saveStateAt = 1;
  assert.throws(() => assertRunProvenance(premature), /saveStateAt=0/);

  const menuDriven = validManifest();
  menuDriven.benchmark.inputScriptMode = "scripted";
  assert.throws(() => assertRunProvenance(menuDriven), /inputScriptMode=none or post-load-only/);

  const postLoad = validManifest();
  Object.assign(postLoad.benchmark, {
    inputScriptMode: "post-load-only",
    inputScriptEventCount: 2,
    inputScriptScheduleOrigin: "after-first-timed-sample",
    inputScriptSha256: "a".repeat(64),
    timingStartsAfterVerifiedLoad: true,
    timingBaselineEstablishedAt: "2026-07-10T00:00:00.000Z",
  });
  assert.equal(assertRunProvenance(postLoad).benchmark.inputScriptEventCount, 2);
  postLoad.benchmark.inputScriptScheduleOrigin = "save-loaded";
  assert.throws(() => assertRunProvenance(postLoad), /first timed baseline sample/);

  const labelOnly = validManifest();
  labelOnly.fixture.battleCheckpoint.verified = false;
  assert.throws(() => assertRunProvenance(labelOnly), /battle\/XFB checkpoint/);

  const unknownTelemetry = validManifest();
  unknownTelemetry.causalTelemetrySchema.version = CAUSAL_TELEMETRY_SCHEMA_VERSION + 1;
  assert.throws(() => assertRunProvenance(unknownTelemetry), /Unsupported causal telemetry schema/);

  assert.equal(assertRunProvenance(validManifest()).fixture.saveStateLoaded, true);
});

test("post-load input parser accepts only balanced deterministic emulator keys", () => {
  const parsed = parsePostLoadInputScript(
    "down:2:x,up:2.1:x,down:1:ArrowLeft,up:1.2:ArrowLeft",
    { durationSeconds: 5 }
  );
  assert.deepEqual(parsed.map(({ action, second, key }) => ({ action, second, key })), [
    { action: "down", second: 1, key: "ArrowLeft" },
    { action: "up", second: 1.2, key: "ArrowLeft" },
    { action: "down", second: 2, key: "x" },
    { action: "up", second: 2.1, key: "x" },
  ]);
  assert.equal(
    serializePostLoadInputScript(parsed),
    "down:1:ArrowLeft,up:1.2:ArrowLeft,down:2:x,up:2.1:x"
  );
  assert.deepEqual(parsePostLoadInputScript("none", { durationSeconds: 5 }), []);
  assert.throws(
    () => parsePostLoadInputScript("down:1:x", { durationSeconds: 5 }),
    /leaves keys pressed/
  );
  assert.throws(
    () => parsePostLoadInputScript("up:1:x", { durationSeconds: 5 }),
    /not down/
  );
  assert.throws(
    () => parsePostLoadInputScript("down:1:F5,up:2:F5", { durationSeconds: 5 }),
    /Invalid PERF_INPUT_SCRIPT/
  );
  assert.throws(
    () => parsePostLoadInputScript("down:5:x,up:5.1:x", { durationSeconds: 5 }),
    /Invalid PERF_INPUT_SCRIPT/
  );
});

test("post-load input metadata hashes the canonical script before provenance checks", async () => {
  const inputScript = "down:1:x,up:1.1:x";
  const metadata = await collectRunMetadata({
    root: process.cwd(),
    url: "http://127.0.0.1:8082/?inputphoton=1",
    browserName: "chromium",
    browserChannel: "chrome",
    browserVersion: "143.0",
    browserExecutable: "chrome.exe",
    headed: true,
    durationSeconds: 5,
    sampleMs: 1000,
    screenshotEverySeconds: 0,
    captureScreenshots: true,
    showDebugPanel: false,
    romPath: "unused.iso",
    corePath: "unused.wasm",
    saveStateUrl: "/fixture.sav",
    saveStatePath: "unused.sav",
    saveStateAt: 0,
    inputScript,
    sceneLabel: FIXED_BATTLE_FIXTURE.sceneLabel,
    artifactDescriptions: {
      rom: { sha256: "2".repeat(64) },
      core: { sha256: "1".repeat(64) },
      saveState: { sha256: FIXED_BATTLE_FIXTURE.saveStateSha256 },
    },
  });
  assert.equal(
    metadata.benchmark.inputScriptSha256,
    createHash("sha256").update(inputScript).digest("hex")
  );
});

test("post-load scheduler establishes sample zero and samples timestamp ties before input", () => {
  const inputEvents = parsePostLoadInputScript("down:0:x,up:0.1:x", { durationSeconds: 2 });
  assert.deepEqual(
    selectNextPostLoadBenchmarkAction({
      sampleIndex: 0,
      totalSamples: 2,
      sampleMs: 1000,
      inputIndex: 0,
      inputEvents,
    }),
    { type: "sample", index: 0, atMs: 0 }
  );
  assert.equal(
    selectNextPostLoadBenchmarkAction({
      sampleIndex: 1,
      totalSamples: 2,
      sampleMs: 1000,
      inputIndex: 0,
      inputEvents,
    }).type,
    "input"
  );

  const tied = parsePostLoadInputScript("down:1:x,up:1.1:x", { durationSeconds: 2 });
  assert.deepEqual(
    selectNextPostLoadBenchmarkAction({
      sampleIndex: 1,
      totalSamples: 2,
      sampleMs: 1000,
      inputIndex: 0,
      inputEvents: tied,
    }),
    { type: "sample", index: 1, atMs: 1000 }
  );
});

test("fixed-work scheduler preserves marker actions and bounds the run by wall time", () => {
  const inputEvents = parsePostLoadInputScript(
    "down:1.5:x,up:1.6:x",
    { durationSeconds: 2 }
  );
  assert.equal(
    selectNextFixedWorkBenchmarkAction({
      sampleIndex: 2,
      totalSamples: 2,
      sampleMs: 1000,
      inputIndex: 0,
      inputEvents,
      wallTimeCapMs: 2000,
    }).type,
    "input"
  );
  assert.deepEqual(
    selectNextFixedWorkBenchmarkAction({
      sampleIndex: 2,
      totalSamples: 1,
      sampleMs: 1000,
      inputIndex: inputEvents.length,
      inputEvents,
      wallTimeCapMs: 1750,
    }),
    { type: "wall-time-cap", atMs: 1750 }
  );
  assert.equal(fixedWorkPollDelayMs({ nowMs: 1000, deadlineMs: 1500 }), 100);
  assert.equal(fixedWorkPollDelayMs({ nowMs: 1440, deadlineMs: 1500 }), 60);
  assert.equal(fixedWorkPollDelayMs({ nowMs: 1500, deadlineMs: 1500 }), 0);
  assert.throws(
    () => fixedWorkPollDelayMs({ nowMs: 1000, deadlineMs: 1500, pollIntervalMs: 0 }),
    /positive poll interval/
  );
});

test("fixed emulated work derives throughput from one post-settle baseline", () => {
  const common = {
    targetCoreSeconds: 2,
    coreTicksPerSecond: 1000,
    baseline: { coreTicks: 10_000, frame: 100, observedAtMs: 500 },
    wallTimeCapSeconds: 5,
    pollIntervalMs: 100,
  };
  const reached = summarizeFixedEmulatedWork({
    ...common,
    observation: { coreTicks: 12_100, frame: 226, observedAtMs: 2500 },
  });
  assert.equal(reached.targetCoreTicks, 2000);
  assert.equal(reached.actualCoreTickDelta, 2100);
  assert.equal(reached.actualFrameDelta, 126);
  assert.equal(reached.elapsedWallSeconds, 2);
  assert.equal(reached.reachedTarget, true);
  assert.equal(reached.throughputGameSpeedPercent, 105);
  assert.equal(reached.throughputCoreFps, 63);

  const capped = summarizeFixedEmulatedWork({
    ...common,
    observation: { coreTicks: 11_900, frame: 214, observedAtMs: 2500 },
  });
  assert.equal(capped.reachedTarget, false);
  assert.equal(capped.throughputGameSpeedPercent, 95);
  assert.equal(capped.throughputCoreFps, 57);

  const regressed = summarizeFixedEmulatedWork({
    ...common,
    observation: { coreTicks: 9_999, frame: 99, observedAtMs: 2500 },
  });
  assert.equal(regressed.deltasValid, false);
  assert.equal(regressed.reachedTarget, false);
  assert.equal(regressed.throughputGameSpeedPercent, null);
  assert.equal(regressed.throughputCoreFps, null);
});

test("served identity and observed battle checkpoint reject mismatches", () => {
  const local = { app: { sha256: "a".repeat(64), bytes: 12 } };
  assert.equal(assertServedArtifactIdentity(local, structuredClone(local)).verified, true);
  assert.throws(
    () => assertServedArtifactIdentity(local, { app: { sha256: "b".repeat(64), bytes: 12 } }),
    /identity mismatch/
  );

  const checkpoint = parseBattleCheckpoint({
    frame: 77,
    coreTicks: 123456,
    ppcPc: 0x80300000,
    width: 640,
    height: 480,
    ppcWasmHelperStats: "video xfb:77 640x480 hash:deadbeef nz:2048 | jit:off",
  });
  assert.equal(
    assertBattleCheckpoint(checkpoint, {
      frame: 77,
      coreTicks: 123456,
      xfbHash: "deadbeef",
      width: 640,
      height: 480,
    }).verified,
    true
  );
  assert.throws(
    () => assertBattleCheckpoint(checkpoint, { ...checkpoint, xfbHash: "bad0cafe" }),
    /xfbHash/
  );

  const fixed = {
    frame: 89,
    coreTicks: 15166162443,
    ppcPc: -2144030364,
    xfbHash: "4b2d0a3b",
    width: 640,
    height: 480,
    checkpointObservationSource: "cpu-thread-after-load",
    loadedCheckpointGeneration: 1,
  };
  const exact = assertBattleCheckpoint(fixed);
  assert.equal(exact.verified, true);
  assert.equal(exact.coreTicksDelta, 0);
  assert.equal(exact.coreTicksDeltaMin, -20_000);
  assert.equal(exact.coreTicksDeltaMax, 0);
  assert.equal(assertBattleCheckpoint({ ...fixed, frame: 95 }).verified, true);
  const nearby = assertBattleCheckpoint({ ...fixed, coreTicks: fixed.coreTicks - 11_350 });
  assert.equal(nearby.verified, true);
  assert.equal(nearby.coreTicksDelta, -11_350);
  assert.equal(
    assertBattleCheckpoint({ ...fixed, coreTicks: fixed.coreTicks - 20_000 }).verified,
    true
  );
  assert.throws(
    () => assertBattleCheckpoint({ ...fixed, coreTicks: fixed.coreTicks - 20_001 }),
    /coreTicks.*accepted -20000\.\.0/
  );
  assert.throws(() => assertBattleCheckpoint({ ...fixed, coreTicks: fixed.coreTicks + 1 }), /coreTicks/);
  assert.throws(
    () => assertBattleCheckpoint({ ...fixed, checkpointObservationSource: "legacy-worker-poll" }),
    /checkpointObservationSource/
  );
  assert.throws(
    () => assertBattleCheckpoint({ ...fixed, loadedCheckpointGeneration: 0 }),
    /loadedCheckpointGeneration/
  );
  assert.throws(() => assertBattleCheckpoint({ ...fixed, ppcPc: fixed.ppcPc + 1 }), /ppcPc/);
});

test("battle checkpoint prefers the CPU-thread after-load capture and retains the legacy poll", () => {
  const checkpoint = parseBattleCheckpoint({
    frame: 77,
    coreTicks: 15166151316,
    ppcPc: -1,
    loadedCheckpointGeneration: 3,
    loadedCheckpointTicks: 15166162443,
    loadedCheckpointPpcPc: -2144030364,
    width: 640,
    height: 480,
    ppcWasmHelperStats: "video xfb:77 640x480 hash:4b2d0a3b nz:2048",
  });
  assert.equal(checkpoint.coreTicks, 15166162443);
  assert.equal(checkpoint.ppcPc, -2144030364);
  assert.equal(checkpoint.checkpointObservationSource, "cpu-thread-after-load");
  assert.equal(checkpoint.legacyCoreTicks, 15166151316);
  assert.equal(checkpoint.legacyPpcPc, -1);
});

test("served closure extraction includes core-host and detects a changed dependency", () => {
  assert.deepEqual(
    extractLocalModuleSpecifiers(
      'import { EmulatorHost } from "./core-host.js";\nnew Worker(new URL("./worker.js", import.meta.url));\nnew URL("core.wasm", import.meta.url);',
      "src/app.js"
    ),
    ["./core-host.js", "./worker.js", "core.wasm"]
  );
  const expected = {
    "src/app.js": { sha256: "a".repeat(64), bytes: 100 },
    "src/core-host.js": { sha256: "b".repeat(64), bytes: 200 },
  };
  assert.throws(
    () => assertServedArtifactIdentity(expected, {
      ...expected,
      "src/core-host.js": { sha256: "c".repeat(64), bytes: 200 },
    }),
    /core-host\.js/
  );
});

test("all retained WebGPU, WASM LinkError, and fallback evidence is fatal", () => {
  const evidence = findFatalRuntimeEvidence({
    consoleLines: [
      "[webgpu-exec] VALIDATION: bind group layout mismatch",
      "WebAssembly.LinkError: import object field is not callable",
    ],
    statuses: [
      "WebGPU real-clear error: command encoder invalid",
      "webgpu-show-image draw error: texture destroyed",
      "status failed: WebAssembly RuntimeError",
    ],
    renderer: {
      requestedPresenterBackend: "webgpu",
      activePresenterBackend: "webgl",
      errors: [{ kind: "device-lost", message: "destroyed" }],
      emscriptenPrintErr: [
        "Aborted(out of bounds memory access)",
        "WebGPU validation error: bind group incompatible",
      ],
      statusHistory: [{ message: "worker RPC rendererDiagnostics timed out after 10000 ms" }],
      fatalStatusHistory: [{ message: "WebGPU uncaptured validation error: stale status" }],
    },
  });
  assert.ok(evidence.some((line) => line.includes("VALIDATION")));
  assert.ok(evidence.some((line) => line.includes("WebAssembly.LinkError")));
  assert.ok(evidence.some((line) => line.includes("real-clear error")));
  assert.ok(evidence.some((line) => line.includes("show-image draw error")));
  assert.ok(evidence.some((line) => line.includes("device-lost")));
  assert.ok(evidence.some((line) => line.includes("renderer fallback")));
  assert.ok(evidence.some((line) => line.includes("emscripten-printErr")));
  assert.ok(evidence.some((line) => line.includes("timed out")));
  assert.ok(evidence.some((line) => line.includes("stale status")));
});

test("successful WebGPU counters are not mistaken for fatal evidence", () => {
  const evidence = findFatalRuntimeEvidence({
    consoleLines: [
      "[webgpu-shader] ok=33 fail=0 (stage=0 xlat=1 id=143) firstErr=<none>",
      "[webgpu-cmd-shader] module id=4 stage=2 compiled OK [ok=4 fail=0]",
      "[webgpu-pcfg] variant OK 13|bgra8unorm|null|rz0 [ok=3 fail=0]",
    ],
    statuses: [],
    renderer: { errors: [], emscriptenPrintErr: [], statusHistory: [], fatalStatusHistory: [] },
  });

  assert.deepEqual(evidence, []);
});

test("worker diagnostics structurally retain fatal catches and RPCs are bounded", async () => {
  const [workerSource, gateSource] = await Promise.all([
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/perf-regression-gate.mjs", import.meta.url), "utf8"),
  ]);
  for (const token of [
    "requestedVideoBackend",
    "activeVideoBackend",
    "requestedPresenterBackend",
    "activePresenterBackend",
    "fatalStatusHistory",
    'recordRendererError("real-clear-error"',
    'recordRendererError("show-image-draw-error"',
    'recordRendererError("wasm-link-error"',
  ]) assert.match(workerSource, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(gateSource, /Worker RPC \$\{type\} timed out after \$\{timeoutMs\} ms/);
  assert.match(gateSource, /requestWorkerRpc\(page, "rendererDiagnostics"\)/);
  assert.match(gateSource, /loadStateFileWithTimeout\(page/);
  assert.match(
    gateSource,
    /renderer = withExpectedRendererIdentity\(await readRendererDiagnostics\(page\), scenario\.params\);\s+manifest\.renderer = renderer;\s+const observedBattleCheckpoint = parseBattleCheckpoint/
  );
  assert.match(gateSource, /PERF_CONTINUE_INVALID_CHECKPOINT/);
  assert.match(gateSource, /diagnosticContinuation: true/);
  assert.match(gateSource, /if \(!context\.continueInvalidCheckpoint\) assertRunProvenance\(manifest\)/);
});

test("locked build provenance rejects valid-looking source, toolchain, and JS mutations", () => {
  const provenance = validLockedBuildProvenance();
  assert.deepEqual(validateLockedBuildProvenance(provenance), { verified: true, failures: [] });

  const sourceMutation = structuredClone(provenance);
  sourceMutation.locked.buildInfo.source.upstreamCommit = "9".repeat(40);
  assert.equal(validateLockedBuildProvenance(sourceMutation).verified, false);

  const toolchainMutation = structuredClone(provenance);
  toolchainMutation.locked.buildInfo.toolchain.ninjaVersion = "1.13.0";
  assert.equal(validateLockedBuildProvenance(toolchainMutation).verified, false);

  const jsMutation = structuredClone(provenance);
  jsMutation.actualArtifacts.js.sha256 = "0".repeat(64);
  const jsResult = validateLockedBuildProvenance(jsMutation);
  assert.equal(jsResult.verified, false);
  assert.ok(jsResult.failures.some((failure) => failure.includes("js.sha256")));

  const pendingRebuild = structuredClone(provenance);
  pendingRebuild.locked.abiManifest.sourceOnlyExportsPendingRebuild = ["_GetLastLoadedCoreTicksLow"];
  const pendingResult = validateLockedBuildProvenance(pendingRebuild);
  assert.equal(pendingResult.verified, false);
  assert.ok(pendingResult.failures.some((failure) => failure.includes("sourceOnlyExportsPendingRebuild")));

  for (const requiredExport of REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS) {
    const missingExport = structuredClone(provenance);
    missingExport.locked.abiManifest.moduleExports =
      missingExport.locked.abiManifest.moduleExports.filter((name) => name !== requiredExport);
    const missingResult = validateLockedBuildProvenance(missingExport);
    assert.equal(missingResult.verified, false);
    assert.ok(
      missingResult.failures.some((failure) => failure.includes(requiredExport)),
      `${requiredExport} must be named in the qualification failure`
    );
  }
});

test("content-addressed candidate bundle may supply its generated ABI manifest", () => {
  const provenance = validLockedBuildProvenance();
  provenance.evidenceFiles.abiManifest.trackedAtHead = false;
  provenance.evidenceFiles.abiManifest.matchesHead = false;
  provenance.evidenceFiles.abiManifest.candidateBundleMember = true;
  provenance.candidateBundle = { verified: true };
  assert.deepEqual(validateLockedBuildProvenance(provenance), { verified: true, failures: [] });

  provenance.candidateBundle.verified = false;
  const invalid = validateLockedBuildProvenance(provenance);
  assert.equal(invalid.verified, false);
  assert.ok(invalid.failures.some((failure) => failure.includes("abiManifest.trackedAtHead")));
});

test("qualification requires clean git, exact video/presenter identity, and locked evidence", () => {
  const manifest = validManifest();
  manifest.browser.headed = false;
  manifest.browser.profileId = "ephemeral-run-1";
  manifest.browser.executablePath = "C:/Chrome/chrome.exe";
  manifest.browser.actualChannel = "chrome";
  manifest.renderer = {
    expectedVideoBackend: "Software Renderer",
    requestedVideoBackend: "Software Renderer",
    activeVideoBackend: "Software Renderer",
    expectedRequestedPresenterBackend: "webgpu",
    expectedActivePresenterBackend: "webgpu",
    requestedPresenterBackend: "webgpu",
    activePresenterBackend: "webgpu",
    adapter: { selected: true, vendor: "test-vendor" },
    device: { created: true },
  };
  manifest.benchmark.cacheState = "cold";
  manifest.hostCore = { abiVersion: 1 };
  manifest.eventSchema = { version: 1 };
  manifest.causalTelemetrySchema = { version: CAUSAL_TELEMETRY_SCHEMA_VERSION };
  manifest.buildProvenance = validLockedBuildProvenance();
  manifest.upstream = { dolphinSha: manifest.buildProvenance.locked.sourceLock.upstream.commit };
  manifest.patches = { hashes: manifest.buildProvenance.locked.sourceLock.patches.map((patch) => patch.sha256) };
  manifest.toolchain = manifest.buildProvenance.locked.toolchainLock;
  assert.equal(evaluateQualificationProvenance(manifest).eligible, false);
  assert.ok(evaluateQualificationProvenance(manifest).missing.includes("browser.headed=true"));
  manifest.browser.headed = true;
  assert.equal(evaluateQualificationProvenance(manifest).eligible, true);

  const dirty = structuredClone(manifest);
  dirty.git.dirty = true;
  assert.ok(evaluateQualificationProvenance(dirty).missing.includes("git.dirty=false"));

  const videoMismatch = structuredClone(manifest);
  videoMismatch.renderer.activeVideoBackend = "WebGPU-Real";
  assert.ok(
    evaluateQualificationProvenance(videoMismatch).missing.includes(
      "renderer.activeVideoBackend=Software Renderer"
    )
  );

  const forgedEnvironment = structuredClone(manifest);
  forgedEnvironment.buildProvenance.untrustedEnvironmentOverrides = {
    UPSTREAM_DOLPHIN_SHA: "9".repeat(40),
    HOST_CORE_ABI_VERSION: "999",
  };
  assert.equal(evaluateQualificationProvenance(forgedEnvironment).eligible, true);

  const forgedManifest = structuredClone(manifest);
  forgedManifest.buildProvenance.locked.buildInfo.source.patchSeriesSha256 = "8".repeat(64);
  forgedManifest.buildProvenance.verification.verified = true;
  assert.equal(evaluateQualificationProvenance(forgedManifest).eligible, false);
});

test("headless, screening, and unresolved statistics cannot report qualification success", () => {
  assert.deepEqual(classifyGateOutcome({
    qualificationEligible: false,
    targetPassed: true,
  }), { verdict: "NON_QUALIFYING", exitCode: 2, qualificationPassed: false, promotable: false });
  assert.equal(classifyGateOutcome({
    qualificationEligible: true,
    targetPassed: true,
    comparisonMode: "screening",
    statisticalGatePassed: true,
  }).verdict, "NON_QUALIFYING");
  assert.equal(classifyGateOutcome({
    qualificationEligible: true,
    targetPassed: true,
    comparisonMode: "confirmation",
    statisticalGatePassed: false,
  }).exitCode, 2);
  assert.deepEqual(classifyGateOutcome({
    qualificationEligible: true,
    targetPassed: true,
    comparisonMode: "confirmation",
    statisticalGatePassed: true,
  }), { verdict: "PASS", exitCode: 0, qualificationPassed: true, promotable: true });
});

test("comparison run validity includes assertions and page/worker console errors", () => {
  assert.deepEqual(evaluateRunValidity({}), { valid: true, invalidReasons: [] });
  const result = evaluateRunValidity({
    invalidReasons: ["save load failed"],
    failures: ["compilefail=1"],
    consoleErrors: ["[worker:core:error] device lost"],
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.invalidReasons, [
    "save load failed",
    "run failure: compilefail=1",
    "console error: [worker:core:error] device lost",
  ]);
});

test("fixed-battle XFB identity is locked per deliberate rendering mode", () => {
  assert.equal(
    expectedBattleCheckpointForParams({ video: "software", fastsw: "0" }).xfbHash,
    "55dc4398"
  );
  assert.equal(
    expectedBattleCheckpointForParams({ video: "software", fastsw: "1" }).xfbHash,
    "4b2d0a3b"
  );
  assert.equal(
    expectedBattleCheckpointForParams({ video: "wgpu", fastsw: "0" }).xfbHash,
    "6fd97dc5"
  );
  const full = expectedBattleCheckpointForParams({ video: "software", fastsw: "0" });
  assert.equal(
    assertBattleCheckpoint({
      frame: 1,
      coreTicks: full.coreTicks,
      ppcPc: full.ppcPc,
      xfbHash: full.xfbHash,
      width: full.width,
      height: full.height,
      checkpointObservationSource: "cpu-thread-after-load",
      loadedCheckpointGeneration: 1,
    }, full).verified,
    true
  );
});

test("JIT summaries expose reuse and reject stale exported counters", () => {
  const healthy = summarizeJitMetrics([
    {
      ppcWasmBlockCompileCount: 100,
      ppcWasmBlockRunCount: 4000,
      helper: "tier:guarded jit attempts:120 compiled:100 emitfail:0 compilefail:0 | jit:on",
    },
    {
      ppcWasmBlockCompileCount: 140,
      ppcWasmBlockRunCount: 7000,
      helper: "tier:guarded jit attempts:180 compiled:140 emitfail:0 compilefail:0 | jit:on",
    },
  ]);
  assert.deepEqual(healthy, {
    exportedCompileCount: 140,
    exportedRunCount: 7000,
    helperAttemptCount: 180,
    helperCompileCount: 140,
    emitFailureCount: 0,
    compileFailureCount: 0,
    activeSampleCount: 2,
    runToCompileRatio: 50,
    countersConsistent: true,
  });

  const stale = summarizeJitMetrics([
    {
      ppcWasmBlockCompileCount: 0,
      ppcWasmBlockRunCount: 0,
      helper: "tier:guarded jit attempts:3114 compiled:1436 emitfail:9 compilefail:0 | jit:on",
    },
  ]);
  assert.equal(stale.countersConsistent, false);
  assert.equal(stale.runToCompileRatio, null);
  assert.equal(stale.emitFailureCount, 9);
});

test("metrics experiment evidence accepts intentional causal suppression only when activated", () => {
  const metricsOn = evaluateMetricsModeEvidence({
    requested: "1",
    diagnostics: {
      enabled: true,
      helperStatsCalls: 10,
      profileStatsCalls: 10,
      profileTimeSamples: 100,
    },
    samples: [
      {
        helper: "video xfb:10 | metrics:on | jit:off",
        causalTelemetrySchemaVersion: CAUSAL_TELEMETRY_SCHEMA_VERSION,
        causalTelemetry: { schemaVersion: CAUSAL_TELEMETRY_SCHEMA_VERSION },
      },
    ],
  });
  assert.deepEqual(metricsOn.failures, []);

  const metricsOff = evaluateMetricsModeEvidence({
    requested: "0",
    diagnostics: {
      enabled: false,
      helperStatsCalls: 0,
      profileStatsCalls: 0,
      profileTimeSamples: 0,
    },
    samples: [
      {
        helper: "video xfb:10 | metrics:off | jit:off",
        causalTelemetrySchemaVersion: null,
        causalTelemetry: null,
      },
    ],
  });
  assert.deepEqual(metricsOff.failures, []);

  assert.match(
    evaluateMetricsModeEvidence({
      requested: "0",
      diagnostics: { enabled: true, helperStatsCalls: 1, profileStatsCalls: 1, profileTimeSamples: 1 },
      samples: [{
        helper: "metrics:on",
        causalTelemetrySchemaVersion: CAUSAL_TELEMETRY_SCHEMA_VERSION,
        causalTelemetry: {},
      }],
    }).failures.join(" | "),
    /requested metrics=0.*enabled=true.*helperStatsCalls=1.*causal telemetry was present/
  );
  assert.match(
    evaluateMetricsModeEvidence({
      requested: "1",
      diagnostics: { enabled: false, helperStatsCalls: 0, profileStatsCalls: 0, profileTimeSamples: 0 },
      samples: [{ helper: "metrics:off", causalTelemetrySchemaVersion: null, causalTelemetry: null }],
    }).failures.join(" | "),
    /requested metrics=1.*enabled=false.*helperStatsCalls=0.*missing or unsupported causal telemetry schema/
  );
});

test("software raster evidence requires every phase and sampled timing to activate", () => {
  const telemetry = {
    softwareRaster: {
      profileEnabled: true,
      rasterTraversalCount: 10,
      rasterTraversalTimedSampleCount: 1,
      tevPixelCount: 20,
      tevTimedSampleCount: 1,
      textureSampleCount: 30,
      textureTimedSampleCount: 1,
      fifoAgeSampleCount: 4,
      xfbGenerationCount: 2,
      frameGenerationCount: 2,
      sampledSourceFrameCount: 2,
    },
  };
  const active = evaluateSoftwareRasterInstrumentationEvidence({
    required: true,
    samples: [{ causalTelemetry: telemetry }],
  });
  assert.equal(active.activated, true);
  assert.deepEqual(active.failures, []);

  const inactive = evaluateSoftwareRasterInstrumentationEvidence({
    required: true,
    samples: [{ causalTelemetry: { softwareRaster: { profileEnabled: true } } }],
  });
  assert.equal(inactive.activated, false);
  assert.match(inactive.failures.join(" | "), /rasterTraversalCount.*textureTimedSampleCount.*frameGenerationCount/);

  assert.deepEqual(
    evaluateSoftwareRasterInstrumentationEvidence({ required: false, samples: [] }).failures,
    []
  );
});

test("comparison tasklist alternates complete four-run blocks and is bounded", () => {
  const config = comparisonConfig({ mode: "screening", blockCount: 2 });
  const tasklist = buildComparisonTasklist(config);
  assert.deepEqual(tasklist.blocks.map((block) => block.order), [
    ["A", "B", "B", "A"],
    ["B", "A", "A", "B"],
  ]);
  assert.equal(tasklist.blocks.flatMap((block) => block.runs).length, 8);
  assert.equal(tasklist.maximumAttemptedBlocks, 3);
  assert.throws(
    () => buildComparisonTasklist(comparisonConfig({ mode: "screening", blockCount: 3 })),
    /exactly 2/
  );
  assert.throws(
    () => buildComparisonTasklist(comparisonConfig({ mode: "confirmation", blockCount: 11 })),
    /5 to 10/
  );

  const confirmation = buildComparisonTasklist(comparisonConfig({ mode: "confirmation", blockCount: 5 }));
  assert.equal(confirmation.blocks.length, 10);
  assert.equal(confirmation.blocks.filter((block) => block.status === "pending").length, 5);
  assert.equal(confirmation.blocks.filter((block) => block.status === "conditional").length, 5);
});

test("replacement blocks preserve the complete invalid block order", () => {
  const config = comparisonConfig({ mode: "confirmation", blockCount: 5 });
  const invalid = buildComparisonTasklist(config).blocks[0];
  const replacement = buildReplacementBlock(config, invalid);
  assert.deepEqual(replacement.order, invalid.order);
  assert.equal(replacement.replaces, invalid.blockId);
  assert.equal(replacement.runs.length, 4);
  assert.ok(replacement.runs.every((run) => run.blockId === replacement.blockId));
});

test("screening block effects are sign-normalized but never promotable", () => {
  const config = comparisonConfig({ mode: "screening", blockCount: 2 });
  const runs = makeRuns(config, [
    { a: [100, 102], b: [110, 112] },
    { a: [101, 103], b: [111, 113] },
  ]);
  const report = summarizeComparison(config, runs);
  assert.equal(report.validBlockCount, 2);
  assert.equal(report.outcome, "SCREENING_SIGNAL");
  assert.equal(report.promotable, false);
  assert.ok(report.medianEffectPercent > 8);

  const lowerIsBetter = { ...config, direction: "lower" };
  const lowerReport = summarizeComparison(lowerIsBetter, makeRuns(lowerIsBetter, [
    { a: [20, 20], b: [10, 10] },
    { a: [22, 22], b: [11, 11] },
  ]));
  assert.ok(lowerReport.medianEffectPercent > 0);
});

test("tail-gate screening is a bounded null-drain A/B with semantic-work gates", async () => {
  const config = JSON.parse(await readFile(
    "tools/perf-configs/wgpu-tail-gate-screening.json", "utf8"
  ));
  const tasklist = buildComparisonTasklist(config);
  assert.equal(config.mode, "screening");
  assert.equal(config.blockCount, 2);
  assert.equal(config.minimumEffectPercent, 1);
  assert.equal(
    config.primaryMetric,
    "fixedEmulatedWork.throughputGameSpeedPercent"
  );
  assert.deepEqual(tasklist.blocks.map((block) => block.order), [
    ["A", "B", "B", "A"],
    ["B", "A", "A", "B"],
  ]);
  assert.equal(config.armA.params.wgpurenderprobe, "null-drain");
  assert.equal(config.armB.params.wgpurenderprobe, "null-drain");
  assert.equal(config.armA.params.wgputailgate, "0");
  assert.equal(config.armB.params.wgputailgate, "1");
  assert.deepEqual(
    config.overheadGate.semanticWork.map((rule) => rule.path),
    ["fixedEmulatedWork.actualCoreTickDelta", "fixedEmulatedWork.actualFrameDelta"]
  );
});

test("diagnostic-quiet screening changes only the explicit log filter arm", async () => {
  const config = JSON.parse(await readFile(
    "tools/perf-configs/wgpu-diagnostic-quiet-screening.json", "utf8"
  ));
  const tasklist = buildComparisonTasklist(config);
  assert.equal(config.primaryMetric, "fixedEmulatedWork.throughputGameSpeedPercent");
  assert.equal(config.minimumEffectPercent, 1);
  assert.deepEqual(tasklist.blocks.map((block) => block.order), [
    ["A", "B", "B", "A"],
    ["B", "A", "A", "B"],
  ]);
  assert.equal(config.armA.params.wgpudiagquiet, "0");
  assert.equal(config.armB.params.wgpudiagquiet, "1");
  assert.equal(config.armA.params.wgputailgate, "0");
  assert.equal(config.armB.params.wgputailgate, "0");
  const withoutQuiet = ({ wgpudiagquiet, ...params }) => params;
  assert.deepEqual(withoutQuiet(config.armA.params), withoutQuiet(config.armB.params));
});

test("draw-detail overhead screening pins hardware null-drain and changes only its toggle", async () => {
  const config = JSON.parse(await readFile(
    new URL("../tools/perf-configs/wgpu-draw-profile-overhead.json", import.meta.url),
    "utf8"
  ));
  const validated = validateComparisonConfig(config);
  assert.equal(validated.overheadGate.maximumRegressionPercent, 2);
  assert.equal(validated.stabilityGate.maximumWithinArmSpreadPercent, 10);
  const paramsA = { ...config.armA.params };
  const paramsB = { ...config.armB.params };
  assert.equal(paramsA.wgpudrawprofile, "0");
  assert.equal(paramsB.wgpudrawprofile, "1");
  delete paramsA.wgpudrawprofile;
  delete paramsB.wgpudrawprofile;
  assert.deepEqual(paramsB, paramsA);
  assert.equal(paramsA.video, "wgpu");
  assert.equal(paramsA.presenter, "webgpu");
  assert.equal(paramsA.wgpurenderprobe, "null-drain");
  assert.equal(paramsA.wgpuprodprofile, "1");
  assert.equal(paramsA.wgpuuploadtransport, "mapped");
  assert.equal(paramsA.wasmjit, "0");
});

test("comparison stability gate rejects unstable arms and retains per-arm evidence", () => {
  const config = comparisonConfig({
    stabilityGate: { maximumWithinArmSpreadPercent: 10 },
  });
  const unstable = summarizeComparison(config, makeRuns(config, [
    { a: [68.10, 46.85], b: [60, 61] },
    { a: [60, 61], b: [64, 65] },
  ]));
  assert.equal(unstable.blocks[0].valid, false);
  const unstableArmA = unstable.blocks[0].withinArmStability.A;
  assert.equal(unstableArmA.min, 46.85);
  assert.equal(unstableArmA.max, 68.10);
  assert.equal(unstableArmA.mean, 57.474999999999994);
  assert.ok(Math.abs(
    unstableArmA.spreadPercent - 36.97259678120921
  ) < 1e-12);
  assert.equal(unstable.blocks[0].withinArmStability.B.spreadPercent, 1.6528925619834711);
  assert.match(
    unstable.blocks[0].invalidReasons.join("\n"),
    /arm A within-arm spread 36\.973% exceeds maximum 10%/
  );
  assert.equal(unstable.invalidBlockCount, 1);
  assert.equal(unstable.outcome, "INFRASTRUCTURE_INCONCLUSIVE");

  const stable = summarizeComparison(config, makeRuns(config, [
    { a: [68.10, 64], b: [70, 67] },
    { a: [65, 68], b: [69, 72] },
  ]));
  assert.equal(stable.validBlockCount, 2);
  assert.equal(stable.invalidBlockCount, 0);
  assert.ok(stable.blocks.every((block) =>
    block.withinArmStability.A.spreadPercent <= 10 &&
    block.withinArmStability.B.spreadPercent <= 10
  ));
});

test("comparison stability gate validation is optional and fail-closed", () => {
  assert.equal(validateComparisonConfig(comparisonConfig()).stabilityGate, null);
  assert.throws(
    () => validateComparisonConfig(comparisonConfig({ stabilityGate: [] })),
    /stabilityGate must be an object/
  );
  assert.throws(
    () => validateComparisonConfig(comparisonConfig({
      stabilityGate: { maximumWithinArmSpreadPercent: -1 },
    })),
    /maximumWithinArmSpreadPercent must be non-negative/
  );
});

test("comparison runner consumes bounded replacements before final invalid-rate classification", async () => {
  const source = await readFile("tools/perf-regression-gate.mjs", "utf8");
  assert.match(source,
    /\["NEEDS_MORE_BLOCKS", "INCOMPLETE", "INFRASTRUCTURE_INCONCLUSIVE"\][\s\S]*?\.includes\(current\.outcome\)/);
  assert.doesNotMatch(source,
    /if \(current\.outcome === "INFRASTRUCTURE_INCONCLUSIVE"\) break;/);
  assert.match(source, /buildReplacementBlock\(config, block, replacementNumber\)/);
  assert.match(source, /"wgputailgate"/);
  assert.match(source, /wgpuTailGateDeltaPayloadSamples/);
  assert.match(source, /wgpuTailGateFinalAvailable/);
  assert.match(source, /wgpuTailGateFinalDirtyAtSkip/);
});

test("overhead screening enforces a strict regression ceiling and semantic work", () => {
  const config = comparisonConfig({
    mode: "screening",
    blockCount: 2,
    overheadGate: {
      maximumRegressionPercent: 2,
      semanticWork: [
        { path: "fixedEmulatedWork.actualCoreTickDelta", maximumDifferencePercent: 5 },
        { path: "fixedEmulatedWork.actualFrameDelta", maximumDifferencePercent: 5 },
      ],
    },
  });
  const runs = makeRuns(config, [
    { a: [100, 100], b: [99, 99] },
    { a: [100, 100], b: [99, 99] },
  ]);
  for (const run of runs) {
    run.fixedEmulatedWork = {
      actualCoreTickDelta: 486_000_000,
      actualFrameDelta: 60,
    };
  }
  let report = summarizeComparison(config, runs);
  assert.equal(report.overheadGatePassed, true);
  assert.equal(report.validBlockCount, 2);
  assert.ok(report.blocks.every((block) => block.overheadRegressionPercent === 1));

  const regression = structuredClone(runs);
  for (const run of regression.filter((entry) => entry.arm === "B")) {
    run.metrics.gameSpeed.mean = 98;
  }
  report = summarizeComparison(config, regression);
  assert.equal(report.overheadGatePassed, false);
  assert.match(report.blocks[0].invalidReasons.join("\n"), /must be <2%/);

  const semanticMismatch = structuredClone(runs);
  for (const run of semanticMismatch.filter((entry) => entry.arm === "B")) {
    run.fixedEmulatedWork.actualFrameDelta = 70;
  }
  report = summarizeComparison(config, semanticMismatch);
  assert.equal(report.overheadGatePassed, false);
  assert.match(report.blocks[0].invalidReasons.join("\n"), /semantic work.*actualFrameDelta/);
});

test("comparison rejects upload-probe runs with incomparable fixed workloads", () => {
  const config = comparisonConfig({ mode: "screening", blockCount: 2 });
  const runs = makeRuns(config, [
    { a: [100, 100], b: [110, 110] },
    { a: [101, 101], b: [111, 111] },
  ]);
  const workload = {
    coreSha256: "a".repeat(64),
    saveStateSha256: "b".repeat(64),
    checkpointTicks: 1000,
    checkpointPpcPc: 2000,
    actualCoreTickDelta: 486_000_000,
    actualFrameDelta: 480,
    observedRecordCount: 1_000_000,
    totalUploadBytes: 500_000_000,
    submissionCount: 480,
    opHistogram: new Array(25).fill(1000),
    submitDigests: ["11111111", "22222222"],
  };
  for (const run of runs) run.uploadProbeWorkload = { ...workload };
  assert.deepEqual(evaluateWgpuUploadProbeWorkloadEquivalence(runs.slice(0, 4)), []);
  runs[1].uploadProbeWorkload = {
    ...workload,
    submitDigests: ["11111111", "different-later-boundary"],
  };
  assert.deepEqual(evaluateWgpuUploadProbeWorkloadEquivalence(runs.slice(0, 4)), []);
  runs[1].uploadProbeWorkload = { ...workload };
  assert.equal(summarizeComparison(config, runs).outcome, "SCREENING_SIGNAL");

  const semanticMismatch = [...workload.opHistogram];
  semanticMismatch[20] *= 1.01;
  runs[1].uploadProbeWorkload = { ...workload, opHistogram: semanticMismatch };
  assert.match(
    evaluateWgpuUploadProbeWorkloadEquivalence(runs.slice(0, 4)).join("\n"),
    /opcode 20 per frame/
  );

  const lowRateBase = [...workload.opHistogram];
  lowRateBase[8] = 2;
  for (const run of runs) run.uploadProbeWorkload = { ...workload, opHistogram: lowRateBase };
  const lowRateMismatch = [...lowRateBase];
  lowRateMismatch[8] = 3;
  runs[1].uploadProbeWorkload = { ...workload, opHistogram: lowRateMismatch };
  assert.match(
    evaluateWgpuUploadProbeWorkloadEquivalence(runs.slice(0, 4)).join("\n"),
    /opcode 8 per frame/
  );
  const blitMismatch = [...workload.opHistogram];
  blitMismatch[24] = 1;
  runs[1].uploadProbeWorkload = { ...workload, opHistogram: blitMismatch };
  assert.match(
    evaluateWgpuUploadProbeWorkloadEquivalence(runs.slice(0, 4)).join("\n"),
    /opcode 24 per frame/
  );
  for (const run of runs) run.uploadProbeWorkload = { ...workload };

  runs[1].uploadProbeWorkload = {
    ...workload,
    totalUploadBytes: workload.totalUploadBytes * 1.01,
    submitDigests: ["bad0cafe", "22222222"],
  };
  const report = summarizeComparison(config, runs);
  assert.equal(report.blocks[0].valid, false);
  assert.match(
    report.blocks[0].invalidReasons.join("\n"),
    /totalUploadBytes per frame|initial submit structure/
  );
  assert.notEqual(report.outcome, "SCREENING_SIGNAL");
});

test("confirmation extends beyond five blocks until exact permutation evidence resolves", () => {
  const passing = comparisonConfig({ mode: "confirmation", blockCount: 5 });
  const fiveBlockReport = summarizeComparison(
    passing,
    makeRuns(passing, Array.from({ length: 5 }, (_, index) => ({
      a: [100 + index, 100 + index],
      b: [108 + index, 108 + index],
    })))
  );
  assert.equal(fiveBlockReport.permutationPValue, 0.0625);
  assert.equal(fiveBlockReport.outcome, "NEEDS_MORE_BLOCKS");
  assert.equal(fiveBlockReport.promotable, false);

  const passReport = summarizeComparison(
    passing,
    makeRuns(passing, Array.from({ length: 6 }, (_, index) => ({
      a: [100 + index, 100 + index],
      b: [108 + index, 108 + index],
    })))
  );
  assert.equal(passReport.outcome, "STATISTICAL_GATE_PASS");
  assert.equal(passReport.statisticalGatePassed, true);
  assert.equal(passReport.promotable, false);
  assert.ok(passReport.permutationPValue <= 0.05);
  assert.ok(passReport.interval95.low > 0);

  const unresolved = comparisonConfig({ mode: "confirmation", blockCount: 10 });
  const unresolvedReport = summarizeComparison(
    unresolved,
    makeRuns(unresolved, Array.from({ length: 10 }, (_, index) => ({
      a: [100, 100],
      b: index % 2 === 0 ? [102, 102] : [98, 98],
    })))
  );
  assert.equal(unresolvedReport.outcome, "INCONCLUSIVE");
  assert.equal(unresolvedReport.promotable, false);
  assert.ok(unresolvedReport.interval95.low <= 0);
  assert.ok(unresolvedReport.interval95.high >= 0);
});

test("one invalid run invalidates its whole block and trips the screening stop", () => {
  const config = comparisonConfig({ mode: "screening", blockCount: 2 });
  const runs = makeRuns(config, [
    { a: [100, 100], b: [104, 104] },
    { a: [100, 100], b: [104, 104] },
  ]);
  runs[1].valid = false;
  runs[1].invalidReasons = ["browser crashed"];
  const report = summarizeComparison(config, runs);
  assert.equal(report.invalidBlockCount, 1);
  assert.equal(report.validBlockCount, 1);
  assert.equal(report.outcome, "INFRASTRUCTURE_INCONCLUSIVE");
});

test("numeric summaries retain the full run distribution", () => {
  assert.deepEqual(summarizeNumeric([1, 2, 3, 4, "bad"]), {
    count: 4,
    min: 1,
    mean: 2.5,
    p50: 2.5,
    p95: 3.8499999999999996,
    p99: 3.9699999999999998,
    max: 4,
  });
});

test("full timed metrics never silently discard the pre-steady-state window", () => {
  const windows = summarizeTimedMetricWindows([
    { elapsedSeconds: 0, gameSpeed: 50, coreFps: 30, presentFps: 20, visualFps: 10 },
    { elapsedSeconds: 5, gameSpeed: 100, coreFps: 60, presentFps: 40, visualFps: 20 },
  ], 5);
  assert.equal(windows.fullTimedWindow.sampleCount, 2);
  assert.equal(windows.fullTimedWindow.metrics.gameSpeed.mean, 75);
  assert.equal(windows.steadyStateWindow.sampleCount, 1);
  assert.equal(windows.steadyStateWindow.metrics.gameSpeed.mean, 100);
});

function validLockedBuildProvenance() {
  const hashes = {
    toolchainLock: "a".repeat(64),
    vendorSnapshot: "b".repeat(64),
    cargoLock: "c".repeat(64),
    buildInfo: "d".repeat(64),
    sourceLock: "e".repeat(64),
    abiManifest: "f".repeat(64),
    patchSeries: "9".repeat(64),
    patch: "8".repeat(64),
    js: "7".repeat(64),
    wasm: "6".repeat(64),
    cmakeCache: "5".repeat(64),
    section: "4".repeat(64),
  };
  const upstreamCommit = "1".repeat(40);
  const toolchainLock = {
    schemaVersion: 1,
    platform: "win32-x64",
    node: { version: "24.12.0", sha256: hashes.patch },
    emscripten: {
      version: "5.0.7",
      compilerCommit: "2".repeat(40),
      emsdkCommit: "3".repeat(40),
      emccSha256: hashes.patch,
      emcmakeSha256: hashes.patch,
      clangxxSha256: hashes.patch,
    },
    cmake: { version: "4.3.2", sha256: hashes.patch },
    ninja: { version: "1.13.0.git.kitware.jobserver-pipe-1", sha256: hashes.patch },
    rust: {
      target: "wasm32-unknown-emscripten",
      rustcVersion: "1.97.0-nightly",
      rustcCommit: "4".repeat(40),
      rustcSha256: hashes.patch,
      cargoVersion: "1.97.0-nightly",
      cargoCommit: "5".repeat(40),
      cargoSha256: hashes.patch,
      rustupSha256: hashes.patch,
    },
    naga: { crateVersion: "0.1.0", dependencyVersion: "26.0.0", cargoLockSha256: hashes.cargoLock },
  };
  const sourceLock = {
    schemaVersion: 1,
    upstream: { commit: upstreamCommit },
    patchSeriesSha256: hashes.patchSeries,
    patches: [{ order: 1, path: "patches/one.patch", hashMode: "lf-normalized", sha256: hashes.patch }],
  };
  const abiManifest = {
    schemaVersion: 1,
    abiVersion: 1,
    coreId: `sha256:${hashes.wasm}`,
    upstreamCommit,
    moduleExports: [...REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS],
    artifacts: [
      {
        path: "cores/dolphin/dolphin-core-upstream.js",
        hashMode: "lf-normalized",
        size: 123,
        sha256: hashes.js,
      },
      {
        path: "cores/dolphin/dolphin-core-upstream.wasm",
        size: 456,
        sha256: hashes.wasm,
      },
    ],
    contractSources: [
      {
        path: "src/upstream-worker-protocol.js",
        hashMode: "lf-normalized",
        size: 42,
        sha256: hashes.section,
      },
    ],
  };
  const vendorSnapshot = {
    schemaVersion: 1,
    root: { baseCommit: upstreamCommit, resultTree: "5".repeat(40) },
  };
  const buildInfo = {
    schemaVersion: 1,
    createdAt: "2026-07-09T00:00:00.000Z",
    coreId: `sha256:${hashes.wasm}`,
    repository: { commit: "6".repeat(40), status: "" },
    source: {
      upstreamCommit,
      patchSeriesSha256: hashes.patchSeries,
      sourceLockSha256: hashes.sourceLock,
      vendorSnapshotSha256: hashes.vendorSnapshot,
      vendorResultTree: vendorSnapshot.root.resultTree,
    },
    toolchain: {
      lockSha256: hashes.toolchainLock,
      emscriptenVersion: toolchainLock.emscripten.version,
      emscriptenCompilerCommit: toolchainLock.emscripten.compilerCommit,
      emsdkCommit: toolchainLock.emscripten.emsdkCommit,
      cmakeVersion: toolchainLock.cmake.version,
      ninjaVersion: toolchainLock.ninja.version,
      rustcVersion: toolchainLock.rust.rustcVersion,
      rustcCommit: toolchainLock.rust.rustcCommit,
      cargoVersion: toolchainLock.rust.cargoVersion,
      nagaDependencyVersion: toolchainLock.naga.dependencyVersion,
      cargoLockSha256: toolchainLock.naga.cargoLockSha256,
    },
    configure: {
      wasmMemoryPages: 24576,
      wasmCompileFlags: "-O3 -pthread -msimd128 -flto",
      cmakeArgs: ["-DCMAKE_BUILD_TYPE=Release"],
      cmakeCacheSha256: hashes.cmakeCache,
    },
    artifacts: {
      js: {
        path: "C:/build/dolphin-core-upstream.js",
        hashMode: "lf-normalized",
        size: 123,
        sha256: hashes.js,
      },
      wasm: {
        path: "C:/build/dolphin-core-upstream.wasm",
        hashMode: "raw",
        size: 456,
        sha256: hashes.wasm,
      },
      wasmSections: [{ id: 1, size: 32, sha256: hashes.section }],
    },
  };
  const evidenceFiles = {
    buildInfo: evidence("cores/dolphin/dolphin-core-upstream.build.json", hashes.buildInfo, false),
    sourceLock: evidence("provenance/dolphin-source.lock.json", hashes.sourceLock),
    abiManifest: evidence("provenance/dolphin-core-abi-v1.json", hashes.abiManifest),
    toolchainLock: evidence("provenance/wasm-toolchain.lock.json", hashes.toolchainLock),
    vendorSnapshot: evidence("provenance/dolphin-vendor-snapshot-v1.json", hashes.vendorSnapshot),
    nagaCargoLock: {
      ...evidence("tools/naga-spirv-wgsl/Cargo.lock", hashes.cargoLock),
      normalizedSha256: hashes.cargoLock,
    },
  };
  const provenance = {
    source: "cores/dolphin/dolphin-core-upstream.build.json",
    locked: { buildInfo, sourceLock, abiManifest, toolchainLock, vendorSnapshot },
    actualArtifacts: {
      js: { path: "cores/dolphin/dolphin-core-upstream.js", hashMode: "lf-normalized", size: 123, rawSize: 123, sha256: hashes.js },
      wasm: { path: "cores/dolphin/dolphin-core-upstream.wasm", hashMode: "raw", size: 456, rawSize: 456, sha256: hashes.wasm },
    },
    actualContractSources: {
      "src/upstream-worker-protocol.js": {
        path: "src/upstream-worker-protocol.js",
        hashMode: "lf-normalized",
        size: 42,
        sha256: hashes.section,
      },
    },
    evidenceFiles,
    evidenceBundle: Object.entries(evidenceFiles).map(([key, entry]) => ({
      key,
      path: `build-provenance/${key}.json`,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
    untrustedEnvironmentOverrides: {},
  };
  provenance.verification = validateLockedBuildProvenance(provenance);
  return provenance;
}

function evidence(pathname, sha256, committed = true) {
  return {
    path: pathname,
    exists: true,
    bytes: 100,
    sha256,
    normalizedSha256: sha256,
    trackedAtHead: committed,
    matchesHead: committed,
  };
}

function validManifest() {
  return {
    git: { commit: "abc123", dirty: false },
    browser: { version: "143.0", headed: false },
    benchmark: {
      url: "http://127.0.0.1:8082/?video=software",
      sceneLabel: FIXED_BATTLE_FIXTURE.sceneLabel,
      saveStateAt: 0,
      inputScriptMode: "none",
    },
    artifacts: {
      rom: { sha256: "2".repeat(64) },
      core: { sha256: "1".repeat(64) },
      saveState: { sha256: FIXED_BATTLE_FIXTURE.saveStateSha256 },
    },
    fixture: {
      isoVerified: true,
      saveStateVerified: true,
      saveStateLoaded: true,
      battleCheckpoint: { verified: true },
    },
    causalTelemetrySchema: { version: CAUSAL_TELEMETRY_SCHEMA_VERSION },
    servedApplication: { verified: true, manifestSha256: "e".repeat(64) },
  };
}

function comparisonConfig(overrides = {}) {
  return {
    mode: "screening",
    blockCount: 2,
    primaryMetric: "metrics.gameSpeed.mean",
    direction: "higher",
    minimumEffectPercent: 3,
    hypothesis: "Candidate improves game speed.",
    armA: { name: "baseline", params: { fastsw: 1 } },
    armB: { name: "candidate", params: { fastsw: 2 } },
    ...overrides,
  };
}

function producerProfileWire({
  enabled = 1,
  epoch = 9,
  phaseCount = 12,
  periods,
  calls,
  samples,
  totals,
  maxima,
}) {
  return [
    `wgprod:1,${enabled},${epoch},${phaseCount}`,
    `wgprd:${periods.join(",")}`,
    `wgprc:${calls.join(",")}`,
    `wgprs:${samples.join(",")}`,
    `wgprt:${totals.join(",")}`,
    `wgprm:${maxima.join(",")}`,
  ].join(" ");
}

function drawProfileWire({ enabled, epoch, multiplier }) {
  const periods = [64, 64, 256, 64, 64, 64, 256];
  const calls = periods.map((period) => period * multiplier);
  const samples = periods.map(() => multiplier);
  const totals = periods.map((_, index) => (index + 1) * 100 * multiplier);
  const maxima = periods.map((_, index) => (index + 1) * 10 * multiplier);
  return [
    `wgdraw:1,${enabled},${epoch},7`,
    `wgdrd:${periods.join(",")}`,
    `wgdrc:${calls.join(",")}`,
    `wgdrs:${samples.join(",")}`,
    `wgdrt:${totals.join(",")}`,
    `wgdrm:${maxima.join(",")}`,
  ].join(" ");
}

function makeRuns(config, valuesByBlock) {
  const tasklist = buildComparisonTasklist(config);
  return tasklist.blocks.slice(0, valuesByBlock.length).flatMap((block, blockIndex) => {
    const values = valuesByBlock[blockIndex];
    const next = { A: [...values.a], B: [...values.b] };
    return block.runs.map((task) => ({
      ...task,
      valid: true,
      invalidReasons: [],
      metrics: { gameSpeed: { mean: next[task.arm].shift() } },
    }));
  });
}

test("the worker's WGPU runtime config names the engine whose defaults applied", async () => {
  const { readFile } = await import("node:fs/promises");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const payload = worker.slice(worker.indexOf("function wgpuRuntimeConfigPayload()"));
  assert.match(payload.slice(0, 800), /schema: "wasm-dolphin\.wgpu-runtime-config\.v1",[\s\S]*?wasmEngine: wasmEngineName,/);
});

test("the reference disc hash comes from the environment or an untracked config, never the tree", async () => {
  const { referenceIsoSha256, requireReferenceIsoSha256 } = await import("../tools/perf-artifacts.mjs");
  const h = "a".repeat(64);
  assert.equal(referenceIsoSha256({}), null);
  assert.equal(referenceIsoSha256({ REFERENCE_ISO_SHA256: h.toUpperCase() }), h);
  assert.equal(referenceIsoSha256({ REFERENCE_FIXTURE: "/x/ref.json" }, () => JSON.stringify({ isoSha256: h })), h);
  assert.throws(() => referenceIsoSha256({ REFERENCE_FIXTURE: "/x/ref.json" }, () => "{}"), /no isoSha256/);
  assert.throws(() => referenceIsoSha256({ REFERENCE_FIXTURE: "/x/missing.json" }, () => { throw new Error("ENOENT"); }), /ENOENT/);
  assert.throws(() => requireReferenceIsoSha256({}), /not configured/);
});
