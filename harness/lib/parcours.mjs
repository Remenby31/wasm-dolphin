// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// A parcours (harness/probes/parcours.mjs): a whole play-through from the
// boot, title, menus, selection, loading, a full game round, its results and
// back, sampled once a second and cut into phases found from generic signals
// only. Pure: tested in tests/harness-parcours.test.mjs.
//
// One raw sample a second (the probe reads them, nothing per frame):
//   t         host ms (timeOrigin + now) of the page's reading
//   info      __lastFrameInfo: speed (gameSpeed %), newFps, producedFps,
//             newShown (new frames shown since boot, cumulative), outOfOrder
//             (cumulative), cpuBusy, gpuBusy, replayBusy (occupancy of the
//             worker's last 500 ms window, 0..1), draws (the replay's draws
//             since boot, cumulative)
//   counters  the drop sampler's last row of that second (its own t): ticks,
//             discBytes, xfbCopies (EFB→XFB copies), cumulative; null when
//             no row came (the rates of the previous second are kept)
//   presents  host times of the presentations of that second (timeline)
//   vi        VI outputs of that second (timeline)
//   integrity validationReadIntegrity, for the deltas per phase (optional)
//   film      the pad film's position { pos, hold } (optional)
// Derived per second: speed (guest / host time from the core ticks), new
// frames shown and produced a second, smoothness (new frames against the
// game's cadence, learnt as the site learns it), present hitches over 50 and
// 100 ms, disc bytes a second, XFB copies and replay draws per frame made,
// occupancy.
import { integrityOf } from "./integrity.mjs";
import { noiseOf, verdictOf } from "./drops.mjs";
import { median, percentile, round } from "./stats.mjs";

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
const delta = (a, b) => (num(a) == null || num(b) == null || b < a ? null : b - a);

// The raw samples -> one row a second (the first sample is the origin).
export function deriveSeconds(samples, { tps = null } = {}) {
  const rows = [];
  let cadence = null, lastPresent = null, prevCounters = samples[0]?.counters ?? null, carried = null;
  const t0 = samples[0]?.t ?? 0;
  let booted = false;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1], b = samples[i];
    const dt = (b.t - a.t) / 1000;
    if (!(dt > 0)) continue;
    const ia = a.info ?? {}, ib = b.info ?? {};
    // counters: rates over the sampler's own rows; a second without a new
    // row keeps the previous rates
    const c = b.counters ?? null;
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
    const shown = delta(ia.newShown, ib.newShown);
    const newFps = shown != null ? shown / dt : num(ib.newFps);
    const producedFps = num(ib.producedFps);
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
    const seen = windowCadence({ newFps, producedFps, speed, viRate, ...occupancy });
    cadence = seen ?? cadence;
    const ref = cadence ?? viCadence(viRate);
    booted ||= (num(ib.newShown) ?? 0) > 0;
    rows.push({
      i: rows.length, t: round((b.t - t0) / 1000, 2), at: b.t, booted,
      speed: round(speed, 1), newFps: round(newFps, 1), producedFps: round(producedFps, 1),
      cadence: ref, smoothness: newFps == null ? null : round(Math.max(0, Math.min(100, (newFps / ref) * 100)), 1),
      viRate: round(viRate, 1), presents: (b.presents ?? []).length, hitches50, hitches100, maxGapMs: round(maxGapMs, 1),
      discBps: carried?.discBps == null ? null : Math.round(carried.discBps),
      xfbPerFrame: carried?.xfbPerSec != null && producedFps > 0 ? round(carried.xfbPerSec / producedFps, 2) : null,
      drawsPerFrame: draws != null && made ? round(draws / made, 1) : null,
      outOfOrder: delta(ia.outOfOrder, ib.outOfOrder),
      ...occupancy,
      integrity: b.integrity ?? null, film: b.film ?? null
    });
  }
  return rows;
}

// One second's phase from its signals alone; null: no signal (kept from
// the second before).
export function classifySecond(r, { gameDrawsPerFrame = GAME_DRAWS_PER_FRAME } = {}) {
  if (!r.booted) return "boot";
  const disc = r.discBps ?? 0;
  const scarce = (r.newFps ?? 0) < SCARCE_SHARE * (r.cadence ?? 60) || (r.speed != null && r.speed < SCARCE_SPEED);
  if (disc >= LOAD_DISC_BPS && scarce) return "loading";
  if ((r.newFps ?? 0) < MIN_NEW_FPS) return null;
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

// Runs of one phase: [{ phase, from, to }] in seconds (row indexes).
export const segmentsOf = (labels) => runsOf(labels).map((r) => ({ phase: r.label, from: r.from, to: r.to }));

const triple = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return v.length ? { min: round(Math.min(...v), 1), p5: round(percentile(v, 5), 1), median: round(median(v), 1) } : { min: null, p5: null, median: null };
};

// One phase (or section): its seconds -> the numbers a person reads and the
// flat metrics the A/B judges.
export function summarizeSeconds(rows, { integrityAllow = [] } = {}) {
  const speed = triple(rows.map((r) => r.speed)), newFps = triple(rows.map((r) => r.newFps)), smooth = triple(rows.map((r) => r.smoothness));
  const worst = rows.filter((r) => r.smoothness != null || r.speed != null)
    .sort((a, b) => (a.smoothness ?? 101) - (b.smoothness ?? 101) || (a.speed ?? 999) - (b.speed ?? 999))
    .slice(0, 3).map((r) => ({ t: r.t, speed: r.speed, newFps: r.newFps, smoothness: r.smoothness }));
  const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const first = rows.find((r) => r.integrity), last = rows.findLast((r) => r.integrity);
  const integrity = first && last && first !== last ? integrityOf(first.integrity, last.integrity, { allow: integrityAllow }) : null;
  const metrics = {
    seconds: rows.length, speedMedian: speed.median, speedP5: speed.p5, speedMin: speed.min,
    newFpsMedian: newFps.median, newFpsP5: newFps.p5, smoothMedian: smooth.median, smoothP5: smooth.p5, smoothMin: smooth.min,
    hitches50: sum("hitches50"), hitches100: sum("hitches100")
  };
  return {
    seconds: rows.length, speed, newFps, smoothness: smooth, hitches50: metrics.hitches50, hitches100: metrics.hitches100, worst,
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
  rows.forEach((r, i) => { r.phase = labels[i]; r.rawPhase = rawLabels[i]; });
  const segments = segmentsOf(labels).map((s) => ({ ...s, fromT: rows[s.from]?.t ?? null, toT: rows[s.to - 1]?.t ?? null }));
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
    seconds: rows.length, completion: completionOf(markers, reached, segments), segments, phases: kinds, sections, overall: all,
    integrityFailed: Boolean(all?.integrity?.fatal?.length),
    rows: rows.map(({ integrity, film, at, ...r }) => r)
  };
}

// --- A/B: pairs by phase, never by timestamp ---------------------------------
// Every phase kind ("kind:game") and every section ("section:race") of the
// runs is one comparison; its metrics are the runs' flat metrics.
export const PARCOURS_PRIMARY = Object.freeze({ speedMedian: "down", speedP5: "down", newFpsMedian: "down", smoothP5: "down", hitches100: "up" });
export const PARCOURS_FLOOR = Object.freeze({ speedMedian: 1, speedP5: 2, newFpsMedian: 1, smoothP5: 3, hitches100: 1 });

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

export function parcoursVerdict(baseline, candidate, noise = null) {
  const b = baseline.filter(usable), c = candidate.filter(usable);
  const keys = [...new Set([...b, ...c].flatMap((a) => Object.keys(phaseMetrics(a))))].sort();
  const phases = {};
  for (const k of keys) {
    const of = (xs) => xs.map((a) => phaseMetrics(a)[k]).filter(Boolean);
    phases[k] = verdictOf(of(b), of(c), { noise: noise?.[k] ?? null, floor: PARCOURS_FLOOR, metrics: PARCOURS_PRIMARY });
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
