// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// A parcours (harness/probes/parcours.mjs): a whole play-through from the
// boot, title, menus, selection, loading, a full game round, its results and
// back, sampled once a second and cut into phases found from generic signals
// only. Pure: tested in tests/harness-parcours.test.mjs.
//
// One raw sample a second (the probe reads them, nothing per frame):
//   t         host ms (timeOrigin + now) of the page's reading
//   info      __lastFrameInfo: speed (gameSpeed %), newFps and producedFps
//             (the worker's 500 ms window: newFps kept as newFpsWorker, the
//             seconds count the presents instead),
//             newShown (new frames shown since boot, cumulative), outOfOrder
//             (cumulative), cpuBusy, gpuBusy, replayBusy (occupancy of the
//             worker's last 500 ms window, 0..1), draws (the replay's draws
//             since boot, cumulative)
//   counters  the drop sampler's last row of that second (its own t): ticks,
//             discBytes, xfbCopies (EFB→XFB copies), cumulative; null when
//             no row came (the rates of the previous second are kept)
//   presents  host times of the presentations of that second (timeline);
//             presentTag / presentTagEpoch the frame tag each shows (patch
//             0208), presentsKnown false when the timeline read failed, its
//             ring lost presents or the tags were not one per present
//   vi        VI outputs of that second (timeline); viT their host times
//             (the frames' phase against the presents: ?vilock, patch 0212)
//   audioQ    the mixer queue's overflow skips and underrun fills since boot,
//             the throttle trim and the phase lock's counters (patch 0212,
//             ?vilock=1; null on a core without it)
//   integrity validationReadIntegrity, for the deltas per phase (optional)
//   film      the pad film's position { pos, hold } (optional)
// Derived per second: speed (guest / host time from the core ticks), new
// frames shown and produced a second, smoothness (new frames against the
// game's cadence, learnt as the site learns it; against what the game made
// in a content second: contentSecond), present hitches over 50 and
// 100 ms, disc bytes a second, XFB copies and replay draws per frame made,
// occupancy.
import { integrityOf } from "./integrity.mjs";
import { contentRule, noiseOf, verdictOf } from "./drops.mjs";
import { median, percentile, round } from "./stats.mjs";

// How the seconds are judged (not what the page runs: the probe's
// PROBE_VERSION). An A/A's noise holds only for the same analysis: readNoise
// refuses another. 2: content seconds judged against what was made
// (contentRule), the menus' smoothness p5 several points higher than in 1.
// 4: new frames counted present by present on a fixed 1 s grid of the
// timeline (was the worker's last 500 ms: one 50 ms hitch read 93.3 %, the
// other half unseen), by frame tag when recorded (newFramesBasis "tag", else
// "all"), unknown seconds counted (smoothUnknown, p5 unreliable past 5 %);
// the film's declared phases (film.phases) before the detector's.
// 5: the produced frames (the content reference) on the same grid, by tag
// (producedBasis "grid"; "worker": the worker's 500 ms rate, older runs).
// 6: a pause of production is a stall only past 2.5 VI periods too (a game
// below its VI rate pauses 2 VIs); a row without a grid second takes the
// worker's produced rate for its phase signals (the live phase).
// 7: a second whose production pauses while the game asked no XFB copy
// that was not produced, every gap at full speed with its VIs on, is the
// game's pause: content, judged against what it made plus the VIs the
// emulation missed (gamePauseReference), at the run's nominal VI cadence (no
// learnt 30/60 coin flip); each phase publishes those pauses (gamePauses:
// count, seconds, durations, start, film position).
// 8: a gap is the game's pause only with the GPU side idle over it, from the
// drop sampler's 100 ms rows (gamePauseGpuSide; unknown: no excuse); the
// pauses' count and total time are A/B primaries (a rise is a regression).
export const ANALYSIS_VERSION = 8;

export const PHASES = Object.freeze(["boot", "loading", "cinematic", "menu", "game"]);
// A phase lasts at least this long: a shorter run of seconds goes to the
// phase before it (hysteresis), so one odd second never makes a phase.
export const MIN_PHASE_SEC = 2;
// loading: the disc read at least this much in the second (drop-meter's
// loads use the same rate) while the new frames fell under SCARCE_SHARE of
// the cadence, or the emulation under SCARCE_SPEED %.
export const LOAD_DISC_BPS = 2.5 * (1 << 20);
export const SCARCE_SHARE = 0.9;
export const SCARCE_SPEED = 90;
// cinematic: new frames with (nearly) no EFB→XFB copy each (a movie the CPU
// writes straight to the XFB), or a stream from the disc of at least
// STREAM_DISC_BPS with almost no 3D work (a movie decoded on the CPU and
// drawn as one or a few textured quads, which the GPU copies as any frame:
// seen on the first disc measured, ~1.8 MB/s and ~11 draws a frame).
export const CINEMA_XFB_PER_FRAME = 0.2;
export const STREAM_DISC_BPS = 0.5 * (1 << 20);
export const CINEMA_MAX_DRAWS_PER_FRAME = 30;
// game against menu: the replay's draws per frame made. A default from the
// first disc measured (menus and title 70-180 draws a frame, 3D play
// 300-450); a film may give its own (film.detect.gameDrawsPerFrame).
export const GAME_DRAWS_PER_FRAME = 200;
// A second with fewer new frames than this and nothing read: no signal (a
// still picture, a pause), it keeps the phase before it.
export const MIN_NEW_FPS = 5;
export const HITCH_MS = [50, 100];
// One present gap [a, b) (host ms): its length, the VI outputs inside it
// (viT: their host times, null when the ring lost entries: unknown), and the
// presenting worker's longest stall inside it from the drop sampler's ticks
// (ticks: EVERY tick [t, lagMs] of the sampler, null when it was not read: a
// tick that ran lagMs late means the worker could not run during
// [t - lagMs, t]). An absent datum stays unknown, never 0 (lib/drops.mjs
// attribution): no tick due in the gap nor stalled across it, or no ticks
// read, gives null; an on-time tick inside it, 0. Pure.
export function gapDetail(a, b, viT = null, ticks = null) {
  const vis = Array.isArray(viT) ? viT.filter((v) => v >= a && v < b).length : null;
  let workerLagMs = null;
  if (Array.isArray(ticks)) {
    for (const [t, l] of ticks) {
      const due = t - l;
      const over = Math.min(b, t) - Math.max(a, due);
      if (!(due >= a && due < b) && !(over > 0)) continue;
      workerLagMs = Math.max(workerLagMs ?? 0, Math.max(0, over));
    }
  }
  return { at: a, ms: round(b - a, 1), vis, workerLagMs: workerLagMs == null ? null : round(workerLagMs, 1) };
}

// The site's smoothness (salon packages/core/src/smoothness.ts): a window
// teaches the game's cadence (VI/1, /2, /3, within 10 %) only at full speed
// with the screen showing what the game made; under the VI rate only with
// margin (the three occupancies under LEARN_MAX_BUSY). Else the last one,
// else the VI rate's.
export const LEARN_MIN_SPEED = 95;
export const LEARN_MIN_SHOWN_SHARE = 0.95;
export const LEARN_MAX_BUSY = 0.7;
const viCadence = (viRate) => (viRate >= 55 ? 60 : viRate > 0 ? 50 : 60);
export function windowCadence({ newFps, producedFps, speed, viRate, cpuBusy, gpuBusy, replayBusy }) {
  if (newFps == null || producedFps == null || !(producedFps > 0) || !(speed >= LEARN_MIN_SPEED)) return null;
  if (newFps < producedFps * LEARN_MIN_SHOWN_SHARE) return null;
  const vi = viCadence(viRate);
  const c = [vi, vi / 2, vi / 3].find((x) => Math.abs(newFps - x) <= x * 0.1);
  if (c === undefined) return null;
  const margin = (v) => typeof v === "number" && v >= 0 && v < LEARN_MAX_BUSY;
  if (c < vi && !(margin(cpuBusy) && margin(gpuBusy) && margin(replayBusy))) return null;
  return c;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// A second whose missing frames are the game's own content: lib/drops.mjs
// contentRule, the single definition the attribution uses too (full speed,
// every thread measured and under the site's margin, fewer frames made than
// the scene's cadence). Then smoothness is shown / produced. On the first
// disc measured, 31 % of the menus' deficit was this (a save screen, the
// hand-over to a race: 45-50 frames made a second).
// The smoothness reference of a content second is what was made: none made
// (0, a still screen) leaves no reference, so it is no content second here
// (0/0 would be NaN).
export function contentSecond({ producedFps, speed, cadence, cpuBusy, gpuBusy, replayBusy }) {
  if (!(Number.isFinite(producedFps) && producedFps > 0)) return false;
  return contentRule({ speed, produced: producedFps, expected: cadence, occupancy: { cpu: cpuBusy, gpu: gpuBusy, replay: replayBusy } });
}
const smoothOf = (n, ref) => (n == null || !(Number.isFinite(ref) && ref > 0) ? null : round(Math.max(0, Math.min(100, (n / ref) * 100)), 1));
const delta = (a, b) => (num(a) == null || num(b) == null || b < a ? null : b - a);

// The new frames shown, second by second on a FIXED grid: bin k is
// [origin + k s, origin + (k + 1) s), origin the first reading; every present
// of the timeline lands in exactly one bin, whatever the readings' times (a
// hitch delays the reading after it: a window tied to the readings would
// leave part of the gap unseen). Basis:
//   "tag"  each present's frame tag and tag epoch recorded (presentTag,
//          presentTagEpoch: src/wgpu-new-frames.js, patch 0208): a present is
//          new when its (epoch, tag) is past the last one shown (a re-shown
//          duplicate or an older frame is not; a reboot or a state load
//          moves the epoch); a tag of 0 (unknown) makes its bin unknown;
//   "all"  no tags recorded (records before analysis 4): every present is
//          one, which only holds on the WebGPU vsync presenter (each frame
//          put up once); a re-shown duplicate would count.
// A bin is null (unknown) when a reading that may hold its presents was not
// read whole: reading j holds the presents after reading j-1's timeline read
// and up to its own, all within (t[j-1], t[j+1]) since the loop reads in
// order; unknown are a reading flagged presentsKnown false (the read failed,
// the ring lost presents, the tags missing or not one per present), on a
// record without that flag viT null while the run has VI times, and frames
// untagged (info.newShown absent: the software renderer presents a picture
// at every VI). Bins past the last reading are incomplete: none.
export const NEW_FRAMES_BIN_MS = 1000;
export function newFrameBins(samples, { binMs = NEW_FRAMES_BIN_MS } = {}) {
  if (!samples.length) return { basis: null, bins: [] };
  const origin = samples[0].t, last = samples.at(-1).t;
  const viEver = samples.some((s) => Array.isArray(s.viT));
  const basis = samples.some((s) => Array.isArray(s.presentTag)) ? "tag" : "all";
  const known = samples.map((s) => {
    if (!Array.isArray(s.presents) || num(s.info?.newShown) == null) return false;
    if (typeof s.presentsKnown === "boolean" && !s.presentsKnown) return false;
    if (basis === "tag" && !(Array.isArray(s.presentTag) && Array.isArray(s.presentTagEpoch) && s.presentTag.length === s.presents.length && s.presentTagEpoch.length === s.presents.length)) return false;
    if (typeof s.presentsKnown === "boolean") return true;
    return viEver ? Array.isArray(s.viT) : true;
  });
  const n = Math.floor((last - origin) / binMs);
  const counts = Array(n).fill(0);
  const unknown = Array(n).fill(false);
  // the spans a reading not read whole may hold presents in
  samples.forEach((s, j) => {
    if (j === 0 || known[j]) return;
    const from = samples[j - 1].t, to = samples[j + 1]?.t ?? Infinity;
    for (let k = Math.max(0, Math.floor((from - origin) / binMs)); k < n && origin + k * binMs < to; k += 1) unknown[k] = true;
  });
  // every present in time order: [t, new (true / false / null unknown)]
  const all = [];
  samples.forEach((s, j) => (s.presents ?? []).forEach((t, i) => all.push([t, j, i])));
  all.sort((x, y) => x[0] - y[0]);
  let shownTag = 0, shownEpoch = -Infinity;
  for (const [t, j, i] of all) {
    const k = Math.floor((t - origin) / binMs);
    let isNew = true;
    if (basis === "tag") {
      const tag = samples[j].presentTag?.[i], epoch = samples[j].presentTagEpoch?.[i];
      if (!(Number.isFinite(tag) && tag > 0 && Number.isFinite(epoch))) isNew = null;
      else {
        isNew = epoch > shownEpoch || (epoch === shownEpoch && tag > shownTag);
        if (isNew) { shownTag = tag; shownEpoch = epoch; }
      }
    }
    if (k < 0 || k >= n) continue;
    if (isNew === null) unknown[k] = true;
    else if (isNew) counts[k] += 1;
  }
  return {
    basis,
    bins: counts.map((c, k) => ({ k, from: origin + k * binMs, to: origin + (k + 1) * binMs, newFrames: unknown[k] ? null : c * (1000 / binMs) }))
  };
}

// The frames produced (a new frame tag entering the present queue: the
// worker's timeline, producedT) on the same fixed 1 s grid as newFrameBins:
// the content reference of each second (what the game made), exact like the
// new frames shown (the worker's 500 ms produced rate swung 15.6-59.9 on one
// loading second where the game made 30-36 frames a second, every run).
// Basis "grid" when the run recorded them, else "worker" (bins null: the
// rows keep the worker's rate). A bin is null (unknown) when a reading that
// may hold its frames was not read whole (producedKnown false, frames
// untagged: info.newShown absent), as for the presents.
export function producedBins(samples, { binMs = NEW_FRAMES_BIN_MS } = {}) {
  if (!samples.length) return { basis: null, bins: null };
  if (!samples.some((s) => Array.isArray(s.producedT))) return { basis: "worker", bins: null };
  const origin = samples[0].t, last = samples.at(-1).t;
  const known = samples.map((s) => Array.isArray(s.producedT) && s.producedKnown === true && num(s.info?.newShown) != null);
  const n = Math.floor((last - origin) / binMs);
  const counts = Array(n).fill(0);
  const unknown = Array(n).fill(false);
  samples.forEach((s, j) => {
    if (j === 0 || known[j]) return;
    const from = samples[j - 1].t, to = samples[j + 1]?.t ?? Infinity;
    for (let k = Math.max(0, Math.floor((from - origin) / binMs)); k < n && origin + k * binMs < to; k += 1) unknown[k] = true;
  });
  const times = samples.flatMap((s) => s.producedT ?? []).sort((x, y) => x - y);
  for (const t of times) {
    const k = Math.floor((t - origin) / binMs);
    if (k >= 0 && k < n) counts[k] += 1;
  }
  // each second's longest pause in production: every interval between two
  // frames (or from the last frame to the second's end, with none after
  // known) that overlaps the second, its whole length
  const maxGap = Array(n).fill(0);
  const edges = [origin, ...times.filter((t) => t >= origin), last];
  for (let i = 1; i < edges.length; i += 1) {
    const a = edges[i - 1], b = edges[i];
    for (let k = Math.max(0, Math.floor((a - origin) / binMs)); k < n && origin + k * binMs < b; k += 1) maxGap[k] = Math.max(maxGap[k], b - a);
  }
  return { basis: "grid", bins: counts.map((c, k) => (unknown[k] ? null : c * (1000 / binMs))), maxGapMs: maxGap.map((g, k) => (unknown[k] ? null : g)) };
}

// A second's production is regular (its frames spread over it, no burst then
// a stop): its longest pause at most REGULAR_GAP_FACTOR frame intervals, and
// never under REGULAR_GAP_VIS VI periods. A worker stalled 300 ms makes and
// shows nothing meanwhile: 42 made, 42 shown, and only a regular production
// may be the game's own content. A game below its VI rate makes a frame
// every 2 VIs now and then (33 ms at 59.94 Hz): its pauses are its pace, not
// a stall (a race's results at 50-56 frames a second read 83-93 % as losses
// with the frame-interval bound alone). Frames not made at full speed stay
// content here: the speed p5 is the measure of an emulation slowdown.
export const REGULAR_GAP_FACTOR = 1.5;
export const REGULAR_GAP_VIS = 2.5;
export function regularProduction(made, maxGapMs, { viMs = 1000 / 59.94 } = {}) {
  if (!(Number.isFinite(made) && made > 0 && Number.isFinite(maxGapMs))) return false;
  return maxGapMs <= Math.max(REGULAR_GAP_FACTOR * (1000 / made), REGULAR_GAP_VIS * viMs);
}

// The VI outputs of each grid second (the samples' viT), null where a reading
// whose span the second touches has no VI times (the ring lost entries or the
// read failed): the same spans as newFrameBins.
export function viBins(samples, { binMs = NEW_FRAMES_BIN_MS } = {}) {
  if (!samples.length || !samples.some((s) => Array.isArray(s.viT))) return null;
  const origin = samples[0].t, last = samples.at(-1).t;
  const n = Math.floor((last - origin) / binMs);
  const counts = Array(n).fill(0), unknown = Array(n).fill(false);
  samples.forEach((s, j) => {
    if (j === 0 || Array.isArray(s.viT)) return;
    const from = samples[j - 1].t, to = samples[j + 1]?.t ?? Infinity;
    for (let k = Math.max(0, Math.floor((from - origin) / binMs)); k < n && origin + k * binMs < to; k += 1) unknown[k] = true;
  });
  for (const s of samples) for (const t of s.viT ?? []) {
    const k = Math.floor((t - origin) / binMs);
    if (k >= 0 && k < n) counts[k] += 1;
  }
  return counts.map((c, k) => (unknown[k] ? null : c * (1000 / binMs)));
}

// The game's own pause (analysis 7): a grid second whose production pauses
// (not regular) while the game asked no XFB copy that was not produced: the
// core's EFB->XFB copies over the sampler's counter window at most the
// frames produced in that same window + 1 (both counted over the window, a
// fresh counter row covering the second: gamePauseWindow). On the 2P race
// load the game asks no copy for ~300 ms, at full speed, its VIs on (12 of
// 12 runs; no emulator shows a frame the game does not make). Such a second
// is content, judged against what the game made plus the VIs the emulation
// itself missed in it: reference = produced + max(0, the run's NOMINAL VI
// cadence (60 at 59.94 Hz, 50 at PAL: nominalViRate, never one second's
// measured rate nor a cadence learnt from the scene) - VIs counted in the
// second), and only when every production gap of the second is a game
// pause (gamePauseSpans: full speed, VIs continuous, no burst after it) and
// is excused in every second it covers; else the second is judged against
// the scene's cadence, as any other.
export function gamePauseReference({ made, xfbCopies, producedInWindow = made, vis, viRate }) {
  if (!(Number.isFinite(made) && Number.isFinite(xfbCopies) && Number.isFinite(producedInWindow) && Number.isFinite(vis))) return null;
  if (xfbCopies > producedInWindow + 1) return null;
  return made + Math.max(0, viCadence(viRate) - vis);
}

// The run's nominal VI rate: 59.94 or 50, from the median of its readings'
// VI rates (a second that lost VIs never turns NTSC into PAL).
export function nominalViRate(samples) {
  const rates = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    if (dt > 0 && num(samples[i].vi) != null) rates.push(samples[i].vi / dt);
  }
  const m = median(rates);
  return m == null ? 59.94 : m >= 55 ? 59.94 : 50;
}

// The counter window a grid second is judged on: the reading's FRESH sampler
// counter row (a reading without a new row keeps old rates: never used
// here) over at least GAME_PAUSE_WINDOW_COVER of the second; its copies and
// the frames produced in the same window. Null: no pause can be excused.
export const GAME_PAUSE_WINDOW_COVER = 0.95;
export function gamePauseWindow(win, bin, producedT) {
  if (!win || !(win.to > win.from) || !Number.isFinite(win.copies)) return null;
  const cover = Math.max(0, Math.min(win.to, bin.to) - Math.max(win.from, bin.from)) / (bin.to - bin.from);
  if (cover < GAME_PAUSE_WINDOW_COVER) return null;
  return { copies: win.copies, produced: producedT.filter((t) => t > win.from && t <= win.to).length };
}

// The production gaps of a grid second (two frames of producedT in a row
// more than REGULAR_GAP_VIS VI periods apart), each judged a game pause or
// not: at full speed (the speed of every row the gap covers >= 
// GAME_PAUSE_FULL_SPEED %: speedAt), the VIs continuous over it (from the
// last VI before it to the first after: at most GAME_PAUSE_MISSED_VIS fewer
// VIs than its length holds, and no VI interval over GAME_PAUSE_MAX_VI_GAP
// periods: host jitter delays a VI by up to 2.5 periods then catches up, a
// caught-up stall of 3 periods or more is ours), and no burst after it (at
// most GAME_PAUSE_RESUME_FRAMES frames within GAME_PAUSE_RESUME_FRAMES VI
// periods after it: frames held by a stall of ours come out at once, a game
// resumes at its pace). Times in the emulation's host clock.
// The GPU side over a gap, from the drop sampler's 100 ms rows (the probe's
// gpuRows, GPU_ROW_COLUMNS; never the worker's 500 ms window): a stall of
// ours on the GPU side (in dual core without SyncOnSkipIdle the guest CPU
// spins at full speed waiting for draw-done, the VIs go on, no copy is asked,
// nothing bursts after) looks like the game's pause in every other signal.
// Over the rows covering the gap (each row's share spread at most over its
// overlap with the gap: an upper bound, a 45 ms stall inside a 100 ms row
// counts whole): the GPU thread's work (its waits for this worker included:
// the replay held it) and this worker's busy time each at most
// GAME_PAUSE_MAX_GPU_SHARE of the gap; the CPU thread's waits for the GPU
// (FlushGpu, EFB syncs) at most GAME_PAUSE_MAX_GPU_WAIT_MS; the copies at
// most the frames produced over the same rows + 1. Rows missing, a drain
// lost (a row interval over GAME_PAUSE_MAX_ROW_MS) or a field unknown:
// unknown, never excused.
export const GPU_ROW_COLUMNS = Object.freeze(["t", "xfbCopies", "gpuWorkUs", "gpuConsumerWaitUs", "presentSleepUs", "flushGpuWaitUs", "efbWaitUs", "replayBusyMs"]);
export const GAME_PAUSE_MAX_GPU_SHARE = 0.5;
export const GAME_PAUSE_MAX_GPU_WAIT_MS = 1;
export const GAME_PAUSE_MAX_ROW_MS = 250;
export function gamePauseGpuSide({ rows, a, b, producedT }) {
  const unknown = { known: false, ok: false };
  if (!Array.isArray(rows) || !(b > a)) return unknown;
  const [T, XFB, WORK, , PRESENT, FLUSH, EFB, REPLAY] = GPU_ROW_COLUMNS.map((_, i) => i);
  const first = rows.findLastIndex((r) => r[T] <= a), last = rows.findIndex((r) => r[T] >= b);
  if (first < 0 || last < 0) return unknown;
  let gpuMs = 0, replayMs = 0, waitMs = 0, copies = 0;
  for (let i = first + 1; i <= last; i += 1) {
    const p = rows[i - 1], c = rows[i];
    if (c.some((x) => x == null) || p.some((x) => x == null)) return unknown;
    const span = c[T] - p[T];
    if (!(span > 0) || span > GAME_PAUSE_MAX_ROW_MS) return unknown;
    const d = (k) => c[k] - p[k];
    if ([XFB, WORK, PRESENT, FLUSH, EFB, REPLAY].some((k) => d(k) < 0)) return unknown;
    const overlap = Math.min(c[T], b) - Math.max(p[T], a);
    gpuMs += Math.min(overlap, (d(WORK) - d(PRESENT)) / 1000);
    replayMs += Math.min(overlap, d(REPLAY));
    waitMs += (d(FLUSH) + d(EFB)) / 1000;
    copies += d(XFB);
  }
  const produced = producedT.filter((t) => t > rows[first][T] && t <= rows[last][T]).length;
  const gap = b - a;
  const ok = gpuMs <= GAME_PAUSE_MAX_GPU_SHARE * gap && replayMs <= GAME_PAUSE_MAX_GPU_SHARE * gap && waitMs <= GAME_PAUSE_MAX_GPU_WAIT_MS && copies <= produced + 1;
  return { known: true, ok, gpuMs: round(Math.max(0, gpuMs), 1), replayMs: round(Math.max(0, replayMs), 1), waitMs: round(waitMs, 1), copies, produced };
}

export const GAME_PAUSE_FULL_SPEED = 98;
export const GAME_PAUSE_MISSED_VIS = 1;
export const GAME_PAUSE_MAX_VI_GAP = 3;
export const GAME_PAUSE_RESUME_FRAMES = 3;
export function gamePauseSpans({ producedT, viT, from, to, viMs, speedAt, gpuRows = null }) {
  if (!(Array.isArray(producedT) && Array.isArray(viT) && viMs > 0)) return [];
  const out = [];
  for (let i = 1; i < producedT.length; i += 1) {
    const a = producedT[i - 1], b = producedT[i];
    if (!(b - a > REGULAR_GAP_VIS * viMs) || b <= from || a >= to) continue;
    const before = viT.findLast((t) => t <= a), after = viT.find((t) => t >= b);
    let missed = null, maxViGap = null;
    if (before != null && after != null) {
      const span = viT.filter((t) => t >= before && t <= after);
      missed = Math.round((after - before) / viMs) - (span.length - 1);
      maxViGap = 0;
      for (let j = 1; j < span.length; j += 1) maxViGap = Math.max(maxViGap, span[j] - span[j - 1]);
    }
    const resumed = producedT.filter((t) => t > b && t <= b + GAME_PAUSE_RESUME_FRAMES * viMs).length;
    const speeds = speedAt ? speedAt(a, b) : [];
    const continuousVis = missed != null && missed <= GAME_PAUSE_MISSED_VIS && maxViGap <= GAME_PAUSE_MAX_VI_GAP * viMs;
    const fullSpeed = speeds.length > 0 && speeds.every((x) => Number.isFinite(x) && x >= GAME_PAUSE_FULL_SPEED);
    const noBurst = resumed <= GAME_PAUSE_RESUME_FRAMES;
    const gpuSide = gamePauseGpuSide({ rows: gpuRows, a, b, producedT });
    out.push({ start: a, end: b, durationMs: round(b - a, 1), missedVis: missed, maxViGapMs: maxViGap == null ? null : round(maxViGap, 1), continuousVis, fullSpeed, noBurst, gpuSide, ok: continuousVis && fullSpeed && noBurst && gpuSide.ok });
  }
  return out;
}

// The raw samples -> one row a second (the first sample is the origin).
export function deriveSeconds(samples, { tps = null } = {}) {
  const rows = [];
  let cadence = null, lastPresent = null, prevCounters = samples[0]?.counters ?? null, carried = null;
  const t0 = samples[0]?.t ?? 0;
  let booted = false;
  const { bins } = newFrameBins(samples);
  const { bins: produced, maxGapMs: producedGap } = producedBins(samples);
  const vis = viBins(samples);
  const allProduced = samples.flatMap((s) => s.producedT ?? []).sort((x, y) => x - y);
  const allVis = samples.flatMap((s) => s.viT ?? []).sort((x, y) => x - y);
  // the GPU side's 100 ms rows, in time order (a reading without them leaves
  // a hole: the gaps over it are unknown)
  const gpuRows = samples.some((s) => Array.isArray(s.gpuRows)) ? samples.flatMap((s) => s.gpuRows ?? []).sort((x, y) => x[0] - y[0]) : null;
  // the film's position at a host time: interpolated between the readings
  // around it (a reading a second before would name the scene a second early)
  const filmAt = (t) => {
    const a = samples.findLast((s) => s.t <= t && s.film?.pos != null), b = samples.find((s) => s.t >= t && s.film?.pos != null);
    if (!a || !b) return a?.film.pos ?? b?.film.pos ?? null;
    return b.t === a.t ? a.film.pos : Math.round(a.film.pos + ((b.film.pos - a.film.pos) * (t - a.t)) / (b.t - a.t));
  };
  const nominalVi = nominalViRate(samples), nominalViMs = 1000 / nominalVi;
  // the game-pause candidates, decided once every second is read
  const pauseBins = new Map(); // grid second k -> { row, bin index, gaps, smoothPause, smoothScene }
  const rowSpeeds = []; // [from, to, speed] per reading
  let nextBin = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1], b = samples[i];
    const dt = (b.t - a.t) / 1000;
    if (!(dt > 0)) continue;
    const ia = a.info ?? {}, ib = b.info ?? {};
    // counters: rates over the sampler's own rows; a second without a new
    // row keeps the previous rates
    const c = b.counters ?? null;
    // this reading's fresh counter window (none: rates kept from before)
    const counterWindow = c && prevCounters && c.t > prevCounters.t && delta(prevCounters.xfbCopies, c.xfbCopies) != null ? { from: prevCounters.t, to: c.t, copies: delta(prevCounters.xfbCopies, c.xfbCopies) } : null;
    if (c && prevCounters && c.t > prevCounters.t) {
      const cdt = (c.t - prevCounters.t) / 1000;
      const ticks = delta(prevCounters.ticks, c.ticks);
      carried = {
        speed: ticks != null && tps > 0 ? (ticks / tps / cdt) * 100 : null,
        discBps: delta(prevCounters.discBytes, c.discBytes) == null ? null : delta(prevCounters.discBytes, c.discBytes) / cdt,
        xfbPerSec: delta(prevCounters.xfbCopies, c.xfbCopies) == null ? null : delta(prevCounters.xfbCopies, c.xfbCopies) / cdt
      };
    }
    if (c && (!prevCounters || c.t > prevCounters.t)) prevCounters = c;
    // the worker's own rate (its last 500 ms stats window): what the
    // seconds' phases and cadence read; the cumulative count moves once per
    // stats post (~45 / ~75 at 60), the count only without the rate
    const shown = delta(ia.newShown, ib.newShown);
    const newFpsWorker = num(ib.newFps) ?? (shown != null ? shown / dt : null);
    // the new frames shown, counted present by present on the fixed 1 s grid
    // (newFrameBins): this row's bins are those whose middle is in
    // (a.t, b.t] (the readings sit near the grid's edges, early or late: one
    // bin a row, two after a skipped reading, each bin in one row); the
    // smoothness reads these only: the worker's rate saw half the second,
    // twice over
    const own = [];
    const mid = (x) => (x.from + x.to) / 2;
    while (nextBin < bins.length && mid(bins[nextBin]) <= b.t) {
      if (mid(bins[nextBin]) > a.t) own.push(bins[nextBin]);
      nextBin += 1;
    }
    const knownBins = own.filter((x) => x.newFrames != null);
    const newFps = knownBins.length ? knownBins.reduce((n, x) => n + x.newFrames, 0) / knownBins.length : null;
    const newSignal = newFps ?? newFpsWorker;
    // the worker's produced rate (0208, WebGPU only); off WebGPU (the
    // software renderer: none) the sampler's XFB copies a second, so a core
    // rendering 7 frames a second at full speed is seen (render-starved)
    // on the grid when the run recorded the produced frames (producedBins):
    // the mean of this row's known bins; else the worker's rate
    const ownProduced = produced ? own.map((x) => produced[x.k] ?? null) : null;
    const knownProduced = ownProduced ? ownProduced.filter((x) => x != null) : [];
    // a row owning no known grid second (the live loop's newest row, before
    // its second is complete): the worker's rate for the ROW's signals
    // (draws per frame, cadence, phase), never for a smoothness (the bins
    // keep their own: unknown when their production is)
    const workerProduced = num(ib.producedFps) ?? (carried?.xfbPerSec != null ? carried.xfbPerSec : null);
    const producedFps = produced && knownProduced.length ? knownProduced.reduce((n, x) => n + x, 0) / knownProduced.length : workerProduced;
    const producedFrom = produced && knownProduced.length ? "grid" : num(ib.producedFps) != null ? "worker" : carried?.xfbPerSec != null ? "xfb" : null;
    const speed = carried?.speed ?? num(ib.speed);
    const draws = delta(ia.draws, ib.draws);
    const made = producedFps != null && producedFps * dt >= 1 ? producedFps * dt : null;
    const viRate = num(b.vi) != null ? b.vi / dt : null;
    // present intervals ending in this second, the last one before it included
    let hitches50 = 0, hitches100 = 0, maxGapMs = 0;
    for (const p of b.presents ?? []) {
      if (lastPresent != null) {
        const gap = p - lastPresent;
        if (gap > HITCH_MS[0]) hitches50 += 1;
        if (gap > HITCH_MS[1]) hitches100 += 1;
        maxGapMs = Math.max(maxGapMs, gap);
      }
      lastPresent = p;
    }
    // a second with no present at all is one long gap (counted once, where it ends)
    if (!(b.presents ?? []).length && lastPresent != null) maxGapMs = Math.max(maxGapMs, b.t - lastPresent);
    const occupancy = { cpuBusy: num(ib.cpuBusy), gpuBusy: num(ib.gpuBusy), replayBusy: num(ib.replayBusy) };
    const seen = windowCadence({ newFps: newSignal, producedFps, speed, viRate, ...occupancy });
    cadence = seen ?? cadence;
    const sceneCadence = cadence ?? viCadence(viRate);
    // Content, not a loss: the game itself made fewer frames than the
    // cadence (a menu animating at 45, a screen held still) at full speed
    // with margin on every thread: the reference is what it made.
    const content = contentSecond({ producedFps, speed, cadence: sceneCadence, ...occupancy });
    const ref = content ? producedFps : sceneCadence;
    booted ||= (num(ib.newShown) ?? 0) > 0;
    rowSpeeds.push([a.t, b.t, speed]);
    const rowIndex = rows.length;
    rows.push({
      i: rows.length, t: round((b.t - t0) / 1000, 2), at: b.t, booted,
      speed: round(speed, 1), newFps: round(newFps, 1), newFpsWorker: round(newFpsWorker, 1), producedFps: round(producedFps, 1), producedFrom,
      cadence: ref, sceneCadence, content,
      // each grid second's smoothness (null: unknown); the row's, its worst
      // (on the grid: each second its own content judgement against what
      // was made in that second; what was made unknown, the second unknown)
      smoothBins: own.map((x, i) => {
        if (!produced) return { t: round((x.to - t0) / 1000, 2), newFrames: x.newFrames, smoothness: smoothOf(x.newFrames, ref) };
        // content only with a regular production (a stall that stops making
        // and showing alike is a loss); speed and occupancy are the row's
        // (the occupancy: the worker's 500 ms window)
        const made = ownProduced[i];
        const regular = made != null && regularProduction(made, producedGap[x.k], { viMs: viRate > 0 ? 1000 / viRate : undefined });
        const binContent = regular && contentSecond({ producedFps: made, speed, cadence: sceneCadence, ...occupancy });
        // an irregular production with no XFB copy left unproduced: maybe
        // the game's own pause (gamePauseReference), decided after the loop
        const win = !regular && made != null ? gamePauseWindow(counterWindow, x, allProduced) : null;
        const pauseRef = win ? gamePauseReference({ made, xfbCopies: win.copies, producedInWindow: win.produced, vis: vis?.[x.k] ?? null, viRate: nominalVi }) : null;
        const reference = binContent ? made : sceneCadence;
        const smoothness = made == null ? null : smoothOf(x.newFrames, reference);
        if (pauseRef != null) pauseBins.set(x.k, { row: rowIndex, i, from: x.from, to: x.to, smoothPause: smoothOf(x.newFrames, pauseRef) });
        return { t: round((x.to - t0) / 1000, 2), newFrames: x.newFrames, produced: made, regular, content: binContent, gamePause: false, smoothness };
      }),
      smoothness: null,
      gamePauses: [],
      viRate: round(viRate, 1), presents: (b.presents ?? []).length, hitches50, hitches100, maxGapMs: round(maxGapMs, 1),
      // the presenting worker's longest stall in the second (sampler rows)
      workerLagMs: Array.isArray(b.samplerTicks) && b.samplerTicks.length ? Math.max(...b.samplerTicks.map((x) => x[1])) : null,
      discBps: carried?.discBps == null ? null : Math.round(carried.discBps),
      // copies per frame need the worker's own produced count (off WebGPU
      // produced IS the copies: 1 by construction, so unknown)
      xfbPerFrame: (producedFrom === "worker" || producedFrom === "grid") && carried?.xfbPerSec != null && producedFps > 0 ? round(carried.xfbPerSec / producedFps, 2) : null,
      drawsPerFrame: draws != null && made ? round(draws / made, 1) : null,
      outOfOrder: delta(ia.outOfOrder, ib.outOfOrder),
      ...occupancy,
      integrity: b.integrity ?? null, film: b.film ?? null, filmFrom: a.film?.pos ?? null
    });
  }
  // the game's pauses: a candidate second is excused only when it has gaps,
  // every gap is a game pause, and every second each gap covers is excused
  // too (repeated until none changes); each pause published once, in the row
  // of the second it starts in
  const speedAt = (from, to) => rowSpeeds.filter(([a, b]) => b > from && a < to).map((x) => x[2]);
  for (const [k, c] of pauseBins) {
    c.gaps = gamePauseSpans({ producedT: allProduced, viT: allVis, from: c.from, to: c.to, viMs: nominalViMs, speedAt, gpuRows });
    c.ok = c.gaps.length > 0 && c.gaps.every((g) => g.ok);
  }
  const binOf = (t) => Math.floor((t - t0) / NEW_FRAMES_BIN_MS);
  for (let changed = true; changed;) {
    changed = false;
    for (const c of pauseBins.values()) {
      if (!c.ok) continue;
      const covered = c.gaps.every((g) => {
        for (let k = binOf(g.start); k <= binOf(g.end - 1e-6); k += 1) if (!pauseBins.get(k)?.ok) return false;
        return true;
      });
      if (!covered) { c.ok = false; changed = true; }
    }
  }
  const published = new Set();
  for (const c of pauseBins.values()) {
    if (!c.ok) continue;
    const bin = rows[c.row].smoothBins[c.i];
    bin.gamePause = true;
    bin.smoothness = c.smoothPause;
    for (const g of c.gaps) {
      if (published.has(g.start)) continue;
      published.add(g.start);
      const owner = pauseBins.get(binOf(g.start));
      rows[owner.row].gamePauses.push({ t: round((g.start - t0) / 1000, 2), durationMs: g.durationMs, filmPos: filmAt(g.start) });
    }
  }
  // a row's smoothness: its worst grid second, null unless all are known
  for (const r of rows) r.smoothness = r.smoothBins.length && r.smoothBins.every((x) => x.smoothness != null) ? Math.min(...r.smoothBins.map((x) => x.smoothness)) : null;
  return rows;
}

// One second's phase from its signals alone; null: no signal (kept from
// the second before).
export function classifySecond(r, { gameDrawsPerFrame = GAME_DRAWS_PER_FRAME } = {}) {
  if (!r.booted) return "boot";
  const disc = r.discBps ?? 0;
  const shown = r.newFps ?? r.newFpsWorker ?? 0;
  const scarce = shown < SCARCE_SHARE * (r.sceneCadence ?? r.cadence ?? 60) || (r.speed != null && r.speed < SCARCE_SPEED);
  if (disc >= LOAD_DISC_BPS && scarce) return "loading";
  if (shown < MIN_NEW_FPS) return null;
  const draws = r.drawsPerFrame;
  if ((r.xfbPerFrame != null && r.xfbPerFrame < CINEMA_XFB_PER_FRAME) || (disc >= STREAM_DISC_BPS && draws != null && draws < CINEMA_MAX_DRAWS_PER_FRAME)) return "cinematic";
  if (draws == null) return null;
  return draws >= gameDrawsPerFrame ? "game" : "menu";
}

// Seconds -> labels with hysteresis: no-signal seconds keep the label
// before (the first ones the label after), then every run shorter than
// minSec joins the run before it (the first run, the one after), repeated
// until every run lasts minSec or the series is one run. Boot is only ever a
// prefix (before the first new frame) and is never merged away.
export function phaseLabels(rows, { minSec = MIN_PHASE_SEC, ...opts } = {}) {
  const raw = rows.map((r) => classifySecond(r, opts));
  const filled = raw.slice();
  for (let i = 1; i < filled.length; i += 1) if (filled[i] == null) filled[i] = filled[i - 1];
  for (let i = filled.length - 2; i >= 0; i -= 1) if (filled[i] == null) filled[i] = filled[i + 1];
  let runs = runsOf(filled.map((x) => x ?? "menu"));
  for (let changed = true; changed && runs.length > 1;) {
    changed = false;
    for (let k = 0; k < runs.length; k += 1) {
      const r = runs[k];
      if (r.label === "boot" || r.to - r.from >= minSec) continue;
      // the run before, unless it is the boot: then the run after
      const into = k > 0 && runs[k - 1].label !== "boot" ? runs[k - 1] : runs[k + 1];
      if (!into) continue;
      runs[k] = { ...r, label: into.label };
      runs = runsOf(runs.flatMap((x) => Array(x.to - x.from).fill(x.label)));
      changed = true;
      break;
    }
  }
  return { raw, labels: runs.flatMap((x) => Array(x.to - x.from).fill(x.label)) };
}

function runsOf(labels) {
  const out = [];
  labels.forEach((l, i) => {
    if (out.length && out.at(-1).label === l) out.at(-1).to = i + 1;
    else out.push({ label: l, from: i, to: i + 1 });
  });
  return out;
}

// The phase the last seconds agree on (online: a film's marker waits for
// it), or null while they do not.
export function currentPhase(rows, { minSec = MIN_PHASE_SEC, ...opts } = {}) {
  if (rows.length < minSec) return null;
  const last = rows.slice(-minSec).map((r) => classifySecond(r, opts));
  return last.every((l) => l != null && l === last[0]) ? last[0] : null;
}

// The film's own phases (film.phases: [{ at, phase, label }], each from its
// poll to the next one's): the film clock is the same in every run, where a
// detected boundary moves with the signals under test (a lock shifting the
// race's start by a second). Each second takes the declared phase covering
// most of its film span (filmFrom, film.pos]; a span still at one poll (the
// film held at a marker) the phase at that poll. null: no film position, no
// phase declared, or the span mostly before the first declared one: the
// detector's label stands there, and wherever the film declares phase null
// (the detector from that poll on) or the run had shown no frame yet (boot).
export function filmPhaseLabels(rows, phases) {
  if (!Array.isArray(phases) || !phases.length) return rows.map(() => null);
  const spans = phases.map((p, k) => ({ from: p.at, to: phases[k + 1]?.at ?? Infinity, phase: p.phase }));
  return rows.map((r) => {
    const to = num(r.film?.pos), from = num(r.filmFrom);
    if (to == null || from == null || to < from || r.booted === false) return null;
    if (to === from) return spans.find((x) => x.from <= to && to < x.to)?.phase ?? null;
    let best = null, most = 0, covered = 0;
    for (const x of spans) {
      const over = Math.min(to, x.to) - Math.max(from, x.from);
      if (!(over > 0)) continue;
      covered += over;
      if (over > most) { most = over; best = x.phase; }
    }
    // mostly before the first declared phase: the detector's
    return covered * 2 > to - from ? best ?? null : null;
  });
}

// Runs of one phase: [{ phase, from, to }] in seconds (row indexes).
export const segmentsOf = (labels) => runsOf(labels).map((r) => ({ phase: r.label, from: r.from, to: r.to }));

const triple = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return v.length ? { min: round(Math.min(...v), 1), p5: round(percentile(v, 5), 1), median: round(median(v), 1) } : { min: null, p5: null, median: null };
};

// One phase (or section): its seconds -> the numbers a person reads and the
// flat metrics the A/B judges.
// Smoothness unknown in more than this share of a phase's grid seconds: its
// p5 is marked unreliable (an unknown second may be the worst one).
export const SMOOTH_UNKNOWN_MAX_SHARE = 0.05;
export function summarizeSeconds(rows, { integrityAllow = [] } = {}) {
  // the grid seconds (deriveSeconds smoothBins), each counted once; a row
  // without them (built by hand) is one second
  const grid = rows.flatMap((r) => (Array.isArray(r.smoothBins) ? r.smoothBins.map((x) => x.smoothness) : [r.smoothness]));
  const smoothUnknown = grid.filter((x) => x == null).length;
  const speed = triple(rows.map((r) => r.speed)), newFps = triple(rows.map((r) => r.newFps)), smooth = triple(grid);
  const smoothReliable = grid.length > 0 && smoothUnknown <= SMOOTH_UNKNOWN_MAX_SHARE * grid.length;
  // an unknown smoothness is never ranked good: it comes first
  // a row owning no grid second (two readings in one second) has no
  // smoothness of its own: left out, not ranked over a bad one
  const worst = rows.filter((r) => (Array.isArray(r.smoothBins) ? r.smoothBins.length > 0 : r.smoothness != null || r.speed != null))
    .sort((a, b) => (a.smoothness ?? -1) - (b.smoothness ?? -1) || (a.speed ?? 999) - (b.speed ?? 999))
    .slice(0, 3).map((r) => ({ t: r.t, speed: r.speed, newFps: r.newFps, smoothness: r.smoothness }));
  const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const first = rows.find((r) => r.integrity), last = rows.findLast((r) => r.integrity);
  const integrity = first && last && first !== last ? integrityOf(first.integrity, last.integrity, { allow: integrityAllow }) : null;
  const metrics = {
    seconds: rows.length, speedMedian: speed.median, speedP5: speed.p5, speedMin: speed.min,
    newFpsMedian: newFps.median, newFpsP5: newFps.p5, smoothMedian: smooth.median, smoothP5: smooth.p5, smoothMin: smooth.min,
    smoothSeconds: grid.length, smoothUnknown, smoothReliable,
    hitches50: sum("hitches50"), hitches100: sum("hitches100")
  };
  // seconds whose missing frames were the game's own (contentSecond)
  const contentSeconds = rows.filter((r) => r.content).length;
  // the game's own pauses the p5 does not count as losses (gamePauseSpans):
  // published next to it, every one
  const pauses = rows.flatMap((r) => r.gamePauses ?? []);
  const gamePauses = { count: pauses.length, durationsMs: pauses.map((p) => p.durationMs), totalMs: round(pauses.reduce((n, p) => n + p.durationMs, 0), 1), seconds: rows.reduce((n, r) => n + (r.smoothBins ?? []).filter((x) => x.gamePause).length, 0), list: pauses };
  metrics.gamePauses = gamePauses.count;
  metrics.gamePauseMs = gamePauses.totalMs;
  return {
    seconds: rows.length, contentSeconds, gamePauses, speed, newFps, smoothness: { ...smooth, seconds: grid.length, unknown: smoothUnknown, reliable: smoothReliable }, hitches50: metrics.hitches50, hitches100: metrics.hitches100, worst,
    occupancy: { cpuBusy: round(median(rows.map((r) => r.cpuBusy)), 2), gpuBusy: round(median(rows.map((r) => r.gpuBusy)), 2), replayBusy: round(median(rows.map((r) => r.replayBusy)), 2) },
    discMB: round(rows.reduce((s, r) => s + (r.discBps ?? 0), 0) / (1 << 20), 1),
    integrity: integrity ? { fatal: integrity.fatal ?? [], reported: integrity.reported ?? [] } : null,
    metrics
  };
}

// The film's markers as the run reached them: [{ ordinal, phase, label,
// at (host ms), missed }] -> completed when each was reached, in order, and
// the phases found contain the markers' phases in that order.
export function completionOf(markers, reached, segments = null) {
  const missing = [];
  let last = -Infinity, order = true;
  markers.forEach((m, k) => {
    const r = reached.find((x) => x.ordinal === k);
    if (!r || r.missed) { missing.push(m.label ?? m.phase); return; }
    if (!(r.at >= last)) order = false;
    last = r.at;
  });
  let detected = true;
  if (segments && markers.length) {
    let k = 0;
    for (const s of segments) if (k < markers.length && s.phase === markers[k].phase) k += 1;
    detected = k === markers.length;
  }
  const completed = markers.length > 0 && !missing.length && order && detected;
  return { completed, markers: markers.length, reached: markers.length - missing.length, missing, inOrder: order, phasesInOrder: detected };
}

// Sections: from each reached marker to the next (named by the marker's
// label, else its phase and ordinal); "start" before the first.
export function sectionsOf(rows, reached, markers) {
  const cuts = reached.filter((r) => !r.missed).sort((a, b) => a.at - b.at)
    .map((r) => ({ at: r.at, name: markers[r.ordinal]?.label ?? `${markers[r.ordinal]?.phase}-${r.ordinal + 1}` }));
  const out = [];
  let k = -1;
  for (const r of rows) {
    while (k + 1 < cuts.length && cuts[k + 1].at <= r.at) k += 1;
    const name = k < 0 ? "start" : cuts[k].name;
    if (!out.length || out.at(-1).name !== name) out.push({ name, rows: [] });
    out.at(-1).rows.push(r);
  }
  return out;
}

// One run: seconds, phases found, per phase kind and per section summaries,
// completion. raw: { samples, tps, markers: film markers, reached, detect }.
export function analyzeRun(raw, { integrityAllow = [] } = {}) {
  const rows = deriveSeconds(raw.samples ?? [], { tps: raw.tps });
  const { raw: rawLabels, labels } = phaseLabels(rows, raw.detect ?? {});
  // the film's declared phases first, the detector where it declares none
  const film = filmPhaseLabels(rows, raw.filmPhases);
  rows.forEach((r, i) => { r.phase = film[i] ?? labels[i]; r.rawPhase = rawLabels[i]; r.phaseFrom = film[i] ? "film" : "detector"; });
  // segments (and the completion's phase order) on the phases kept: the film's where declared
  const segments = segmentsOf(rows.map((r) => r.phase)).map((s) => ({ ...s, fromT: rows[s.from]?.t ?? null, toT: rows[s.to - 1]?.t ?? null }));
  const kinds = {};
  for (const p of PHASES) {
    const rs = rows.filter((r) => r.phase === p);
    if (rs.length) kinds[p] = summarizeSeconds(rs, { integrityAllow });
  }
  const markers = raw.markers ?? [];
  const reached = raw.reached ?? [];
  const sections = {};
  for (const s of sectionsOf(rows, reached, markers)) {
    const key = sections[s.name] ? `${s.name}#${Object.keys(sections).filter((k) => k.split("#")[0] === s.name).length + 1}` : s.name;
    const phaseSeconds = {};
    for (const r of s.rows) phaseSeconds[r.phase] = (phaseSeconds[r.phase] ?? 0) + 1;
    sections[key] = { ...summarizeSeconds(s.rows, { integrityAllow }), phases: phaseSeconds };
  }
  const all = rows.length >= 2 ? summarizeSeconds(rows, { integrityAllow }) : null;
  return {
    seconds: rows.length, newFramesBasis: newFrameBins(raw.samples ?? []).basis, producedBasis: producedBins(raw.samples ?? []).basis, completion: completionOf(markers, reached, segments), segments, phases: kinds, sections, overall: all,
    integrityFailed: Boolean(all?.integrity?.fatal?.length),
    rows: rows.map(({ integrity, film, filmFrom, at, ...r }) => ({ ...r, filmPos: film?.pos ?? null }))
  };
}

// --- A/B: pairs by phase, never by timestamp ---------------------------------
// Every phase kind ("kind:game") and every section ("section:race") of the
// runs is one comparison; its metrics are the runs' flat metrics.
// The game's pauses are judged too (analysis 8): an emulator stall the rule
// took for one raises their count and time, a regression past the noise
// (the count a Poisson count, lib/drops.mjs COUNTS).
export const PARCOURS_PRIMARY = Object.freeze({ speedMedian: "down", speedP5: "down", newFpsMedian: "down", smoothP5: "down", hitches100: "up", gamePauses: "up", gamePauseMs: "up" });
export const PARCOURS_FLOOR = Object.freeze({ speedMedian: 1, speedP5: 2, newFpsMedian: 1, smoothP5: 3, hitches100: 1, gamePauses: 1, gamePauseMs: 50 });

export function phaseMetrics(analysis) {
  const out = {};
  for (const [k, s] of Object.entries(analysis.phases ?? {})) out[`kind:${k}`] = s.metrics;
  for (const [k, s] of Object.entries(analysis.sections ?? {})) out[`section:${k}`] = s.metrics;
  return out;
}

// The A/A noise per phase key, from the runs of one side.
export function phaseNoise(analyses) {
  const byKey = {};
  for (const a of analyses) for (const [k, m] of Object.entries(phaseMetrics(a))) (byKey[k] ??= []).push(m);
  return Object.fromEntries(Object.entries(byKey).map(([k, ms]) => [k, noiseOf(ms)]));
}

// Usable runs: completed, integrity clean, not overloaded.
export const usable = (a) => Boolean(a && !a.error && a.completion?.completed && !a.integrityFailed && !a.overloaded && !a.powerDrained);

// One run's game pauses for a phase key ("kind:menu", "section:race"):
// { count, seconds, totalMs, list: [{ t, durationMs, filmPos }] }; null: the
// run has no such phase.
export function gamePausesOf(analysis, key) {
  const [kind, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  const s = kind === "kind" ? analysis.phases?.[name] : kind === "section" ? analysis.sections?.[name] : null;
  if (!s) return null;
  const g = s.gamePauses;
  return g ? { count: g.count, seconds: g.seconds, totalMs: g.totalMs, list: g.list } : { count: null, seconds: null, totalMs: null, list: [] };
}

export function parcoursVerdict(baseline, candidate, noise = null) {
  const b = baseline.filter(usable), c = candidate.filter(usable);
  const keys = [...new Set([...b, ...c].flatMap((a) => Object.keys(phaseMetrics(a))))].sort();
  const phases = {};
  for (const k of keys) {
    const of = (xs) => xs.map((a) => phaseMetrics(a)[k]).filter(Boolean);
    const v = verdictOf(of(b), of(c), { noise: noise?.[k] ?? null, floor: PARCOURS_FLOOR, metrics: PARCOURS_PRIMARY });
    // a smoothness p5 marked unreliable on either side (unknown seconds past
    // SMOOTH_UNKNOWN_MAX_SHARE: a lost read can hide the worst second) is
    // judged neither way: inconclusive
    if ([...of(b), ...of(c)].some((m) => m.smoothReliable === false)) {
      v.rows = v.rows.map((r) => (r.metric === "smoothP5" ? { ...r, regression: false, improvement: false, inconclusive: true, unreliable: true } : r));
      v.regression = v.rows.some((r) => r.regression);
      v.improvement = v.rows.some((r) => r.improvement);
      v.inconclusive = true;
    }
    // the game's pauses each side's p5 excused, run by run (published next
    // to the p5, never judged: the game's, not the emulator's)
    const pausesOf = (xs) => xs.map((a) => gamePausesOf(a, k)).filter(Boolean);
    v.gamePauses = { baseline: pausesOf(b), candidate: pausesOf(c) };
    phases[k] = v;
  }
  const regressions = Object.entries(phases).flatMap(([k, v]) => v.rows.filter((r) => r.regression).map((r) => ({ where: k, ...r })));
  return {
    usable: { baseline: b.length, candidate: c.length },
    regression: regressions.length > 0,
    improvement: Object.values(phases).some((v) => v.improvement),
    inconclusive: !keys.length || Object.values(phases).some((v) => v.inconclusive),
    regressions, phases
  };
}

// --- the autopilot's stuck signal -------------------------------------------
// Two pictures of the screen (RGBA) -> how much changed: the mean absolute
// difference of their grey levels on a GRID x GRID mesh (0-255). A kart
// pushing against a wall changes a few pixels (smoke, the HUD's clock), a
// moving one most of them.
export const STILL_GRID = 32;
export const STILL_DIFF = 6;
export function frameDiff(a, b, grid = STILL_GRID) {
  if (!a || !b || !a.width || !b.width) return null;
  let sum = 0;
  for (let gy = 0; gy < grid; gy += 1) for (let gx = 0; gx < grid; gx += 1) {
    const grey = (f) => {
      const x = Math.min(f.width - 1, Math.floor(((gx + 0.5) * f.width) / grid)), y = Math.min(f.height - 1, Math.floor(((gy + 0.5) * f.height) / grid));
      const i = (y * f.width + x) * 4;
      return 0.299 * f.data[i] + 0.587 * f.data[i + 1] + 0.114 * f.data[i + 2];
    };
    sum += Math.abs(grey(a) - grey(b));
  }
  return round(sum / (grid * grid), 2);
}

// --- timeline picture -------------------------------------------------------
export const PHASE_COLORS = Object.freeze({ boot: [200, 200, 200], loading: [250, 214, 140], cinematic: [196, 170, 240], menu: [160, 205, 250], game: [170, 230, 170] });
const GLYPHS = {
  0: "111101101101111", 1: "010110010010111", 2: "111001111100111", 3: "111001111001111", 4: "101101111001001", 5: "111100111001111", 6: "111100111101111", 7: "111001010010010", 8: "111101111101111", 9: "111101111001111",
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110", E: "111100110100111", F: "111100110100100", G: "011100101101011", H: "101101111101101", I: "111010010010111", K: "101101110101101", L: "100100100100111", M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100", R: "110101110101101", S: "011100010001110", T: "111010010010010", U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101", Y: "101101010010010",
  "%": "101001010100101", "/": "001001010100100", "-": "000000111000000", ".": "000000000000010", ":": "000010000010000", " ": "000000000000000"
};

// The run as a picture (no dependency: an RGBA buffer for savePng): speed %
// (top) and new frames a second (bottom) against time, the phases found as
// coloured bands, the film's markers as vertical lines (red: missed).
export function renderTimeline(analysis, { pxPerSec = 4, height = 320, markers = [] } = {}) {
  const rows = analysis.rows ?? [];
  const n = Math.max(1, rows.length);
  const left = 34, right = 8, top = 14, gap = 16;
  const width = Math.max(320, Math.min(4000, left + right + n * pxPerSec));
  const plotW = width - left - right;
  const panelH = Math.floor((height - top - gap - 12) / 2);
  const data = new Uint8Array(width * height * 4).fill(255);
  const put = (x, y, [r, g, b]) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  };
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) put(x, y, c); };
  const line = (x0, y0, x1, y1, c) => {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let s = 0; s <= steps; s += 1) put(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, c);
  };
  const text = (x, y, str, c = [40, 40, 40]) => {
    for (const ch of String(str).toUpperCase()) {
      const g = GLYPHS[ch] ?? GLYPHS[" "];
      for (let k = 0; k < 15; k += 1) if (g[k] === "1") put(x + (k % 3), y + Math.floor(k / 3), c);
      x += 4;
    }
  };
  const xOf = (i) => left + (i / n) * plotW;
  const panels = [
    { y0: top, key: "speed", max: 120, grid: [100, 50], label: "SPEED %" },
    { y0: top + panelH + gap, key: "newFps", max: 70, grid: [60, 30], label: "NEW FRAMES/S" }
  ];
  for (const p of panels) {
    const y1 = p.y0 + panelH;
    rows.forEach((r, i) => rect(Math.floor(xOf(i)), p.y0, Math.ceil(xOf(i + 1)), y1, PHASE_COLORS[r.phase] ?? [240, 240, 240]));
    for (const g of p.grid) { const y = y1 - (g / p.max) * panelH; for (let x = left; x < left + plotW; x += 3) put(x, y, [120, 120, 120]); text(2, y - 2, g); }
    line(left, y1, left + plotW, y1, [60, 60, 60]);
    line(left, p.y0, left, y1, [60, 60, 60]);
    text(left + 2, p.y0 - 8, p.label);
    let prev = null;
    rows.forEach((r, i) => {
      const v = r[p.key];
      if (v == null) { prev = null; return; }
      const pt = [xOf(i + 0.5), y1 - (Math.min(p.max, Math.max(0, v)) / p.max) * panelH];
      if (prev) line(prev[0], prev[1], pt[0], pt[1], [20, 40, 160]);
      else put(pt[0], pt[1], [20, 40, 160]);
      prev = pt;
    });
  }
  // markers (seconds index of the reached time), labelled at the bottom
  for (const m of markers) {
    if (m.index == null) continue;
    const x = xOf(m.index), c = m.missed ? [210, 30, 30] : [30, 30, 30];
    line(x, top, x, height - 12, c);
    text(x + 2, height - 9, String(m.label ?? m.phase).slice(0, 12), c);
  }
  // the phases' initials along the top of the first panel
  for (const s of analysis.segments ?? []) if ((s.to - s.from) * pxPerSec >= 10) text(xOf(s.from) + 2, top + 2, s.phase.slice(0, Math.max(1, Math.floor(((s.to - s.from) * pxPerSec - 4) / 4))));
  return { width, height, data };
}

// Each reached marker's second index (for renderTimeline).
export function markerIndexes(analysis, reached, markers) {
  const rows = analysis.rows ?? [];
  return markers.map((m, k) => {
    const r = reached.find((x) => x.ordinal === k);
    if (!r || r.missed || r.t == null) return { ...m, index: null, missed: true };
    const idx = rows.findIndex((row) => row.t >= r.t);
    return { ...m, index: idx < 0 ? rows.length : idx, missed: false };
  });
}
