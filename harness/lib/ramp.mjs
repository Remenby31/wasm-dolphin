// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// First-launch ramp (research/deep-first-minute.md, "missing probe"): a
// player's very first launch, on a fresh profile (no JIT cache, no region
// cache, no V8 code cache), from the disc handed over to the end of the
// window, and the regions the core installed meanwhile.
//
// Two series, one sample per wall-clock second, in % of real time:
//   game  useful game frames (XFB copies, patch 0113 counters) per second
//         over the scene's native rate (matrix.mjs SCENE_NATIVE_FRAMES_PER_VI
//         × 60): the KPI. The product config runs decoupled (SyncOnSkipIdle
//         off): its VI speed stays at 100 % while the game frames fall
//         behind (2026-10-23: heavy scene at VI 100 % on both machines);
//   vi    the VI-tick speed (timeline.mjs), kept for the coupled configs.
// The game ramp counts from the scene's start (after the steps), the VI one
// from the hand-over. A threshold counts as reached when the series holds it
// 5 s in a row (fullSpeedAt): one slower second restarts the count.
//   timeTo90Ms    >= 90 % (the KPI, target < 15 s);
//   timeToFullMs  >= 95 %;
//   plateauSpeed  median over the plateau window (seconds from the start,
//                 e.g. the heavy intro, 0-17 s after the scene starts), else
//                 the last RAMP_TAIL_SAMPLES seconds;
//   timeToTail90Ms >= 90 % of that plateau, for a scene that never reaches
//                 90 % at all (a CPU-bound one).
import { describe, median, round } from "./stats.mjs";
import { fullSpeedAt } from "./timeline.mjs";

export const RAMP_THRESHOLD = 90;
export const RAMP_TAIL_SAMPLES = 10;
export const RAMP_PLATEAU_MIN = 5;
export const RAMP_TARGET_MS = 15000;

const since = (at, from) => (at == null ? null : Math.round(at - from));

// frames: [{ t, xfb }] cumulative XFB copies sampled about once a second;
// nativeFps: the scene's native game frames per second.
export function gameSpeedSeries(frames, nativeFps) {
  const out = [];
  if (!(nativeFps > 0)) return out;
  for (let i = 1; i < frames.length; i += 1) {
    const dt = frames[i].t - frames[i - 1].t, dx = frames[i].xfb - frames[i - 1].xfb;
    if (!(dt > 0) || !(dx >= 0)) continue;
    const fps = (dx * 1000) / dt;
    out.push({ atMs: frames[i - 1].t, speed: (100 * fps) / nativeFps, fps });
  }
  return out;
}

// One ramp over a series [{ atMs, speed }], counted from `from` (host epoch
// ms); plateau: [fromSec, toSec] after `from`, or null for the tail.
export function rampOver(series, from, plateau = null) {
  const after = series.filter((x) => x.atMs >= from);
  const win = plateau
    ? after.filter((x) => x.atMs >= from + plateau[0] * 1000 && x.atMs < from + plateau[1] * 1000)
    : after.slice(-RAMP_TAIL_SAMPLES);
  const plateauSpeed = win.length >= (plateau ? RAMP_PLATEAU_MIN : RAMP_TAIL_SAMPLES) ? median(win.map((x) => x.speed)) : null;
  return {
    timeTo90Ms: since(fullSpeedAt(after, { speed: RAMP_THRESHOLD }), from),
    timeToFullMs: since(fullSpeedAt(after), from),
    plateauSpeed: round(plateauSpeed, 1),
    timeToTail90Ms: plateauSpeed > 0 ? since(fullSpeedAt(after, { speed: (RAMP_THRESHOLD / 100) * plateauSpeed }), from) : null
  };
}

// speeds: speedSeries() of the launch; t0: host epoch ms of the hand-over;
// regions: [{ t, installed, queued }]; games: gameSpeedSeries() or null
// (an engine without the XFB counter); sceneAt: when the steps ended.
export function rampOf(speeds, t0, regions = [], { games = null, sceneAt = null, plateau = null } = {}) {
  const installedAt = (t) => (t == null ? null : regions.filter((r) => r.t <= t).at(-1)?.installed ?? null);
  const vi = rampOver(speeds, t0);
  const gameFrom = sceneAt ?? t0;
  const game = games?.length ? rampOver(games, gameFrom, plateau) : null;
  const kpi = game ?? vi, kpiFrom = game ? gameFrom : t0;
  return {
    metric: game ? "game" : "vi", ...kpi, vi, game,
    sceneAtMs: sceneAt == null ? null : Math.round(sceneAt - t0),
    regionsAt90: installedAt(kpi.timeTo90Ms == null ? null : kpiFrom + kpi.timeTo90Ms),
    regionsAtEnd: regions.at(-1)?.installed ?? null,
    // [ms from the hand-over, %] per second; game also with its frames/s
    speedSeries: speeds.map((x) => [Math.round(x.atMs - t0), round(x.speed, 1)]),
    gameSeries: (games ?? []).map((x) => [Math.round(x.atMs - t0), round(x.speed, 1), round(x.fps, 1)]),
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
  const what = r.ramp.metric === "game" ? "useful game frames" : "VI speed";
  if (r.ramp.timeTo90Ms == null) return `${what} never ${RAMP_THRESHOLD} % for 5 s in ${windowSec} s (plateau ${r.ramp.plateauSpeed ?? "?"} %)`;
  return null;
}

// Medians over the runs that reached 90 %; the others are listed with why.
// Overloaded runs are left out, never counted as failures.
export function summarizeRamp(records, windowSec) {
  const good = records.filter((r) => !rampFailure(r, windowSec));
  const counted = records.filter((r) => !r.overloaded && r.ramp);
  const pick = (list, f, digits = 0) => describe(list.map((r) => f(r.ramp)), digits);
  const metrics = [...new Set(counted.map((r) => r.ramp.metric))];
  return {
    metric: metrics.length === 1 ? metrics[0] : metrics.length ? "mixed" : null,
    goodRuns: good.length,
    failed: records.map((r, i) => ({ run: r.run ?? i + 1, why: rampFailure(r, windowSec) })).filter((f) => f.why && f.why !== "overloaded"),
    overloadedRuns: records.filter((r) => r.overloaded).map((r, i) => r.run ?? i + 1),
    timeTo90Ms: pick(good, (x) => x.timeTo90Ms), timeToFullMs: pick(good, (x) => x.timeToFullMs), regionsAt90: pick(good, (x) => x.regionsAt90),
    // over every counted run, the CPU-bound ones included
    plateauSpeed: pick(counted, (x) => x.plateauSpeed, 1),
    timeToTail90Ms: pick(counted, (x) => x.timeToTail90Ms),
    regionsAtEnd: pick(counted, (x) => x.regionsAtEnd),
    vi: { timeTo90Ms: pick(counted, (x) => x.vi?.timeTo90Ms), plateauSpeed: pick(counted, (x) => x.vi?.plateauSpeed, 1) },
    targetMs: RAMP_TARGET_MS
  };
}
