// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Speed drops over a whole play-through (harness/probes/drop-meter.mjs),
// loads and menus included, not only a race in steady state. Pure: tested
// in tests/harness-drops.test.mjs.
//
// Inputs, all on one host clock (timeOrigin + now, ms):
//   vi       every VI output of the core { t, ticks } (complete ring)
//   presents every presentation { t }
//   rows     the worker's drop sampler (src/harness-drop-sampler.js): one
//            row per tick, cumulative counters, `lagMs` how late it ran
//   page     the page's sampler { t, lagMs, underruns }
//   markers  the scenario's labelled steps { t, label }
// Windows of `stepMs` (100 ms) cut the run. Per window:
//   speed    guest time advanced / host time, % (VI ticks interpolated at
//            the window's edges)
//   lostMs   host ms not matched by guest ms (negative: the core caught up)
//   causes   host ms the window spent in each thing that can slow it down
//            (counter differences, the sampler stalls overlapping it)
// A drop is a run of windows under DROP_SPEED (or with a long gap between
// presentations); its cause is the largest of its causes when that one
// covers at least CAUSE_MIN_SHARE of the time it lost, "uncounted-busy"
// when the CPU thread hardly slept where the time was lost (busy, in none
// of the counted waits: guest code, or a host cost nothing counts yet, as V8
// compiling region functions lazily was), else "unexplained".
// Late wake-ups (lateWake) and uncounted busy time (uncountedBusy) are
// judged per sampler row against the run's calm pace (lateWakeLoss): the
// throttle sleeps to absolute targets, so a wake-up's coalescing lateness is
// absorbed by the next sleep and costs nothing unless the row lost time
// without working more than usual.
import { describe, median, percentile, round, stdev } from "./stats.mjs";

export const STEP_MS = 100;
export const DROP_SPEED = 90;
export const HITCH_MS = [50, 100];
export const CAUSE_MIN_SHARE = 0.25;
export const STALL_MIN_MS = 20;
export const EMULATION_SLEEP_SHARE = 0.1;
// Columns that are u32 in the core and wrap (µs totals of patch 0003, the
// EFB words of 0164): unwrapped before any difference.
export const WRAPPING = new Set(["sleepLateOverflow", "jitModuleUs", "jitInstanceUs", "jitCompiles", "efbSyncs", "efbWaitUs", "discWaits", "discReads"]);
// Cause → how many host ms a window spent in it (counter differences).
export const CAUSES = {
  // the whole block compile (0167) when the core has it, else its
  // synchronous WebAssembly part (0003)
  jit: (d) => (d.jitUs != null ? d.jitUs : sum(d.jitModuleUs, d.jitInstanceUs)) / 1000,
  regions: (d) => d.regionInstallMs,
  disc: (d) => d.discWaitUs / 1000,
  gpuWait: (d) => d.flushGpuWaitUs / 1000,
  efb: (d) => d.efbWaitUs / 1000,
  pipelines: (d) => sum(d.pipelineMs, d.shaderMs),
  // the lateness that cost guest time (lateWakeLoss), else all of it
  lateWake: (d) => (d.lateWakeLossMs != null ? d.lateWakeLossMs : d.sleepLateUs / 1000),
  // host time the CPU thread worked past its calm pace in none of the
  // counted causes, where it lost time (lateWakeLoss)
  uncountedBusy: (d) => d.uncountedBusyMs
};
// Counted causes the CPU thread's busy time can go to (lateWake is sleep;
// pipelines are the replay worker's).
const BUSY_CAUSES = ["jit", "regions", "disc", "gpuWait", "efb"];
// A row is calm when its guest time is within this share of its host time;
// a row's pace is that of the calm rows of the PACE_SPAN_MS before it (a
// boot screen and a race work at very different paces), else the run's.
const CALM_SHARE = 0.02;
const PACE_SPAN_MS = 1000;

// Rows with two cumulative columns added (ms): lateWakeLossMs, the wake-up
// lateness of rows that lost guest time without working past their calm
// pace (busy host ms per guest ms, the median of the calm rows that slept
// in the PACE_SPAN_MS before, else in the run), and uncountedBusyMs, the busy time past that pace in none of the
// counted causes, up to the time the row lost. Rows unchanged when the
// sampler has no ticks, sleep or lateness columns, or no calm row slept.
export function lateWakeLoss(rows, tps) {
  if (!(tps > 0) || rows.length < 2 || !["ticks", "cpuSleepUs", "sleepLateUs"].every((c) => rows[0][c] !== undefined)) return rows;
  const steps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1], b = rows[i];
    const dd = (k) => (b[k] == null || a[k] == null ? null : b[k] - a[k]);
    const raw = [dd("ticks"), dd("cpuSleepUs"), dd("sleepLateUs")];
    // a counter missing at either edge: the row is not judged (null / 1000
    // would read as 0)
    const known = raw.every((v) => v != null && Number.isFinite(v));
    const host = b.t - a.t, guest = (raw[0] / tps) * 1000, slept = raw[1] / 1000, late = raw[2] / 1000;
    const counted = BUSY_CAUSES.reduce((sum, k) => { const v = CAUSES[k](Object.fromEntries(Object.keys(b).map((c) => [c, dd(c)]))); return sum + (Number.isFinite(v) ? Math.max(0, v) : 0); }, 0);
    const calm = known && host > 0 && guest > 0 && slept > 0 && Math.abs(guest - host) <= CALM_SHARE * host;
    steps.push({ t: b.t, known, host, guest, slept, late, counted, pace: calm ? Math.max(0, host - slept) / guest : null });
  }
  const medianOf = (xs) => { const v = xs.filter((p) => p != null).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const runPace = medianOf(steps.map((x) => x.pace));
  if (runPace == null) return rows;
  const out = [{ ...rows[0], lateWakeLossMs: 0, uncountedBusyMs: 0 }];
  let lateSum = 0, busySum = 0;
  let lo = 0;
  steps.forEach((x, i) => {
    while (steps[lo].t < x.t - x.host - PACE_SPAN_MS) lo += 1;
    const pace = medianOf(steps.slice(lo, i).map((y) => y.pace)) ?? runPace;
    const lost = x.known ? Math.max(0, x.host - x.guest) : 0;
    const excess = x.known ? Math.max(0, x.host - x.slept - pace * x.guest - x.counted) : 0;
    // one cause per row: worked past its pace more than it woke late, the
    // work lost the time; else the lateness did
    if (excess > x.late) busySum += Math.min(excess, lost);
    else lateSum += Math.min(x.late, lost);
    out.push({ ...rows[i + 1], lateWakeLossMs: lateSum, uncountedBusyMs: busySum });
  });
  return out;
}
const sum = (...xs) => xs.reduce((a, x) => a + (Number.isFinite(x) ? x : 0), 0);

// Rows as objects, wrapping columns unwrapped, sorted by time.
export function rowsOf(drained) {
  const out = [];
  const offset = {}, prev = {};
  for (const chunk of drained) {
    if (!chunk?.rows) continue;
    for (const r of chunk.rows) {
      const o = {};
      chunk.columns.forEach((c, i) => {
        let v = r[i];
        if (v != null && WRAPPING.has(c)) {
          if (prev[c] != null && v + (offset[c] ?? 0) < prev[c] - 2 ** 31) offset[c] = (offset[c] ?? 0) + 2 ** 32;
          v += offset[c] ?? 0;
          prev[c] = v;
        }
        o[c] = v;
      });
      out.push(o);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// Linear interpolation of field `k` of time-sorted points at host time t;
// null outside them or where a point lacks the field.
export function interpolate(points, k, t) {
  if (!points.length || t < points[0].t || t > points.at(-1).t) return null;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  if (a[k] == null || b[k] == null) return null;
  if (b.t === a.t) return a[k];
  return a[k] + ((b[k] - a[k]) * (t - a.t)) / (b.t - a.t);
}

// Host ms of [t0, t1) covered by stalls: a tick that ran lagMs late means
// its thread could not run during [t - lagMs, t].
export function stallOverlap(rows, t0, t1, min = STALL_MIN_MS) {
  let ms = 0;
  for (const r of rows) {
    if (!(r.lagMs >= min) || r.t < t0 || r.t - r.lagMs > t1) continue;
    ms += Math.max(0, Math.min(t1, r.t) - Math.max(t0, r.t - r.lagMs));
  }
  return ms;
}

const labelAt = (markers, t) => {
  let label = null;
  for (const m of markers) if (m.t <= t) label = m.label; else break;
  return label;
};

export function windowsOf({ vi, presents = [], rows = [], page = [], markers = [], tps, from = null, to = null, stepMs = STEP_MS }) {
  if (!(tps > 0) || vi.length < 2) return [];
  rows = lateWakeLoss(rows, tps);
  const start = Math.max(from ?? vi[0].t, vi[0].t), end = Math.min(to ?? vi.at(-1).t, vi.at(-1).t);
  const columns = rows.length ? Object.keys(rows[0]).filter((c) => c !== "t" && c !== "lagMs") : [];
  const sortedMarkers = [...markers].sort((a, b) => a.t - b.t);
  const out = [];
  let pi = 0, vj = 0;
  let lastPresent = null;
  for (let t0 = start; t0 + stepMs <= end + 1e-9; t0 += stepMs) {
    const t1 = t0 + stepMs;
    const g0 = interpolate(vi, "ticks", t0), g1 = interpolate(vi, "ticks", t1);
    const guestMs = g0 == null || g1 == null ? null : ((g1 - g0) / tps) * 1000;
    let nPresents = 0, maxGap = 0;
    while (pi < presents.length && presents[pi].t < t1) {
      if (presents[pi].t >= t0) {
        nPresents += 1;
        if (lastPresent != null) maxGap = Math.max(maxGap, presents[pi].t - lastPresent);
      }
      lastPresent = presents[pi].t;
      pi += 1;
    }
    let nVi = 0;
    while (vj < vi.length && vi[vj].t < t1) { if (vi[vj].t >= t0) nVi += 1; vj += 1; }
    const d = {};
    for (const c of columns) {
      const a = interpolate(rows, c, t0), b = interpolate(rows, c, t1);
      d[c] = a == null || b == null ? null : b - a;
    }
    const causes = {};
    for (const [k, f] of Object.entries(CAUSES)) {
      const v = f(d);
      causes[k] = Number.isFinite(v) ? Math.max(0, v) : null;
    }
    causes.workerPause = stallOverlap(rows, t0, t1);
    causes.mainPause = stallOverlap(page, t0, t1);
    out.push({
      t0, label: labelAt(sortedMarkers, t0),
      guestStart: g0 == null ? null : g0 / tps,
      speed: guestMs == null ? null : (100 * guestMs) / stepMs,
      lostMs: guestMs == null ? null : stepMs - guestMs,
      vis: (nVi * 1000) / stepMs,
      presents: nPresents, maxPresentGap: maxGap,
      xfb: d.xfbCopies ?? null, discBytes: d.discBytes ?? null, sleptMs: d.cpuSleepUs == null ? null : d.cpuSleepUs / 1000,
      gpuWorkMs: d.gpuWorkUs == null ? null : d.gpuWorkUs / 1000,
      behindMs: d.behindUs == null ? null : d.behindUs / 1000,
      // guest cycles (region counters on, else 0): in regions, in all, idle-skipped
      cycles: { region: d.regionCycles ?? null, total: d.totalCycles ?? null, idle: d.idleCycles ?? null },
      lateWakeOverflow: d.sleepLateOverflow ?? null,
      jitBlocks: d.jitBlocks ?? null, defers: d.offThreadDefers ?? null, regions: d.regionsInstalled ?? null, regionsDropped: d.regionsDropped ?? null,
      underruns: interpolateDelta(page, "underruns", t0, t1),
      causes
    });
  }
  return out;
}

function interpolateDelta(points, k, t0, t1) {
  const a = interpolate(points, k, t0), b = interpolate(points, k, t1);
  return a == null || b == null ? null : b - a;
}

// Guest/host speed over `span` consecutive windows ending at each window
// (1 s sliding by default): the series the time-under-threshold reads.
export function slidingSpeed(windows, span = 10) {
  const out = [];
  for (let i = span - 1; i < windows.length; i += 1) {
    const w = windows.slice(i - span + 1, i + 1);
    if (w.some((x) => x.speed == null)) continue;
    out.push({ t0: w[0].t0, speed: w.reduce((a, x) => a + x.speed, 0) / span, label: w[0].label });
  }
  return out;
}

// The dominant cause of a set of windows (see the header).
export function causeOf(windows) {
  const lost = windows.reduce((a, w) => a + Math.max(0, w.lostMs ?? 0), 0);
  const causes = {};
  for (const w of windows) for (const [k, v] of Object.entries(w.causes)) causes[k] = (causes[k] ?? 0) + (v ?? 0);
  const [top, ms] = Object.entries(causes).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  // Did the CPU thread sleep where the time was lost? Each window's share
  // of throttle sleep, weighted by the time it lost (the edges of a drop,
  // which lose little, weigh little).
  const weights = windows.map((w) => Math.max(0, w.lostMs ?? 0));
  const wsum = weights.reduce((a, x) => a + x, 0);
  const slept = windows.reduce((a, w) => a + (w.sleptMs ?? 0), 0);
  const sleptShare = wsum > 0 ? windows.reduce((a, w, i) => a + ((w.sleptMs ?? 0) / STEP_MS) * weights[i], 0) / wsum : null;
  let cause;
  if (top && ms >= CAUSE_MIN_SHARE * Math.max(lost, 1)) cause = top === "uncountedBusy" ? "uncounted-busy" : top;
  else if (windows.every((w) => w.sleptMs != null) && sleptShare != null && sleptShare < EMULATION_SLEEP_SHARE) cause = "uncounted-busy";
  else cause = "unexplained";
  const total = (k) => round(windows.reduce((a, w) => a + (w[k] ?? 0), 0), 1);
  return {
    cause, lostMs: round(lost, 1), causesMs: Object.fromEntries(Object.entries(causes).map(([k, v]) => [k, round(v, 1)])), sleptMs: round(slept, 1), sleptShare: round(sleptShare, 3),
    // what ran meanwhile: new JIT blocks, of them posted off thread
    // (interpreted until compiled), regions dropped, disc bytes read
    // wake-ups past 15.75 ms: causesMs.lateWake is then a lower bound
    lateWakeOverflow: total("lateWakeOverflow"),
    jitBlocks: total("jitBlocks"), defers: total("defers"), regionsDropped: total("regionsDropped"), discBytes: total("discBytes"),
    ...cycleShares(windows)
  };
}

// With the region counters on: the share of guest cycles run in regions,
// outside idle skip (the KPI's definition), and the idle-skipped share.
export function cycleShares(windows) {
  let region = 0, total = 0, idle = 0;
  for (const w of windows) {
    if (w.cycles?.total == null) return {};
    region += w.cycles.region ?? 0; total += w.cycles.total; idle += w.cycles.idle ?? 0;
  }
  if (!(total > 0)) return {};
  return { regionShare: round(region / Math.max(1, total - idle), 3), idleShare: round(idle / total, 3) };
}

// Runs of slow windows (speed under `speed`, or a present gap over the
// first hitch threshold), merged across `bridge` normal windows.
export function dropEvents(windows, { speed = DROP_SPEED, gapMs = HITCH_MS[0], bridge = 1 } = {}) {
  const slow = windows.map((w) => (w.speed != null && w.speed < speed) || w.maxPresentGap > gapMs);
  const events = [];
  let i = 0;
  while (i < windows.length) {
    if (!slow[i]) { i += 1; continue; }
    let j = i;
    while (j + 1 < windows.length && (slow[j + 1] || (j + 2 < windows.length && slow[j + 2] && bridge >= 1))) j += 1;
    const ws = windows.slice(i, j + 1);
    const speeds = ws.map((w) => w.speed).filter((s) => s != null);
    events.push({
      t0: ws[0].t0, durationMs: ws.length * STEP_MS, label: ws[0].label, guestStart: ws[0].guestStart,
      minSpeed: speeds.length ? round(Math.min(...speeds), 1) : null,
      maxPresentGap: round(Math.max(...ws.map((w) => w.maxPresentGap)), 1),
      ...causeOf(ws)
    });
    i = j + 1;
  }
  return events;
}

// Loads: windows whose disc rate, averaged over `smooth` windows around
// them, reaches `minBytesPerSec` (streamed music and movies stay under it:
// ~0.12 and ~1.8 MB/s on the local disc), merged across gaps up to
// `mergeMs`. Per load: host and guest durations; excessMs = host - guest,
// the part a player waits longer than the game itself takes (at 100 % they
// are equal).
export function loadSegments(windows, { minBytesPerSec = 2.5 * (1 << 20), smooth = 5, mergeMs = 1000, minMs = 300 } = {}) {
  const half = smooth >> 1;
  const busy = windows.filter((w, i) => {
    const around = windows.slice(Math.max(0, i - half), i + half + 1).filter((x) => x.discBytes != null);
    return around.length > 0 && w.discBytes > 0 && (around.reduce((a, x) => a + x.discBytes, 0) * 1000) / (around.length * STEP_MS) >= minBytesPerSec;
  });
  const segs = [];
  for (const w of busy) {
    const last = segs.at(-1);
    if (last && w.t0 - last.end <= mergeMs) last.end = w.t0 + STEP_MS;
    else segs.push({ start: w.t0, end: w.t0 + STEP_MS });
  }
  return segs.filter((s) => s.end - s.start >= minMs).map((s) => {
    const ws = windows.filter((w) => w.t0 >= s.start && w.t0 < s.end);
    const guestMs = ws.reduce((a, w) => a + (w.speed == null ? 0 : (w.speed * STEP_MS) / 100), 0);
    const hostMs = s.end - s.start;
    const sl = slidingSpeed(ws, Math.min(10, ws.length));
    return {
      t0: s.start, label: ws[0]?.label ?? null, guestStart: ws[0]?.guestStart ?? null,
      hostMs: round(hostMs, 0), guestMs: round(guestMs, 0), excessMs: round(hostMs - guestMs, 0),
      bytes: ws.reduce((a, w) => a + (w.discBytes ?? 0), 0),
      worstSecond: sl.length ? round(Math.min(...sl.map((x) => x.speed)), 1) : null,
      ...causeOf(ws)
    };
  });
}

const gapsOf = (events) => events.slice(1).map((e, i) => e.t - events[i].t);

// The headline numbers of one run (or one phase of it: pass its windows and
// the presents/vi of the same span).
// Host time the core stood still: over every VI interval longer than two
// fields, host minus guest time. Independent of the 100 ms grid, and never
// offset by the throttle catching up later (review of #261: a 50 ms stall
// made up afterwards could net 0 in a window).
export const STALL_GAP_MS = 2 * 1000 / 59.94;
export function stallMsOf(vi, tps) {
  if (!(tps > 0)) return null;
  let ms = 0;
  for (let i = 1; i < vi.length; i += 1) {
    const host = vi[i].t - vi[i - 1].t;
    if (host > STALL_GAP_MS) ms += Math.max(0, host - ((vi[i].ticks - vi[i - 1].ticks) / tps) * 1000);
  }
  return ms;
}

// The same quantity from the drop sampler's ticks (every 50 ms on the
// worker, independent of the VI outputs): a stall inside a long VI gap (the
// game blanking the VI, or a change that emits fewer VI entries) still
// shows. Each 50 ms interval is judged against the LOCAL speed, the median
// of the intervals within +-1 s (review of #269): under STALL_LOCAL_RATIO of
// it, its host minus guest time counts. A stall straddling two rows leaves
// each at ~0.5 (caught, even when the core catches up right after: at least
// half of it, the part sharing a row with the catch-up nets out there); a
// sustained slowness moves the local median with it (80 % for 4 s: 0); the
// throttle's bursts (rows 0.8/1.2) stay above. `ratio` 0.75 against real
// time instead reads the slowness itself (slowRowsMs, reported only).
export const STALL_LOCAL_RATIO = 0.6;
export const SLOW_PAIR_RATIO = 0.75;
const LOCAL_HALF_ROWS = 20;
const STEP_ROWS_SHARE = 0.2;
// Whether row i is in a run of 3 rows or more under 0.2 of real time.
function nearlyStoppedRun(iv, i) {
  if (!(iv[i].r < 0.2)) return false;
  let from = i, to = i;
  while (from > 0 && iv[from - 1].r < 0.2) from -= 1;
  while (to < iv.length - 1 && iv[to + 1].r < 0.2) to += 1;
  return to - from + 1 >= 3;
}
export function stallMsOfRows(rows, tps, ratio = null) {
  if (!(tps > 0)) return null;
  const iv = [];
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].ticks == null || rows[i - 1].ticks == null) continue;
    const host = rows[i].t - rows[i - 1].t, guest = ((rows[i].ticks - rows[i - 1].ticks) / tps) * 1000;
    if (host > 0) iv.push({ host, guest, r: guest / host });
  }
  if (!iv.length) return null;
  let ms = 0;
  for (let i = 0; i < iv.length; i += 1) {
    let bar;
    if (ratio != null) bar = ratio;
    else {
      const local = iv.slice(Math.max(0, i - LOCAL_HALF_ROWS), i + LOCAL_HALF_ROWS + 1).map((x) => x.r).sort((x, y) => x - y);
      const med = local[local.length >> 1];
      bar = STALL_LOCAL_RATIO * med;
      // Guest time in quanta as long as a row (66 ms steps) leaves a row
      // with no progress every few rows, SCATTERED (alternating with fast
      // rows, at most 2 in a row with the steps' rounding): skipped when over
      // 20 % of the window's rows are low and no run of them is longer. A
      // stall's low rows are contiguous: a 500 ms stall in a long VI gap
      // still counts, and a 50 ms one in a phase at 70 % (few low rows) too
      // (review of #271); a 50 ms stall inside such quantized steps does not.
      // A sustained slowness moves the median with it.
      const win = iv.slice(Math.max(0, i - LOCAL_HALF_ROWS), i + LOCAL_HALF_ROWS + 1).map((x) => x.r < bar);
      const lows = win.filter(Boolean).length;
      let run = 0, longest = 0;
      for (const low of win) { run = low ? run + 1 : 0; longest = Math.max(longest, run); }
      if (lows > STEP_ROWS_SHARE * win.length && longest <= 2) continue;
      // Where the core runs slow locally (median under 0.75), steps with a
      // 20 ms jitter or a slow phase made false stalls (review of #271: up to
      // 500 ms in 5 s): there, only a run of 3 rows or more nearly stopped
      // (under 0.2 of real time) is one.
      if (med < SLOW_PAIR_RATIO && !nearlyStoppedRun(iv, i)) continue;
    }
    if (iv[i].r < bar) ms += Math.max(0, iv[i].host - iv[i].guest);
  }
  return ms;
}

// Gaps between presents beyond their usual size, summed (ms): what the presenter
// stalled, whatever the core did meanwhile (a pipeline compile blocking the
// presenter while the core runs on: stallMs and worstSecond read 0).
// Beyond max(two fields, 1.5 x the phase's median gap): at 30 images/s two
// fields is the nominal gap and its jitter added up (A/A ~1000 ms, review
// of #267); relative to the median, only the stalls count.
export function presentExcessOf(presents) {
  const gaps = presents.slice(1).map((p, i) => p.t - presents[i].t);
  if (!gaps.length) return 0;
  const sorted = [...gaps].sort((a, b) => a - b);
  const bar = Math.max(STALL_GAP_MS, 1.5 * sorted[sorted.length >> 1]);
  return gaps.reduce((ms, g) => ms + Math.max(0, g - bar), 0);
}

// What the screen showed (--display: the worker's rAF records what each
// BeginFrame put on screen, timeline.mjs displayStats), for a change to the
// presentation itself (present-vsync: a late image is a 3-vsync interval
// on one side, a compositor drop with no trace on the other). Distinct
// images: a shown frame whose VI differs from the previous shown one.
// displayExcessMs: intervals between distinct images beyond max(2 vsyncs,
// 1.5 x the median), summed; displayRepeats3: intervals of 3 vsyncs or
// more; displayGaps100: intervals over 100 ms. Null without the counter.
// page: the page's sampler rows ({ t, rafs } cumulative). An interval of the
// worker's BeginFrames longer than MUTE_RAF_MS while the page's rAF went on
// is the worker's rAF alone being mute (headless, 1-4 s): no screen
// measurement there, not a loss (review of #265). Distinct-image intervals
// spanning one are left out of the excess, repeats and gaps, and their time
// is reported (screenUnmeasuredMs).
export const MUTE_RAF_MS = 100;
function pageRafsBetween(page, t0, t1) {
  const at = (t) => { let v = null; for (const r of page) { if (r.t > t) break; if (r.rafs != null) v = r.rafs; } return v; };
  const a = at(t0), b = at(t1);
  return a == null || b == null ? null : b - a;
}
// alive(t0, t1): whether the worker itself was running then (its sampler on
// time, presents still reaching the canvas). The worker's rAF, its sampler,
// the wgpu replay and the presenter share one thread (review of #272): a
// worker blocked (a pipeline compiled on it) silences its rAF because the
// screen IS frozen; only a live worker's silent rAF is "not measured".
export function displaySummaryOf(displayed, page = null, alive = null) {
  if (!displayed || displayed.length < 3) return null;
  const mute = [];
  if (page?.some((r) => r.rafs != null)) {
    for (let i = 1; i < displayed.length; i += 1) {
      const t0 = displayed[i - 1].t, t1 = displayed[i].t;
      if (t1 - t0 > MUTE_RAF_MS && (pageRafsBetween(page, t0, t1) ?? 0) >= 3 && (alive ? alive(t0, t1) : false)) mute.push([t0, t1]);
    }
  }
  const begin = displayed.slice(1).map((f, i) => f.t - displayed[i].t).sort((a, b) => a - b);
  const vsync = begin[begin.length >> 1];
  const distinct = [];
  for (const f of displayed) if (f.submits > 0 && (distinct.length === 0 || f.vi !== distinct.at(-1).vi)) distinct.push(f);
  if (distinct.length < 2) return { distinct: distinct.length, displayedPerSecond: 0, displayExcessMs: null, displayRepeats3: null, displayGaps100: null };
  const spans = mute.length;
  const all = distinct.slice(1).map((f, i) => ({ from: distinct[i].t, to: f.t, ms: f.t - distinct[i].t }));
  const unmeasured = all.filter((g) => mute.some(([a, b]) => a >= g.from && b <= g.to));
  const gaps = all.filter((g) => !unmeasured.includes(g)).map((g) => g.ms);
  const sorted = gaps.length ? [...gaps].sort((a, b) => a - b) : [0];
  const bar = Math.max(2 * vsync, 1.5 * sorted[sorted.length >> 1]);
  const span = (displayed.at(-1).t - displayed[0].t) / 1000;
  return {
    distinct: distinct.length, muteRafSpans: spans, screenUnmeasuredMs: round(unmeasured.reduce((a, g) => a + g.ms, 0), 0),
    // the unmeasured intervals themselves (host ms), for the per-guest-second rate
    unmeasuredSpans: unmeasured.map((g) => [g.from, g.to]),
    displayedPerSecond: span > 0 ? round(distinct.length / span, 1) : null,
    displayExcessMs: round(gaps.reduce((a, g) => a + Math.max(0, g - bar), 0), 0),
    // relative to the phase's own cadence too (review of #270): at 30
    // images/s every interval is 2 vsyncs; a repeat is 1.5 x that or more
    displayRepeats3: gaps.filter((g) => g >= Math.max(2.5 * vsync, 1.5 * sorted[sorted.length >> 1])).length,
    displayGaps100: gaps.filter((g) => g > 100).length
  };
}

// Seconds without a BeginFrame: the worker's rAF (the --display counter)
// and the page's (its rAF count per sampler tick), the longest gap of each.
// Reported, never gating: a pause of the worker's rAF alone (seen headless,
// 1-4 s, 2 visits in 12) says nothing yet about a real screen.
export function beginFrameGaps(displayed, page) {
  const worker = displayed?.length > 1 ? Math.max(...displayed.slice(1).map((f, i) => f.t - displayed[i].t)) : null;
  let pageGap = null;
  const withRafs = (page ?? []).filter((r) => r.rafs != null);
  if (withRafs.length > 1) {
    pageGap = 0;
    let since = withRafs[0].t;
    for (let i = 1; i < withRafs.length; i += 1) {
      if (withRafs[i].rafs > withRafs[i - 1].rafs) since = withRafs[i].t;
      else pageGap = Math.max(pageGap, withRafs[i].t - since);
    }
  }
  return { workerBeginFrameGapMs: worker == null ? null : round(worker, 0), pageBeginFrameGapMs: pageGap == null ? null : round(pageGap, 0) };
}

// Distinct images per guest second, the screen-unmeasured intervals left out
// of both the count (the image that closes one) and the guest time (theirs).
// Null when what is left measured is too short to be a rate (review of #286:
// 0.1 s and 2 images missing read 40 instead of 60): under MIN_MEASURED_SEC
// of guest time, or under half the phase.
export const MIN_MEASURED_SEC = 1;
export function displayedPerGuestSecOf(display, guestSec, vi, tps) {
  if (!display || !(guestSec > 0) || display.distinct == null || !(tps > 0) || vi.length < 2) return null;
  // Each span bounded to the VI timeline (review of #286: a span ending past
  // the last VI output interpolated to nothing, its time not taken out while
  // its image was); a span wholly outside takes nothing out.
  const lo = vi[0].t, hi = vi.at(-1).t;
  let out = 0, images = 0;
  for (const [a, b] of display.unmeasuredSpans ?? []) {
    const from = Math.max(a, lo), to = Math.min(b, hi);
    if (to <= from) continue;
    out += Math.max(0, (interpolate(vi, "ticks", to) - interpolate(vi, "ticks", from)) / tps);
    images += 1;
  }
  const sec = guestSec - out;
  if (!(sec >= MIN_MEASURED_SEC) || sec < guestSec / 2) return null;
  return round(Math.max(0, display.distinct - images) / sec, 2);
}

// The audio latency the page reported over these windows' span: median
// and p95 of its samples, ms (unmuted audio only; null without samples);
// audioMixerMs: the median of the mixer's part (a core with 0186).
export function audioLatencyOf(page, windows) {
  const none = { audioLatencyMs: null, audioLatencyP95Ms: null, audioMixerMs: null };
  if (!page?.length || !windows?.length) return none;
  const t0 = windows[0].t0, t1 = windows.at(-1).t0 + STEP_MS;
  const span = page.filter((r) => r.t >= t0 && r.t <= t1 && Number.isFinite(r.audioMs) && r.audioMs > 0);
  const v = span.map((r) => r.audioMs).sort((a, b) => a - b);
  const m = span.filter((r) => Number.isFinite(r.mixerMs)).map((r) => r.mixerMs).sort((a, b) => a - b);
  return v.length ? { audioLatencyMs: v[v.length >> 1], audioLatencyP95Ms: v[Math.min(v.length - 1, Math.floor(v.length * 0.95))], audioMixerMs: m.length ? m[m.length >> 1] : null } : none;
}

// Net host ms not matched by guest time over consecutive windows: each
// window's lostMs (negative while the core runs ahead, catching up) added to
// a backlog that never goes below 0, so a catch-up repays only a loss counted
// earlier in the span. A plain sum went negative when the span opened on the
// catch-up of a stall before it: the first window after a state load ran at
// 151 % repaying the load's own pause (lost -49 ms on a visit, 2026-11-03).
// The analysis's version, in summary.json: --noise refuses an A/A analysed
// with another one (re-analyse it: drop-meter.mjs --analyze <its dir>).
// 2: lostMs as a backlog never below 0 (netLostMs), 1 its plain sum.
export const ANALYSIS_VERSION = 2;

export function netLostMs(windows) {
  return windows.reduce((backlog, w) => Math.max(0, backlog + (w.lostMs ?? 0)), 0);
}

export function dropSummary({ windows, presents = [], vi = [], tps = null, rows = [], displayed = null, page = null }) {
  const guestSec = tps > 0 && vi.length > 1 ? (vi.at(-1).ticks - vi[0].ticks) / tps : null;
  // The worker alive over [t0, t1]: no sampler tick late by STALL_MIN_MS or
  // more, and presents at least every 50 ms on average.
  const alive = (t0, t1) => rows.every((r) => r.t < t0 || r.t - r.lagMs > t1 || r.lagMs < STALL_MIN_MS) &&
    presents.filter((p) => p.t >= t0 && p.t <= t1).length >= Math.floor((t1 - t0) / 50);
  const display = displaySummaryOf(displayed, page, rows.length ? alive : null);
  const sl = slidingSpeed(windows);
  const below = (x) => (sl.length ? round((100 * sl.filter((s) => s.speed < x).length) / sl.length, 2) : null);
  const pg = gapsOf(presents), vg = gapsOf(vi);
  const lost = netLostMs(windows);
  // Time lost inside drops only (never offset by the throttle catching up
  // afterwards, unlike lostMs): what a 50 ms stall on a load shows as.
  const dropLost = windows.reduce((a, w) => a + ((w.speed != null && w.speed < DROP_SPEED) || w.maxPresentGap > HITCH_MS[0] ? Math.max(0, w.lostMs ?? 0) : 0), 0);
  const host = windows.length * STEP_MS;
  const xfb = windows.reduce((a, w) => a + (w.xfb ?? 0), 0);
  return {
    hostSec: round(host / 1000, 1),
    // net host ms not matched by guest time: a catch-up repays only a loss
    // counted earlier in the span (netLostMs), never below 0
    lostMs: round(lost, 0), dropLostMs: round(dropLost, 0),
    // the larger of the two readings: VI intervals, sampler rows
    stallMs: round(Math.max(stallMsOf(vi, tps) ?? 0, stallMsOfRows(rows, tps) ?? 0), 0),
    stallViMs: round(stallMsOf(vi, tps), 0), stallRowsMs: round(stallMsOfRows(rows, tps), 0),
    slowRowsMs: round(stallMsOfRows(rows, tps, SLOW_PAIR_RATIO), 0),
    presentExcessMs: round(presentExcessOf(presents), 0),
    // images per GUEST second (review of #269: a cadence halved, 60 -> 30
    // with the core at 100 %, moves no gap past the median): presents, and
    // with --display the distinct images shown
    presentsPerGuestSec: guestSec > 0 ? round(presents.length / guestSec, 2) : null,
    ...(display ?? {}),
    // without the unmeasured intervals, at either end (review of #272): the
    // image closing each one and the guest time it spans
    displayedPerGuestSec: displayedPerGuestSecOf(display, guestSec, vi, tps),
    ...(displayed || page ? beginFrameGaps(displayed, page) : {}),
    pctBelow95: below(95), pctBelow90: below(90),
    worstSecond: sl.length ? round(Math.min(...sl.map((s) => s.speed)), 1) : null,
    hitches50: pg.filter((g) => g > HITCH_MS[0]).length, hitches100: pg.filter((g) => g > HITCH_MS[1]).length,
    viGaps50: vg.filter((g) => g > HITCH_MS[0]).length, viGaps100: vg.filter((g) => g > HITCH_MS[1]).length,
    presentP99: round(percentile(pg, 99), 1), presentMax: pg.length ? round(Math.max(...pg), 1) : null,
    gameFps: host > 0 ? round((xfb * 1000) / host, 1) : null,
    underruns: windows.reduce((a, w) => a + (w.underruns ?? 0), 0),
    // audio queued after the mixer (page sampler; null before the audio runs)
    ...audioLatencyOf(page, windows)
  };
}

// Per labelled phase of the scenario: the same summary over its windows.
export function phaseSummaries({ windows, presents = [], vi = [], tps = null, rows = [], displayed = null, page = null }) {
  const labels = [...new Set(windows.map((w) => w.label))];
  return labels.map((label) => {
    const ws = windows.filter((w) => w.label === label);
    const t0 = ws[0].t0, t1 = ws.at(-1).t0 + STEP_MS;
    const inside = (e) => e.t >= t0 && e.t < t1;
    // the VI entry just before the phase too: its first interval counts
    const first = vi.findIndex(inside);
    const phaseVi = first > 0 ? vi.slice(first - 1).filter((e, i) => i === 0 || inside(e)) : vi.filter(inside);
    const r0 = rows.findIndex(inside);
    const phaseRows = r0 > 0 ? rows.slice(r0 - 1).filter((e, i) => i === 0 || inside(e)) : rows.filter(inside);
    return { label, ...dropSummary({ windows: ws, presents: presents.filter(inside), vi: phaseVi, tps, rows: phaseRows, displayed: displayed ? displayed.filter(inside) : null, page: page ? page.filter(inside) : null }) };
  });
}

// The worst drops of a run, by host time lost.
export function worstDrops(events, n = 5) {
  return [...events].sort((a, b) => b.lostMs - a.lostMs).slice(0, n);
}

// A/A: each metric's spread over repeated runs of the same build. minDiff:
// the smallest difference between the medians of two series of n runs that
// is unlikely to be noise (about 2 standard errors of a difference).
export const TRIM_MIN_RUNS = 10;
export function noiseOf(summaries) {
  const keys = [...new Set(summaries.flatMap((s) => Object.keys(s)))].filter((k) => summaries.some((s) => typeof s[k] === "number"));
  return Object.fromEntries(keys.map((k) => {
    const xs = summaries.map((s) => s[k]).filter(Number.isFinite);
    const sd = stdev(xs);
    // Robust spread (1.4826 x the median absolute deviation): one run far off
    // (a multi-second BeginFrame gap) no longer widens the threshold of a
    // phase for every later comparison; such runs are counted, not dropped.
    const med = median(xs);
    const mad = xs.length ? median(xs.map((x) => Math.abs(x - med))) : null;
    const robustSd = mad == null ? null : 1.4826 * mad;
    // Outliers (beyond 5 robust sds, where the MAD is not 0) are always
    // counted. They are left out of the threshold's sd only with an A/A of
    // TRIM_MIN_RUNS or more (review of #271: from 6 runs the MAD itself is
    // noisy, a normal run went out 6.6 % of the time and the confirmed false
    // positives rose from 0.45 to 5 %), with the degrees of freedom of the
    // runs kept.
    const far = (x) => robustSd > 0 && Math.abs(x - med) > 5 * robustSd;
    const kept = xs.filter((x) => !far(x));
    const outliers = xs.length - kept.length;
    // ...and only when it is rare, a single run (review of #271: recurring
    // outliers, 10 % of runs, are part of the noise: trimmed, 3 % confirmed).
    const trim = outliers === 1 && xs.length >= TRIM_MIN_RUNS;
    return [k, { ...describe(xs, 2), robustSd: round(robustSd, 2), outliers,
      ...(trim ? { trimmedSd: round(stdev(kept), 2), keptN: kept.length } : {}),
      minDiff: sd == null || xs.length < 2 ? null : round(2 * sd * Math.sqrt(2 / xs.length), 2) }];
  }));
}

// A native reference (research/native-dolphin): [{ guestSec, frames }] of
// one play-through of the same scenario. Game frames per guest second over
// [g0, g1]: what the game shows at full speed there.
export function nativeFps(reference, g0, g1) {
  const inside = reference.filter((r) => r.guestSec >= g0 && r.guestSec <= g1);
  if (inside.length < 2) return null;
  const a = inside[0], b = inside.at(-1);
  return b.guestSec > a.guestSec ? round((b.frames - a.frames) / (b.guestSec - a.guestSec), 1) : null;
}

export { median };

// The metrics a merge guard judges, and which way is worse. Few on purpose
// (each one is a test; review of #261): per phase, the time the core stood
// still (stallMs) and the gaps over 50 ms between presents; per visit, the
// hitches over 100 ms and the worst second. Others are reported, never gating.
export const VISIT_PRIMARY = { hitches100: "up", worstSecond: "down" };
export const PHASE_PRIMARY = { stallMs: "up", presentExcessMs: "up", hitches50: "up", presentsPerGuestSec: "down" };
// With --display, what the screen showed replaces the presentation timeline
// in the gating (review of #265: present-vsync changes the presentations
// themselves); the presentation metrics stay reported.
export const VISIT_PRIMARY_DISPLAY = { displayGaps100: "up", worstSecond: "down" };
export const PHASE_PRIMARY_DISPLAY = { stallMs: "up", displayExcessMs: "up", displayRepeats3: "up", displayedPerGuestSec: "down", screenUnmeasuredMs: "up" };
export const REPORTED = { lostMs: "up", dropLostMs: "up", slowRowsMs: "up", pctBelow95: "up", pctBelow90: "up", hitches50: "up", presentP99: "up", loadExcessMs: "up" };
export const GUARDED = { ...VISIT_PRIMARY, ...REPORTED };
export const VERDICT_MIN_RUNS = 3;
export const COUNTS = new Set(["hitches50", "hitches100", "displayRepeats3", "displayGaps100"]);
export const Z_COUNTS = 2.576;
// A median of n runs varies ~1.25x more than a mean.
export const MEDIAN_SE = 1.25;
// Student's t, two-sided 1 % (0.995), by degrees of freedom: the A/A's sd is
// itself estimated from few runs (review of #261: with 2.5 and an sd from 6
// runs, ~40 % of identical batches showed a "regression").
const T995 = [63.657, 9.925, 5.841, 4.604, 4.032, 3.707, 3.499, 3.355, 3.25, 3.169, 3.106, 3.055, 3.012, 2.977, 2.947, 2.921, 2.898, 2.878, 2.861, 2.845, 2.831, 2.819, 2.807, 2.797, 2.787, 2.779, 2.771, 2.763, 2.756, 2.75];
export const tQuantile = (df) => (df < 1 ? Infinity : df <= T995.length ? T995[df - 1] : 2.576);
export const VERDICT_FLOOR = { displayGaps100: 1, lostMs: 50, dropLostMs: 20, pctBelow95: 0.5, pctBelow90: 0.5, worstSecond: 5, hitches50: 2, hitches100: 1, presentP99: 2, loadExcessMs: 50 };
// Per phase: a 50 ms stall on a stable load must show (floor 20 ms), and
// one new gap over 50 ms (floor 0.5: a whole one beyond the noise).
export const PHASE_FLOOR = { screenUnmeasuredMs: 100, presentsPerGuestSec: 3, displayedPerGuestSec: 3, stallMs: 20, presentExcessMs: 20, displayExcessMs: 20, displayRepeats3: 0.5, displayGaps100: 0.5, hitches50: 0.5, dropLostMs: 20, lostMs: 20, pctBelow95: 0.5, pctBelow90: 0.5, worstSecond: 5, hitches100: 1, presentP99: 5 };

// Candidate against baseline over runs of one visit (or one phase). A metric
// regresses when its median moved the worse way by more than
// max(floor, t x 1.25 x sd x sqrt(2/n)): t of Student at the sd's degrees
// of freedom, sd from an A/A of this probe (noise[k].stdev) else from the
// two sides. Fewer than VERDICT_MIN_RUNS
// usable runs on a side, or none: inconclusive, never "no regression".
export function verdictOf(baseline, candidate, { noise = null, floor = VERDICT_FLOOR, metrics = { ...VISIT_PRIMARY } } = {}) {
  const rows = [];
  for (const [k, worse] of Object.entries(metrics)) {
    const b = baseline.map((s) => s[k]).filter(Number.isFinite), c = candidate.map((s) => s[k]).filter(Number.isFinite);
    const n = Math.min(b.length, c.length);
    const base = { metric: k, baseline: b.length ? round(median(b), 2) : null, candidate: c.length ? round(median(c), 2) : null };
    if (n < VERDICT_MIN_RUNS) {
      rows.push({ ...base, delta: null, threshold: null, regression: false, improvement: false, inconclusive: true });
      continue;
    }
    const delta = median(c) - median(b);
    const fromAa = noise?.[k]?.stdev != null && noise[k].n > 1;
    // The A/A's sd without its outlier runs when it had some (one run far off
    // does not widen the threshold); its plain sd otherwise.
    let sd = fromAa ? (noise[k].trimmedSd ?? noise[k].stdev) : Math.sqrt(((stdev(b) ?? 0) ** 2 + (stdev(c) ?? 0) ** 2) / 2);
    const aaDf = fromAa ? (noise[k].trimmedSd != null ? noise[k].keptN : noise[k].n) - 1 : null;
    // A count (hitches) varies at least as a Poisson count: an A/A that saw
    // the same count six times says sd 0, not that a gap cannot come and go.
    let poisson = false;
    if (COUNTS.has(k)) {
      const floorSd = Math.sqrt((fromAa ? noise[k].mean ?? noise[k].median ?? 0 : median(b)) + 0.5);
      if (floorSd >= sd) { sd = floorSd; poisson = true; }
    }
    // Where the Poisson floor sets the sd, it is a model, not an estimate:
    // the normal quantile, not Student's (review of #267: t x a floor made
    // hitches nearly blind, +5 hitches needed at a mean of 1).
    const t = poisson ? Z_COUNTS : tQuantile(fromAa ? aaDf : b.length + c.length - 2);
    const threshold = Math.max(t * MEDIAN_SE * sd * Math.sqrt(2 / n), floor[k] ?? 0);
    const worseBy = worse === "up" ? delta : -delta;
    rows.push({ ...base, delta: round(delta, 2), threshold: round(threshold, 2), regression: worseBy > threshold, improvement: -worseBy > threshold });
  }
  return { regression: rows.some((r) => r.regression), improvement: rows.some((r) => r.improvement), inconclusive: rows.length === 0 || rows.some((r) => r.inconclusive), rows };
}

// One visit's gating verdict: the visit's primaries and every phase's.
// sides: { baseline: [analysis], candidate: [analysis] } (usable runs only);
// noise: { run, phases } from an A/A summary, or null.
export function visitVerdict(baseline, candidate, noise = null, { display = false } = {}) {
  const visitMetrics = display ? VISIT_PRIMARY_DISPLAY : VISIT_PRIMARY, phaseMetrics = display ? PHASE_PRIMARY_DISPLAY : PHASE_PRIMARY;
  const visit = verdictOf(baseline.map((a) => a.summary), candidate.map((a) => a.summary), { noise: noise?.run ?? null, metrics: visitMetrics });
  const reported = verdictOf(baseline.map((a) => a.summary), candidate.map((a) => a.summary), { noise: noise?.run ?? null,
    metrics: display ? { ...REPORTED, hitches100: "up", presentExcessMs: "up" } : REPORTED });
  const labels = [...new Set([...baseline, ...candidate].flatMap((a) => a.phases.map((p) => p.label)))];
  const phaseOf = (list, label) => list.map((a) => a.phases.find((p) => p.label === label)).filter(Boolean);
  const phases = Object.fromEntries(labels.map((label) => [label,
    verdictOf(phaseOf(baseline, label), phaseOf(candidate, label), { noise: noise?.phases?.[label] ?? null, floor: PHASE_FLOOR, metrics: phaseMetrics })]));
  const all = [visit, ...Object.values(phases)];
  const regressions = [
    ...visit.rows.filter((r) => r.regression).map((r) => ({ where: "visit", ...r })),
    ...Object.entries(phases).flatMap(([label, v]) => v.rows.filter((r) => r.regression).map((r) => ({ where: label, ...r })))
  ];
  return { regression: regressions.length > 0, inconclusive: all.some((v) => v.inconclusive), improvement: all.some((v) => v.improvement), regressions, visit, phases, reported };
}

// One line of the nightly trend (measures/drops/trend.jsonl) and the table
// regenerated from all of them.
export function trendLine({ at, commit, visitSummary }) {
  return {
    at, commit,
    visits: visitSummary.map((v) => ({ visit: v.visit, runs: v.runs, ...Object.fromEntries(Object.keys(GUARDED).map((k) => [k, v.noise[k]?.median ?? null])), top: v.worst.slice(0, 3).map((d) => `${d.label}:${d.cause}:${Math.round(d.lostMs)}ms`) }))
  };
}

export function trendTable(lines) {
  const head = ["date", "commit", "visit", "runs", ...Object.keys(GUARDED), "top drops"];
  const out = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const l of lines) for (const v of l.visits) out.push(`| ${l.at.slice(0, 16)} | ${String(l.commit).slice(0, 8)} | ${v.visit === 1 ? "cold" : "warm"} | ${v.runs} | ${Object.keys(GUARDED).map((k) => v[k] ?? "–").join(" | ")} | ${v.top.join(", ")} |`);
  return out.join("\n") + "\n";
}

// ---- Dip attribution (one tool for drop-meter and parcours) --------------
// Where a run's smoothness went, frame by frame. Input: a sequence of
// windows in host time, from any probe (an adapter per probe):
//   { t, ms, phase?, cadence?, speed?, produced?, shown?, presents?,
//     gaps?: [{ ms, vis, workerLagMs? }]  (presentation gaps ending in it;
//                                         vis null when not measured),
//     beatFrames?                         (repeats proven by beatEvidence),
//     occupancy?: { cpu, gpu, replay }   (0..1; null when not measured),
//     causes?: { <cause>: host ms }      (counter differences),
//     mainLagMs?, workerLagMs? }
// produced: new game frames (XFB copies or new frame tags), shown: new
// frames put on screen, presents: presentations (new or repeated).
// cadence: the scene's frames per second (a 30 fps menu, a 60 fps race in
// one run), else opts.cadence; a second never spans two cadences.
// Per second (ATTRIBUTION_SECOND_MS) the deficit is cadence − shown, split
// into parts that add up to it exactly:
//   production gap = min(cadence − produced, deficit):
//     emulation:<cause>  the guest ran under ATTRIBUTION_FULL_SPEED %: shared
//                        in proportion to the counted causes' ms over the
//                        time lost (all of it when they cover it), the rest
//                        emulation:unexplained
//     game:<thread>      full speed, a thread saturated (≥ ATTRIBUTION_BUSY)
//     content            full speed, cpu, gpu and replay ALL known and under
//                        ATTRIBUTION_CONTENT_BUSY (the margin the site needs
//                        to learn a cadence), produced under
//                        ATTRIBUTION_CONTENT_SHARE of the cadence: the scene's
//                        own cadence; 0 frames lost
//     marginal           full speed, all known, none saturated, one between
//                        ATTRIBUTION_CONTENT_BUSY and ATTRIBUTION_BUSY: content
//                        or game, undecided; not counted lost, reported
//                        apart (marginalFrames)
//     game:marginal      full speed, all known and quiet, produced near the
//                        cadence yet short
//     game:unknown       full speed, an occupancy not measured
//     production:unknown the speed not measured
//   presentation gap = deficit − production gap:
//     presenter-blocked  gaps during which the core produced VIs while the
//                        presenting worker lagged (vis and lateness measured)
//     beat               repeats proven by beatEvidence (frame by frame: the
//                        missed frame's arrival phase on the measured vsync
//                        grid at the run's boundary, the phase crossing it)
//     no-present         cadence − presents (presents measured)
//     old-frame          presented, but an older picture
//     pacing:unknown     what the data cannot split (presents not measured)
// Markers per second, not parts: main-stall (the page's sampler late) and
// gc-probable (the worker late with no counted work).
// Seconds under `fluidity` % (shown / cadence) are the dips; the table ranks
// parts by frames over the dips, per phase when windows carry one.
// Thresholds are the caller's: nothing here knows a game or a scene.
export const ATTRIBUTION_SECOND_MS = 1000;
export const ATTRIBUTION_FULL_SPEED = 99;
export const ATTRIBUTION_BUSY = 0.85;
export const ATTRIBUTION_CONTENT_BUSY = 0.7;
export const ATTRIBUTION_CONTENT_SHARE = 0.95;
export const ATTRIBUTION_FLUIDITY = 95;
export const ATTRIBUTION_HITCH_MS = 25;
export const ATTRIBUTION_EMULATION_CAUSES = ["jit", "regions", "disc", "slot", "efb", "gpuWait", "pipelines", "lateWake", "uncountedBusy"];
const OCCUPANCY_THREADS = ["cpu", "gpu", "replay"];

const sumOf = (xs, f) => xs.reduce((a, x) => a + (Number.isFinite(f(x)) ? f(x) : 0), 0);
// a window's cause in ms, floored at 0 per window (a negative counter delta
// in one window never cancels a positive one in another)
const causeMs = (w, c) => { const v = w?.causes?.[c]; return Number.isFinite(v) && v > 0 ? v : 0; };
// parts of the deficit that are not frames lost: the scene's own cadence,
// and the undecided margin between it and a busy thread
const NOT_LOST = new Set(["content", "marginal"]);
const allKnown = (xs, f) => xs.length > 0 && xs.every((x) => Number.isFinite(f(x)));

// The run's standard VI rate: the median over its windows of VIs × 100 /
// speed (a stall or a stale speed in a few seconds does not move it),
// snapped to 59.94 or 50 within 3 %; null without VI counts and speeds.
export function standardViHz(windows) {
  const rates = windows.filter((w) => Number.isFinite(w.vis) && w.speed > 0 && w.ms > 0).map((w) => (w.vis * 1000 * 100) / (w.ms * w.speed)).sort((a, b) => a - b);
  if (rates.length < 3) return null;
  const med = rates[rates.length >> 1];
  return [59.94, 50].find((hz) => Math.abs(med / hz - 1) <= 0.03) ?? null;
}

// The content rule, the one definition (attribution, parcours smoothness):
// the game made fewer frames than the scene's cadence (under contentShare of
// it) at full speed, with every thread measured and under contentBusy (the
// site's margin). Its missing frames are the scene's own, not lost.
export function contentRule({ speed, produced, expected, occupancy = {} }, { fullSpeed = ATTRIBUTION_FULL_SPEED, contentBusy = ATTRIBUTION_CONTENT_BUSY, contentShare = ATTRIBUTION_CONTENT_SHARE } = {}) {
  // every input measured: null >= 0 is true in JS, and an unknown value
  // must never pass as content (nor its frames as not lost)
  if (!Number.isFinite(speed) || !Number.isFinite(produced) || !Number.isFinite(expected)) return false;
  if (!(speed >= fullSpeed) || !(produced >= 0) || !(expected > 0)) return false;
  return OCCUPANCY_THREADS.every((k) => Number.isFinite(occupancy[k]) && occupancy[k] < contentBusy) && produced < contentShare * expected;
}

// One second's split (frames). null when it lacks produced or shown.
export function attributeSecond(ws, { cadence, viHz = null, fullSpeed = ATTRIBUTION_FULL_SPEED, busy = ATTRIBUTION_BUSY, contentBusy = ATTRIBUTION_CONTENT_BUSY, contentShare = ATTRIBUTION_CONTENT_SHARE, stallMs = STALL_MIN_MS } = {}) {
  if (!allKnown(ws, (w) => w.produced) || !allKnown(ws, (w) => w.shown)) return null;
  const hostMs = sumOf(ws, (w) => w.ms);
  // a cadence never exceeds the run's standard VI rate (viHz: 50 or 59.94):
  // over it by more than 2 %, it is that rate. Never the second's own VI
  // count: in a stall it falls while the speed read may be stale, and the
  // frames owed must not fall with it.
  const cadenceOf = (w) => { const c = w.cadence ?? cadence; return viHz > 0 && c > 1.02 * viHz ? viHz : c; };
  const expected = sumOf(ws, (w) => (cadenceOf(w) * w.ms) / 1000);
  const produced = sumOf(ws, (w) => w.produced), shown = sumOf(ws, (w) => w.shown);
  const presents = allKnown(ws, (w) => w.presents) ? sumOf(ws, (w) => w.presents) : null;
  const speed = allKnown(ws, (w) => w.speed) ? sumOf(ws, (w) => w.speed * w.ms) / hostMs : null;
  // a thread's occupancy: known only when every window measured it
  const occ = {};
  for (const k of OCCUPANCY_THREADS) occ[k] = allKnown(ws, (w) => w.occupancy?.[k]) ? Math.max(...ws.map((w) => w.occupancy[k])) : null;
  const saturated = OCCUPANCY_THREADS.filter((k) => occ[k] != null && occ[k] >= busy);
  const parts = {};
  const add = (k, f) => { if (f > 1e-9) parts[k] = (parts[k] ?? 0) + f; };
  const deficit = Math.max(0, expected - shown);
  // the production gap, never more than the deficit (shown can exceed
  // produced: a frame produced in the second before, counters' edges)
  const productionGap = Math.min(deficit, Math.max(0, expected - produced));
  if (productionGap > 0) {
    if (speed == null) add("production:unknown", productionGap);
    else if (speed < fullSpeed) {
      // shared in proportion: each cause its ms over the time lost; when the
      // counted ms exceed the time lost, scaled down together (no cause is
      // favoured by its place in a list)
      const lostMs = Math.max(1, hostMs - (speed * hostMs) / 100);
      const ms = Object.fromEntries(ATTRIBUTION_EMULATION_CAUSES.map((c) => [c, sumOf(ws, (w) => causeMs(w, c))]));
      const counted = Object.values(ms).reduce((a, x) => a + x, 0);
      const scale = counted > lostMs ? lostMs / counted : 1;
      let left = productionGap;
      for (const c of ATTRIBUTION_EMULATION_CAUSES) {
        const f = (productionGap * ms[c] * scale) / lostMs;
        add(`emulation:${c}`, f);
        left -= f;
      }
      add("emulation:unexplained", left);
    } else if (saturated.length) add(`game:${saturated.join("+")}`, productionGap);
    else if (OCCUPANCY_THREADS.some((k) => occ[k] == null)) add("game:unknown", productionGap);
    else if (contentRule({ speed, produced, expected, occupancy: occ }, { fullSpeed, contentBusy, contentShare })) add("content", productionGap);
    else if (OCCUPANCY_THREADS.some((k) => occ[k] >= contentBusy)) add("marginal", productionGap);
    else add("game:marginal", productionGap);
  }
  // the presentation gap: the rest of the deficit
  let presentationGap = deficit - productionGap;
  if (presentationGap > 0) {
    let blocked = 0;
    for (const w of ws) for (const g of w.gaps ?? []) {
      const frameMs = 1000 / cadenceOf(w);
      const lag = g.workerLagMs ?? w.workerLagMs;
      if (g.ms > frameMs * 1.5 && g.vis != null && g.vis > 0 && lag != null && lag >= g.ms / 2) blocked += Math.max(0, Math.round(g.ms / frameMs) - 1);
    }
    blocked = Math.min(blocked, presentationGap);
    add("presenter-blocked", blocked);
    presentationGap -= blocked;
    const beat = Math.min(presentationGap, sumOf(ws, (w) => w.beatFrames));
    add("beat", beat);
    presentationGap -= beat;
    if (presents == null) add("pacing:unknown", presentationGap);
    else {
      const noPresent = Math.min(presentationGap, Math.max(0, expected - presents));
      add("no-present", noPresent);
      add("old-frame", presentationGap - noPresent);
    }
  }
  const counted = sumOf(ws, (w) => sumOf(ATTRIBUTION_EMULATION_CAUSES, (c) => causeMs(w, c)));
  const markers = [];
  if (sumOf(ws, (w) => w.mainLagMs) >= stallMs) markers.push("main-stall");
  if (sumOf(ws, (w) => w.workerLagMs) >= stallMs && counted < stallMs) markers.push("gc-probable");
  const lost = Object.entries(parts).filter(([k]) => !NOT_LOST.has(k)).reduce((a, [, f]) => a + f, 0);
  return {
    t: ws[0].t, phase: ws[0].phase ?? null, hostMs, expected: round(expected, 1), produced, shown, presents,
    speed: speed == null ? null : round(speed, 1), occupancy: occ,
    fluidity: expected > 0 ? round((100 * shown) / expected, 1) : null, deficit: round(deficit, 2),
    lostFrames: round(lost, 2), parts: Object.fromEntries(Object.entries(parts).map(([k, f]) => [k, round(f, 2)])), markers
  };
}

// The run's seconds, its dips (under `fluidity`), its hitches (presentation
// gaps over `hitchMs`, each classed by its own gap) and the table: per
// phase, each part's frames over the dips, ranked.
export function attributeDips(windows, { cadence, viHz = null, fluidity = ATTRIBUTION_FLUIDITY, hitchMs = ATTRIBUTION_HITCH_MS, secondMs = ATTRIBUTION_SECOND_MS, ...opts } = {}) {
  const ws = [...windows].filter((w) => Number.isFinite(w.t) && w.ms > 0).sort((a, b) => a.t - b.t);
  viHz ??= standardViHz(ws);
  opts = { ...opts, viHz };
  if (!(cadence > 0) && !ws.every((w) => w.cadence > 0)) throw new Error("attributeDips: the scene's cadence (frames per second) is the caller's: opts.cadence, or window.cadence on every window");
  const seconds = [];
  let group = [];
  for (const w of ws) {
    // a second closes on its span from the first window's start, or when the
    // window would take its duration past 5 % over a second (rows of 0.99 s
    // and 1.01 s are two seconds, never one of 2 s)
    const groupMs = sumOf(group, (x) => x.ms);
    if (group.length && (w.t - group[0].t >= secondMs || groupMs + w.ms > 1.05 * secondMs || (w.phase ?? null) !== (group[0].phase ?? null) || (w.cadence ?? cadence) !== (group[0].cadence ?? cadence))) {
      seconds.push(group);
      group = [];
    }
    group.push(w);
  }
  if (group.length) seconds.push(group);
  const attributed = seconds.filter((g) => sumOf(g, (w) => w.ms) >= secondMs / 2).map((g) => attributeSecond(g, { cadence, ...opts })).filter(Boolean);
  const dips = attributed.filter((s) => s.fluidity != null && s.fluidity < fluidity);
  const hitches = [];
  for (const w of ws) for (const g of w.gaps ?? []) {
    if (!(g.ms > hitchMs)) continue;
    const frameMs = 1000 / (w.cadence ?? cadence);
    hitches.push({ t: w.t, phase: w.phase ?? null, ms: round(g.ms, 1), frames: Math.max(1, Math.round(g.ms / frameMs) - 1), cause: hitchCause(g, w, { frameMs }) });
  }
  return { cadence: cadence ?? null, seconds: attributed.length, dips, hitches, table: attributionTable(dips, hitches) };
}

// A presentation gap's cause, from the gap itself, when measured: the core
// kept producing VIs through it (within 1.5 frames) — the presentation side
// (presenter-blocked when the presenting worker lagged half the gap and its
// lateness is known, else no-present); else the guest fell behind — its
// window's largest counted cause (emulation:<cause>, else
// emulation:unexplained). Not measured (vis null): unknown.
export function hitchCause(gap, window, { frameMs } = {}) {
  if (gap.vis == null || !(frameMs > 0)) return "unknown";
  if (gap.vis >= gap.ms / frameMs - 1.5) {
    const lag = gap.workerLagMs ?? window.workerLagMs;
    return gap.vis > 0 && lag != null && lag >= gap.ms / 2 ? "presenter-blocked" : "no-present";
  }
  const top = ATTRIBUTION_EMULATION_CAUSES.map((c) => [c, causeMs(window, c)]).sort((a, b) => b[1] - a[1])[0];
  return top && top[1] > 0 ? `emulation:${top[0]}` : "emulation:unexplained";
}

// A steady period from timestamps (ms): t regressed on the number of
// periods elapsed, pooled over the steady stretches.
// 1. Counting: each timestamp's period number n comes from its stretch's
//    smoothed intercept (the mean of t − n·median over its last `countSpan`
//    points), so one jittered timestamp never shifts the count of the ones
//    after it; a missed vsync counts whole when `wholeSkips`, else n must
//    step by one; a lone timestamp off the count is skipped, two in a row
//    end the stretch.
// 2. Steadiness: the local period, by regression over ±`localSpan` points of
//    its stretch (precise to ~0.05 % even at 3 ms of jitter), must lie within
//    `slopeTolerance` of the median local period: a stretch a few per cent
//    slow (a VI at 96 % speed) is cut out, never pooled.
// 3. Fit, then `trims` passes drop points more than `trimSigmas` residual
//    sigmas off (a dropped point leaves its stretch whole).
// 4. One rate: blocks of `blockSize` points fitted alone, each against the
//    median block within `blockSigmas` of its own standard errors; off
//    blocks are cut out (blockMode "exclude", the VI) or make it null
//    ("reject", the screen).
// Returns { periodMs, sigmaMs (one timestamp's residual jitter), seHz (the
// rate's standard error), n, kept (share of timestamps fitted), skips
// (share of intervals spanning several periods) } or null with fewer than
// `min` timestamps, fewer than half of them fitted, a rate less precise
// than `maxSeHz`, or under `wholeShare` of the intervals spanning a whole
// number of fitted periods (two rates mixed).
export function fitPeriod(times, opts = {}) {
  const { min = 600, wholeShare = 0.7 } = opts;
  if (!times || times.length < min) return null;
  const d = times.slice(1).map((t, i) => t - times[i]).filter((x) => x > 0);
  const sorted = [...d].sort((x, y) => x - y);
  const med = sorted[sorted.length >> 1];
  if (!(med > 0)) return null;
  // counted first by the median interval, then again by the fitted period
  // (slow stretches move the median a few per cent at high jitter)
  const first = fitPeriodOnce(times, med, opts);
  const out = first && (fitPeriodOnce(times, first.periodMs, opts) ?? first);
  if (!out) return null;
  // one rate: most intervals span a whole number of periods (two rates in
  // equal parts, 60 + 120, fit a period between them that few do)
  const whole = d.filter((x) => { const k = Math.round(x / out.periodMs); return k >= 1 && Math.abs(x / out.periodMs - k) <= 0.3; }).length / d.length;
  return whole >= wholeShare ? out : null;
}

function fitPeriodOnce(times, med, { tolerance = 0.45, slopeTolerance = 0.005, localSpan = 30, countSpan = 15, wholeSkips = true, min = 600, minStretch = 30, trims = 3, trimSigmas = 4, maxSeHz = 0.005, blockSize = 300, blockSigmas = 3.5, blockMode = "exclude", sigmaFloorMs = 0.02 } = {}) {
  // 1. counting
  const counted = [];
  let cur = [{ t: times[0], n: 0 }], skipped = false, multi = 0, steps = 0;
  const close = () => { if (cur.length >= minStretch) counted.push(cur); };
  for (let i = 1; i < times.length; i += 1) {
    const t = times[i];
    const tail = cur.slice(-countSpan);
    const c = tail.reduce((a, p) => a + p.t - p.n * med, 0) / tail.length;
    const n = Math.round((t - c) / med);
    const last = cur.at(-1).n;
    const ok = n > last && (wholeSkips || n === last + 1 + (skipped ? 1 : 0)) && Math.abs(t - c - n * med) <= tolerance * med;
    if (ok) { steps += 1; if (n - last > 1 + (skipped ? 1 : 0)) multi += 1; cur.push({ t, n }); skipped = false; }
    else if (!skipped && cur.length > 1) skipped = true;
    else { close(); cur = [{ t, n: 0 }]; skipped = false; }
  }
  close();
  // 2. steadiness by the local period
  const localSlope = (st, i) => {
    const lo = Math.max(0, i - localSpan), hi = Math.min(st.length, i + localSpan + 1);
    let mn = 0, mt = 0;
    for (let j = lo; j < hi; j += 1) { mn += st[j].n; mt += st[j].t; }
    mn /= hi - lo; mt /= hi - lo;
    let sxy = 0, sxx = 0;
    for (let j = lo; j < hi; j += 1) { sxy += (st[j].n - mn) * (st[j].t - mt); sxx += (st[j].n - mn) ** 2; }
    return sxx > 0 ? sxy / sxx : null;
  };
  const slopes = counted.map((st) => st.map((_, i) => localSlope(st, i)));
  const all = slopes.flat().filter((v) => v != null).sort((x, y) => x - y);
  if (!all.length) return null;
  const ref = all[all.length >> 1];
  const stretches = [];
  counted.forEach((st, si) => {
    let piece = [];
    st.forEach((p, i) => {
      const sl = slopes[si][i];
      if (sl != null && Math.abs(sl / ref - 1) <= slopeTolerance) piece.push(p);
      else { if (piece.length >= minStretch) stretches.push(piece); piece = []; }
    });
    if (piece.length >= minStretch) stretches.push(piece);
  });
  // 3. fit and trims
  const fit = (parts) => {
    const centred = parts.map((st) => ({ st, mn: st.reduce((a, p) => a + p.n, 0) / st.length, mt: st.reduce((a, p) => a + p.t, 0) / st.length }));
    let sxy = 0, sxx = 0, count = 0;
    for (const { st, mn, mt } of centred) {
      for (const p of st) { sxy += (p.n - mn) * (p.t - mt); sxx += (p.n - mn) ** 2; }
      count += st.length;
    }
    if (count < min / 2 || !(sxx > 0)) return null;
    const periodMs = sxy / sxx;
    let ss = 0;
    for (const c of centred) {
      c.res = c.st.map((p) => p.t - c.mt - periodMs * (p.n - c.mn));
      for (const r of c.res) ss += r * r;
    }
    const sigmaMs = Math.sqrt(ss / Math.max(1, count - parts.length - 1));
    return { periodMs, sigmaMs, seHz: (1000 / periodMs ** 2) * (sigmaMs / Math.sqrt(sxx)), n: count, centred };
  };
  let best = fit(stretches);
  for (let pass = 0; best && pass < trims; pass += 1) {
    const limit = trimSigmas * best.sigmaMs;
    const next = [];
    let cut = false;
    for (const { st, res } of best.centred) {
      const kept = st.filter((_, i) => Math.abs(res[i]) <= limit);
      if (kept.length < st.length) cut = true;
      if (kept.length >= minStretch) next.push(kept);
    }
    if (!cut) break;
    const refit = fit(next);
    if (!refit) break;
    best = refit;
  }
  // 4. one rate: blocks of `blockSize` points, each fitted alone, against
  // the median block's period, within `blockSigmas` standard errors of
  // their own. A slowdown too small for the local slope (0.1 % for 12 s)
  // is still hundreds of them off. "exclude" (the VI: a slow stretch is
  // real) cuts the blocks off and fits again; "reject" (the screen: one
  // rate or none) returns null.
  for (let pass = 0; best && pass < 2; pass += 1) {
    const blocks = [];
    best.centred.forEach(({ st }, si) => {
      for (let i = 0; i < st.length; i += blockSize) {
        const end = st.length - (i + blockSize) < blockSize / 2 ? st.length : i + blockSize;
        blocks.push({ si, pts: st.slice(i, end) });
        if (end === st.length) break;
      }
    });
    if (blocks.length < 2) break;
    for (const b of blocks) {
      const mn = b.pts.reduce((a, p) => a + p.n, 0) / b.pts.length, mt = b.pts.reduce((a, p) => a + p.t, 0) / b.pts.length;
      let sxy = 0, sxx = 0;
      for (const p of b.pts) { sxy += (p.n - mn) * (p.t - mt); sxx += (p.n - mn) ** 2; }
      b.slope = sxx > 0 ? sxy / sxx : null;
      // the block's own residual sigma: the run's is inflated by the very
      // misfit this looks for (two rates pooled into one line)
      let ss = 0;
      if (b.slope != null) for (const p of b.pts) ss += (p.t - mt - b.slope * (p.n - mn)) ** 2;
      // floored at `sigmaFloorMs` (the timers' resolution): exact timestamps
      // would otherwise make any rounding a deviation
      b.se = sxx > 0 && b.pts.length > 2 ? Math.max(sigmaFloorMs, Math.sqrt(ss / (b.pts.length - 2))) / Math.sqrt(sxx) : Infinity;
    }
    const sl = blocks.filter((b) => b.slope != null).map((b) => b.slope).sort((x, y) => x - y);
    const ref = sl[sl.length >> 1];
    for (const b of blocks) b.off = !(b.slope != null && Math.abs(b.slope - ref) <= blockSigmas * b.se);
    if (!blocks.some((b) => b.off)) break;
    if (blockMode === "reject") return null;
    const parts = [];
    let piece = null, lastSi = -1;
    for (const b of blocks) {
      if (b.off) { piece = null; continue; }
      if (piece && b.si === lastSi) piece.push(...b.pts);
      else { piece = [...b.pts]; parts.push(piece); }
      lastSi = b.si;
    }
    best = fit(parts.filter((x) => x.length >= minStretch));
  }
  if (!best || !(best.seHz <= maxSeHz)) return null;
  return { periodMs: best.periodMs, sigmaMs: best.sigmaMs, seHz: best.seHz, n: best.n, kept: best.n / times.length, skips: steps ? multi / steps : 0 };
}

// The screen's refresh, measured from the animation frames (not the
// presentations, which follow the core's VI): their period by regression
// over every tick, a missed vsync counted as whole periods. One rate for the
// whole run or none: null when under `minKept` of the ticks fit it (a rate
// change, 60 → 72, leaves the other part out), when over `maxSkips` of the
// intervals span several periods (120 → 60 would read as 120 with every
// other vsync missed), or when any block of ticks, fitted alone, is off the
// others beyond its standard error (fitPeriod blockMode "reject": 60 → 59.94
// mid-run), or when a block of `block` ticks counted on its own median
// interval differs by more than `blockTolerance` (60 → 72, whose 60 Hz part
// also reads as 72 Hz with a vsync in six missed; 120 → 60 likewise).
export function measuredRefreshHz(ticks, { minKept = 0.9, maxSkips = 0.25, block = 600, blockTolerance = 0.01, ...opts } = {}) {
  const fit = fitPeriod(ticks, { wholeSkips: true, blockMode: "reject", ...opts });
  if (!fit || fit.kept < minKept || fit.skips > maxSkips) return null;
  // blocks counted on their own median interval: a part on a common grid
  // with the rest (60 Hz read as 72 Hz with a vsync in six missed) shows its
  // own rate there
  for (let i = 0; i + block <= ticks.length; i += block) {
    const part = fitPeriod(ticks.slice(i, ticks.length - i < 2 * block ? ticks.length : i + block), { wholeSkips: true, ...opts, min: block });
    if (part && Math.abs(part.periodMs / fit.periodMs - 1) > blockTolerance) return null;
  }
  return 1000 / fit.periodMs;
}

// The beat, proven frame by frame. vi: the core's VI outputs { t, index };
// ticks: the screen's animation frames { t, vi (index shown), submits }.
// Each repeat (a tick showing the same picture as the one before while the
// next one was produced) has a missed frame, the next VI, whose arrival
// phase on the measured vsync grid (t − the tick before it, mod the period)
// is read. A screen at refresh Hz and a core at VI Hz drift by one period
// every 1/|refresh − VI| s: their repeats gather at ONE phase, the boundary.
// Proven when the refresh and VI rates differ by more than `minDriftHz`, at
// least `minShare` of the repeats' missed frames lie within `deltaMs` of the
// densest phase (random repeats spread over the period: a few per cent),
// and, per repeat, the phase around it (the median over ±`smooth` VIs) lies
// at that boundary too (the phase crossing it, not one late frame) and the
// repeat is a single tick (the beat loses one frame at a time; a stall holds
// several). Both rates come from regressions (fitPeriod: the refresh over
// every tick, the VI over its full-speed stretches); `deltaMs` defaults to
// `jitterSigmas` times the VI timestamps' residual jitter. An upper bound: a
// random drop inside a crossing window reads as beat (~1 in 4 on a drifting
// screen; see harness/README.md). Returns
// { refreshHz, viHz, viJitterMs, deltaMs, boundaryMs, share, proven: [tick t] }
// or a reason.
export function beatEvidence({ vi, ticks }, { deltaMs = null, jitterSigmas = 3, minShare = 0.5, minDriftHz = 0.005, smooth = 30, minRepeats = 6 } = {}) {
  const refreshHz = measuredRefreshHz(ticks?.map((k) => k.t));
  if (!refreshHz) return { proven: [], reason: "refresh not measured (too few animation frames)" };
  // the core's VI period by regression over its full-speed stretches (a
  // slow second breaks a stretch, never bends the rate), with its jitter
  const viFit = fitPeriod(vi?.map((v) => v.t), { wholeSkips: false });
  if (!viFit) return { proven: [], refreshHz, reason: "VI period not measured (too few steady VIs)" };
  const viHz = 1000 / viFit.periodMs;
  if (Math.abs(refreshHz - viHz) <= minDriftHz) return { proven: [], refreshHz, viHz, reason: "VI and refresh rates do not drift" };
  const T = 1000 / refreshHz;
  // the phase window: the VI timestamps' measured jitter (3 sigma), at least
  // 0.25 ms, well under the half-period
  deltaMs ??= Math.min(T / 6, Math.max(0.25, jitterSigmas * viFit.sigmaMs));
  const tickTimes = ticks.map((k) => k.t);
  const prevTick = (t) => {
    let lo = 0, hi = tickTimes.length - 1;
    if (t < tickTimes[0]) return null;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tickTimes[mid] <= t) lo = mid; else hi = mid; }
    return tickTimes[hi] <= t ? tickTimes[hi] : tickTimes[lo];
  };
  const phase = (t) => { const p = prevTick(t); return p == null || t - p > 1.5 * T ? null : (t - p) % T; };
  const byIndex = new Map(vi.map((v, i) => [v.index, i]));
  const phases = vi.map((v) => phase(v.t));
  const dist = (a, b) => { const d = Math.abs(a - b) % T; return Math.min(d, T - d); };
  // repeats and their missed frame's phase
  const repeats = [];
  for (let j = 1; j < ticks.length; j += 1) {
    const a = ticks[j - 1], b = ticks[j];
    if (!(a.submits > 0) || a.vi == null || a.vi < 0) continue;
    if (b.vi !== a.vi && b.submits > 0) continue;
    const k = byIndex.get(a.vi + 1);
    if (k == null || vi[k].t > b.t + T) continue; // not produced yet: nothing to show
    // the beat loses one tick at a time: the next tick shows a new picture
    const c = ticks[j + 1];
    const single = c != null && c.submits > 0 && c.vi !== a.vi;
    if (phases[k] != null) repeats.push({ t: b.t, k, phase: phases[k], single });
  }
  if (repeats.length < minRepeats) return { proven: [], refreshHz, viHz, reason: `${repeats.length} repeats` };
  // the densest phase (a window of ±deltaMs around each repeat's phase)
  let boundary = null, best = -1;
  for (const r of repeats) {
    const n = repeats.filter((o) => dist(o.phase, r.phase) <= deltaMs).length;
    if (n > best) { best = n; boundary = r.phase; }
  }
  const share = best / repeats.length;
  if (share < minShare) return { proven: [], refreshHz, viHz, viJitterMs: round(viFit.sigmaMs, 3), deltaMs: round(deltaMs, 3), boundaryMs: round(boundary, 3), share: round(share, 3), reason: "repeats spread over the period: no common boundary" };
  const smoothedAt = (k) => {
    const xs = phases.slice(Math.max(0, k - smooth), k + smooth + 1).filter((p) => p != null).map((p) => dist(p, boundary)).sort((a, b) => a - b);
    return xs.length ? xs[xs.length >> 1] : null;
  };
  const proven = repeats.filter((r) => r.single && dist(r.phase, boundary) <= deltaMs && (smoothedAt(r.k) ?? Infinity) <= deltaMs).map((r) => r.t);
  return { refreshHz, viHz, viJitterMs: round(viFit.sigmaMs, 3), deltaMs: round(deltaMs, 3), boundaryMs: round(boundary, 3), share: round(share, 3), repeats: repeats.length, proven };
}

// Per phase (or "all"): each part's frames over the dips, ranked, and the
// hitches by cause.
export function attributionTable(dips, hitches = []) {
  const byPhase = new Map();
  const row = (phase) => {
    if (!byPhase.has(phase)) byPhase.set(phase, { phase, dips: 0, lostFrames: 0, parts: {}, markers: {}, hitches: 0, hitchFrames: 0, hitchCauses: {} });
    return byPhase.get(phase);
  };
  for (const d of dips) {
    const r = row(d.phase ?? "all");
    r.dips += 1;
    r.lostFrames += d.lostFrames;
    for (const [k, f] of Object.entries(d.parts)) r.parts[k] = (r.parts[k] ?? 0) + f;
    for (const m of d.markers) r.markers[m] = (r.markers[m] ?? 0) + 1;
  }
  for (const h of hitches) {
    const r = row(h.phase ?? "all");
    r.hitches += 1;
    r.hitchFrames += h.frames;
    r.hitchCauses[h.cause] = (r.hitchCauses[h.cause] ?? 0) + h.frames;
  }
  return [...byPhase.values()].map((r) => ({
    ...r, lostFrames: round(r.lostFrames, 1),
    ranked: Object.entries(r.parts).filter(([k]) => !NOT_LOST.has(k)).sort((a, b) => b[1] - a[1])
      .map(([cause, frames]) => ({ cause, frames: round(frames, 1), share: r.lostFrames > 0 ? round(frames / r.lostFrames, 3) : null })),
    contentFrames: round(r.parts.content ?? 0, 1),
    marginalFrames: round(r.parts.marginal ?? 0, 1)
  }));
}

// A scene's cadence per second, as the site learns it: VI / n (n the VIs
// per new frame, rounded), from PREVIOUS seconds only (a second is never
// judged against what it produced), each at full speed with cpu, gpu and
// replay all measured and under `contentBusy` (the content rule's margin);
// the cadence is the median of the last `span` learned values, else the
// reference (the VI rate). A thread never sampled (drop-meter's replay):
// nothing is learned, the reference holds. seconds: [{ vis, produced,
// speed, occupancy }].
export function learnedCadences(seconds, { fullSpeed = ATTRIBUTION_FULL_SPEED, contentBusy = ATTRIBUTION_CONTENT_BUSY, span = 5, reference = null } = {}) {
  const learned = [];
  return seconds.map((s) => {
    const sorted = [...learned.slice(-span)].sort((a, b) => a - b);
    const cadence = sorted.length ? sorted[sorted.length >> 1] : (reference ?? (s.vis > 0 ? s.vis : null));
    const margin = OCCUPANCY_THREADS.every((k) => s.occupancy?.[k] != null && s.occupancy[k] < contentBusy);
    if (s.speed != null && s.speed >= fullSpeed && margin && s.vis > 0 && s.produced > 0) learned.push(s.vis / Math.max(1, Math.round(s.vis / s.produced)));
    return cadence;
  });
}

// drop-meter's windows (windowsOf) and its timeline as attribution windows:
// produced = XFB copies, shown = distinct new pictures displayed (--display),
// presents and the presentation gaps (with the VIs produced during each),
// causes from the counters, the samplers' lateness, occupancy of the CPU
// thread (awake share) and of the GPU thread (working share; replay is not
// sampled: null, so never content), the cadence learned per second from
// previous seconds (lib: learnedCadences; replay unsampled, so the VI rate),
// and the beat frames proven per window.
export function dropWindowsForAttribution(windows, { presents = [], vi = [], displayed = null, rows = [] } = {}) {
  if (!displayed) throw new Error("attribution needs the pictures displayed: run drop-meter with --display");
  const distinct = [];
  for (const f of displayed) if (f.submits > 0 && (distinct.length === 0 || f.vi !== distinct.at(-1).vi)) distinct.push(f);
  const countIn = (points, t0, t1) => points.reduce((a, p) => a + (p.t >= t0 && p.t < t1 ? 1 : 0), 0);
  const gapsIn = (t0, t1) => {
    const out = [];
    for (let i = 1; i < presents.length; i += 1) {
      const a = presents[i - 1].t, b = presents[i].t;
      if (b < t0 || b >= t1) continue;
      out.push({ ms: b - a, vis: countIn(vi, a, b), workerLagMs: stallOverlap(rows, a, b, 0) });
    }
    return out;
  };
  const beat = beatEvidence({ vi: vi.map((v) => ({ t: v.t, index: v.sinceBoot })), ticks: displayed });
  const out = windows.map((w) => {
    const t1 = w.t0 + STEP_MS;
    return {
      t: w.t0, ms: STEP_MS, phase: w.label ?? null, speed: w.speed, vis: countIn(vi, w.t0, t1),
      produced: w.xfb, shown: countIn(distinct, w.t0, t1), presents: w.presents,
      gaps: gapsIn(w.t0, t1), beatFrames: countIn(beat.proven.map((t) => ({ t })), w.t0, t1),
      occupancy: { cpu: w.sleptMs == null ? null : round(Math.max(0, 1 - w.sleptMs / STEP_MS), 3), gpu: w.gpuWorkMs == null ? null : Math.min(1, w.gpuWorkMs / STEP_MS), replay: null },
      causes: { ...w.causes, slot: w.causes.slot ?? null },
      mainLagMs: w.causes.mainPause ?? null, workerLagMs: w.causes.workerPause ?? null
    };
  });
  // the cadence per second, learned on cpu and gpu (replay is not sampled)
  const perSecond = [];
  for (let i = 0; i < out.length; i += 10) {
    const ws = out.slice(i, i + 10);
    const occ = (k) => (ws.every((w) => w.occupancy[k] != null) ? Math.max(...ws.map((w) => w.occupancy[k])) : null);
    perSecond.push({ vis: sumOf(ws, (w) => w.vis) * (1000 / sumOf(ws, (w) => w.ms)), produced: sumOf(ws, (w) => w.produced) * (1000 / sumOf(ws, (w) => w.ms)), speed: ws.every((w) => w.speed != null) ? sumOf(ws, (w) => w.speed) / ws.length : null, occupancy: { cpu: occ("cpu"), gpu: occ("gpu"), replay: occ("replay") } });
  }
  // replay is not sampled here: nothing is learned, the run's VI rate holds
  const viTimes = vi.map((v) => v.t);
  const viFit = fitPeriod(viTimes, { wholeSkips: false, min: 60 });
  const cadences = learnedCadences(perSecond, { reference: viFit ? 1000 / viFit.periodMs : null });
  out.forEach((w, i) => { w.cadence = cadences[Math.floor(i / 10)] ?? null; });
  out.beat = beat;
  return out;
}

// parcours (lib/parcours.mjs deriveSeconds: one row per second) as
// attribution windows. rows[i] is the second ending at raw.samples[i + 1]
// (samples[0] is the origin); the samples give the exact presentation times
// (gaps). A gap's VIs and the worker's lateness are taken only when the
// sample measured them (gapVis, workerLagMs): never estimated, so a gap
// without them is classed unknown, and presenter-blocked needs them. The
// beat needs per-frame VI and vsync times: not proven from parcours rows.
export function parcoursWindowsForAttribution(rows, raw = null) {
  return rows.map((r, i) => {
    // a row covers (previous row's t, its t] in seconds: rows are not spaced
    // exactly 1 s (0.99, 1.01). The first row, and a row after a sampling
    // hole (over 1.5 s since the previous: a row missing), cover their last
    // second only: the hole stays unmeasured, never a stretched second
    const gap = i > 0 && Number.isFinite(rows[i - 1].t) ? r.t - rows[i - 1].t : null;
    const prevT = gap > 0 && gap <= 1.5 ? rows[i - 1].t : r.t - 1;
    const perRow = (rate) => (Number.isFinite(rate) ? rate * (r.t - prevT) : null);
    const sample = raw?.samples?.[i + 1] ?? null;
    const times = Array.isArray(sample?.presents) ? [...sample.presents].sort((a, b) => a - b) : null;
    const prev = Array.isArray(raw?.samples?.[i]?.presents) ? raw.samples[i].presents.at(-1) : null;
    const gaps = [];
    if (times) for (let k = 0; k < times.length; k += 1) {
      const from = k === 0 ? prev : times[k - 1];
      if (from == null) continue;
      gaps.push({ ms: times[k] - from, vis: sample.gapVis?.[k] ?? null, workerLagMs: sample.gapWorkerLagMs?.[k] ?? null });
    }
    return {
      t: prevT * 1000, ms: (r.t - prevT) * 1000, phase: r.phase ?? null, cadence: r.cadence ?? null, speed: r.speed ?? null,
      // rates per second over the row's own duration; presents is a count
      vis: perRow(r.viRate), produced: perRow(r.producedFps), shown: perRow(r.newFps), presents: r.presents ?? null, gaps,
      occupancy: { cpu: r.cpuBusy ?? null, gpu: r.gpuBusy ?? null, replay: r.replayBusy ?? null },
      workerLagMs: r.workerLagMs ?? null
    };
  });
}

// The table as text lines.
export function attributionLines(result) {
  const lines = [];
  for (const r of result.table) {
    lines.push(`${r.phase}: ${r.dips} dip second(s), ${r.lostFrames} frames lost${r.contentFrames ? ` (+${r.contentFrames} content, not lost)` : ""}${r.marginalFrames ? ` (+${r.marginalFrames} marginal: a thread at ${ATTRIBUTION_CONTENT_BUSY}-${ATTRIBUTION_BUSY}, content or game)` : ""}${Object.keys(r.markers).length ? `, markers ${JSON.stringify(r.markers)}` : ""}`);
    for (const x of r.ranked) lines.push(`  ${x.cause.padEnd(28)} ${String(x.frames).padStart(7)} frames  ${x.share == null ? "" : `${(100 * x.share).toFixed(1)} %`}`);
    if (r.hitches) lines.push(`  hitches > ${ATTRIBUTION_HITCH_MS} ms: ${r.hitches} (${r.hitchFrames} frames): ${Object.entries(r.hitchCauses).sort((a, b) => b[1] - a[1]).map(([c, f]) => `${c} ${f}`).join(", ")}`);
  }
  return lines;
}
