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
// covers at least CAUSE_MIN_SHARE of the time it lost, "emulation" when the
// CPU thread hardly slept where the time was lost (busy all along running
// guest code, none of the counted waits), else "unexplained".
import { describe, median, percentile, round, stdev } from "./stats.mjs";

export const STEP_MS = 100;
export const DROP_SPEED = 90;
export const HITCH_MS = [50, 100];
export const CAUSE_MIN_SHARE = 0.25;
export const STALL_MIN_MS = 20;
export const EMULATION_SLEEP_SHARE = 0.1;
// Columns that are u32 in the core and wrap (µs totals of patch 0003, the
// EFB words of 0164): unwrapped before any difference.
export const WRAPPING = new Set(["jitModuleUs", "jitInstanceUs", "jitCompiles", "efbSyncs", "efbWaitUs", "discWaits", "discReads"]);
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
  lateWake: (d) => d.sleepLateUs / 1000
};
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
      behindMs: d.behindUs == null ? null : d.behindUs / 1000,
      // guest cycles (region counters on, else 0): in regions, in all, idle-skipped
      cycles: { region: d.regionCycles ?? null, total: d.totalCycles ?? null, idle: d.idleCycles ?? null },
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
  if (top && ms >= CAUSE_MIN_SHARE * Math.max(lost, 1)) cause = top;
  else if (windows.every((w) => w.sleptMs != null) && sleptShare != null && sleptShare < EMULATION_SLEEP_SHARE) cause = "emulation";
  else cause = "unexplained";
  const total = (k) => round(windows.reduce((a, w) => a + (w[k] ?? 0), 0), 1);
  return {
    cause, lostMs: round(lost, 1), causesMs: Object.fromEntries(Object.entries(causes).map(([k, v]) => [k, round(v, 1)])), sleptMs: round(slept, 1), sleptShare: round(sleptShare, 3),
    // what ran meanwhile: new JIT blocks, of them posted off thread
    // (interpreted until compiled), regions dropped, disc bytes read
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
export function dropSummary({ windows, presents = [], vi = [] }) {
  const sl = slidingSpeed(windows);
  const below = (x) => (sl.length ? round((100 * sl.filter((s) => s.speed < x).length) / sl.length, 2) : null);
  const pg = gapsOf(presents), vg = gapsOf(vi);
  const lost = windows.reduce((a, w) => a + (w.lostMs ?? 0), 0);
  const host = windows.length * STEP_MS;
  const xfb = windows.reduce((a, w) => a + (w.xfb ?? 0), 0);
  return {
    hostSec: round(host / 1000, 1),
    // net host ms not matched by guest time (catch-up counted)
    lostMs: round(lost, 0),
    pctBelow95: below(95), pctBelow90: below(90),
    worstSecond: sl.length ? round(Math.min(...sl.map((s) => s.speed)), 1) : null,
    hitches50: pg.filter((g) => g > HITCH_MS[0]).length, hitches100: pg.filter((g) => g > HITCH_MS[1]).length,
    viGaps50: vg.filter((g) => g > HITCH_MS[0]).length, viGaps100: vg.filter((g) => g > HITCH_MS[1]).length,
    presentP99: round(percentile(pg, 99), 1), presentMax: pg.length ? round(Math.max(...pg), 1) : null,
    gameFps: host > 0 ? round((xfb * 1000) / host, 1) : null,
    underruns: windows.reduce((a, w) => a + (w.underruns ?? 0), 0)
  };
}

// Per labelled phase of the scenario: the same summary over its windows.
export function phaseSummaries({ windows, presents = [], vi = [] }) {
  const labels = [...new Set(windows.map((w) => w.label))];
  return labels.map((label) => {
    const ws = windows.filter((w) => w.label === label);
    const t0 = ws[0].t0, t1 = ws.at(-1).t0 + STEP_MS;
    const inside = (e) => e.t >= t0 && e.t < t1;
    return { label, ...dropSummary({ windows: ws, presents: presents.filter(inside), vi: vi.filter(inside) }) };
  });
}

// The worst drops of a run, by host time lost.
export function worstDrops(events, n = 5) {
  return [...events].sort((a, b) => b.lostMs - a.lostMs).slice(0, n);
}

// A/A: each metric's spread over repeated runs of the same build. minDiff:
// the smallest difference between the medians of two series of n runs that
// is unlikely to be noise (about 2 standard errors of a difference).
export function noiseOf(summaries) {
  const keys = [...new Set(summaries.flatMap((s) => Object.keys(s)))].filter((k) => summaries.some((s) => typeof s[k] === "number"));
  return Object.fromEntries(keys.map((k) => {
    const xs = summaries.map((s) => s[k]).filter(Number.isFinite);
    const sd = stdev(xs);
    return [k, { ...describe(xs, 2), minDiff: sd == null || xs.length < 2 ? null : round(2 * sd * Math.sqrt(2 / xs.length), 2) }];
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

// The metrics a merge guard judges, and which way is worse.
export const GUARDED = {
  lostMs: "up", pctBelow95: "up", pctBelow90: "up", worstSecond: "down",
  hitches50: "up", hitches100: "up", presentP99: "up", loadExcessMs: "up"
};

// Candidate against baseline over runs of one visit number. A metric
// regresses when its median moved the worse way by more than its noise:
// minDiff from an A/A of this probe when given (noise[k].minDiff, for its
// own n; scaled to this n), else 2 standard errors of a difference from the
// two sides' own spread. Small absolute moves never count (floor).
export const VERDICT_MIN_RUNS = 3;
export const VERDICT_FLOOR = { lostMs: 50, pctBelow95: 0.5, pctBelow90: 0.5, worstSecond: 5, hitches50: 2, hitches100: 1, presentP99: 2, loadExcessMs: 50 };
export function verdictOf(baseline, candidate, { noise = null } = {}) {
  const rows = [];
  for (const [k, worse] of Object.entries(GUARDED)) {
    const b = baseline.map((s) => s[k]).filter(Number.isFinite), c = candidate.map((s) => s[k]).filter(Number.isFinite);
    if (!b.length || !c.length) continue;
    const delta = median(c) - median(b);
    const n = Math.min(b.length, c.length);
    let threshold;
    const fromAa = noise?.[k]?.minDiff != null && noise[k].n > 1;
    // Without an A/A, two sides' spread of fewer than VERDICT_MIN_RUNS runs
    // says nothing about the noise: no verdict on that metric.
    if (!fromAa && n < VERDICT_MIN_RUNS) {
      rows.push({ metric: k, baseline: round(median(b), 2), candidate: round(median(c), 2), delta: round(delta, 2), threshold: null, regression: false, improvement: false, inconclusive: true });
      continue;
    }
    if (fromAa) threshold = noise[k].minDiff * Math.sqrt(noise[k].n / Math.max(n, 1));
    else {
      const sd = Math.sqrt(((stdev(b) ?? 0) ** 2 + (stdev(c) ?? 0) ** 2) / 2);
      threshold = 2 * sd * Math.sqrt(2 / Math.max(n, 1));
    }
    threshold = Math.max(threshold, VERDICT_FLOOR[k] ?? 0);
    const worseBy = worse === "up" ? delta : -delta;
    rows.push({ metric: k, baseline: round(median(b), 2), candidate: round(median(c), 2), delta: round(delta, 2), threshold: round(threshold, 2), regression: worseBy > threshold, improvement: -worseBy > threshold });
  }
  return { regression: rows.some((r) => r.regression), improvement: rows.some((r) => r.improvement), inconclusive: rows.length > 0 && rows.every((r) => r.inconclusive), rows };
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
