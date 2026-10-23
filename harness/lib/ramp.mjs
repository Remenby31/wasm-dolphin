// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// First-launch ramp (research/deep-first-minute.md, "missing probe"): the
// emulated speed of a player's very first launch, on a fresh profile (no JIT
// cache, no region cache, no V8 code cache), from the disc handed over to
// the end of the window, and the regions the core installed meanwhile.
//
// Speeds are the VI-tick speed of timeline.mjs (one sample per wall-clock
// second, 100 = real time). A threshold counts as reached when the speed
// holds it 5 s in a row (fullSpeedAt): one slower second restarts the count.
//   timeTo90Ms    absolute: >= 90 % (the KPI, target < 15 s on the Mac);
//   timeToFullMs  >= 95 %, the full-speed threshold of the other probes;
//   timeToTail90Ms relative: >= 90 % of the run's own plateau (median of its
//                 last RAMP_TAIL_SAMPLES seconds), for a scene that never
//                 reaches 90 % at all (a CPU-bound one).
import { describe, median, round } from "./stats.mjs";
import { fullSpeedAt } from "./timeline.mjs";

export const RAMP_THRESHOLD = 90;
export const RAMP_TAIL_SAMPLES = 10;
export const RAMP_TARGET_MS = 15000;

const since = (at, t0) => (at == null ? null : Math.round(at - t0));

// speeds: speedSeries() of the launch; t0: host epoch ms of the hand-over;
// regions: [{ t, installed, queued }] sampled about once a second.
export function rampOf(speeds, t0, regions = []) {
  const tail = speeds.slice(-RAMP_TAIL_SAMPLES).map((x) => x.speed);
  const plateau = tail.length >= RAMP_TAIL_SAMPLES ? median(tail) : null;
  const timeTo90Ms = since(fullSpeedAt(speeds, { speed: RAMP_THRESHOLD }), t0);
  const installedAt = (ms) => (ms == null ? null : regions.filter((r) => r.t - t0 <= ms).at(-1)?.installed ?? null);
  return {
    timeTo90Ms,
    timeToFullMs: since(fullSpeedAt(speeds), t0),
    plateauSpeed: round(plateau, 1),
    timeToTail90Ms: plateau > 0 ? since(fullSpeedAt(speeds, { speed: (RAMP_THRESHOLD / 100) * plateau }), t0) : null,
    regionsAt90: installedAt(timeTo90Ms),
    regionsAtEnd: regions.at(-1)?.installed ?? null,
    // [ms from the hand-over, speed %] and [ms, installed, queued], per second
    speedSeries: speeds.map((x) => [Math.round(x.atMs - t0), round(x.speed, 1)]),
    regionSeries: regions.map((r) => [Math.round(r.t - t0), r.installed, r.queued])
  };
}

// Why a run gives no ramp: an error, a crash, an overloaded machine, or a
// window that ended before 90 % (a failure of the KPI, not a missing value).
export function rampFailure(r, windowSec) {
  if (r.error) return r.error;
  if (r.fatal?.length) return "crash";
  if (r.overloaded) return "overloaded";
  if (!r.ramp?.speedSeries?.length) return "no VI timeline";
  if (r.ramp.timeTo90Ms == null) return `never ${RAMP_THRESHOLD} % for 5 s in ${windowSec} s (plateau ${r.ramp.plateauSpeed ?? "?"} %)`;
  return null;
}

// Medians over the runs that reached 90 %; the others are listed with why.
// Overloaded runs are left out, never counted as failures.
export function summarizeRamp(records, windowSec) {
  const good = records.filter((r) => !rampFailure(r, windowSec));
  const pick = (f) => describe(good.map((r) => r.ramp[f]), 0);
  const counted = records.filter((r) => !r.overloaded);
  return {
    goodRuns: good.length,
    failed: records.map((r, i) => ({ run: r.run ?? i + 1, why: rampFailure(r, windowSec) })).filter((f) => f.why && f.why !== "overloaded"),
    overloadedRuns: records.filter((r) => r.overloaded).map((r, i) => r.run ?? i + 1),
    timeTo90Ms: pick("timeTo90Ms"), timeToFullMs: pick("timeToFullMs"), regionsAt90: pick("regionsAt90"),
    // over every counted run, the CPU-bound ones included
    plateauSpeed: describe(counted.map((r) => r.ramp?.plateauSpeed), 1),
    timeToTail90Ms: describe(counted.map((r) => r.ramp?.timeToTail90Ms), 0),
    regionsAtEnd: describe(counted.map((r) => r.ramp?.regionsAtEnd), 0),
    targetMs: RAMP_TARGET_MS
  };
}
