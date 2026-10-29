import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JIT_CACHE_ENTRY_KEY_SCHEMA, canonicalCoreFingerprint } from
  "../src/jit-cache-identity.js";
import { CAUSAL_TELEMETRY_SCHEMA_VERSION } from "../src/causal-telemetry.js";
import { defaultWgpuMappedStagingSlotCount, defaultWgpuUploadTransport, wgpuMappedStagingSlotCountOf } from "../src/wgpu-replay-diagnostics.js";
import { WGPU_UBO_COMPUTE_PROJECTION_SCHEMA } from
  "../src/wgpu-ubo-compute-projection.js";
import { REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS } from "./dolphin-provenance.mjs";
import {
  WGPU_DRAW_PROFILE_PHASE_ORDER,
  WGPU_DRAW_PROFILE_PERIODS,
  WGPU_DRAW_PROFILE_SCHEMA,
  WGPU_PRODUCER_PROFILE_PHASE_ORDER,
  WGPU_PRODUCER_PROFILE_SCHEMA,
  WGPU_TAIL_GATE_SCHEMA,
  parseWgpuDrawProfileStats as parseDrawProfileWire,
  parseWgpuProducerProfileStats as parseProducerProfileWire,
  parseWgpuTailGateStats as parseTailGateWire,
} from "../src/wgpu-pass-state-cache.js";

export {
  WGPU_DRAW_PROFILE_PHASE_ORDER,
  WGPU_PRODUCER_PROFILE_PHASE_ORDER,
  WGPU_TAIL_GATE_SCHEMA,
};
export const WGPU_PRODUCER_PROFILE_SCHEMA_VERSION = 1;
export const WGPU_DRAW_PROFILE_SCHEMA_VERSION = 1;
export const WGPU_TAIL_GATE_SCHEMA_VERSION = 1;
export const WGPU_SPARSE_UBO_SCHEMA = "wasm-dolphin.wgpu-sparse-ubo.v1";
export const WGPU_RUNTIME_CONFIG_SCHEMA = "wasm-dolphin.wgpu-runtime-config.v1";

export function evaluateWgpuRuntimeConfigEvidence({
  required = false,
  runtimeConfig,
  params = {},
} = {}) {
  if (!required) return { required: false, runtimeConfig: runtimeConfig ?? null, failures: [] };
  const failures = [];
  if (runtimeConfig?.schema !== WGPU_RUNTIME_CONFIG_SCHEMA) {
    failures.push(
      `WGPU runtime config schema mismatch: ${runtimeConfig?.schema ?? "unavailable"}`
    );
  }
  const requestedFlag = (name) => String(params?.[name] ?? "0") === "1";
  const expectedMetricsEnabled = String(params?.metrics) === "1";
  // Unforced, the engine's own defaults apply (mapped staging and 4 slots under
  // JavaScriptCore); an artifact without the engine is read as V8's.
  const engine = runtimeConfig?.wasmEngine ?? "v8";
  const requestedTransport = params?.wgpuuploadtransport;
  const expectedUploadTransport = requestedTransport === "mapped" || requestedTransport === "queue"
    ? requestedTransport : defaultWgpuUploadTransport(engine);
  const expectedUboCache = requestedFlag("wgpuubocache");
  const expectedUboMetrics = expectedMetricsEnabled && requestedFlag("wgpuubometrics");
  const expectedUniformFast = requestedFlag("wgpuuniformfast");
  const expectedUboPack = requestedFlag("wgpuubopack") && !expectedUboCache;
  const expectedStageFast = expectedUploadTransport === "mapped" && requestedFlag("wgpustagefast");
  const requestedSlots = String(params?.wgpustagingslots ?? "");
  const expectedSlots = /^[3-8]$/.test(requestedSlots)
    ? wgpuMappedStagingSlotCountOf(requestedSlots) : defaultWgpuMappedStagingSlotCount(engine);
  const expectedTimingStride = String(params?.wgpumappedtiming) === "64" ? 64 : 1;
  const expectedGeometryPack = requestedFlag("wgpugeompack");
  const expectedGeometryRange = expectedGeometryPack && requestedFlag("wgpugeomrange");
  const expectedTailGate = requestedFlag("wgputailgate");
  const expect = (label, actual, expected) => {
    if (actual !== expected) {
      failures.push(
        `WGPU runtime config ${label} mismatch: requested=${String(expected)} ` +
        `active=${actual == null ? "unavailable" : String(actual)}`
      );
    }
  };
  expect("metrics", runtimeConfig?.metricsEnabled, expectedMetricsEnabled);
  expect("upload transport", runtimeConfig?.uploadTransport, expectedUploadTransport);
  expect("UBO cache", runtimeConfig?.uboCacheEnabled, expectedUboCache);
  expect("UBO metrics", runtimeConfig?.producerUboCacheMetricsEnabled, expectedUboMetrics);
  expect("uniform fast", runtimeConfig?.producerUniformFastEnabled, expectedUniformFast);
  expect("UBO pack", runtimeConfig?.uboPackEnabled, expectedUboPack);
  if ((expectedUboCache || expectedUboMetrics || expectedUniformFast) &&
      runtimeConfig?.producerUboCacheAvailable !== true) {
    failures.push("WGPU runtime config UBO cache producer setter is unavailable");
  }
  if (expectedUboPack && runtimeConfig?.producerUboPackAvailable !== true) {
    failures.push("WGPU runtime config UBO pack producer setter is unavailable");
  }
  expect("mapped staging", runtimeConfig?.mappedStaging?.enabled,
    expectedUploadTransport === "mapped");
  expect("mapped staging fast path", runtimeConfig?.mappedStagingFastPath, expectedStageFast);
  expect("mapped staging slots", runtimeConfig?.mappedStaging?.slotCount, expectedSlots);
  expect("mapped staging record store", runtimeConfig?.mappedStaging?.recordStore,
    expectedStageFast ? "flat" : "objects");
  expect("mapped timing enabled", runtimeConfig?.mappedStaging?.timing?.enabled,
    expectedMetricsEnabled);
  expect("mapped timing stride", runtimeConfig?.mappedStaging?.timing?.stride,
    expectedTimingStride);
  expect("geometry pack", runtimeConfig?.geometryPackEnabled, expectedGeometryPack);
  expect("geometry range", runtimeConfig?.geometryRangeEnabled, expectedGeometryRange);
  if (expectedGeometryRange && runtimeConfig?.producerGeometryRangeAvailable !== true) {
    failures.push("WGPU runtime config geometry-range producer setter is unavailable");
  }
  expect("tail gate requested", runtimeConfig?.tailGate?.requested, expectedTailGate);
  expect("tail gate enabled", runtimeConfig?.tailGate?.enabled, expectedTailGate);
  if (expectedTailGate && runtimeConfig?.tailGate?.available !== true) {
    failures.push("WGPU runtime config tail-gate producer setter is unavailable");
  }
  if (runtimeConfig?.tailGate?.schema !== WGPU_TAIL_GATE_SCHEMA ||
      runtimeConfig?.tailGate?.schemaVersion !== WGPU_TAIL_GATE_SCHEMA_VERSION) {
    failures.push("WGPU runtime config tail-gate schema is unavailable or malformed");
  }
  return { required: true, runtimeConfig: runtimeConfig ?? null, failures };
}

export const FIXED_MELEE_BATTLE_FIXTURE = Object.freeze({
  sceneLabel: "Melee Kirby vs Link fixed battle",
  isoSha256: "1018b65a58ca654056be1611a43e753de5dd5f842ce5266581b29c6a12ce7c67",
  saveStateSha256: "620879e2ed3c35248deba9fb2f7b2a39f91f5374d2f6a98d2a2455cb55e156d1",
});

export const FIXED_MELEE_BATTLE_CHECKPOINT = Object.freeze({
  // Recorded from the paused, exact-state checkpoint. The harness pauses the
  // core before State::LoadAs so these values are tied to save bytes rather
  // than wall-clock delay after loading. Restored in-slice bookkeeping can
  // make the after-load observation lower by at most one CoreTiming
  // MAX_SLICE_LENGTH (20,000 ticks, about 41 microseconds at 486 MHz). PC,
  // XFB hash, dimensions, callback source, and fixture hashes remain exact.
  frame: null,
  coreTicks: 15166162443,
  coreTicksDeltaMin: -20_000,
  coreTicksDeltaMax: 0,
  ppcPc: -2144030364,
  xfbHash: "4b2d0a3b",
  width: 640,
  height: 480,
  checkpointObservationSource: "cpu-thread-after-load",
  minLoadedCheckpointGeneration: 1,
});

const FIXED_MELEE_SOFTWARE_XFB_HASH_BY_FASTSW = Object.freeze({
  0: "55dc4398",
  1: FIXED_MELEE_BATTLE_CHECKPOINT.xfbHash,
});

const FIXED_MELEE_WGPU_XFB_HASH = "6fd97dc5";

export function expectedBattleCheckpointForParams(params = {}) {
  const video = String(params.video || "software").toLowerCase();
  const fastsw = Number.parseInt(String(params.fastsw ?? "1"), 10);
  let xfbHash = FIXED_MELEE_BATTLE_CHECKPOINT.xfbHash;
  if (video === "software") {
    xfbHash = FIXED_MELEE_SOFTWARE_XFB_HASH_BY_FASTSW[fastsw] ?? xfbHash;
  } else if (video === "wgpu") {
    xfbHash = FIXED_MELEE_WGPU_XFB_HASH;
  }
  return { ...FIXED_MELEE_BATTLE_CHECKPOINT, xfbHash };
}

export const HOST_CORE_ABI_VERSION = 1;
export const PERF_EVENT_SCHEMA_VERSION = 1;
export const PERF_AUDIO_MODES = Object.freeze(["muted", "audible"]);

export function normalizePerfAudioMode(value) {
  const mode = String(value ?? "").trim().toLowerCase() || "muted";
  if (!PERF_AUDIO_MODES.includes(mode)) {
    throw new Error(
      `Invalid PERF_AUDIO_MODE=${JSON.stringify(value)}; expected muted or audible`
    );
  }
  return mode;
}

export function evaluateJitCacheReadiness(snapshot) {
  if (snapshot?.enabled === false) {
    return { ready: true, invalidReasons: [] };
  }
  const invalidReasons = [];
  if (snapshot?.enabled !== true) invalidReasons.push("enabled is not true");
  if (snapshot?.bootLoadComplete !== true) invalidReasons.push("bootLoadComplete is not true");
  if (snapshot?.lazyFillStarted !== true) invalidReasons.push("lazyFillStarted is not true");
  if (snapshot?.lazyFillActive !== false) invalidReasons.push("lazyFillActive is not false");
  if (snapshot?.lazyFillCompleted !== true) invalidReasons.push("lazyFillCompleted is not true");
  if (snapshot?.lazyFillTerminalReason !== "complete") {
    invalidReasons.push(`lazyFillTerminalReason is ${snapshot?.lazyFillTerminalReason ?? "missing"}`);
  }
  if (Number(snapshot?.lazyFillFailureCount) !== 0) {
    invalidReasons.push(`lazyFillFailureCount is ${snapshot?.lazyFillFailureCount ?? "missing"}`);
  }
  if (Number(snapshot?.verificationPending) !== 0) {
    invalidReasons.push(`verificationPending is ${snapshot?.verificationPending ?? "missing"}`);
  }
  if (Number(snapshot?.compilePending) !== 0) {
    invalidReasons.push(`compilePending is ${snapshot?.compilePending ?? "missing"}`);
  }
  if (Number(snapshot?.idbWritesPending) !== 0) {
    invalidReasons.push(`idbWritesPending is ${snapshot?.idbWritesPending ?? "missing"}`);
  }
  const workerCount = Number(snapshot?.pthreadWorkerCount);
  if (!(workerCount > 0)) invalidReasons.push(`pthreadWorkerCount is ${snapshot?.pthreadWorkerCount ?? "missing"}`);
  const requiredWorkerCount = Number(snapshot?.pthreadRequiredWorkerCount);
  const requiredBarrierAcked = Number(snapshot?.pthreadRequiredBarrierAcked);
  if (!(requiredWorkerCount > 0)) {
    invalidReasons.push(
      `pthreadRequiredWorkerCount is ${snapshot?.pthreadRequiredWorkerCount ?? "missing"}`
    );
  }
  if (requiredBarrierAcked !== requiredWorkerCount) {
    invalidReasons.push(
      `pthreadRequiredBarrierAcked is ${snapshot?.pthreadRequiredBarrierAcked ?? "missing"}`
    );
  }
  if (Number(snapshot?.pthreadInstallPostFailures) !== 0) {
    invalidReasons.push(
      `pthreadInstallPostFailures is ${snapshot?.pthreadInstallPostFailures ?? "missing"}`
    );
  }
  if (Number(snapshot?.pthreadBarrierInvalidAcks) !== 0) {
    invalidReasons.push(
      `pthreadBarrierInvalidAcks is ${snapshot?.pthreadBarrierInvalidAcks ?? "missing"}`
    );
  }
  return { ready: invalidReasons.length === 0, invalidReasons };
}

export function evaluateAudioClaimQualification({
  audioMode,
  headed = false,
  qualificationEligible = false,
} = {}) {
  const mode = normalizePerfAudioMode(audioMode);
  const audibleRequested = mode === "audible";
  let reason = null;
  if (!audibleRequested) reason = "audio-mode-muted";
  else if (!headed) reason = "headless";
  else if (!qualificationEligible) reason = "run-not-qualified";
  return {
    mode,
    audibleRequested,
    eligible: reason === null,
    reason,
  };
}

const POST_LOAD_INPUT_KEYS = new Set([
  "x", "z", "v", "b", "q", "e", "c",
  "w", "a", "s", "d", "i", "j", "k", "l",
  "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

export function parsePostLoadInputScript(value, { durationSeconds = Infinity } = {}) {
  const source = String(value ?? "").trim();
  if (!source || /^(?:none|off)$/i.test(source)) return [];
  if (!(durationSeconds > 0)) {
    throw new Error("Post-load input scripts require a positive benchmark duration");
  }

  const entries = source.split(",");
  if (entries.length > 256) {
    throw new Error("PERF_INPUT_SCRIPT supports at most 256 input events");
  }

  const events = entries.map((entry, index) => {
    const parts = entry.trim().split(":");
    const action = parts[0];
    const second = Number.parseFloat(parts[1]);
    const key = parts[2];
    if (
      parts.length !== 3 ||
      !["down", "up"].includes(action) ||
      !Number.isFinite(second) ||
      second < 0 ||
      second >= durationSeconds ||
      !POST_LOAD_INPUT_KEYS.has(key)
    ) {
      throw new Error(`Invalid PERF_INPUT_SCRIPT entry "${entry}"`);
    }
    return { action, second, key, index };
  }).sort((left, right) => left.second - right.second || left.index - right.index);

  const pressedAt = new Map();
  for (const event of events) {
    if (event.action === "down") {
      if (pressedAt.has(event.key)) {
        throw new Error(`PERF_INPUT_SCRIPT repeats key down without key up: ${event.key}`);
      }
      pressedAt.set(event.key, event.second);
      continue;
    }
    const downAt = pressedAt.get(event.key);
    if (downAt == null) {
      throw new Error(`PERF_INPUT_SCRIPT releases a key that is not down: ${event.key}`);
    }
    if (event.second <= downAt) {
      throw new Error(`PERF_INPUT_SCRIPT key up must follow key down in time: ${event.key}`);
    }
    pressedAt.delete(event.key);
  }
  if (pressedAt.size) {
    throw new Error(`PERF_INPUT_SCRIPT leaves keys pressed: ${[...pressedAt.keys()].join(", ")}`);
  }
  return events;
}

export function serializePostLoadInputScript(events) {
  return events.map((event) => `${event.action}:${event.second}:${event.key}`).join(",");
}

export function summarizePostLoadInputDelivery(
  events = [],
  { expectedCount = 0, maxLatenessMs = 100 } = {}
) {
  const expected = Math.max(0, Math.trunc(Number(expectedCount) || 0));
  const latenessLimit = Number(maxLatenessMs);
  if (!Number.isFinite(latenessLimit) || latenessLimit < 0) {
    throw new Error("Post-load input maximum lateness must be a non-negative number");
  }
  const delivered = (events || []).filter(Boolean);
  const lateEvents = delivered.filter((event) => Number(event.latenessMs) > latenessLimit);
  const missingLatenessCount = delivered.filter(
    (event) => !Number.isFinite(Number(event.latenessMs))
  ).length;
  const beforeBaselineCount = delivered.filter((event) => event.afterBaselineSample !== true).length;
  const markerBarrierUnavailableCount = delivered.filter(
    (event) => event.markerBarrier?.available !== true
  ).length;
  const markerBarrierTimeoutCount = delivered.filter(
    (event) => event.markerBarrier?.available === true && event.markerBarrier.completed !== true
  ).length;
  const failures = [];
  if (delivered.length !== expected) {
    failures.push(`post-load input delivered ${delivered.length}/${expected} events`);
  }
  if (beforeBaselineCount > 0) {
    failures.push(`post-load input delivered ${beforeBaselineCount} events before the timed baseline sample`);
  }
  if (missingLatenessCount > 0) {
    failures.push(`post-load input missing lateness for ${missingLatenessCount} events`);
  }
  if (lateEvents.length > 0) {
    failures.push(
      `post-load input dispatch lateness exceeded ${latenessLimit}ms for ${lateEvents.length} events ` +
      `(max=${Math.max(...lateEvents.map((event) => Number(event.latenessMs))).toFixed(1)}ms)`
    );
  }
  if (markerBarrierUnavailableCount > 0) {
    failures.push(`input marker completion barrier unavailable for ${markerBarrierUnavailableCount} events`);
  }
  if (markerBarrierTimeoutCount > 0) {
    failures.push(`input marker completion barrier timed out for ${markerBarrierTimeoutCount} events`);
  }
  return {
    expectedCount: expected,
    deliveredCount: delivered.length,
    maxAllowedLatenessMs: latenessLimit,
    maxObservedLatenessMs: delivered.length
      ? Math.max(...delivered.map((event) => Number(event.latenessMs) || 0))
      : 0,
    lateEventCount: lateEvents.length,
    missingLatenessCount,
    beforeBaselineCount,
    markerBarrierUnavailableCount,
    markerBarrierTimeoutCount,
    failures,
  };
}

export function selectNextPostLoadBenchmarkAction({
  sampleIndex,
  totalSamples,
  sampleMs,
  inputIndex,
  inputEvents,
}) {
  const sample = sampleIndex <= totalSamples
    ? { type: "sample", index: sampleIndex, atMs: sampleIndex * sampleMs }
    : null;
  const inputEvent = inputEvents[inputIndex];
  const input = inputEvent
    ? { type: "input", index: inputIndex, atMs: inputEvent.second * 1000, event: inputEvent }
    : null;
  if (!sample) return input;
  if (!input || sampleIndex === 0 || sample.atMs <= input.atMs) return sample;
  return input;
}

export function selectNextFixedWorkBenchmarkAction({
  wallTimeCapMs,
  ...schedule
}) {
  const action = selectNextPostLoadBenchmarkAction(schedule);
  if (!action || action.atMs > wallTimeCapMs) {
    return { type: "wall-time-cap", atMs: wallTimeCapMs };
  }
  return action;
}

export function fixedWorkPollDelayMs({
  nowMs,
  deadlineMs,
  pollIntervalMs = 100,
}) {
  const remainingMs = Number(deadlineMs) - Number(nowMs);
  if (!(remainingMs > 0)) return 0;
  const intervalMs = Number(pollIntervalMs);
  if (!(intervalMs > 0)) {
    throw new Error("Fixed-work polling requires a positive poll interval");
  }
  return Math.min(intervalMs, remainingMs);
}

export function summarizeFixedEmulatedWork({
  targetCoreSeconds,
  coreTicksPerSecond,
  baseline,
  observation,
  wallTimeCapSeconds,
  pollIntervalMs,
}) {
  const targetSeconds = Number(targetCoreSeconds);
  const ticksPerSecond = Number(coreTicksPerSecond);
  const baselineTicks = Number(baseline?.coreTicks);
  const baselineFrame = Number(baseline?.frame);
  const baselineObservedAtMs = Number(baseline?.observedAtMs);
  const observedTicks = Number(observation?.coreTicks);
  const observedFrame = Number(observation?.frame);
  const observedAtMs = Number(observation?.observedAtMs);
  if (!(targetSeconds > 0)) {
    throw new Error("Fixed emulated work requires positive targetCoreSeconds");
  }
  if (!(ticksPerSecond > 0)) {
    throw new Error("Fixed emulated work requires positive coreTicksPerSecond");
  }
  if (![baselineTicks, baselineFrame, baselineObservedAtMs, observedTicks, observedFrame, observedAtMs]
    .every(Number.isFinite)) {
    throw new Error("Fixed emulated work requires finite baseline and observation values");
  }

  const targetCoreTicks = targetSeconds * ticksPerSecond;
  const actualCoreTickDelta = observedTicks - baselineTicks;
  const actualFrameDelta = observedFrame - baselineFrame;
  const elapsedWallSeconds = (observedAtMs - baselineObservedAtMs) / 1000;
  const deltasValid = actualCoreTickDelta >= 0 && actualFrameDelta >= 0 && elapsedWallSeconds >= 0;
  const hasElapsedTime = deltasValid && elapsedWallSeconds > 0;
  return {
    enabled: true,
    targetCoreSeconds: targetSeconds,
    targetCoreTicks,
    coreTicksPerSecond: ticksPerSecond,
    wallTimeCapSeconds: Number(wallTimeCapSeconds),
    pollIntervalMs: Number(pollIntervalMs),
    baselineCoreTicks: baselineTicks,
    baselineFrame,
    baselineObservedAtMs,
    observedCoreTicks: observedTicks,
    observedFrame,
    observedAtMs,
    actualCoreTickDelta,
    actualFrameDelta,
    elapsedWallSeconds,
    reachedTarget: deltasValid && actualCoreTickDelta >= targetCoreTicks,
    throughputGameSpeedPercent: hasElapsedTime
      ? (actualCoreTickDelta * 100) / (ticksPerSecond * elapsedWallSeconds)
      : null,
    throughputCoreFps: hasElapsedTime ? actualFrameDelta / elapsedWallSeconds : null,
    deltasValid,
  };
}

export const REQUIRED_RUN_PROVENANCE = Object.freeze([
  "git.commit",
  "browser.version",
  "benchmark.url",
  "benchmark.sceneLabel",
  "benchmark.saveStateAt",
  "benchmark.inputScriptMode",
  "artifacts.rom.sha256",
  "artifacts.core.sha256",
  "artifacts.saveState.sha256",
  "fixture.isoVerified",
  "fixture.saveStateVerified",
  "fixture.saveStateLoaded",
  "fixture.battleCheckpoint.verified",
  "servedApplication.verified",
  "causalTelemetrySchema.version",
]);

export const REQUIRED_QUALIFICATION_PROVENANCE = Object.freeze([
  "git.dirty",
  "browser.headed",
  "browser.version",
  "browser.executablePath",
  "browser.actualChannel",
  "browser.profileId",
  "benchmark.cacheState",
  "renderer.expectedVideoBackend",
  "renderer.requestedVideoBackend",
  "renderer.activeVideoBackend",
  "renderer.expectedRequestedPresenterBackend",
  "renderer.expectedActivePresenterBackend",
  "renderer.requestedPresenterBackend",
  "renderer.activePresenterBackend",
  "buildProvenance.verification.verified",
  "servedApplication.verified",
  "servedApplication.manifestSha256",
]);

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function describeFile(filePath, { hash = true } = {}) {
  if (!filePath) return null;
  const info = await stat(filePath);
  const startedAt = performance.now();
  const sha256 = hash ? await hashFile(filePath) : null;
  return {
    name: path.basename(filePath),
    bytes: info.size,
    sha256,
    hashDurationMs: hash ? Math.round(performance.now() - startedAt) : null,
  };
}

export async function verifyFileFixture(filePath, { label, expectedSha256 }) {
  if (!filePath) {
    throw new Error(`Missing ${label} path`);
  }
  let description;
  try {
    description = await describeFile(filePath, { hash: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Missing ${label}: ${filePath}`);
    }
    throw error;
  }
  const expected = String(expectedSha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`Expected SHA-256 for ${label} must be 64 hexadecimal characters`);
  }
  if (description.sha256 !== expected) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected}, got ${description.sha256}`
    );
  }
  return { ...description, path: path.resolve(filePath), verified: true };
}

export function missingRunProvenance(manifest, required = REQUIRED_RUN_PROVENANCE) {
  return required.filter((field) => {
    const value = readPath(manifest, field);
    return value === undefined || value === null || value === "";
  });
}

export function assertRunProvenance(manifest, required = REQUIRED_RUN_PROVENANCE) {
  const missing = missingRunProvenance(manifest, required);
  if (missing.length) {
    throw new Error(`Missing required run provenance: ${missing.join(", ")}`);
  }
  if (manifest.benchmark.saveStateAt !== 0) {
    throw new Error("Fixed-battle timing requires benchmark.saveStateAt=0");
  }
  const inputScriptMode = manifest.benchmark.inputScriptMode;
  if (!new Set(["none", "post-load-only"]).has(inputScriptMode)) {
    throw new Error(
      "Fixed-battle timing requires benchmark.inputScriptMode=none or post-load-only"
    );
  }
  if (inputScriptMode === "post-load-only") {
    if (manifest.benchmark.timingStartsAfterVerifiedLoad !== true) {
      throw new Error("Post-load input requires timingStartsAfterVerifiedLoad=true");
    }
    if (manifest.benchmark.inputScriptScheduleOrigin !== "after-first-timed-sample") {
      throw new Error("Post-load input must be scheduled after the first timed baseline sample");
    }
    if (!manifest.benchmark.timingBaselineEstablishedAt) {
      throw new Error("Post-load input requires an established timed baseline sample");
    }
    if (!(manifest.benchmark.inputScriptEventCount > 0)) {
      throw new Error("Post-load input requires a positive inputScriptEventCount");
    }
    if (!/^[0-9a-f]{64}$/i.test(String(manifest.benchmark.inputScriptSha256 || ""))) {
      throw new Error("Post-load input requires a SHA-256 inputScriptSha256");
    }
  }
  const fixedWork = manifest.benchmark.fixedEmulatedWork;
  if (fixedWork?.enabled) {
    if (!(fixedWork.targetCoreSeconds > 0) || !(fixedWork.targetCoreTicks > 0)) {
      throw new Error("Fixed emulated work requires positive target seconds and target ticks");
    }
    if (!(fixedWork.coreTicksPerSecond > 0) || !(fixedWork.wallTimeCapSeconds > 0)) {
      throw new Error("Fixed emulated work requires a positive tick rate and wall-time cap");
    }
    if (!(fixedWork.pollIntervalMs > 0)) {
      throw new Error("Fixed emulated work requires a positive polling interval");
    }
    if (!manifest.benchmark.timingBaselineEstablishedAt) {
      throw new Error("Fixed emulated work requires a post-settle timed baseline sample");
    }
  }
  if (manifest.causalTelemetrySchema.version !== CAUSAL_TELEMETRY_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported causal telemetry schema: expected ${CAUSAL_TELEMETRY_SCHEMA_VERSION}, ` +
      `got ${manifest.causalTelemetrySchema.version}`
    );
  }
  if (!manifest.fixture.isoVerified || !manifest.fixture.saveStateVerified) {
    throw new Error("Fixed-battle fixture hashes were not verified");
  }
  if (!manifest.fixture.saveStateLoaded) {
    throw new Error("Fixed-battle save state was not loaded before timing");
  }
  if (!manifest.fixture.battleCheckpoint?.verified) {
    throw new Error("Deterministic post-load battle/XFB checkpoint was not verified");
  }
  if (!manifest.servedApplication?.verified) {
    throw new Error("Served application/core identity was not verified");
  }
  return manifest;
}

export function evaluateQualificationProvenance(manifest) {
  const missing = missingRunProvenance(manifest, REQUIRED_QUALIFICATION_PROVENANCE);
  if (manifest?.git?.dirty !== false) missing.push("git.dirty=false");
  if (manifest?.browser?.headed !== true) missing.push("browser.headed=true");
  if (!Array.isArray(manifest?.patches?.hashes) || manifest.patches.hashes.length === 0) {
    missing.push("patches.hashes[0]");
  } else if (manifest.patches.hashes.some((hash) => !/^[0-9a-f]{64}$/i.test(String(hash)))) {
    missing.push("patches.hashes(valid SHA-256)");
  }
  const renderer = manifest?.renderer || {};
  if (renderer.requestedVideoBackend !== renderer.expectedVideoBackend) {
    missing.push(`renderer.requestedVideoBackend=${renderer.expectedVideoBackend || "expected"}`);
  }
  if (renderer.activeVideoBackend !== renderer.expectedVideoBackend) {
    missing.push(`renderer.activeVideoBackend=${renderer.expectedVideoBackend || "expected"}`);
  }
  if (renderer.requestedPresenterBackend !== renderer.expectedRequestedPresenterBackend) {
    missing.push(
      `renderer.requestedPresenterBackend=${renderer.expectedRequestedPresenterBackend || "expected"}`
    );
  }
  if (renderer.activePresenterBackend !== renderer.expectedActivePresenterBackend) {
    missing.push(
      `renderer.activePresenterBackend=${renderer.expectedActivePresenterBackend || "expected"}`
    );
  }
  if (renderer.expectedActivePresenterBackend === "webgpu") {
    if (!renderer.adapter?.selected) {
      missing.push("renderer.adapter.selected=true");
    } else if (![renderer.adapter.vendor, renderer.adapter.device, renderer.adapter.description].some(Boolean)) {
      missing.push("renderer.adapter.identity");
    }
    if (!renderer.device?.created) missing.push("renderer.device.created=true");
  }
  if (!manifest?.browser?.profileId) missing.push("browser.profileId");
  if (!/^[0-9a-f]{64}$/i.test(String(manifest?.servedApplication?.manifestSha256 || ""))) {
    missing.push("servedApplication.manifestSha256(valid SHA-256)");
  }
  if (manifest?.hostCore?.abiVersion !== HOST_CORE_ABI_VERSION) {
    missing.push(`hostCore.abiVersion=${HOST_CORE_ABI_VERSION}`);
  }
  if (manifest?.eventSchema?.version !== PERF_EVENT_SCHEMA_VERSION) {
    missing.push(`eventSchema.version=${PERF_EVENT_SCHEMA_VERSION}`);
  }
  if (manifest?.causalTelemetrySchema?.version !== CAUSAL_TELEMETRY_SCHEMA_VERSION) {
    missing.push(`causalTelemetrySchema.version=${CAUSAL_TELEMETRY_SCHEMA_VERSION}`);
  }
  const lockedVerification = validateLockedBuildProvenance(manifest?.buildProvenance || {});
  if (manifest?.buildProvenance?.verification?.verified !== true) {
    missing.push("buildProvenance.verification.verified=true");
  }
  if (!lockedVerification.verified) {
    missing.push(...lockedVerification.failures.map((failure) => `buildProvenance.${failure}`));
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(manifest?.upstream?.dolphinSha || ""))) {
    missing.push("upstream.dolphinSha(valid commit)");
  }
  if (manifest?.upstream?.dolphinSha !== manifest?.buildProvenance?.locked?.sourceLock?.upstream?.commit) {
    missing.push("upstream.dolphinSha=locked source commit");
  }
  const lockedPatchHashes = (manifest?.buildProvenance?.locked?.sourceLock?.patches || []).map(
    (patch) => patch?.sha256
  );
  if (JSON.stringify(manifest?.patches?.hashes || []) !== JSON.stringify(lockedPatchHashes)) {
    missing.push("patches.hashes=locked patch order");
  }
  if (JSON.stringify(manifest?.toolchain ?? null) !== JSON.stringify(manifest?.buildProvenance?.locked?.toolchainLock ?? null)) {
    missing.push("toolchain=locked toolchain manifest");
  }
  const uniqueMissing = [...new Set(missing)];
  return {
    eligible: uniqueMissing.length === 0,
    missing: uniqueMissing,
  };
}

export function validateLockedBuildProvenance(provenance = {}) {
  const buildInfo = provenance.locked?.buildInfo;
  const sourceLock = provenance.locked?.sourceLock;
  const abiManifest = provenance.locked?.abiManifest;
  const toolchainLock = provenance.locked?.toolchainLock;
  const vendorSnapshot = provenance.locked?.vendorSnapshot;
  const actual = provenance.actualArtifacts || {};
  const actualContractSources = provenance.actualContractSources || {};
  const evidence = provenance.evidenceFiles || {};
  const failures = [];
  const require = (condition, label) => {
    if (!condition) failures.push(label);
  };
  const sha = (value) => /^[0-9a-f]{64}$/i.test(String(value || ""));
  const commit = (value) => /^[0-9a-f]{40}$/i.test(String(value || ""));
  const exact = (left, right, label) => require(left !== undefined && left === right, label);
  const evidenceFile = (key, { committed = false } = {}) => {
    const entry = evidence[key];
    require(entry?.exists === true, `evidenceFiles.${key}.exists=true`);
    require(sha(entry?.sha256), `evidenceFiles.${key}.sha256`);
    if (committed) {
      const candidateAbi = key === "abiManifest" && provenance.candidateBundle?.verified === true &&
        entry?.candidateBundleMember === true;
      require(entry?.trackedAtHead === true || candidateAbi, `evidenceFiles.${key}.trackedAtHead=true`);
      require(entry?.matchesHead === true || candidateAbi, `evidenceFiles.${key}.matchesHead=true`);
    }
  };

  require(buildInfo?.schemaVersion === 1, "locked.buildInfo.schemaVersion=1");
  require(sourceLock?.schemaVersion === 1, "locked.sourceLock.schemaVersion=1");
  require(abiManifest?.schemaVersion === 1, "locked.abiManifest.schemaVersion=1");
  require(toolchainLock?.schemaVersion === 1, "locked.toolchainLock.schemaVersion=1");
  require(vendorSnapshot?.schemaVersion === 1, "locked.vendorSnapshot.schemaVersion=1");
  evidenceFile("buildInfo");
  evidenceFile("sourceLock", { committed: true });
  evidenceFile("abiManifest", { committed: true });
  evidenceFile("toolchainLock", { committed: true });
  evidenceFile("vendorSnapshot", { committed: true });
  evidenceFile("nagaCargoLock", { committed: true });
  const bundledEvidence = new Map(
    (Array.isArray(provenance.evidenceBundle) ? provenance.evidenceBundle : []).map((entry) => [entry?.key, entry])
  );
  for (const key of ["buildInfo", "sourceLock", "abiManifest", "toolchainLock", "vendorSnapshot", "nagaCargoLock"]) {
    const bundled = bundledEvidence.get(key);
    require(Boolean(bundled?.path), `evidenceBundle.${key}.path`);
    exact(bundled?.sha256, evidence[key]?.sha256, `evidenceBundle.${key}.sha256`);
    exact(bundled?.bytes, evidence[key]?.bytes, `evidenceBundle.${key}.bytes`);
  }

  require(commit(sourceLock?.upstream?.commit), "locked.sourceLock.upstream.commit");
  exact(vendorSnapshot?.root?.baseCommit, sourceLock?.upstream?.commit, "locked.vendorSnapshot.root.baseCommit");
  require(commit(vendorSnapshot?.root?.resultTree), "locked.vendorSnapshot.root.resultTree");
  require(sha(sourceLock?.patchSeriesSha256), "locked.sourceLock.patchSeriesSha256");
  require(Array.isArray(sourceLock?.patches) && sourceLock.patches.length > 0, "locked.sourceLock.patches");
  for (const [index, patch] of (sourceLock?.patches || []).entries()) {
    require(patch?.order === index + 1, `locked.sourceLock.patches[${index}].order`);
    require(sha(patch?.sha256), `locked.sourceLock.patches[${index}].sha256`);
    require(patch?.hashMode === "lf-normalized", `locked.sourceLock.patches[${index}].hashMode`);
  }

  require(abiManifest?.abiVersion === HOST_CORE_ABI_VERSION, `locked.abiManifest.abiVersion=${HOST_CORE_ABI_VERSION}`);
  require(
    (abiManifest?.sourceOnlyExportsPendingRebuild ?? []).length === 0,
    "locked.abiManifest.sourceOnlyExportsPendingRebuild must be empty for qualification"
  );
  require(Array.isArray(abiManifest?.moduleExports), "locked.abiManifest.moduleExports");
  for (const name of REQUIRED_WGPU_OWNERSHIP_TRACE_EXPORTS) {
    require(
      abiManifest?.moduleExports?.includes(name),
      `locked.abiManifest.moduleExports includes ${name}`
    );
  }
  exact(abiManifest?.upstreamCommit, sourceLock?.upstream?.commit, "locked.abiManifest.upstreamCommit");
  require(sha(String(abiManifest?.coreId || "").replace(/^sha256:/, "")), "locked.abiManifest.coreId");
  require(Array.isArray(abiManifest?.artifacts), "locked.abiManifest.artifacts");
  require(
    Array.isArray(abiManifest?.contractSources) && abiManifest.contractSources.length > 0,
    "locked.abiManifest.contractSources"
  );
  for (const [index, declared] of (abiManifest?.contractSources || []).entries()) {
    const observed = actualContractSources[declared?.path];
    require(Boolean(observed), `actualContractSources.${declared?.path || index}`);
    exact(observed?.path, declared?.path, `abi.contractSources[${index}].path`);
    exact(observed?.hashMode, declared?.hashMode || "raw", `abi.contractSources[${index}].hashMode`);
    exact(observed?.sha256, declared?.sha256, `abi.contractSources[${index}].sha256`);
    exact(observed?.size, declared?.size, `abi.contractSources[${index}].size`);
  }

  require(commit(buildInfo?.repository?.commit), "locked.buildInfo.repository.commit");
  require(buildInfo?.repository?.status === "", "locked.buildInfo.repository.status=clean");
  require(!Number.isNaN(Date.parse(buildInfo?.createdAt || "")), "locked.buildInfo.createdAt");
  exact(buildInfo?.source?.upstreamCommit, sourceLock?.upstream?.commit, "locked.buildInfo.source.upstreamCommit");
  exact(buildInfo?.source?.patchSeriesSha256, sourceLock?.patchSeriesSha256, "locked.buildInfo.source.patchSeriesSha256");
  exact(buildInfo?.source?.sourceLockSha256, evidence.sourceLock?.sha256, "locked.buildInfo.source.sourceLockSha256");
  exact(buildInfo?.source?.vendorSnapshotSha256, evidence.vendorSnapshot?.sha256, "locked.buildInfo.source.vendorSnapshotSha256");
  exact(buildInfo?.source?.vendorResultTree, vendorSnapshot?.root?.resultTree, "locked.buildInfo.source.vendorResultTree");
  exact(buildInfo?.toolchain?.lockSha256, evidence.toolchainLock?.sha256, "locked.buildInfo.toolchain.lockSha256");

  for (const [label, value] of [
    ["platform", toolchainLock?.platform],
    ["node.version", toolchainLock?.node?.version],
    ["emscripten.version", toolchainLock?.emscripten?.version],
    ["cmake.version", toolchainLock?.cmake?.version],
    ["ninja.version", toolchainLock?.ninja?.version],
    ["rust.rustcVersion", toolchainLock?.rust?.rustcVersion],
    ["rust.cargoVersion", toolchainLock?.rust?.cargoVersion],
    ["naga.crateVersion", toolchainLock?.naga?.crateVersion],
    ["naga.dependencyVersion", toolchainLock?.naga?.dependencyVersion],
  ]) require(typeof value === "string" && value.length > 0, `locked.toolchainLock.${label}`);
  for (const [label, value] of [
    ["emscripten.compilerCommit", toolchainLock?.emscripten?.compilerCommit],
    ["emscripten.emsdkCommit", toolchainLock?.emscripten?.emsdkCommit],
    ["rust.rustcCommit", toolchainLock?.rust?.rustcCommit],
    ["rust.cargoCommit", toolchainLock?.rust?.cargoCommit],
  ]) require(commit(value), `locked.toolchainLock.${label}`);

  const toolchainComparisons = [
    ["emscriptenVersion", toolchainLock?.emscripten?.version],
    ["emscriptenCompilerCommit", toolchainLock?.emscripten?.compilerCommit],
    ["emsdkCommit", toolchainLock?.emscripten?.emsdkCommit],
    ["cmakeVersion", toolchainLock?.cmake?.version],
    ["ninjaVersion", toolchainLock?.ninja?.version],
    ["rustcVersion", toolchainLock?.rust?.rustcVersion],
    ["rustcCommit", toolchainLock?.rust?.rustcCommit],
    ["cargoVersion", toolchainLock?.rust?.cargoVersion],
    ["nagaDependencyVersion", toolchainLock?.naga?.dependencyVersion],
    ["cargoLockSha256", toolchainLock?.naga?.cargoLockSha256],
  ];
  for (const [field, expected] of toolchainComparisons) {
    exact(buildInfo?.toolchain?.[field], expected, `locked.buildInfo.toolchain.${field}`);
  }
  exact(toolchainLock?.naga?.cargoLockSha256, evidence.nagaCargoLock?.normalizedSha256, "locked.toolchainLock.naga.cargoLockSha256");
  require(toolchainLock?.rust?.target === "wasm32-unknown-emscripten", "locked.toolchainLock.rust.target");
  for (const [label, value] of [
    ["node.sha256", toolchainLock?.node?.sha256],
    ["emscripten.emccSha256", toolchainLock?.emscripten?.emccSha256],
    ["emscripten.emcmakeSha256", toolchainLock?.emscripten?.emcmakeSha256],
    ["emscripten.clangxxSha256", toolchainLock?.emscripten?.clangxxSha256],
    ["cmake.sha256", toolchainLock?.cmake?.sha256],
    ["ninja.sha256", toolchainLock?.ninja?.sha256],
    ["rust.rustcSha256", toolchainLock?.rust?.rustcSha256],
    ["rust.cargoSha256", toolchainLock?.rust?.cargoSha256],
    ["rust.rustupSha256", toolchainLock?.rust?.rustupSha256],
    ["naga.cargoLockSha256", toolchainLock?.naga?.cargoLockSha256],
  ]) require(sha(value), `locked.toolchainLock.${label}`);

  require(Number.isInteger(buildInfo?.configure?.wasmMemoryPages) && buildInfo.configure.wasmMemoryPages > 0, "locked.buildInfo.configure.wasmMemoryPages");
  require(typeof buildInfo?.configure?.wasmCompileFlags === "string" && buildInfo.configure.wasmCompileFlags.length > 0, "locked.buildInfo.configure.wasmCompileFlags");
  require(Array.isArray(buildInfo?.configure?.cmakeArgs) && buildInfo.configure.cmakeArgs.length > 0, "locked.buildInfo.configure.cmakeArgs");
  require(sha(buildInfo?.configure?.cmakeCacheSha256), "locked.buildInfo.configure.cmakeCacheSha256");

  const artifactBySuffix = (artifacts, suffix) =>
    (Array.isArray(artifacts) ? artifacts : Object.values(artifacts || {})).find((entry) =>
      String(entry?.path || "").replaceAll("\\", "/").endsWith(suffix)
    );
  const jsAbi = artifactBySuffix(abiManifest?.artifacts, "cores/dolphin/dolphin-core-upstream.js");
  const wasmAbi = artifactBySuffix(abiManifest?.artifacts, "cores/dolphin/dolphin-core-upstream.wasm");
  const jsBuild = buildInfo?.artifacts?.js;
  const wasmBuild = buildInfo?.artifacts?.wasm;
  require(
    String(jsBuild?.path || "").replaceAll("\\", "/").endsWith("/dolphin-core-upstream.js"),
    "locked.buildInfo.artifacts.js.path"
  );
  require(
    String(wasmBuild?.path || "").replaceAll("\\", "/").endsWith("/dolphin-core-upstream.wasm"),
    "locked.buildInfo.artifacts.wasm.path"
  );
  require(actual.js?.path === "cores/dolphin/dolphin-core-upstream.js", "actualArtifacts.js.path");
  require(actual.wasm?.path === "cores/dolphin/dolphin-core-upstream.wasm", "actualArtifacts.wasm.path");
  require(jsAbi?.hashMode === "lf-normalized", "locked.abiManifest.artifacts.js.hashMode");
  require(jsBuild?.hashMode === "lf-normalized", "locked.buildInfo.artifacts.js.hashMode");
  require(wasmBuild?.hashMode === "raw", "locked.buildInfo.artifacts.wasm.hashMode");
  require(actual.js?.hashMode === "lf-normalized", "actualArtifacts.js.hashMode");
  require(actual.wasm?.hashMode === "raw", "actualArtifacts.wasm.hashMode");
  for (const [label, declared, observed] of [
    ["abi.js", jsAbi, actual.js],
    ["abi.wasm", wasmAbi, actual.wasm],
    ["buildInfo.js", jsBuild, { ...actual.js, size: actual.js?.rawSize }],
    ["buildInfo.wasm", wasmBuild, { ...actual.wasm, size: actual.wasm?.rawSize }],
  ]) {
    exact(declared?.sha256, observed?.sha256, `${label}.sha256`);
    exact(declared?.size, observed?.size, `${label}.size`);
  }
  exact(buildInfo?.coreId, `sha256:${actual.wasm?.sha256}`, "locked.buildInfo.coreId");
  exact(abiManifest?.coreId, `sha256:${actual.wasm?.sha256}`, "locked.abiManifest.coreId.actual");
  require(Array.isArray(buildInfo?.artifacts?.wasmSections) && buildInfo.artifacts.wasmSections.length > 0, "locked.buildInfo.artifacts.wasmSections");
  for (const [index, section] of (buildInfo?.artifacts?.wasmSections || []).entries()) {
    require(Number.isInteger(section?.id) && section.id >= 0, `locked.buildInfo.artifacts.wasmSections[${index}].id`);
    require(Number.isInteger(section?.size) && section.size >= 0, `locked.buildInfo.artifacts.wasmSections[${index}].size`);
    require(sha(section?.sha256), `locked.buildInfo.artifacts.wasmSections[${index}].sha256`);
  }

  return { verified: failures.length === 0, failures: [...new Set(failures)] };
}

export function assertServedArtifactIdentity(expectedArtifacts, servedArtifacts) {
  const names = Object.keys(expectedArtifacts || {});
  if (!names.length) throw new Error("No local application artifacts were provided for identity verification");
  const mismatches = [];
  for (const name of names) {
    const expected = expectedArtifacts[name];
    const served = servedArtifacts?.[name];
    if (!served) {
      mismatches.push(`${name}: missing from served origin`);
      continue;
    }
    if (expected.sha256 !== served.sha256 || expected.bytes !== served.bytes) {
      mismatches.push(
        `${name}: expected ${expected.sha256}/${expected.bytes}, got ${served.sha256}/${served.bytes}`
      );
    }
  }
  if (mismatches.length) throw new Error(`Served application identity mismatch: ${mismatches.join("; ")}`);
  return { verified: true, artifacts: servedArtifacts };
}

export function extractLocalModuleSpecifiers(source, relativePath) {
  const text = String(source || "");
  const specifiers = new Set();
  const extension = path.extname(relativePath).toLowerCase();
  const add = (specifier, allowBareRelative = false) => {
    if (!specifier || /^(?:[a-z]+:|#)/i.test(specifier)) return;
    if (!allowBareRelative && !specifier.startsWith(".") && !specifier.startsWith("/")) return;
    specifiers.add(specifier);
  };
  if (extension === ".html") {
    for (const match of text.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
      add(match[1], true);
    }
  } else {
    for (const match of text.matchAll(/\b(?:import|export)\s+(?:[^;"']*?\s+from\s*)?["']([^"']+)["']/g)) add(match[1]);
    for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) add(match[1]);
    for (const match of text.matchAll(/\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) add(match[1], true);
  }
  return [...specifiers].sort();
}

export function findFatalRuntimeEvidence({ consoleLines = [], statuses = [], renderer = {} }) {
  const evidence = [];
  const fatalPattern = /(?:webgpu[^\n]*(?:validation|device[ -]lost|uncaptured|real-clear error|show-image draw error|unavailable|\bfail(?:ed)?\b(?!\s*[:=]\s*0\b)|\bmissing\b(?!\s*[:=]\s*0\b)|threw|\berror\b(?!\s*[:=]\s*(?:0|none|<none>)\b))|emscripten abort|\baborted\(|webassembly\.(?:linkerror|runtimeerror)|(?:^|[^a-z])wasm[^\n]*(?:out of bounds|unreachable|abort|failed|error)|worker[^\n]*(?:uncaught|pageerror|rpc[^\n]*timed out)|status[^\n]*(?:failed|fatal))/i;
  const retainedStatuses = (renderer.statusHistory || []).map((entry) =>
    typeof entry === "string" ? entry : entry?.message
  );
  const retainedFatalStatuses = (renderer.fatalStatusHistory || []).map((entry) =>
    typeof entry === "string" ? entry : entry?.message
  );
  for (const line of [...consoleLines, ...statuses, ...retainedStatuses, ...retainedFatalStatuses]) {
    if (fatalPattern.test(String(line))) evidence.push(String(line));
  }
  for (const entry of renderer.errors || []) {
    if ([
      "validation",
      "uncaptured-error",
      "device-lost",
      "submit-error",
      "error-scope-failure",
      "real-clear-error",
      "show-image-draw-error",
      "wasm-link-error",
      "emscripten-abort",
    ].includes(entry.kind)) {
      evidence.push(`[renderer:${entry.kind}] ${entry.message}`);
    }
  }
  for (const line of renderer.emscriptenPrintErr || []) {
    if (fatalPattern.test(String(line))) evidence.push(`[emscripten-printErr] ${line}`);
  }
  if (
    renderer.requestedPresenterBackend === "webgpu" &&
    renderer.activePresenterBackend !== "webgpu" &&
    renderer.activePresenterBackend !== "wgpu-upload-probe"
  ) {
    evidence.push(
      `renderer fallback: requested presenter webgpu, active ${renderer.activePresenterBackend || "unknown"}`
    );
  }
  return [...new Set(evidence)];
}

export function parseBattleCheckpoint(framePayload) {
  const helper = String(framePayload?.ppcWasmHelperStats || "");
  const xfbHash = /\bvideo\s+xfb:\d+[^|]*\bhash:([0-9a-f]+)/i.exec(helper)?.[1]?.toLowerCase() || null;
  const loadedGeneration = Number(framePayload?.loadedCheckpointGeneration) || 0;
  const loadedTicks = Number(framePayload?.loadedCheckpointTicks);
  const loadedPpcPc = Number(framePayload?.loadedCheckpointPpcPc);
  const hasLoadedCheckpoint = loadedGeneration > 0 && Number.isFinite(loadedTicks) && Number.isFinite(loadedPpcPc);
  return {
    frame: Number(framePayload?.frame),
    coreTicks: hasLoadedCheckpoint ? loadedTicks : Number(framePayload?.coreTicks),
    ppcPc: hasLoadedCheckpoint ? loadedPpcPc : Number(framePayload?.ppcPc),
    checkpointObservationSource: hasLoadedCheckpoint ? "cpu-thread-after-load" : "legacy-worker-poll",
    loadedCheckpointGeneration: loadedGeneration,
    legacyCoreTicks: Number(framePayload?.coreTicks),
    legacyPpcPc: Number(framePayload?.ppcPc),
    xfbHash,
    width: Number(framePayload?.width),
    height: Number(framePayload?.height),
  };
}

export function assertBattleCheckpoint(checkpoint, expected = FIXED_MELEE_BATTLE_CHECKPOINT) {
  const required = ["frame", "coreTicks", "ppcPc", "xfbHash", "width", "height"];
  const missing = required.filter((field) => checkpoint?.[field] === null || checkpoint?.[field] === undefined || checkpoint?.[field] === "");
  if (missing.length) throw new Error(`Battle/XFB checkpoint is incomplete: ${missing.join(", ")}`);
  const coreTicksDeltaMin = Number.isFinite(Number(expected.coreTicksDeltaMin))
    ? Number(expected.coreTicksDeltaMin)
    : 0;
  const coreTicksDeltaMax = Number.isFinite(Number(expected.coreTicksDeltaMax))
    ? Number(expected.coreTicksDeltaMax)
    : 0;
  const coreTicksDelta = expected.coreTicks == null
    ? null
    : Number(checkpoint.coreTicks) - Number(expected.coreTicks);
  const mismatches = [];
  for (const field of required) {
    if (field === "coreTicks" && expected[field] != null) {
      if (
        !Number.isFinite(coreTicksDelta) ||
        coreTicksDelta < coreTicksDeltaMin ||
        coreTicksDelta > coreTicksDeltaMax
      ) {
        mismatches.push(
          `${field}: expected ${expected[field]}, got ${checkpoint[field]} ` +
          `(delta ${coreTicksDelta}, accepted ${coreTicksDeltaMin}..${coreTicksDeltaMax})`
        );
      }
    } else if (expected[field] != null && checkpoint[field] !== expected[field]) {
      mismatches.push(`${field}: expected ${expected[field]}, got ${checkpoint[field]}`);
    }
  }
  if (
    expected.checkpointObservationSource != null &&
    checkpoint.checkpointObservationSource !== expected.checkpointObservationSource
  ) {
    mismatches.push(
      `checkpointObservationSource: expected ${expected.checkpointObservationSource}, ` +
      `got ${checkpoint.checkpointObservationSource}`
    );
  }
  const minLoadedCheckpointGeneration = Number(expected.minLoadedCheckpointGeneration) || 0;
  if (Number(checkpoint.loadedCheckpointGeneration) < minLoadedCheckpointGeneration) {
    mismatches.push(
      `loadedCheckpointGeneration: expected >=${minLoadedCheckpointGeneration}, ` +
      `got ${checkpoint.loadedCheckpointGeneration}`
    );
  }
  if (mismatches.length) throw new Error(`Battle/XFB checkpoint mismatch: ${mismatches.join("; ")}`);
  return {
    ...checkpoint,
    expectedCoreTicks: expected.coreTicks ?? null,
    coreTicksDelta,
    coreTicksDeltaMin,
    coreTicksDeltaMax,
    verified: true,
  };
}

export function validateComparisonConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Comparison config must be a JSON object");
  }
  const mode = value.mode;
  if (mode !== "screening" && mode !== "confirmation") {
    throw new Error('Comparison mode must be "screening" or "confirmation"');
  }
  const blockCount = Number(value.blockCount ?? (mode === "screening" ? 2 : 5));
  if (!Number.isInteger(blockCount)) {
    throw new Error("Comparison blockCount must be an integer");
  }
  if (mode === "screening" && blockCount !== 2) {
    throw new Error("Screening is bounded to exactly 2 comparison blocks");
  }
  if (mode === "confirmation" && (blockCount < 5 || blockCount > 10)) {
    throw new Error("Confirmation requires 5 to 10 comparison blocks");
  }
  const maxBlockCount = Number(value.maxBlockCount ?? (mode === "confirmation" ? 10 : blockCount));
  if (!Number.isInteger(maxBlockCount) || maxBlockCount < blockCount || maxBlockCount > 10) {
    throw new Error("maxBlockCount must be an integer from blockCount through 10");
  }
  if (mode === "screening" && maxBlockCount !== 2) {
    throw new Error("Screening maxBlockCount is fixed at 2");
  }
  if (!value.armA?.name || !value.armB?.name) {
    throw new Error("Comparison config requires named armA and armB objects");
  }
  if (!value.primaryMetric || typeof value.primaryMetric !== "string") {
    throw new Error("Comparison config requires one primaryMetric path");
  }
  const direction = value.direction || "higher";
  if (direction !== "higher" && direction !== "lower") {
    throw new Error('Comparison direction must be "higher" or "lower"');
  }
  const minimumEffectPercent = Number(value.minimumEffectPercent ?? 3);
  if (!Number.isFinite(minimumEffectPercent) || minimumEffectPercent < 0) {
    throw new Error("minimumEffectPercent must be a non-negative number");
  }
  const overheadGate = normalizeOverheadGate(value.overheadGate);
  const stabilityGate = normalizeStabilityGate(value.stabilityGate);
  return {
    schemaVersion: 1,
    mode,
    blockCount,
    maxBlockCount,
    primaryMetric: value.primaryMetric,
    direction,
    minimumEffectPercent,
    overheadGate,
    stabilityGate,
    hypothesis: String(value.hypothesis || "").trim() || null,
    invalidationRules: Array.isArray(value.invalidationRules)
      ? value.invalidationRules.map(String)
      : [],
    stopRule:
      String(value.stopRule || "").trim() ||
      (mode === "screening"
        ? "Reject crashes, correctness failures, or absent/wrong-direction signal; never promote."
        : "Stop at 10 valid blocks and classify an unresolved interval INCONCLUSIVE."),
    armA: normalizeArm(value.armA, "A"),
    armB: normalizeArm(value.armB, "B"),
  };
}

export function buildComparisonTasklist(configValue) {
  const config = validateComparisonConfig(configValue);
  const blocks = [];
  for (let blockIndex = 0; blockIndex < config.maxBlockCount; blockIndex += 1) {
    const order = blockIndex % 2 === 0 ? ["A", "B", "B", "A"] : ["B", "A", "A", "B"];
    const block = makeComparisonBlock(config, blockIndex + 1, order);
    if (blockIndex >= config.blockCount) block.status = "conditional";
    blocks.push(block);
  }
  return {
    schemaVersion: 1,
    mode: config.mode,
    initialValidBlocks: config.blockCount,
    maximumValidBlocks: config.maxBlockCount,
    maximumAttemptedBlocks: Math.ceil(config.maxBlockCount / 0.8),
    primaryMetric: config.primaryMetric,
    direction: config.direction,
    minimumEffectPercent: config.minimumEffectPercent,
    overheadGate: config.overheadGate,
    stabilityGate: config.stabilityGate,
    hypothesis: config.hypothesis,
    invalidationRules: config.invalidationRules,
    stopRule: config.stopRule,
    blocks,
  };
}

export function buildReplacementBlock(configValue, invalidBlock, replacementNumber = 1) {
  const config = validateComparisonConfig(configValue);
  if (!invalidBlock?.order || invalidBlock.order.length !== 4) {
    throw new Error("Replacement requires the invalid four-run block and its original order");
  }
  const blockNumber = Number(invalidBlock.blockNumber);
  const replacement = makeComparisonBlock(config, blockNumber, [...invalidBlock.order]);
  replacement.blockId = `${invalidBlock.blockId}-replacement-${replacementNumber}`;
  replacement.replaces = invalidBlock.blockId;
  replacement.runs = replacement.runs.map((run, index) => ({
    ...run,
    runId: `${replacement.blockId}-run-${index + 1}`,
    blockId: replacement.blockId,
  }));
  return replacement;
}

export function summarizeComparison(configValue, runs) {
  const config = validateComparisonConfig(configValue);
  const byBlock = new Map();
  for (const run of runs || []) {
    if (!run?.blockId) continue;
    const group = byBlock.get(run.blockId) || [];
    group.push(run);
    byBlock.set(run.blockId, group);
  }
  const blocks = [];
  for (const [blockId, blockRuns] of byBlock) {
    const invalidReasons = blockRuns.flatMap((run) =>
      run.valid === false ? run.invalidReasons?.length ? run.invalidReasons : [`${run.runId}: invalid`] : []
    );
    const armA = blockRuns.filter((run) => run.arm === "A");
    const armB = blockRuns.filter((run) => run.arm === "B");
    if (blockRuns.length !== 4 || armA.length !== 2 || armB.length !== 2) {
      invalidReasons.push(`${blockId}: expected exactly two A and two B runs`);
    }
    invalidReasons.push(...evaluateWgpuUploadProbeWorkloadEquivalence(blockRuns)
      .map((reason) => `${blockId}: ${reason}`));
    invalidReasons.push(...evaluateFixedSceneMeasurementBoundaryEquivalence(blockRuns)
      .map((reason) => `${blockId}: ${reason}`));
    const valuesA = armA.map((run) => Number(readPath(run, config.primaryMetric)));
    const valuesB = armB.map((run) => Number(readPath(run, config.primaryMetric)));
    if ([...valuesA, ...valuesB].some((number) => !Number.isFinite(number))) {
      invalidReasons.push(`${blockId}: primary metric ${config.primaryMetric} is missing or non-numeric`);
    }
    const withinArmStability = {
      A: valuesA.length === 2 && valuesA.every(Number.isFinite)
        ? summarizeWithinArmSpread(valuesA)
        : null,
      B: valuesB.length === 2 && valuesB.every(Number.isFinite)
        ? summarizeWithinArmSpread(valuesB)
        : null,
    };
    if (config.stabilityGate) {
      for (const arm of ["A", "B"]) {
        const evidence = withinArmStability[arm];
        if (!evidence || !Number.isFinite(evidence.spreadPercent)) {
          invalidReasons.push(
            `${blockId}: primary metric ${config.primaryMetric} arm ${arm} ` +
            "within-arm spread is unavailable"
          );
        } else if (evidence.spreadPercent > config.stabilityGate.maximumWithinArmSpreadPercent) {
          invalidReasons.push(
            `${blockId}: primary metric ${config.primaryMetric} arm ${arm} ` +
            `within-arm spread ${evidence.spreadPercent.toFixed(3)}% exceeds maximum ` +
            `${config.stabilityGate.maximumWithinArmSpreadPercent}%`
          );
        }
      }
    }
    const initiallyValid = invalidReasons.length === 0;
    const meanA = initiallyValid ? mean(valuesA) : null;
    const meanB = initiallyValid ? mean(valuesB) : null;
    const rawEffect = initiallyValid ? meanB - meanA : null;
    const normalizedEffect = initiallyValid
      ? config.direction === "higher" ? rawEffect : -rawEffect
      : null;
    const effectPercent = initiallyValid
      ? meanA === 0 ? null : (normalizedEffect / Math.abs(meanA)) * 100
      : null;
    if (initiallyValid && !Number.isFinite(effectPercent)) {
      invalidReasons.push(`${blockId}: cannot compute relative effect from zero-valued arm A`);
    }
    let overheadRegressionPercent = null;
    const semanticWork = [];
    if (initiallyValid && config.overheadGate) {
      overheadRegressionPercent = Math.max(0, -effectPercent);
      if (overheadRegressionPercent >= config.overheadGate.maximumRegressionPercent) {
        invalidReasons.push(
          `${blockId}: overhead regression ${overheadRegressionPercent.toFixed(3)}% ` +
          `must be <${config.overheadGate.maximumRegressionPercent}%`
        );
      }
      for (const rule of config.overheadGate.semanticWork) {
        const workA = armA.map((run) => Number(readPath(run, rule.path)));
        const workB = armB.map((run) => Number(readPath(run, rule.path)));
        const values = [...workA, ...workB];
        const meanWorkA = values.every(Number.isFinite) ? mean(workA) : null;
        const meanWorkB = values.every(Number.isFinite) ? mean(workB) : null;
        const differencePercent = meanWorkA && meanWorkB != null
          ? (Math.max(...values) - Math.min(...values)) / Math.abs(meanWorkA) * 100
          : null;
        semanticWork.push({
          path: rule.path,
          meanA: meanWorkA,
          meanB: meanWorkB,
          differencePercent,
          maximumDifferencePercent: rule.maximumDifferencePercent,
        });
        if (!Number.isFinite(differencePercent) ||
            differencePercent > rule.maximumDifferencePercent) {
          invalidReasons.push(
            `${blockId}: semantic work ${rule.path} differs by ` +
            `${Number.isFinite(differencePercent) ? differencePercent.toFixed(3) : "unavailable"}% ` +
            `(max ${rule.maximumDifferencePercent}%)`
          );
        }
      }
    }
    const valid = invalidReasons.length === 0 && Number.isFinite(effectPercent);
    blocks.push({
      blockId,
      valid,
      invalidReasons,
      runIds: blockRuns.map((run) => run.runId),
      meanA,
      meanB,
      rawEffect,
      effectPercent: Number.isFinite(effectPercent) ? effectPercent : null,
      overheadRegressionPercent,
      semanticWork,
      withinArmStability,
    });
  }
  const validBlocks = blocks.filter((block) => block.valid);
  const invalidBlocks = blocks.filter((block) => !block.valid);
  const effects = validBlocks.map((block) => block.effectPercent);
  const medianEffectPercent = effects.length ? median(effects) : null;
  const interval95 = effects.length ? bootstrapMedianInterval(effects) : null;
  const permutationPValue = effects.length ? signPermutationPValue(effects) : null;
  const invalidRate = blocks.length ? invalidBlocks.length / blocks.length : 0;

  let outcome = "INCOMPLETE";
  if (blocks.length >= config.blockCount && invalidRate > 0.2) {
    outcome = "INFRASTRUCTURE_INCONCLUSIVE";
  } else if (validBlocks.length >= config.blockCount) {
    const clearsEffect = medianEffectPercent >= config.minimumEffectPercent;
    const excludesZero = interval95.low > 0;
    const exactPermutationPass = permutationPValue <= 0.05;
    const resolvedReject = interval95.high < config.minimumEffectPercent;
    if (config.mode === "screening") {
      outcome = clearsEffect && medianEffectPercent > 0 ? "SCREENING_SIGNAL" : "SCREENING_REJECT";
    } else if (clearsEffect && excludesZero && exactPermutationPass) {
      outcome = "STATISTICAL_GATE_PASS";
    } else if (resolvedReject && exactPermutationPass) {
      outcome = "STATISTICAL_GATE_REJECT";
    } else if (validBlocks.length < config.maxBlockCount) {
      outcome = "NEEDS_MORE_BLOCKS";
    } else {
      outcome = "INCONCLUSIVE";
    }
  }

  return {
    schemaVersion: 1,
    mode: config.mode,
    primaryMetric: config.primaryMetric,
    direction: config.direction,
    minimumEffectPercent: config.minimumEffectPercent,
    overheadGate: config.overheadGate,
    stabilityGate: config.stabilityGate,
    overheadGatePassed: config.overheadGate
      ? validBlocks.length >= config.blockCount && invalidBlocks.length === 0
      : null,
    initialValidBlocks: config.blockCount,
    maximumValidBlocks: config.maxBlockCount,
    attemptedBlocks: blocks.length,
    validBlockCount: validBlocks.length,
    invalidBlockCount: invalidBlocks.length,
    invalidBlockRate: invalidRate,
    medianEffectPercent,
    interval95,
    permutationPValue,
    outcome,
    statisticalGatePassed: config.mode === "confirmation" && outcome === "STATISTICAL_GATE_PASS",
    promotable: false,
    blocks,
  };
}

export function evaluateWgpuUploadProbeWorkloadEquivalence(runs = []) {
  const workloads = runs.map((run) => run?.uploadProbeWorkload ?? null);
  if (workloads.every((value) => value === null)) return [];
  const failures = [];
  if (workloads.some((value) => value === null)) {
    return ["upload-probe workload evidence is missing from one or more runs"];
  }
  const reference = workloads[0];
  for (const name of ["coreSha256", "saveStateSha256", "checkpointTicks", "checkpointPpcPc"]) {
    if (workloads.some((value) => value[name] !== reference[name])) {
      failures.push(`upload-probe ${name} differs across runs`);
    }
  }
  const numeric = (name) => workloads.map((value) => Number(value[name]));
  const requireFinite = (name, values) => {
    if (values.some((value) => !Number.isFinite(value))) {
      failures.push(`upload-probe ${name} is missing or non-numeric`);
      return false;
    }
    return true;
  };
  const ticks = numeric("actualCoreTickDelta");
  if (requireFinite("actualCoreTickDelta", ticks) && relativeSpread(ticks) > 0.0025) {
    failures.push("upload-probe core tick deltas differ by more than 0.25%");
  }
  for (const name of ["actualFrameDelta", "submissionCount"]) {
    const values = numeric(name);
    if (requireFinite(name, values) && Math.max(...values) - Math.min(...values) > 1) {
      failures.push(`upload-probe ${name} differs by more than one`);
    }
  }
  const frames = numeric("actualFrameDelta");
  if (requireFinite("actualFrameDelta", frames) && frames.every((value) => value > 0)) {
    for (const name of ["observedRecordCount", "totalUploadBytes"]) {
      const values = numeric(name);
      if (requireFinite(name, values)) {
        const perFrame = values.map((value, index) => value / frames[index]);
        if (relativeSpread(perFrame) > 0.005) {
          failures.push(`upload-probe ${name} per frame differs by more than 0.5%`);
        }
      }
    }
    const semanticOps = [6, 8, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24];
    const histograms = workloads.map((value) => value.opHistogram);
    if (histograms.some((value) => !Array.isArray(value) || value.length !== 25)) {
      failures.push("upload-probe opcode histograms are missing");
    } else {
      for (const op of semanticOps) {
        const perFrame = histograms.map((histogram, index) => Number(histogram[op]) / frames[index]);
        if (perFrame.some((value) => !Number.isFinite(value)) || relativeSpread(perFrame) > 0.005) {
          failures.push(`upload-probe opcode ${op} per frame differs by more than 0.5%`);
        }
      }
    }
  }
  const digestLists = workloads.map((value) => value.submitDigests);
  if (digestLists.some((value) => !Array.isArray(value) || value.length === 0)) {
    failures.push("upload-probe submit digests are missing");
  } else {
    const expected = digestLists[0][0];
    if (digestLists.some((value) => value[0] !== expected)) {
      failures.push("upload-probe initial submit structure differs across runs");
    }
  }
  return failures;
}

export function evaluateFixedSceneMeasurementBoundaryEquivalence(runs = []) {
  const required = runs.some(
    (run) => run?.fixedEmulatedWork?.enabled === true || run?.fixedSceneMeasurementBoundary != null
  );
  if (!required) return [];
  const signatures = runs.map((run) => run?.fixedSceneMeasurementBoundary?.signature ?? null);
  if (signatures.some((signature) => signature === null)) {
    return ["fixed-scene signature is missing from one or more fixed-work runs"];
  }
  const failures = [];
  const reference = signatures[0];
  for (const field of ["coreTicks", "ppcPc", "xfbHash", "width", "height"]) {
    if (reference?.[field] == null) {
      failures.push(`fixed-scene ${field} is missing`);
    } else if (signatures.some((signature) => signature?.[field] !== reference[field])) {
      failures.push(`fixed-scene ${field} differs across runs`);
    }
  }
  return failures;
}

function relativeSpread(values) {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const scale = Math.max(Math.abs(maximum), Math.abs(minimum));
  return scale === 0 ? 0 : (maximum - minimum) / scale;
}

export function summarizeNumeric(values) {
  const sorted = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return {
    count: sorted.length,
    min: sorted[0],
    mean: mean(sorted),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted.at(-1),
  };
}

export function summarizeTimedMetricWindows(samples, steadyAfterSeconds) {
  const timedSamples = samples || [];
  const steadySamples = timedSamples.filter(
    (sample) => Number(sample.elapsedSeconds) >= Number(steadyAfterSeconds)
  );
  const summarize = (windowSamples) => ({
    gameSpeed: summarizeNumeric(windowSamples.map((sample) => numericValue(sample.gameSpeed))),
    coreFps: summarizeNumeric(windowSamples.map((sample) => numericValue(sample.coreFps))),
    presentationFps: summarizeNumeric(windowSamples.map((sample) => numericValue(sample.presentFps))),
    visualFps: summarizeNumeric(windowSamples.map((sample) => numericValue(sample.visualFps))),
  });
  return {
    fullTimedWindow: {
      startsAtSeconds: 0,
      sampleCount: timedSamples.length,
      metrics: summarize(timedSamples),
    },
    steadyStateWindow: {
      startsAfterSeconds: Number(steadyAfterSeconds),
      sampleCount: steadySamples.length,
      metrics: summarize(steadySamples),
    },
  };
}

export function summarizeCausalFairness(samples = [], { expectedInputEvents = 0 } = {}) {
  const timed = (samples || []).filter(Boolean);
  const first = timed[0] || {};
  const last = timed.at(-1) || {};
  const delta = (field) => {
    const before = Number(first[field]);
    const after = Number(last[field]);
    return Number.isFinite(before) && Number.isFinite(after) ? after - before : null;
  };
  const maximum = (field) => {
    const values = timed.map((sample) => Number(sample[field])).filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
  };
  const audioCounterFields = {
    workerMixCount: "causalAudioWorkerMixCount",
    workerRequestedFrames: "causalAudioWorkerRequestedFrames",
    workerReturnedFrames: "causalAudioWorkerReturnedFrames",
    workerEmptyMixCount: "causalAudioWorkerEmptyMixCount",
    pumpCount: "causalAudioPumpCount",
    pumpPendingSkipCount: "causalAudioPumpPendingSkipCount",
    pumpMissCount: "causalAudioPumpMissCount",
    underrunCount: "causalAudioUnderruns",
    overrunCount: "causalAudioOverruns",
  };
  const audioMaximumFields = {
    workerMixMaxMs: "causalAudioWorkerMixMaxMs",
    pumpGapMaxMs: "causalAudioPumpGapMaxMs",
    mixRoundTripMaxMs: "causalAudioMixRoundTripMaxMs",
  };
  const stageFields = {
    applied: "causalInputMarkerAppliedCount",
    polled: "causalInputMarkerExactCorePollCount",
    armed: "causalInputMarkerArmedCount",
    submitted: "causalInputMarkerSubmittedCount",
    completed: "causalInputMarkerCompletedCount",
  };
  const errorFields = {
    supersededCount: "causalInputMarkerSupersededCount",
    supersededArmedCount: "causalInputMarkerSupersededArmedCount",
    droppedInFlightCount: "causalInputMarkerDroppedInFlightCount",
    generationMismatchCount: "causalInputMarkerGenerationMismatchCount",
    generationUnavailableCount: "causalInputMarkerGenerationUnavailableCount",
    expiredCount: "causalInputMarkerExpiredCount",
    expiredInFlightCount: "causalInputMarkerExpiredInFlightCount",
  };
  const mapDeltas = (fields) => Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name, delta(field)])
  );
  const mapValues = (source, fields) => Object.fromEntries(
    Object.entries(fields).map(([name, field]) => {
      const value = Number(source[field]);
      return [name, Number.isFinite(value) ? value : null];
    })
  );
  const audioDeltas = mapDeltas(audioCounterFields);
  const stageDeltas = mapDeltas(stageFields);
  const errorDeltas = mapDeltas(errorFields);
  const gpuErrors = {
    wgpuErrorCount: delta("causalWgpuErrorCount"),
    gpuCompletionFailedCount: delta("causalGpuCompletionFailedCount"),
  };
  const expected = Math.max(0, Math.trunc(Number(expectedInputEvents) || 0));
  const requiredParityStages = ["applied", "polled", "submitted", "completed"];
  const parityPassed = expected === 0 || (
    last.causalInputMarkerEnabled === true &&
    requiredParityStages.every((name) => stageDeltas[name] === expected)
  );
  const failures = [];
  const validateDecisionDelta = (label, value) => {
    if (value === null) {
      failures.push(`missing ${label} counter delta`);
      return false;
    }
    if (value < 0) {
      failures.push(`reset ${label} counter delta=${value}`);
      return false;
    }
    return true;
  };
  validateDecisionDelta("audio empty-mix", audioDeltas.workerEmptyMixCount);
  validateDecisionDelta("WebAudio underrun", audioDeltas.underrunCount);
  for (const [name, value] of Object.entries(errorDeltas)) {
    validateDecisionDelta(`input marker ${name}`, value);
  }
  validateDecisionDelta("WGPU error", gpuErrors.wgpuErrorCount);
  validateDecisionDelta("GPU completion error", gpuErrors.gpuCompletionFailedCount);
  if (audioDeltas.workerEmptyMixCount > 0) {
    failures.push(`audio empty mixes=${audioDeltas.workerEmptyMixCount}`);
  }
  if (audioDeltas.underrunCount > 0) {
    failures.push(`new WebAudio underruns=${audioDeltas.underrunCount}`);
  }
  if (!parityPassed) {
    failures.push(
      `input marker parity expected=${expected} applied=${stageDeltas.applied} ` +
      `polled=${stageDeltas.polled} armed=${stageDeltas.armed} ` +
      `submitted=${stageDeltas.submitted} completed=${stageDeltas.completed}`
    );
  }
  for (const [name, value] of Object.entries(errorDeltas)) {
    if (value > 0) failures.push(`input marker ${name}=${value}`);
  }
  if (gpuErrors.wgpuErrorCount > 0) failures.push(`WGPU errors=${gpuErrors.wgpuErrorCount}`);
  if (gpuErrors.gpuCompletionFailedCount > 0) {
    failures.push(`GPU completion errors=${gpuErrors.gpuCompletionFailedCount}`);
  }
  return {
    sampleCount: timed.length,
    audio: {
      deltas: audioDeltas,
      counterWindow: {
        boundary: "first-timed-sample-to-final-timed-sample",
        baseline: mapValues(first, audioCounterFields),
        final: mapValues(last, audioCounterFields),
        excludedBeforeTimedBaseline: mapValues(first, audioCounterFields),
      },
      extrema: {
        ...Object.fromEntries(
          Object.entries(audioMaximumFields).map(([name, field]) => [name, maximum(field)])
        ),
        scheduleLeadMinSeconds: summarizeNumeric(
          timed.map((sample) => sample.causalAudioScheduleLeadSeconds)
        )?.min ?? null,
        scheduleLeadMaxSeconds: maximum("causalAudioScheduleLeadSeconds"),
        scheduleDriftMinSeconds: summarizeNumeric(
          timed.map((sample) => sample.causalAudioScheduleDriftSeconds)
        )?.min ?? null,
        scheduleDriftMaxSeconds: maximum("causalAudioScheduleDriftSeconds"),
      },
    },
    inputMarker: {
      expectedCount: expected,
      enabled: last.causalInputMarkerEnabled === true,
      stageDeltas,
      errorDeltas,
      final: {
        pendingGeneration: Number(last.causalInputMarkerPendingGeneration) || 0,
        activeGeneration: Number(last.causalInputMarkerActiveGeneration) || 0,
        inFlightCount: Number(last.causalInputMarkerInFlightCount) || 0,
      },
      parityPassed,
    },
    gpuErrors,
    failures,
  };
}

export function classifyGateOutcome({
  failureCount = 0,
  qualificationEligible = false,
  comparisonMode = null,
  statisticalGatePassed = false,
  targetPassed = false,
}) {
  if (failureCount > 0) {
    return { verdict: "FAIL", exitCode: 1, qualificationPassed: false, promotable: false };
  }
  const experimentEligible = comparisonMode == null
    ? true
    : comparisonMode === "confirmation" && statisticalGatePassed;
  const qualificationPassed = Boolean(qualificationEligible && targetPassed && experimentEligible);
  if (!qualificationPassed) {
    return { verdict: "NON_QUALIFYING", exitCode: 2, qualificationPassed: false, promotable: false };
  }
  return {
    verdict: "PASS",
    exitCode: 0,
    qualificationPassed: true,
    promotable: comparisonMode === "confirmation" && statisticalGatePassed,
  };
}

export function evaluateRunValidity({ invalidReasons = [], failures = [], consoleErrors = [] }) {
  const reasons = [
    ...invalidReasons,
    ...failures.map((failure) => `run failure: ${failure}`),
    ...consoleErrors.map((error) => `console error: ${error}`),
  ].filter(Boolean);
  const uniqueReasons = [...new Set(reasons)];
  return { valid: uniqueReasons.length === 0, invalidReasons: uniqueReasons };
}

export function summarizeJitMetrics(samples = []) {
  const maximumField = (name) => Math.max(0, ...samples.map((sample) => Number(sample?.[name]) || 0));
  const maximumHelper = (pattern) => {
    let maximum = 0;
    for (const sample of samples) {
      const match = pattern.exec(String(sample?.helper || ""));
      if (match) maximum = Math.max(maximum, Number(match[1]) || 0);
    }
    return maximum;
  };
  const exportedCompileCount = maximumField("ppcWasmBlockCompileCount");
  const exportedRunCount = maximumField("ppcWasmBlockRunCount");
  const helperAttemptCount = maximumHelper(/\bjit attempts:(\d+)/);
  const helperCompileCount = maximumHelper(/\bcompiled:(\d+)/);
  const emitFailureCount = maximumHelper(/\bemitfail:(\d+)/);
  const compileFailureCount = maximumHelper(/\bcompilefail:(\d+)/);
  const activeSampleCount = samples.filter((sample) => /\bjit:on\b/.test(String(sample?.helper || ""))).length;
  return {
    exportedCompileCount,
    exportedRunCount,
    helperAttemptCount,
    helperCompileCount,
    emitFailureCount,
    compileFailureCount,
    activeSampleCount,
    runToCompileRatio: exportedCompileCount > 0 ? exportedRunCount / exportedCompileCount : null,
    countersConsistent: exportedCompileCount === helperCompileCount,
  };
}

export function evaluateMetricsModeEvidence({ requested, diagnostics = {}, samples = [] } = {}) {
  const enabled = String(requested) === "1";
  const failures = [];
  const counters = ["helperStatsCalls", "profileStatsCalls", "profileTimeSamples"];
  if (diagnostics.enabled !== enabled) {
    failures.push(`requested metrics=${enabled ? 1 : 0}, renderer reported enabled=${diagnostics.enabled}`);
  }
  for (const name of counters) {
    const value = Number(diagnostics[name]);
    if (enabled ? !(value > 0) : value !== 0) {
      failures.push(`metrics=${enabled ? 1 : 0} activation mismatch: ${name}=${diagnostics[name]}`);
    }
  }
  const marker = `metrics:${enabled ? "on" : "off"}`;
  if (!samples.some((sample) => String(sample.helper || "").includes(marker))) {
    failures.push(`metrics=${enabled ? 1 : 0} activation marker ${marker} was not sampled`);
  }
  if (enabled) {
    if (samples.some((sample) => sample.causalTelemetrySchemaVersion !== CAUSAL_TELEMETRY_SCHEMA_VERSION)) {
      failures.push(
        `missing or unsupported causal telemetry schema (expected ${CAUSAL_TELEMETRY_SCHEMA_VERSION})`
      );
    }
  } else if (
    samples.some(
      (sample) => sample.causalTelemetrySchemaVersion != null || sample.causalTelemetry != null
    )
  ) {
    failures.push("metrics=0 activation mismatch: causal telemetry was present");
  }
  return { enabled, failures };
}

export function evaluateSoftwareRasterInstrumentationEvidence({ required = false, samples = [] } = {}) {
  if (!required) return { required: false, activated: false, maxima: {}, failures: [] };

  const rasterSamples = samples
    .map((sample) => sample?.causalTelemetry?.softwareRaster)
    .filter((value) => value && typeof value === "object");
  const fields = [
    "rasterTraversalCount",
    "rasterTraversalTimedSampleCount",
    "tevPixelCount",
    "tevTimedSampleCount",
    "textureSampleCount",
    "textureTimedSampleCount",
    "fifoAgeSampleCount",
    "xfbGenerationCount",
    "frameGenerationCount",
    "sampledSourceFrameCount",
  ];
  const maxima = Object.fromEntries(
    fields.map((field) => [
      field,
      Math.max(0, ...rasterSamples.map((sample) => Number(sample[field]) || 0)),
    ])
  );
  const missing = fields.filter((field) => !(maxima[field] > 0));
  const profileEnabled = rasterSamples.some((sample) => sample.profileEnabled === true);
  const failures = [];
  if (!profileEnabled) failures.push("software raster profileEnabled=true was not sampled");
  if (missing.length) failures.push(`software raster counters did not activate: ${missing.join(", ")}`);
  return {
    required: true,
    activated: profileEnabled && missing.length === 0,
    maxima,
    failures,
  };
}

export async function collectRunMetadata({
  root,
  url,
  browserName,
  browserChannel,
  browserVersion,
  browserExecutable,
  headed,
  durationSeconds,
  sampleMs,
  screenshotEverySeconds,
  captureScreenshots,
  showDebugPanel,
  romPath,
  hashRom = true,
  corePath,
  saveStateUrl,
  saveStatePath,
  saveStateAt,
  inputScript,
  sceneLabel,
  artifactDescriptions = {},
  startedAt = new Date().toISOString(),
}) {
  const dirtyPaths = (git(root, ["status", "--porcelain=v1"]) || "")
    .split(/\r?\n/)
    .filter(Boolean);
  const cpuModels = [...new Set(os.cpus().map((cpu) => cpu.model.trim()).filter(Boolean))];
  const [rom, core, saveState] = await Promise.all([
    artifactDescriptions.rom || describeFile(romPath, { hash: hashRom }),
    artifactDescriptions.core || describeFile(corePath, { hash: true }),
    artifactDescriptions.saveState || describeFile(saveStatePath, { hash: true }),
  ]);

  return {
    schemaVersion: 1,
    startedAt,
    finishedAt: null,
    git: {
      commit: git(root, ["rev-parse", "HEAD"]),
      branch: git(root, ["branch", "--show-current"]),
      dirty: dirtyPaths.length > 0,
      dirtyPaths,
    },
    runtime: {
      node: process.version,
      argv: process.argv.slice(1),
    },
    machine: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuModels,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    browser: {
      name: browserName,
      channel: browserChannel || null,
      version: browserVersion || null,
      executable: browserExecutable ? path.basename(browserExecutable) : null,
      headed: Boolean(headed),
    },
    benchmark: {
      url,
      durationSeconds,
      sampleMs,
      screenshotEverySeconds,
      captureScreenshots: Boolean(captureScreenshots),
      showDebugPanel: Boolean(showDebugPanel),
      sceneLabel: sceneLabel || null,
      saveStateUrl: saveStateUrl || null,
      saveStateAt: saveStateUrl ? saveStateAt : null,
      inputScriptSha256: createHash("sha256").update(String(inputScript || "")).digest("hex"),
    },
    artifacts: {
      rom,
      core,
      saveState,
    },
  };
}

export function resolveCoreArtifactPath(root, urlValue) {
  const requested = new URL(urlValue, "http://127.0.0.1/")
    .searchParams.get("coreid")
    ?.toLowerCase()
    .replace(/^sha256:/, "") ?? "";
  if (!requested) {
    return path.join(root, "cores", "dolphin", "dolphin-core-upstream.wasm");
  }
  if (!/^[0-9a-f]{64}$/.test(requested)) {
    throw new Error("coreid must be a SHA-256 content hash");
  }
  return path.join(
    root,
    "build",
    "core-candidates",
    requested,
    "dolphin-core-upstream.wasm"
  );
}

export function selectedCoreServedPaths(root, wasmPath) {
  const relative = path.relative(root, wasmPath).replaceAll("\\", "/");
  if (relative === "cores/dolphin/dolphin-core-upstream.wasm") {
    return {
      js: "cores/dolphin/dolphin-core-upstream.js",
      wasm: relative,
      prebuilt: "cores/dolphin/prebuilt-jit-cache.bin",
    };
  }
  const match = /^build\/core-candidates\/([0-9a-f]{64})\/dolphin-core-upstream\.wasm$/i.exec(relative);
  if (!match) throw new Error(`Selected core is outside a supported served location: ${relative}`);
  const prefix = `build/core-candidates/${match[1].toLowerCase()}`;
  return {
    js: `${prefix}/dolphin-core-upstream.js`,
    wasm: `${prefix}/dolphin-core-upstream.wasm`,
    prebuilt: `${prefix}/prebuilt-jit-cache.bin`,
  };
}

export function evaluatePrebuiltJitCacheEvidence({
  evidence,
  expectedSha256,
  manifestEntry,
  requireManifestEntry = false,
} = {}) {
  const expected = String(expectedSha256 || "").toLowerCase().replace(/^sha256:/, "");
  const failures = [];
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    failures.push("selected prebuilt expected WASM SHA-256 is invalid");
  }
  const expectedFingerprint = /^[0-9a-f]{64}$/.test(expected)
    ? canonicalCoreFingerprint(expected)
    : null;
  if (!evidence) {
    failures.push("selected prebuilt cache evidence is missing");
  } else {
    if (!/^[0-9a-f]{64}$/.test(String(evidence.sha256 || ""))) {
      failures.push("selected prebuilt cache SHA-256 is invalid");
    }
    if (!(Number(evidence.bytes) > 0)) failures.push("selected prebuilt cache size is invalid");
    if (evidence.fingerprint !== expectedFingerprint) {
      failures.push(
        `selected prebuilt fingerprint mismatch: expected=${expectedFingerprint || "invalid"} ` +
        `actual=${evidence.fingerprint || "missing"}`
      );
    }
    if (evidence.entryKeySchema !== JIT_CACHE_ENTRY_KEY_SCHEMA) {
      failures.push("selected prebuilt entry-key schema mismatch");
    }
    if (!Number.isSafeInteger(evidence.entryCount) || evidence.entryCount <= 0) {
      failures.push("selected prebuilt entry count is invalid");
    }
    if (evidence.entriesVerified !== true) {
      failures.push("selected prebuilt entry payload verification is missing");
    }
  }
  if (requireManifestEntry && !manifestEntry) {
    failures.push("selected prebuilt candidate manifest entry is missing");
  } else if (manifestEntry) {
    for (const [field, label] of [
      ["sha256", "hash"],
      ["bytes", "size"],
      ["fingerprint", "fingerprint"],
      ["entryKeySchema", "entry-key schema"],
      ["entryCount", "entry count"],
      ["entriesVerified", "entry payload verification"],
    ]) {
      if (manifestEntry[field] !== evidence?.[field]) {
        failures.push(`selected prebuilt manifest ${label} mismatch`);
      }
    }
  }
  return {
    verified: failures.length === 0,
    evidence: evidence ?? null,
    failures,
  };
}

export function parseProfileMetrics(helper = "", frameProfile = "") {
  const core = /\bcoreprof\s+xfb_dt:([\d.]+)\s+avg:([\d.]+)\s+max:([\d.]+)\s+decode:([\d.]+)\s+avg:([\d.]+)\s+max:([\d.]+)\s+vo_sync:([\d.]+)\/max([\d.]+)\s+vo_pub:([\d.]+)\/max([\d.]+)\s+vo_total:([\d.]+)\/max([\d.]+)\s+swxfb:([\d.]+)\s+conv:([\d.]+)\s+copy:([\d.]+)/.exec(helper);
  const frame = /\bloop:([\d.]+)\s+pump:([\d.]+)\s+run:([\d.]+)\s+api:([\d.]+)\s+cap:([\d.]+)\s+copy:([\d.]+)\s+present:([\d.]+)\s+draw:([\d.]+)\s+hash:([\d.]+)\s+paced:([\d.]+)\s+copy:([\d.]+)MB\/s\s+cap:(\d+)\s+shown:(\d+)/.exec(frameProfile);
  const number = (match, index) => (match ? Number(match[index]) : null);

  return {
    coreXfbIntervalMs: number(core, 1),
    coreXfbAverageIntervalMs: number(core, 2),
    coreXfbMaxIntervalMs: number(core, 3),
    coreXfbDecodeMs: number(core, 4),
    coreXfbAverageDecodeMs: number(core, 5),
    coreXfbMaxDecodeMs: number(core, 6),
    videoOutputSyncMs: number(core, 7),
    videoOutputMaxSyncMs: number(core, 8),
    videoOutputPublishMs: number(core, 9),
    videoOutputMaxPublishMs: number(core, 10),
    videoOutputTotalMs: number(core, 11),
    videoOutputMaxTotalMs: number(core, 12),
    softwareXfbTotalMs: number(core, 13),
    softwareXfbConvertMs: number(core, 14),
    softwareXfbCopyMs: number(core, 15),
    jsLoopMs: number(frame, 1),
    jsPumpMs: number(frame, 2),
    jsRunMs: number(frame, 3),
    jsApiMs: number(frame, 4),
    jsCaptureMs: number(frame, 5),
    jsCopyMs: number(frame, 6),
    jsPresentMs: number(frame, 7),
    jsDrawMs: number(frame, 8),
    jsHashMs: number(frame, 9),
    jsPacedMs: number(frame, 10),
    jsCopyMegabytesPerSecond: number(frame, 11),
    jsCaptureCount: number(frame, 12),
    jsPresentCount: number(frame, 13),
  };
}

export function recordsToCsv(records) {
  if (!records?.length) return "";
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const lines = [columns.map(csvCell).join(",")];
  for (const record of records) {
    lines.push(columns.map((column) => csvCell(record[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function evaluateCoreSelectionEvidence({ url, artifactSha256, diagnostics } = {}) {
  const requested = new URL(url, "http://127.0.0.1/")
    .searchParams.get("coreid")
    ?.toLowerCase()
    .replace(/^sha256:/, "") ?? "";
  const expected = requested || String(artifactSha256 || "").toLowerCase();
  const selection = diagnostics?.coreSelection || {};
  const normalize = (value) => String(value || "").toLowerCase().replace(/^sha256:/, "");
  const failures = [];

  if (!/^[0-9a-f]{64}$/.test(expected)) {
    failures.push("expected core SHA-256 is unavailable or invalid");
    return { expectedSha256: expected || null, selection, failures };
  }
  if (normalize(artifactSha256) !== expected) {
    failures.push(
      `core artifact SHA-256 mismatch: requested=${expected} ` +
      `artifact=${normalize(artifactSha256) || "unavailable"}`
    );
  }
  for (const [field, label] of [
    ["requestedCoreSha256", "runtime requested"],
    ["activeCoreSha256", "runtime active"],
  ]) {
    const observed = normalize(selection[field]);
    if (observed !== expected) {
      failures.push(
        `core selection SHA-256 mismatch: expected=${expected} ${label}=${observed || "unavailable"}`
      );
    }
  }
  if (selection.fallbackReason) {
    failures.push(`core selection unexpectedly fell back: ${selection.fallbackReason}`);
  }
  return { expectedSha256: expected, selection, failures };
}

export function evaluateCandidateCoreBundle({ manifest, expectedSha256, files } = {}) {
  const expected = String(expectedSha256 || "").toLowerCase().replace(/^sha256:/, "");
  const failures = [];
  if (manifest?.schemaVersion !== 1) failures.push("candidate manifest schemaVersion=1");
  if (manifest?.coreId !== `sha256:${expected}`) failures.push("candidate manifest coreId matches selected core");
  const declared = new Map((manifest?.files || []).map((entry) => [entry?.name, entry?.sha256]));
  for (const [name, actualSha256] of Object.entries(files || {})) {
    if (declared.get(name) !== actualSha256) {
      failures.push(`candidate manifest hash mismatch: ${name}`);
    }
  }
  if (declared.get("dolphin-core-upstream.wasm") !== expected) {
    failures.push("candidate manifest WASM hash matches selected core");
  }
  if (manifest?.buildInfoSha256 !== declared.get("dolphin-core-upstream.build.json")) {
    failures.push("candidate manifest buildInfoSha256 matches bundled build info");
  }
  return { verified: failures.length === 0, failures };
}

export function evaluateWgpuGeometryRangeEvidence({ requested, telemetry } = {}) {
  if (requested == null) return { required: false, failures: [] };
  const expectedActive = String(requested) === "1";
  const enabled = telemetry?.geometryRangeEnabled;
  const available = telemetry?.producerGeometryRangeAvailable;
  const failures = [];
  if (enabled !== expectedActive || (expectedActive && available !== true)) {
    failures.push(
      `WGPU geometry range mismatch: requested=${expectedActive ? 1 : 0} ` +
      `active=${enabled == null ? "unavailable" : enabled ? 1 : 0} ` +
      `producerAvailable=${available == null ? "unavailable" : available ? 1 : 0}`
    );
  }
  return { required: true, expectedActive, enabled, available, failures };
}

export function evaluateWgpuSemanticQualificationEvidence({
  requested,
  telemetry,
  loadedCheckpointGeneration,
} = {}) {
  if (requested == null) return { required: false, failures: [] };
  const expectedActive = String(requested) === "1";
  const failures = [];
  if (!expectedActive) {
    if (String(requested) !== "0") {
      failures.push(`wgpusemantic=${requested} is unsupported`);
    }
    return { required: false, expectedActive, failures };
  }

  const semantic = telemetry?.semanticRuntime;
  const currentLoadedGeneration = Number(loadedCheckpointGeneration);
  const capturedLoadedGeneration = Number(semantic?.loadedCheckpointGeneration);
  const loadEpochCount = Number(semantic?.loadEpochCount);
  const currentEpochCommittedEventCount = Number(
    semantic?.currentEpochCommittedEventCount
  );
  const minimumCommittedEventCount = Number(semantic?.minimumCommittedEventCount);

  if (semantic?.requested !== true || semantic?.active !== true) {
    failures.push("WGPU semantic runtime was not active when requested");
  }
  if (semantic?.captureComplete !== true) {
    failures.push("WGPU semantic capture did not complete");
  }
  if (semantic?.evidenceValid !== true || semantic?.failed === true) {
    failures.push("WGPU semantic capture evidence is invalid");
  }
  if (!Number.isSafeInteger(currentLoadedGeneration) || currentLoadedGeneration < 1) {
    failures.push("WGPU semantic qualification has no loaded core checkpoint");
  }
  if (!Number.isSafeInteger(capturedLoadedGeneration) || capturedLoadedGeneration < 1) {
    failures.push("WGPU semantic capture did not record a loaded checkpoint generation");
  } else if (
    Number.isSafeInteger(currentLoadedGeneration) &&
    currentLoadedGeneration >= 1 &&
    capturedLoadedGeneration !== currentLoadedGeneration
  ) {
    failures.push(
      `WGPU semantic checkpoint generation mismatch: capture=${capturedLoadedGeneration} ` +
      `current=${currentLoadedGeneration}`
    );
  }
  if (!Number.isSafeInteger(loadEpochCount) || loadEpochCount < 1) {
    failures.push(
      `WGPU semantic capture observed no load epoch: loadEpochCount=${
        Number.isFinite(loadEpochCount) ? loadEpochCount : "unavailable"
      }`
    );
  }
  if (
    !Number.isSafeInteger(minimumCommittedEventCount) ||
    minimumCommittedEventCount < 1 ||
    !Number.isSafeInteger(currentEpochCommittedEventCount) ||
    currentEpochCommittedEventCount < minimumCommittedEventCount
  ) {
    failures.push(
      `WGPU semantic current epoch is below its committed-event minimum: ` +
      `current=${Number.isFinite(currentEpochCommittedEventCount)
        ? currentEpochCommittedEventCount
        : "unavailable"} ` +
      `minimum=${Number.isFinite(minimumCommittedEventCount)
        ? minimumCommittedEventCount
        : "unavailable"}`
    );
  }
  if (semantic?.qualificationReady !== true) {
    failures.push("WGPU semantic post-load qualification is not ready");
  }

  return {
    required: true,
    expectedActive,
    semantic,
    loadedCheckpointGeneration: currentLoadedGeneration,
    failures,
  };
}

export function parseWgpuTailGateStats(text = "") {
  const parsed = parseTailGateWire(text);
  if (!parsed) return null;
  return {
    wgpuTailGateSchema: WGPU_TAIL_GATE_SCHEMA,
    wgpuTailGateSchemaVersion: WGPU_TAIL_GATE_SCHEMA_VERSION,
    wgpuTailGateEnabled: parsed.enabled,
    wgpuTailGateEpoch: parsed.epoch,
    wgpuTailGatePeriod: parsed.period,
    wgpuTailGatePayloadSamples: parsed.payloadSamples,
    wgpuTailGateFlushNeededSamples: parsed.flushNeededSamples,
    wgpuTailGateRefreshNeededSamples: parsed.refreshNeededSamples,
    wgpuTailGateBothCleanSamples: parsed.bothCleanSamples,
    wgpuTailGateDirtyAtSkip: parsed.dirtyAtSkip,
  };
}

export function evaluateWgpuSparseUboEvidence({ requested, samples = [] } = {}) {
  if (requested == null) return { required: false, failures: [] };
  const expectedActive = String(requested) === "1";
  const failures = [];
  if (!expectedActive && String(requested) !== "0") {
    failures.push(`wgpuubosparse=${requested} is unsupported`);
  }
  const observations = samples.map(
    (sample) => sample?.causalTelemetry?.webgpu?.uboSparse ?? null
  );
  if (!observations.length) failures.push("WGPU sparse UBO has no timed samples");
  const counters = [
    "eligibleCalls", "baselineCalls", "sparseCalls", "equalCalls",
    "fullFallbackCalls", "capacityMisses", "fullBytes", "stagedBytes",
    "avoidedStagedBytes", "copyForwardBytes", "overlayRanges", "overlayBytes",
    "predictedGpuCopyBytes", "invalidations",
  ];
  const vectorCounters = ["callsByClass", "sparseCallsByClass", "stagedBytesByClass"];
  const valid = [];
  let previous = null;
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    if (!observation || typeof observation !== "object") {
      failures.push(`WGPU sparse UBO sample ${index} is missing or malformed`);
      continue;
    }
    valid.push(observation);
    if (observation.schema !== WGPU_SPARSE_UBO_SCHEMA) {
      failures.push(`WGPU sparse UBO sample ${index} schema mismatch`);
    }
    if (observation.requested !== expectedActive) {
      failures.push(`WGPU sparse UBO sample ${index} requested state mismatch`);
    }
    if (observation.active !== expectedActive) {
      failures.push(`WGPU sparse UBO sample ${index} active state mismatch`);
    }
    if (!Number.isSafeInteger(observation.instanceId) || observation.instanceId < 0 ||
        (expectedActive && observation.instanceId === 0)) {
      failures.push(`WGPU sparse UBO sample ${index} instanceId is invalid`);
    }
    if (observation.coverageThreshold !== 0.5) {
      failures.push(`WGPU sparse UBO sample ${index} coverage threshold mismatch`);
    }
    if (observation.maxSparseRanges !== 0) {
      failures.push(`WGPU sparse UBO sample ${index} maxSparseRanges mismatch`);
    }
    if (JSON.stringify(observation.classOrder) !== JSON.stringify(["vs", "ps", "gs"]) ||
        JSON.stringify(observation.classSizes) !== JSON.stringify([4112, 1536, 64])) {
      failures.push(`WGPU sparse UBO sample ${index} class schema mismatch`);
    }
    for (const name of counters) {
      if (!Number.isSafeInteger(observation[name]) || observation[name] < 0) {
        failures.push(`WGPU sparse UBO sample ${index} ${name} is invalid`);
      }
    }
    for (const name of vectorCounters) {
      if (!Array.isArray(observation[name]) || observation[name].length !== 3 ||
          observation[name].some((value) => !Number.isSafeInteger(value) || value < 0)) {
        failures.push(`WGPU sparse UBO sample ${index} ${name} is invalid`);
      }
    }
    if (observation.eligibleCalls !== observation.baselineCalls + observation.sparseCalls +
        observation.equalCalls + observation.fullFallbackCalls) {
      failures.push(`WGPU sparse UBO sample ${index} call accounting is inconsistent`);
    }
    if (observation.avoidedStagedBytes !== observation.fullBytes - observation.stagedBytes ||
        observation.overlayBytes !== observation.stagedBytes) {
      failures.push(`WGPU sparse UBO sample ${index} byte accounting is inconsistent`);
    }
    if (Array.isArray(observation.callsByClass) &&
        observation.callsByClass.reduce((sum, value) => sum + value, 0) !==
          observation.eligibleCalls) {
      failures.push(`WGPU sparse UBO sample ${index} per-class calls are inconsistent`);
    }
    if (Array.isArray(observation.sparseCallsByClass) &&
        observation.sparseCallsByClass.reduce((sum, value) => sum + value, 0) !==
          observation.sparseCalls) {
      failures.push(`WGPU sparse UBO sample ${index} per-class sparse calls are inconsistent`);
    }
    if (Array.isArray(observation.stagedBytesByClass) &&
        observation.stagedBytesByClass.reduce((sum, value) => sum + value, 0) !==
          observation.stagedBytes) {
      failures.push(`WGPU sparse UBO sample ${index} per-class staged bytes are inconsistent`);
    }
    if (!expectedActive && counters.some((name) => observation[name] !== 0)) {
      failures.push(`WGPU sparse UBO sample ${index} disabled counters must remain zero`);
    }
    if (previous) {
      if (observation.instanceId !== previous.instanceId) {
        failures.push(
          `WGPU sparse UBO instance changed ${previous.instanceId}->${observation.instanceId}`
        );
      }
      for (const name of counters) {
        if (observation[name] < previous[name]) {
          failures.push(`WGPU sparse UBO sample ${index} ${name} regressed`);
        }
      }
    }
    previous = observation;
  }

  const initial = valid[0] ?? null;
  const final = valid.at(-1) ?? null;
  let deltas = null;
  if (expectedActive) {
    if (valid.length < 2) {
      failures.push("WGPU sparse UBO needs at least two timed samples");
    } else {
      deltas = Object.fromEntries(counters.map(
        (name) => [name, final[name] - initial[name]]
      ));
      if (deltas.eligibleCalls <= 0) {
        failures.push("WGPU sparse UBO handled no eligible uploads in the timed window");
      }
      if (deltas.sparseCalls + deltas.equalCalls <= 0) {
        failures.push("WGPU sparse UBO reconstructed no copy-forward snapshots in the timed window");
      }
      if (!(deltas.stagedBytes < deltas.fullBytes)) {
        failures.push("WGPU sparse UBO did not reduce mapped bytes in the timed window");
      }
    }
  }
  return {
    required: true,
    expectedActive,
    activated: final?.active === true,
    schema: final?.schema ?? null,
    sampleCount: valid.length,
    initial,
    final,
    deltas,
    failures,
  };
}

export function evaluateWgpuUboComputeProjectionEvidence({
  requested,
  samples = [],
} = {}) {
  if (requested == null) return { required: false, failures: [] };
  const expectedActive = String(requested) === "1";
  const failures = [];
  if (!expectedActive && String(requested) !== "0") {
    failures.push(`wgpuubocomputeprojection=${requested} is unsupported`);
  }
  const observations = samples.map(
    (sample) => sample?.causalTelemetry?.webgpu?.uboComputeProjection ?? null
  );
  const valid = [];
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    if (!observation || typeof observation !== "object") {
      failures.push(`WGPU UBO compute projection sample ${index} is missing or malformed`);
      continue;
    }
    valid.push(observation);
    if (observation.schema !== WGPU_UBO_COMPUTE_PROJECTION_SCHEMA) {
      failures.push(`WGPU UBO compute projection sample ${index} schema mismatch`);
    }
    for (const [name, expected] of [
      ["requested", expectedActive],
      ["active", expectedActive],
      ["enabled", expectedActive],
      ["projectionOnly", true],
      ["replayBehaviorChanged", false],
      ["runtimeEligible", false],
    ]) {
      if (observation[name] !== expected) {
        failures.push(
          `WGPU UBO compute projection sample ${index} ${name} mismatch`
        );
      }
    }
    const eligibleCalls = observation.eligible?.calls;
    const eligibleBytes = observation.eligible?.bytes;
    const records = observation.records ?? {};
    const bytes = observation.bytes ?? {};
    const commands = observation.commands ?? {};
    const packages = observation.packages ?? {};
    const nonnegative = [
      eligibleCalls, eligibleBytes, records.total, records.full, records.delta,
      records.equal, records.rawFull, records.utilityRaw,
      records.unknownClassRaw, records.ranges, records.reconstructedBytes,
      bytes.payload, bytes.descriptors, bytes.packageWork,
      bytes.packagePadding, bytes.projected, commands.legacyCopy,
      commands.projectedCopy, commands.dispatches, commands.packages,
      packages.records, observation.malformed,
      observation.unclassifiedResourceIdentity,
    ];
    if (nonnegative.some(
      (value) => !Number.isSafeInteger(value) || value < 0
    )) {
      failures.push(
        `WGPU UBO compute projection sample ${index} contains invalid counters`
      );
      continue;
    }
    if (eligibleCalls !== records.total ||
        eligibleCalls !== commands.legacyCopy ||
        eligibleCalls !== packages.records ||
        eligibleBytes !== records.reconstructedBytes ||
        records.full + records.delta + records.equal + records.rawFull !==
          records.total) {
      failures.push(
        `WGPU UBO compute projection sample ${index} record accounting is inconsistent`
      );
    }
    if (bytes.packageWork !== bytes.payload + bytes.descriptors ||
        bytes.projected !== bytes.packageWork + bytes.packagePadding ||
        bytes.avoided !== eligibleBytes - bytes.projected) {
      failures.push(
        `WGPU UBO compute projection sample ${index} byte accounting is inconsistent`
      );
    }
    if (commands.projectedCopy !== commands.packages ||
        commands.dispatches !== commands.packages ||
        commands.avoidedCopy !== commands.legacyCopy - commands.projectedCopy) {
      failures.push(
        `WGPU UBO compute projection sample ${index} command accounting is inconsistent`
      );
    }
    if (records.utilityRaw + records.unknownClassRaw > records.rawFull) {
      failures.push(
        `WGPU UBO compute projection sample ${index} raw-record accounting is inconsistent`
      );
    }
    if (!expectedActive && (eligibleCalls !== 0 || eligibleBytes !== 0)) {
      failures.push(
        `WGPU UBO compute projection sample ${index} disabled counters must remain zero`
      );
    }
  }

  const initial = valid[0] ?? null;
  const final = valid.at(-1) ?? null;
  let deltas = null;
  if (expectedActive) {
    if (valid.length < 2) {
      failures.push("WGPU UBO compute projection needs at least two timed samples");
    } else {
      deltas = {
        eligibleCalls: final.eligible.calls - initial.eligible.calls,
        eligibleBytes: final.eligible.bytes - initial.eligible.bytes,
        projectedBytes: final.bytes.projected - initial.bytes.projected,
        legacyCopy: final.commands.legacyCopy - initial.commands.legacyCopy,
        projectedCopy:
          final.commands.projectedCopy - initial.commands.projectedCopy,
        dispatches: final.commands.dispatches - initial.commands.dispatches,
        malformed: final.malformed - initial.malformed,
        unclassifiedResourceIdentity:
          final.unclassifiedResourceIdentity - initial.unclassifiedResourceIdentity,
      };
      deltas.projectedGpuCommands = deltas.projectedCopy + deltas.dispatches;
      deltas.avoidedBytes = deltas.eligibleBytes - deltas.projectedBytes;
      deltas.avoidedGpuCommands = deltas.legacyCopy - deltas.projectedGpuCommands;
      if (deltas.eligibleCalls <= 0 || deltas.eligibleBytes <= 0) {
        failures.push(
          "WGPU UBO compute projection observed no eligible timed uploads"
        );
      }
      if (deltas.malformed !== 0 || deltas.unclassifiedResourceIdentity !== 0) {
        failures.push(
          "WGPU UBO compute projection observed malformed or unclassified timed uploads"
        );
      }
      if (!(deltas.projectedBytes < deltas.eligibleBytes)) {
        failures.push(
          "WGPU UBO compute projection did not reduce timed package bytes"
        );
      }
      if (!(deltas.projectedGpuCommands < deltas.legacyCopy)) {
        failures.push(
          "WGPU UBO compute projection did not reduce total timed GPU commands"
        );
      }
    }
  }
  return {
    required: true,
    expectedActive,
    activated: final?.active === true,
    schema: final?.schema ?? null,
    sampleCount: valid.length,
    initial,
    final,
    deltas,
    failures,
  };
}

export function evaluateWgpuTailGateEvidence({ requested, samples = [] } = {}) {
  if (requested == null) return { required: false, failures: [] };
  const expectedEnabled = String(requested) === "1";
  const failures = [];
  if (!expectedEnabled && String(requested) !== "0") {
    failures.push(`wgputailgate=${requested} is unsupported`);
  }
  const observations = samples.map(tailGateFromSample);
  if (!observations.length) failures.push("WGPU tail gate has no timed samples");
  let epoch = null;
  let previous = null;
  const valid = [];
  const counters = [
    "payloadSamples",
    "flushNeededSamples",
    "refreshNeededSamples",
    "bothCleanSamples",
    "dirtyAtSkip",
  ];
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    if (!observation) {
      failures.push(`WGPU tail gate sample ${index} is missing or malformed`);
      continue;
    }
    if (observation.schema !== WGPU_TAIL_GATE_SCHEMA ||
        observation.schemaVersion !== WGPU_TAIL_GATE_SCHEMA_VERSION) {
      failures.push(`WGPU tail gate sample ${index} schema mismatch`);
    }
    if (observation.requested != null && observation.requested !== expectedEnabled) {
      failures.push(`WGPU tail gate sample ${index} requested state mismatch`);
    }
    if (observation.available != null && observation.available !== true) {
      failures.push(`WGPU tail gate sample ${index} producer ABI is unavailable`);
    }
    if (observation.enabled !== expectedEnabled) {
      failures.push(
        `WGPU tail gate sample ${index} enabled mismatch: requested=${expectedEnabled ? 1 : 0} ` +
        `active=${observation.enabled == null ? "unavailable" : observation.enabled ? 1 : 0}`
      );
    }
    if (!Number.isSafeInteger(observation.epoch) || observation.epoch < 0) {
      failures.push(`WGPU tail gate sample ${index} epoch is invalid`);
    } else if (expectedEnabled && observation.epoch === 0) {
      failures.push(`WGPU tail gate sample ${index} enabled epoch is zero`);
    } else if (epoch == null) {
      epoch = observation.epoch;
    } else if (observation.epoch !== epoch) {
      failures.push(`WGPU tail gate epoch changed ${epoch}->${observation.epoch}`);
    }
    if (observation.period !== 256) {
      failures.push(`WGPU tail gate sample ${index} period=${observation.period}, expected 256`);
    }
    for (const name of counters) {
      if (!Number.isSafeInteger(observation[name]) || observation[name] < 0) {
        failures.push(`WGPU tail gate sample ${index} ${name} is invalid`);
      }
    }
    for (const name of ["flushNeededSamples", "refreshNeededSamples", "bothCleanSamples"]) {
      if (Number.isSafeInteger(observation[name]) &&
          Number.isSafeInteger(observation.payloadSamples) &&
          observation[name] > observation.payloadSamples) {
        failures.push(`WGPU tail gate sample ${index} ${name} exceeds payloadSamples`);
      }
    }
    if (expectedEnabled && observation.dirtyAtSkip !== 0) {
      failures.push(`WGPU tail gate sample ${index} dirtyAtSkip=${observation.dirtyAtSkip}`);
    }
    if (previous) {
      for (const name of counters) {
        if (observation[name] < previous[name]) {
          failures.push(`WGPU tail gate sample ${index} ${name} regressed`);
        }
      }
    }
    previous = observation;
    valid.push(observation);
  }
  const first = valid[0] ?? null;
  const final = valid.at(-1) ?? null;
  const deltas = first && final ? Object.fromEntries(
    counters.map((name) => [name, final[name] - first[name]])
  ) : null;
  if (expectedEnabled && final && final.payloadSamples <= 0) {
    failures.push("WGPU tail gate payloadSamples must be positive");
  }
  if (!expectedEnabled && final && counters.some((name) => final[name] !== 0)) {
    failures.push("disabled WGPU tail gate counters must remain zero");
  }
  if (expectedEnabled && final && final.bothCleanSamples <= 0) {
    failures.push("WGPU tail gate bothCleanSamples must be positive");
  }
  if (expectedEnabled && deltas && deltas.payloadSamples <= 0) {
    failures.push("WGPU tail gate payloadSamples did not advance during timed window");
  }
  if (expectedEnabled && deltas && deltas.bothCleanSamples <= 0) {
    failures.push("WGPU tail gate bothCleanSamples did not advance during timed window");
  }
  return {
    required: true,
    expectedEnabled,
    activated: observations.length > 0 &&
      observations.every((value) => value?.enabled === expectedEnabled),
    schemaVersion: final?.schemaVersion ?? null,
    epoch,
    period: final?.period ?? null,
    deltas,
    final,
    failures: [...new Set(failures)],
  };
}

function tailGateFromSample(sample) {
  const nested = sample?.causalTelemetry?.webgpu?.tailGate;
  if (nested) {
    return {
      schema: nested.schema ?? WGPU_TAIL_GATE_SCHEMA,
      schemaVersion: nested.schemaVersion ?? 1,
      requested: nested.requested,
      available: nested.available,
      enabled: nested.enabled,
      epoch: nested.epoch,
      period: nested.period,
      payloadSamples: nested.payloadSamples,
      flushNeededSamples: nested.flushNeededSamples,
      refreshNeededSamples: nested.refreshNeededSamples,
      bothCleanSamples: nested.bothCleanSamples,
      dirtyAtSkip: nested.dirtyAtSkip,
    };
  }
  const value = (name) => sample?.[`wgpuTailGate${name}`] ?? sample?.[`causalWgpuTailGate${name}`];
  if (value("Enabled") != null || value("SchemaVersion") != null) {
    return {
      schema: value("Schema") ?? WGPU_TAIL_GATE_SCHEMA,
      schemaVersion: value("SchemaVersion") ?? 1,
      requested: value("Requested"),
      available: value("Available"),
      enabled: value("Enabled"),
      epoch: value("Epoch"),
      period: value("Period"),
      payloadSamples: value("PayloadSamples"),
      flushNeededSamples: value("FlushNeededSamples"),
      refreshNeededSamples: value("RefreshNeededSamples"),
      bothCleanSamples: value("BothCleanSamples"),
      dirtyAtSkip: value("DirtyAtSkip"),
    };
  }
  const parsed = parseWgpuTailGateStats(sample?.helper);
  if (!parsed) return null;
  return {
    schema: parsed.wgpuTailGateSchema,
    schemaVersion: parsed.wgpuTailGateSchemaVersion,
    enabled: parsed.wgpuTailGateEnabled,
    epoch: parsed.wgpuTailGateEpoch,
    period: parsed.wgpuTailGatePeriod,
    payloadSamples: parsed.wgpuTailGatePayloadSamples,
    flushNeededSamples: parsed.wgpuTailGateFlushNeededSamples,
    refreshNeededSamples: parsed.wgpuTailGateRefreshNeededSamples,
    bothCleanSamples: parsed.wgpuTailGateBothCleanSamples,
    dirtyAtSkip: parsed.wgpuTailGateDirtyAtSkip,
  };
}

export function parseWgpuProducerProfileStats(text = "") {
  const profile = parseProducerProfileWire(text);
  if (!profile) return null;
  return {
    wgpuProducerProfileSchema: profile.schema,
    wgpuProducerProfileSchemaVersion: profile.version,
    wgpuProducerProfileEnabled: profile.enabled,
    wgpuProducerProfileEpoch: profile.epoch,
    wgpuProducerProfilePhaseCount: profile.phaseCount,
    wgpuProducerProfilePhaseOrder: profile.phaseOrder,
    wgpuProducerProfilePeriods: profile.periods,
    wgpuProducerProfileCalls: profile.calls,
    wgpuProducerProfileSamples: profile.samples,
    wgpuProducerProfileSampleTotalNs: profile.sampleTotalNs,
    wgpuProducerProfileSampleMaxNs: profile.sampleMaxNs,
    wgpuProducerProfileEstimatedTotalNs: profile.estimatedTotalNs,
  };
}

export function parseWgpuDrawProfileStats(text = "") {
  const profile = parseDrawProfileWire(text);
  if (!profile) return null;
  return {
    wgpuDrawProfileSchema: profile.schema,
    wgpuDrawProfileSchemaVersion: profile.version,
    wgpuDrawProfileEnabled: profile.enabled,
    wgpuDrawProfileEpoch: profile.epoch,
    wgpuDrawProfilePhaseCount: profile.phaseCount,
    wgpuDrawProfilePhaseOrder: profile.phaseOrder,
    wgpuDrawProfilePeriods: profile.periods,
    wgpuDrawProfileCalls: profile.calls,
    wgpuDrawProfileSamples: profile.samples,
    wgpuDrawProfileSampleTotalNs: profile.sampleTotalNs,
    wgpuDrawProfileSampleMaxNs: profile.sampleMaxNs,
    wgpuDrawProfileEstimatedTotalNs: profile.estimatedTotalNs,
  };
}

export function evaluateWgpuDrawProfileEvidence({ requested, metrics, video, samples = [] } = {}) {
  if (requested == null) return { required: false, failures: [] };
  const failures = [];
  if (!["0", "1"].includes(String(requested))) {
    failures.push(`wgpudrawprofile=${requested} is unsupported`);
  }
  if (String(metrics) !== "1") failures.push("wgpudrawprofile requires metrics=1");
  if (video !== "wgpu") failures.push("wgpudrawprofile requires video=wgpu");
  const expectedEnabled = String(requested) === "1";
  const profiles = samples.map((sample) => {
    const flattened = sample?.wgpuDrawProfileSchemaVersion != null ||
        sample?.causalWgpuDrawProfileSchema != null
      ? sample
      : parseWgpuDrawProfileStats(sample?.helper);
    return flattened ? drawProfileFromFlattenedSample(flattened) : null;
  });
  if (!profiles.length) failures.push("WGPU draw profile has no timed samples");
  let previous = null;
  let epoch = null;
  let periods = null;
  const validProfiles = [];
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    const rawSample = samples[index];
    if (rawSample?.causalWgpuDrawProfileRequested !== expectedEnabled) {
      failures.push(`WGPU draw profile sample ${index} requested state mismatch`);
    }
    if (rawSample?.causalWgpuDrawProfileAvailable !== true) {
      failures.push(`WGPU draw profile sample ${index} ABI is unavailable`);
    }
    if (!profile) {
      failures.push(`WGPU draw profile sample ${index} is missing or malformed`);
      continue;
    }
    if (profile.schemaVersion !== WGPU_DRAW_PROFILE_SCHEMA_VERSION ||
        profile.schema !== WGPU_DRAW_PROFILE_SCHEMA) {
      failures.push(`WGPU draw profile sample ${index} schema mismatch`);
    }
    if (profile.enabled !== expectedEnabled) {
      failures.push(`WGPU draw profile sample ${index} enabled state mismatch`);
    }
    if (profile.phaseCount !== WGPU_DRAW_PROFILE_PHASE_ORDER.length ||
        !sameArray(profile.phaseOrder, WGPU_DRAW_PROFILE_PHASE_ORDER)) {
      failures.push(`WGPU draw profile sample ${index} phase contract mismatch`);
    }
    if (!Number.isSafeInteger(profile.epoch) || profile.epoch < (expectedEnabled ? 1 : 0)) {
      failures.push(`WGPU draw profile sample ${index} epoch is invalid`);
    } else if (epoch == null) epoch = profile.epoch;
    else if (profile.epoch !== epoch) failures.push(`WGPU draw profile epoch changed ${epoch}->${profile.epoch}`);
    let vectorsValid = validateProfileVector(
      profile.periods, index, "periods", failures, WGPU_DRAW_PROFILE_PHASE_ORDER.length,
      { positive: true, label: "draw" }
    );
    for (const name of ["calls", "samples", "sampleTotalNs", "sampleMaxNs", "estimatedTotalNs"]) {
      vectorsValid = validateProfileVector(
        profile[name], index, name, failures, WGPU_DRAW_PROFILE_PHASE_ORDER.length,
        { label: "draw" }
      ) && vectorsValid;
    }
    if (!vectorsValid) continue;
    if (!expectedEnabled && ["calls", "samples", "sampleTotalNs", "sampleMaxNs"].some(
      (name) => profile[name].some((value) => value !== 0)
    )) failures.push(`WGPU draw profile sample ${index} disabled counters are nonzero`);
    if (profile.samples.some((value, phase) => value > profile.calls[phase])) {
      failures.push(`WGPU draw profile sample ${index} samples exceed calls`);
    }
    for (let phase = 0; phase < profile.calls.length; phase += 1) {
      const calls = profile.calls[phase];
      const period = profile.periods[phase];
      const expectedFloor = Math.floor(calls / period);
      const expectedCeil = Math.ceil(calls / period);
      if (profile.samples[phase] < Math.max(0, expectedFloor - 1) ||
          profile.samples[phase] > expectedCeil + 1) {
        failures.push(
          `WGPU draw profile sample ${index} phase ${phase} sample cadence mismatch`
        );
      }
    }
    if (periods == null) periods = profile.periods;
    else if (!sameArray(profile.periods, periods)) failures.push("WGPU draw profile periods changed");
    if (!sameArray(profile.periods, WGPU_DRAW_PROFILE_PERIODS)) {
      failures.push(`WGPU draw profile sample ${index} periods mismatch`);
    }
    if (profile.sampleMaxNs.some((value, phase) => value > profile.sampleTotalNs[phase])) {
      failures.push(`WGPU draw profile sample ${index} max exceeds sampled total`);
    }
    const derived = profile.sampleTotalNs.map((value, phase) => value * profile.periods[phase]);
    if (!sameArray(profile.estimatedTotalNs, derived)) failures.push("WGPU draw profile estimates mismatch");
    if (previous) {
      for (const name of ["calls", "samples", "sampleTotalNs", "sampleMaxNs"]) {
        if (profile[name].some((value, phase) => value < previous[name][phase])) {
          failures.push(`WGPU draw profile sample ${index} ${name} regressed`);
        }
      }
    }
    previous = profile;
    validProfiles.push(profile);
  }
  const first = validProfiles[0] ?? null;
  const final = validProfiles.at(-1) ?? null;
  const deltas = first && final ? Object.fromEntries(
    ["calls", "samples", "sampleTotalNs", "estimatedTotalNs"].map((name) => [
      name, final[name].map((value, phase) => value - first[name][phase]),
    ])
  ) : null;
  if (expectedEnabled && deltas) {
    for (const name of ["calls", "samples", "sampleTotalNs", "estimatedTotalNs"]) {
      if (deltas[name].some((value) => value <= 0)) {
        failures.push(`WGPU draw profile ${name} timed-window delta is not positive`);
      }
    }
  }
  return {
    required: true,
    activated: expectedEnabled && profiles.length > 0 &&
      profiles.every((profile) => profile?.enabled === true),
    epoch,
    phaseOrder: [...WGPU_DRAW_PROFILE_PHASE_ORDER],
    periods: periods ? [...periods] : null,
    deltas,
    final,
    failures: [...new Set(failures)],
  };
}

export function evaluateWgpuProducerProfileEvidence({
  requested,
  metrics,
  samples = [],
} = {}) {
  if (requested == null || String(requested) === "0") {
    return { required: false, failures: [] };
  }
  const failures = [];
  if (String(requested) !== "1") failures.push(`wgpuprodprofile=${requested} is unsupported`);
  if (String(metrics) !== "1") failures.push("wgpuprodprofile=1 requires metrics=1");
  const profiles = samples.map((sample) => {
    const flattened = sample?.wgpuProducerProfileSchemaVersion != null ||
        sample?.causalWgpuProducerProfileSchema != null
      ? sample
      : parseWgpuProducerProfileStats(sample?.helper);
    return flattened ? producerProfileFromFlattenedSample(flattened) : null;
  });
  if (!profiles.length) failures.push("WGPU producer profile has no timed samples");
  let previous = null;
  let epoch = null;
  let periods = null;
  const validProfiles = [];
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    const rawSample = samples[index];
    if (rawSample?.causalWgpuProducerProfileRequested !== true) {
      failures.push(`WGPU producer profile sample ${index} requested state is not active`);
    }
    if (rawSample?.causalWgpuProducerProfileAvailable !== true) {
      failures.push(`WGPU producer profile sample ${index} producer ABI is unavailable`);
    }
    if (!profile) {
      failures.push(`WGPU producer profile sample ${index} is missing or malformed`);
      continue;
    }
    if (profile.schemaVersion !== WGPU_PRODUCER_PROFILE_SCHEMA_VERSION) {
      failures.push(`WGPU producer profile sample ${index} schema=${profile.schemaVersion}`);
    }
    if (profile.schema !== WGPU_PRODUCER_PROFILE_SCHEMA) {
      failures.push(`WGPU producer profile sample ${index} schema name mismatch`);
    }
    if (profile.enabled !== true) failures.push(`WGPU producer profile sample ${index} is disabled`);
    if (profile.phaseCount !== WGPU_PRODUCER_PROFILE_PHASE_ORDER.length) {
      failures.push(`WGPU producer profile sample ${index} phaseCount=${profile.phaseCount}`);
    }
    if (!sameArray(profile.phaseOrder, WGPU_PRODUCER_PROFILE_PHASE_ORDER)) {
      failures.push(`WGPU producer profile sample ${index} phase order mismatch`);
    }
    if (!Number.isSafeInteger(profile.epoch) || profile.epoch <= 0) {
      failures.push(`WGPU producer profile sample ${index} epoch is not positive`);
    } else if (epoch == null) {
      epoch = profile.epoch;
    } else if (profile.epoch !== epoch) {
      failures.push(`WGPU producer profile epoch changed ${epoch}->${profile.epoch}`);
    }
    let vectorsValid = validateProducerProfileVector(
      profile.periods, index, "periods", failures, { positive: true }
    );
    for (const name of ["calls", "samples", "sampleTotalNs", "sampleMaxNs"]) {
      vectorsValid = validateProducerProfileVector(profile[name], index, name, failures) &&
        vectorsValid;
    }
    vectorsValid = validateProducerProfileVector(
      profile.estimatedTotalNs, index, "estimatedTotalNs", failures
    ) && vectorsValid;
    if (!vectorsValid) continue;
    if (profile.samples.some((value, phase) => value > profile.calls[phase])) {
      failures.push(`WGPU producer profile sample ${index} samples exceed calls`);
    }
    if (periods == null) periods = profile.periods;
    else if (!sameArray(profile.periods, periods)) {
      failures.push(`WGPU producer profile sample ${index} periods changed within timed window`);
    }
    const derived = profile.sampleTotalNs.map((value, phase) => value * profile.periods[phase]);
    if (!sameArray(profile.estimatedTotalNs, derived)) {
      failures.push(`WGPU producer profile sample ${index} estimated totals mismatch`);
    }
    if (previous) {
      for (const name of ["calls", "samples", "sampleTotalNs", "sampleMaxNs"]) {
        if (profile[name].some((value, phase) => value < previous[name][phase])) {
          failures.push(`WGPU producer profile sample ${index} ${name} regressed`);
        }
      }
    }
    previous = profile;
    validProfiles.push(profile);
  }
  const first = validProfiles[0] ?? null;
  const final = validProfiles.at(-1) ?? null;
  const deltas = first && final ? Object.fromEntries(
    ["calls", "samples", "sampleTotalNs", "estimatedTotalNs"].map((name) => [
      name,
      final[name].map((value, phase) => value - first[name][phase]),
    ])
  ) : null;
  return {
    required: true,
    activated: profiles.length > 0 && profiles.every((profile) => profile?.enabled === true),
    schemaVersion: final?.schemaVersion ?? null,
    epoch,
    phaseOrder: [...WGPU_PRODUCER_PROFILE_PHASE_ORDER],
    periods: periods ? [...periods] : null,
    deltas,
    final,
    failures: [...new Set(failures)],
  };
}

function producerProfileFromFlattenedSample(sample) {
  const value = (name) => sample[`wgpuProducerProfile${name}`] ??
    sample[`causalWgpuProducerProfile${name}`];
  return {
    schema: value("Schema"),
    schemaVersion: value("SchemaVersion") ?? (value("Schema") === WGPU_PRODUCER_PROFILE_SCHEMA ? 1 : null),
    enabled: value("Enabled"),
    epoch: value("Epoch"),
    phaseCount: value("PhaseCount"),
    phaseOrder: value("PhaseOrder"),
    periods: value("Periods"),
    calls: value("Calls"),
    samples: value("Samples"),
    sampleTotalNs: value("SampleTotalNs"),
    sampleMaxNs: value("SampleMaxNs"),
    estimatedTotalNs: value("EstimatedTotalNs"),
  };
}

function drawProfileFromFlattenedSample(sample) {
  const value = (name) => sample[`wgpuDrawProfile${name}`] ??
    sample[`causalWgpuDrawProfile${name}`];
  return {
    schema: value("Schema"),
    schemaVersion: value("SchemaVersion") ??
      (value("Schema") === WGPU_DRAW_PROFILE_SCHEMA ? 1 : null),
    enabled: value("Enabled"),
    epoch: value("Epoch"),
    phaseCount: value("PhaseCount"),
    phaseOrder: value("PhaseOrder"),
    periods: value("Periods"),
    calls: value("Calls"),
    samples: value("Samples"),
    sampleTotalNs: value("SampleTotalNs"),
    sampleMaxNs: value("SampleMaxNs"),
    estimatedTotalNs: value("EstimatedTotalNs"),
  };
}

function validateProfileVector(
  values,
  sampleIndex,
  name,
  failures,
  phaseCount,
  { positive = false, label = "profile" } = {}
) {
  const valid = Array.isArray(values) && values.length === phaseCount &&
    values.every((value) => Number.isSafeInteger(value) && value >= (positive ? 1 : 0));
  if (!valid) failures.push(`WGPU ${label} profile sample ${sampleIndex} ${name} is invalid`);
  return valid;
}

function validateProducerProfileVector(values, sampleIndex, name, failures, { positive = false } = {}) {
  const valid = Array.isArray(values) &&
    values.length === WGPU_PRODUCER_PROFILE_PHASE_ORDER.length &&
    values.every((value) => Number.isSafeInteger(value) && value >= (positive ? 1 : 0));
  if (!valid) {
    failures.push(`WGPU producer profile sample ${sampleIndex} ${name} is invalid`);
  }
  return valid;
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export function evaluateWgpuRendererWorkerProbeEvidence({ requested, telemetry } = {}) {
  if (requested == null || requested === "off") return { required: false, failures: [] };
  const probe = telemetry?.rendererWorkerProbe;
  const failures = [];
  if (probe?.requested !== requested || probe?.active !== true || probe?.passed !== true) {
    failures.push(
      `WGPU renderer worker probe mismatch: requested=${requested} ` +
      `reported=${probe?.requested ?? "unavailable"} active=${probe?.active ? 1 : 0} ` +
      `passed=${probe?.passed ? 1 : 0}`
    );
  }
  if (requested === "canary" && probe?.schema !== "wasm-dolphin.wgpu-renderer-worker-canary.v1") {
    failures.push(`WGPU renderer worker canary schema mismatch: ${probe?.schema || "unavailable"}`);
  }
  if (["inline-upload", "worker-upload", "null-drain"].includes(requested)) {
    const expectedExecutor = requested === "inline-upload"
      ? "inline" : requested === "worker-upload" ? "worker" : "null";
    const expectedOwner = expectedExecutor === "inline" ? 1 : expectedExecutor === "worker" ? 2 : 3;
    const histogram = probe?.opHistogram;
    const observed = Number(probe?.observedRecordCount);
    const consumed = Number(probe?.consumedRecordCount);
    const uploadRecords = Number(probe?.uploadRecordCount);
    const releasedUploads = Number(probe?.releasedUploadCount);
    const histogramTotal = Array.isArray(histogram)
      ? histogram.reduce((sum, value) => sum + Number(value || 0), 0)
      : -1;
    const expectedUploadRecords = Array.isArray(histogram)
      ? Number(histogram[6] || 0) + Number(histogram[8] || 0)
      : -1;
    if (probe?.schema !== "wasm-dolphin.wgpu-renderer-worker-upload-probe.v1") {
      failures.push(`WGPU upload probe schema mismatch: ${probe?.schema || "unavailable"}`);
    }
    for (const [condition, message] of [
      [probe?.executorLocation === expectedExecutor, "executor location matches request"],
      [probe?.blankOutput === true, "blank output is explicit"],
      [probe?.sharedHeap === true, "shared heap is active"],
      [probe?.protocolVersion === 3, "protocol v3 is active"],
      [probe?.claimedOwner === expectedOwner, "owner token matches executor"],
      [probe?.claimCount === 1 && probe?.conflictCount === 0, "ownership claim is unique"],
      [probe?.handoffAckCount === 1, "ring handoff is acknowledged once"],
      [Number.isSafeInteger(observed) && observed > 0, "records were observed"],
      [consumed === observed, "every observed record was consumed"],
      [Array.isArray(histogram) && histogram.length === 25 && histogramTotal === observed,
        "opcode histogram conserves records"],
      [uploadRecords === expectedUploadRecords && releasedUploads === uploadRecords,
        "every upload record was released once"],
      [Number(probe?.totalUploadBytes) > 0, "upload bytes are nonzero"],
      [probe?.invalidRecordCount === 0 && probe?.unknownOpcodeCount === 0,
        "record validation is clean"],
      [probe?.invalidUploadSpanCount === 0 && probe?.uploadReleaseMismatchCount === 0,
        "upload ownership is clean"],
      [probe?.missingResourceCount === 0, "resource references are complete"],
      [probe?.quiesced === true && probe?.backlog === 0, "probe finalized at quiescence"],
      [probe?.fatalCount === 0 && probe?.consumerState === 1 && probe?.consumerError === 0,
        "consumer remained healthy"],
      [/^[0-9a-f]{8}$/.test(String(probe?.streamDigest || "")),
        "stream digest is present"],
      [Array.isArray(probe?.submitDigests) && probe.submitDigests.length > 0,
        "submit-boundary digests are present"],
    ]) {
      if (!condition) failures.push(`WGPU upload probe invalid: ${message}`);
    }
    if (requested === "null-drain") {
      if (probe?.submissionCount !== 0 || probe?.gpuCompletionCount !== 0 || probe?.staging !== null) {
        failures.push("WGPU null-drain unexpectedly performed GPU work");
      }
    } else if (!(probe?.submissionCount > 0 &&
                 probe?.gpuCompletionCount === probe?.submissionCount &&
                 probe?.staging && probe.staging.failed === false)) {
      failures.push("WGPU upload probe GPU submissions/completions are incomplete");
    }
  }
  return { required: true, requested, probe, failures };
}

export function evaluateWgpuOutputContractEvidence({
  video,
  requestedProbe,
  diagnostics,
} = {}) {
  const uploadProbe = ["inline-upload", "worker-upload", "null-drain"].includes(
    requestedProbe
  );
  const visibleWgpu = ["wgpu", "webgpu-real", "webgpu2"].includes(
    String(video || "").toLowerCase()
  );
  if (!uploadProbe && !visibleWgpu) return { required: false, failures: [] };

  const contract = diagnostics?.outputContract;
  const expected = uploadProbe
    ? {
        disposition: "intentional-blank-probe",
        expectsVisibleCanvas: false,
        activePresenterBackend: "wgpu-upload-probe",
        probeMode: requestedProbe,
      }
    : {
        disposition: "visible-canvas",
        expectsVisibleCanvas: true,
        activePresenterBackend: "webgpu",
        probeMode: null,
      };
  const failures = [];
  if (contract?.schema !== "wasm-dolphin.wgpu-output-contract.v1") {
    failures.push(`WGPU output contract schema mismatch: ${contract?.schema || "unavailable"}`);
  }
  for (const field of [
    "disposition",
    "expectsVisibleCanvas",
    "activePresenterBackend",
    "probeMode",
  ]) {
    if (contract?.[field] !== expected[field]) {
      failures.push(
        `WGPU output contract ${field} mismatch: expected=${String(expected[field])} ` +
        `actual=${contract?.[field] == null ? String(contract?.[field] ?? "unavailable") : String(contract[field])}`
      );
    }
  }
  if (diagnostics?.activePresenterBackend !== expected.activePresenterBackend) {
    failures.push(
      `WGPU output backend mismatch: contract=${expected.activePresenterBackend} ` +
      `diagnostics=${diagnostics?.activePresenterBackend || "unavailable"}`
    );
  }
  return { required: true, expected, contract, failures };
}

export function evaluateWgpuDiagnosticLogFilterEvidence({ requested, diagnostics } = {}) {
  if (String(requested ?? "0") !== "1") return { required: false, failures: [] };
  const snapshot = diagnostics?.diagnosticLogFilter;
  const failures = [];
  if (snapshot?.schema !== "wasm-dolphin.wgpu-diagnostic-log-filter.v1") {
    failures.push(`WGPU diagnostic log filter schema mismatch: ${snapshot?.schema || "unavailable"}`);
  }
  if (snapshot?.enabled !== true) failures.push("WGPU diagnostic log filter is not active");
  if (!Number.isSafeInteger(snapshot?.droppedCount) || snapshot.droppedCount < 0) {
    failures.push("WGPU diagnostic log filter droppedCount is invalid");
  }
  if (!snapshot?.droppedByTag || typeof snapshot.droppedByTag !== "object" ||
      Array.isArray(snapshot.droppedByTag)) {
    failures.push("WGPU diagnostic log filter per-tag evidence is unavailable");
  }
  return { required: true, snapshot, failures };
}

export function validateWgpuUploadProbeFinalization({ requested, finalized } = {}) {
  const failures = [];
  const telemetry = finalized?.causalTelemetry;
  const snapshot = finalized?.snapshot;
  const captured = telemetry?.webgpu?.rendererWorkerProbe;
  if (telemetry?.schemaVersion !== CAUSAL_TELEMETRY_SCHEMA_VERSION) {
    failures.push(
      `causal telemetry schema must be ${CAUSAL_TELEMETRY_SCHEMA_VERSION}`
    );
  }
  if (!snapshot || !captured) {
    failures.push("final probe snapshot and captured telemetry must both be present");
    return { valid: false, failures };
  }
  if (captured.requested !== requested) failures.push("captured probe mode must match the request");
  for (const name of [
    "schema",
    "executorLocation",
    "observedRecordCount",
    "consumedRecordCount",
    "totalUploadBytes",
    "streamDigest",
    "quiesced",
    "passed",
  ]) {
    if (captured[name] !== snapshot[name]) {
      failures.push(`captured probe field ${name} must match the finalized snapshot`);
    }
  }
  return { valid: failures.length === 0, failures };
}

const WGPU_DIRTY_RANGE_PROJECTION_SCHEMA =
  "wasm-dolphin.wgpu-dirty-range-projection.v1";
const WGPU_DIRTY_RANGE_HAZARD_COUNTERS = Object.freeze([
  "overlapUploadCount",
  "overlapIntervalCount",
  "overlapBytes",
  "destinationOrderRegressionCount",
  "sourceArenaWrapCount",
  "sourceOutOfArenaCount",
  "recordIndexWrapCount",
  "recordOrderHazardCount",
]);

export function flattenWgpuDirtyRangeProjection(value) {
  const snapshot = value ?? {};
  const finalized = snapshot.finalized ?? {};
  const flattened = {
    causalWgpuDirtyRangeSchema: snapshot.schema ?? null,
    causalWgpuDirtyRangeRequested:
      typeof snapshot.requested === "boolean" ? snapshot.requested : null,
    causalWgpuDirtyRangeActive:
      typeof snapshot.active === "boolean" ? snapshot.active : null,
    causalWgpuDirtyRangeFinalizedSegmentCount:
      safeNonnegativeInteger(finalized.segmentCount),
    causalWgpuDirtyRangeRawUploads: safeNonnegativeInteger(finalized.raw?.uploads),
    causalWgpuDirtyRangeRawBytes: safeNonnegativeInteger(finalized.raw?.bytes),
  };
  for (const name of WGPU_DIRTY_RANGE_HAZARD_COUNTERS) {
    flattened[`causalWgpuDirtyRangeHazard${upperFirst(name)}`] =
      safeNonnegativeInteger(finalized.hazards?.[name]);
  }
  const thresholds = Array.isArray(snapshot.gapThresholds) ? snapshot.gapThresholds : [];
  const copies = Array.isArray(finalized.projection?.intervalCopiesByGap)
    ? finalized.projection.intervalCopiesByGap
    : [];
  const bytes = Array.isArray(finalized.projection?.copiedBytesByGap)
    ? finalized.projection.copiedBytesByGap
    : [];
  flattened.causalWgpuDirtyRangeGapThresholds = thresholds;
  for (let index = 0; index < thresholds.length; index += 1) {
    const suffix = `Gap${thresholds[index]}`;
    flattened[`causalWgpuDirtyRangeProjectedCopies${suffix}`] =
      safeNonnegativeInteger(copies[index]);
    flattened[`causalWgpuDirtyRangeProjectedBytes${suffix}`] =
      safeNonnegativeInteger(bytes[index]);
  }
  return flattened;
}

export function evaluateWgpuDirtyRangeProjection(samples = []) {
  const failures = [];
  const candidates = Array.from(samples, extractDirtyRangeProjection);
  const firstActiveSampleIndex = candidates.findIndex(hasDirtyRangeActivationSignal);
  const firstValidSampleIndex = candidates.findIndex(isValidDirtyRangeSnapshot);
  if (firstActiveSampleIndex < 0) {
    return dirtyRangeEvaluationResult({
      failures: ["no requested or active WGPU dirty-range projection snapshot was captured"],
    });
  }
  if (firstValidSampleIndex < 0) {
    for (let index = firstActiveSampleIndex; index < candidates.length; index += 1) {
      validateDirtyRangeSnapshot(candidates[index], index, failures);
    }
    return dirtyRangeEvaluationResult({
      failures: failures.length > 0
        ? failures
        : ["no active, schema-valid WGPU dirty-range projection snapshot was captured"],
    });
  }

  let previous = null;
  for (let sampleIndex = firstActiveSampleIndex; sampleIndex < candidates.length; sampleIndex += 1) {
    const snapshot = candidates[sampleIndex];
    validateDirtyRangeSnapshot(snapshot, sampleIndex, failures);
    if (previous && snapshot) {
      validateDirtyRangeMonotonic(previous, snapshot, sampleIndex, failures);
    }
    if (isValidDirtyRangeSnapshot(snapshot)) previous = snapshot;
  }

  const first = candidates[firstValidSampleIndex];
  const finalSampleIndex = candidates.length - 1;
  const final = candidates[finalSampleIndex];
  if (!isValidDirtyRangeSnapshot(final)) {
    failures.push(`final sample ${finalSampleIndex} is not an active, schema-valid snapshot`);
    return dirtyRangeEvaluationResult({
      failures,
      firstValidSampleIndex,
      finalSampleIndex,
      gapThresholds: [...first.gapThresholds],
    });
  }

  const finalizedSegmentCount =
    final.finalized.segmentCount - first.finalized.segmentCount;
  const rawUploads = final.finalized.raw.uploads - first.finalized.raw.uploads;
  const rawBytes = final.finalized.raw.bytes - first.finalized.raw.bytes;
  if (!(finalizedSegmentCount > 0)) {
    failures.push(`finalized segment delta must be positive, got ${finalizedSegmentCount}`);
  }
  if (!(rawUploads > 0)) failures.push(`raw upload delta must be positive, got ${rawUploads}`);
  if (!(rawBytes > 0)) failures.push(`raw byte delta must be positive, got ${rawBytes}`);

  const hazardDeltas = Object.fromEntries(WGPU_DIRTY_RANGE_HAZARD_COUNTERS.map((name) => [
    name,
    final.finalized.hazards[name] - first.finalized.hazards[name],
  ]));
  const unresolvedHazardCount = Object.values(hazardDeltas).reduce(
    (total, value) => total + value,
    0
  );
  const zeroUnresolvedHazards = unresolvedHazardCount === 0;
  const projections = first.gapThresholds.map((gapThresholdBytes, index) => {
    const projectedCopies = final.finalized.projection.intervalCopiesByGap[index] -
      first.finalized.projection.intervalCopiesByGap[index];
    const projectedBytes = final.finalized.projection.copiedBytesByGap[index] -
      first.finalized.projection.copiedBytesByGap[index];
    const copyReductionRatio = rawUploads > 0 ? 1 - projectedCopies / rawUploads : null;
    const byteInflationRatio = rawBytes > 0 ? projectedBytes / rawBytes - 1 : null;
    const copyReductionAtLeast80Percent =
      copyReductionRatio != null && copyReductionRatio >= 0.8;
    const byteInflationAtMost20Percent =
      byteInflationRatio != null && byteInflationRatio <= 0.2;
    return {
      gapThresholdBytes,
      projectedCopies,
      projectedBytes,
      copyReductionRatio,
      byteInflationRatio,
      copyReductionAtLeast80Percent,
      byteInflationAtMost20Percent,
      zeroUnresolvedHazards,
      qualifies:
        copyReductionAtLeast80Percent &&
        byteInflationAtMost20Percent &&
        zeroUnresolvedHazards,
    };
  });
  const qualifyingGapThresholds = projections
    .filter((entry) => entry.qualifies)
    .map((entry) => entry.gapThresholdBytes);

  return dirtyRangeEvaluationResult({
    failures,
    firstValidSampleIndex,
    finalSampleIndex,
    gapThresholds: [...first.gapThresholds],
    finalizedSegmentCount,
    raw: { uploads: rawUploads, bytes: rawBytes },
    hazards: hazardDeltas,
    unresolvedHazardCount,
    zeroUnresolvedHazards,
    projections,
    qualifyingGapThresholds,
    selectedQualifyingGapThreshold: qualifyingGapThresholds[0] ?? null,
  });
}

function dirtyRangeEvaluationResult(overrides = {}) {
  const result = {
    schema: "wasm-dolphin.wgpu-dirty-range-projection-evaluation.v1",
    valid: false,
    firstValidSampleIndex: null,
    finalSampleIndex: null,
    gapThresholds: [],
    finalizedSegmentCount: null,
    raw: null,
    hazards: null,
    unresolvedHazardCount: null,
    zeroUnresolvedHazards: false,
    projections: [],
    qualifyingGapThresholds: [],
    selectedQualifyingGapThreshold: null,
    failures: [],
    ...overrides,
  };
  result.valid = result.failures.length === 0;
  return result;
}

function extractDirtyRangeProjection(sample) {
  return sample?.causalTelemetry?.webgpu?.dirtyRangeProjection ??
    sample?.webgpu?.dirtyRangeProjection ??
    sample?.dirtyRangeProjection ??
    sample ?? null;
}

function hasDirtyRangeActivationSignal(snapshot) {
  return snapshot?.requested === true || snapshot?.active === true || snapshot?.enabled === true;
}

function isValidDirtyRangeSnapshot(snapshot) {
  if (snapshot?.schema !== WGPU_DIRTY_RANGE_PROJECTION_SCHEMA ||
      snapshot.requested !== true || snapshot.active !== true ||
      snapshot.enabled !== true || snapshot.projectionOnly !== true) return false;
  const thresholds = snapshot.gapThresholds;
  const finalized = snapshot.finalized;
  const copies = finalized?.projection?.intervalCopiesByGap;
  const bytes = finalized?.projection?.copiedBytesByGap;
  if (!Array.isArray(thresholds) || thresholds.length === 0 ||
      !Array.isArray(copies) || !Array.isArray(bytes) ||
      copies.length !== thresholds.length || bytes.length !== thresholds.length) return false;
  const counters = [
    finalized?.segmentCount,
    finalized?.raw?.uploads,
    finalized?.raw?.bytes,
    ...copies,
    ...bytes,
  ];
  return counters.every((value) => safeNonnegativeInteger(value) !== null) &&
    WGPU_DIRTY_RANGE_HAZARD_COUNTERS.every(
      (name) => safeNonnegativeInteger(finalized?.hazards?.[name]) !== null
    ) && thresholds.every((value, index) =>
      safeNonnegativeInteger(value) !== null && (index === 0 || value > thresholds[index - 1])
    );
}

function validateDirtyRangeSnapshot(snapshot, sampleIndex, failures) {
  if (!snapshot) {
    failures.push(`sample ${sampleIndex} is missing WGPU dirty-range projection telemetry`);
    return;
  }
  if (snapshot.schema !== WGPU_DIRTY_RANGE_PROJECTION_SCHEMA) {
    failures.push(`sample ${sampleIndex} has unsupported schema ${snapshot.schema ?? "missing"}`);
  }
  for (const [field, value] of [
    ["requested", snapshot.requested],
    ["active", snapshot.active],
    ["enabled", snapshot.enabled],
    ["projectionOnly", snapshot.projectionOnly],
  ]) {
    if (value !== true) failures.push(`sample ${sampleIndex} ${field}=${String(value)} expected true`);
  }
  const thresholds = snapshot.gapThresholds;
  const finalized = snapshot.finalized;
  if (!finalized || typeof finalized !== "object" || Array.isArray(finalized)) {
    failures.push(`sample ${sampleIndex} finalized contract is missing`);
    return;
  }
  const copies = finalized.projection?.intervalCopiesByGap;
  const bytes = finalized.projection?.copiedBytesByGap;
  if (!Array.isArray(thresholds) || thresholds.length === 0) {
    failures.push(`sample ${sampleIndex} gapThresholds must be a non-empty array`);
    return;
  }
  if (!Array.isArray(copies) || copies.length !== thresholds.length ||
      !Array.isArray(bytes) || bytes.length !== thresholds.length) {
    failures.push(`sample ${sampleIndex} projection arrays do not match gapThresholds`);
  }
  validateSafeCounters(
    finalized,
    ["segmentCount"],
    `sample ${sampleIndex} finalized`,
    failures
  );
  validateSafeCounters(
    finalized.raw,
    ["uploads", "bytes"],
    `sample ${sampleIndex} finalized.raw`,
    failures
  );
  validateSafeCounters(
    finalized.hazards,
    WGPU_DIRTY_RANGE_HAZARD_COUNTERS,
    `sample ${sampleIndex} finalized.hazards`,
    failures
  );
  for (let index = 0; index < thresholds.length; index += 1) {
    if (safeNonnegativeInteger(thresholds[index]) === null ||
        (index > 0 && thresholds[index] <= thresholds[index - 1])) {
      failures.push(`sample ${sampleIndex} gapThresholds must be increasing safe integers`);
      break;
    }
  }
  for (const [label, values] of [["intervalCopiesByGap", copies], ["copiedBytesByGap", bytes]]) {
    if (Array.isArray(values) && values.some((value) => safeNonnegativeInteger(value) === null)) {
      failures.push(`sample ${sampleIndex} ${label} contains a non-safe counter`);
    }
  }
}

function validateDirtyRangeMonotonic(previous, current, sampleIndex, failures) {
  if (!isValidDirtyRangeSnapshot(current)) return;
  if (JSON.stringify(current.gapThresholds) !== JSON.stringify(previous.gapThresholds)) {
    failures.push(`sample ${sampleIndex} gapThresholds changed within the timed window`);
    return;
  }
  const paths = [
    ["finalized", "segmentCount"],
    ["finalized", "raw", "uploads"],
    ["finalized", "raw", "bytes"],
    ...WGPU_DIRTY_RANGE_HAZARD_COUNTERS.map((name) => ["finalized", "hazards", name]),
  ];
  for (const path of paths) {
    const before = path.reduce((value, key) => value[key], previous);
    const after = path.reduce((value, key) => value[key], current);
    if (after < before) failures.push(`sample ${sampleIndex} ${path.join(".")} regressed`);
  }
  for (const field of ["intervalCopiesByGap", "copiedBytesByGap"]) {
    const before = previous.finalized.projection[field];
    const after = current.finalized.projection[field];
    if (after.some((value, index) => value < before[index])) {
      failures.push(`sample ${sampleIndex} finalized.projection.${field} regressed`);
    }
  }
}

function validateSafeCounters(value, names, label, failures) {
  for (const name of names) {
    if (safeNonnegativeInteger(value?.[name]) === null) {
      failures.push(`${label}.${name} is not a non-negative safe integer`);
    }
  }
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function upperFirst(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function normalizeArm(arm, label) {
  const params = arm.params == null ? {} : arm.params;
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`Comparison arm ${label} params must be an object`);
  }
  const cacheState = arm.cacheState == null ? "cold" : String(arm.cacheState);
  if (cacheState !== "cold" && cacheState !== "disabled") {
    throw new Error(`Comparison arm ${label} cacheState must be "cold" or "disabled"`);
  }
  return {
    name: String(arm.name),
    params: Object.fromEntries(
      Object.entries(params).map(([key, value]) => [String(key), String(value)])
    ),
    cacheState,
  };
}

function normalizeOverheadGate(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("overheadGate must be an object");
  }
  const maximumRegressionPercent = Number(value.maximumRegressionPercent);
  if (!Number.isFinite(maximumRegressionPercent) || maximumRegressionPercent <= 0) {
    throw new Error("overheadGate.maximumRegressionPercent must be positive");
  }
  if (!Array.isArray(value.semanticWork) || value.semanticWork.length === 0) {
    throw new Error("overheadGate.semanticWork must contain at least one metric rule");
  }
  const semanticWork = value.semanticWork.map((rule, index) => {
    const path = String(rule?.path || "").trim();
    const maximumDifferencePercent = Number(rule?.maximumDifferencePercent);
    if (!path || !Number.isFinite(maximumDifferencePercent) || maximumDifferencePercent < 0) {
      throw new Error(`overheadGate.semanticWork[${index}] is invalid`);
    }
    return { path, maximumDifferencePercent };
  });
  return { maximumRegressionPercent, semanticWork };
}

function normalizeStabilityGate(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stabilityGate must be an object");
  }
  const maximumWithinArmSpreadPercent = Number(value.maximumWithinArmSpreadPercent);
  if (!Number.isFinite(maximumWithinArmSpreadPercent) || maximumWithinArmSpreadPercent < 0) {
    throw new Error("stabilityGate.maximumWithinArmSpreadPercent must be non-negative");
  }
  return { maximumWithinArmSpreadPercent };
}

function summarizeWithinArmSpread(values) {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const average = mean(values);
  const spread = maximum - minimum;
  const spreadPercent = average === 0
    ? spread === 0 ? 0 : null
    : spread / Math.abs(average) * 100;
  return { min: minimum, max: maximum, mean: average, spreadPercent };
}

function numericValue(value) {
  const number = Number.parseFloat(String(value ?? "").replace("%", ""));
  return Number.isFinite(number) ? number : NaN;
}

function makeComparisonBlock(config, blockNumber, order) {
  const blockId = `block-${String(blockNumber).padStart(2, "0")}`;
  return {
    blockId,
    blockNumber,
    order,
    status: "pending",
    runs: order.map((arm, index) => ({
      runId: `${blockId}-run-${index + 1}`,
      blockId,
      blockNumber,
      orderIndex: index + 1,
      arm,
      armName: arm === "A" ? config.armA.name : config.armB.name,
      params: { ...(arm === "A" ? config.armA.params : config.armB.params) },
      cacheState: arm === "A" ? config.armA.cacheState : config.armB.cacheState,
      status: "pending",
    })),
  };
}

function readPath(value, dottedPath) {
  return String(dottedPath)
    .split(".")
    .reduce((current, key) => current?.[key], value);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

function quantile(sorted, probability) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function bootstrapMedianInterval(effects, iterations = 4096) {
  if (effects.length === 1) {
    return { low: effects[0], high: effects[0], method: "block-bootstrap-median", iterations: 1 };
  }
  let state = effects.reduce(
    (seed, value, index) => (seed ^ Math.imul(Math.round(value * 1000) + index + 1, 2654435761)) >>> 0,
    0x9e3779b9
  );
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const medians = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = [];
    for (let index = 0; index < effects.length; index += 1) {
      sample.push(effects[Math.floor(next() * effects.length)]);
    }
    medians.push(median(sample));
  }
  medians.sort((a, b) => a - b);
  return {
    low: quantile(medians, 0.025),
    high: quantile(medians, 0.975),
    method: "block-bootstrap-median",
    iterations,
  };
}

function signPermutationPValue(effects) {
  const observed = Math.abs(mean(effects));
  const combinations = 2 ** effects.length;
  let atLeastAsExtreme = 0;
  for (let mask = 0; mask < combinations; mask += 1) {
    const signed = effects.map((effect, index) =>
      mask & (1 << index) ? effect : -effect
    );
    if (Math.abs(mean(signed)) >= observed - Number.EPSILON) {
      atLeastAsExtreme += 1;
    }
  }
  return atLeastAsExtreme / combinations;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
