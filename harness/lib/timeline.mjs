// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Timing from complete timelines, not samples. The worker drains two rings
// (validationReadTimeline): every presentation (host ms) and every VI output
// of the core (host ms + emulated ticks). Everything here is computed over
// every entry of a window, so no event can fall between two samples.
import { median, percentile } from "./stats.mjs";

export const PRESENT_FREEZE_MS = 500;
export const CORE_FREEZE_MS = 2000;
export const HITCH_MS = 1000 / 60 * 2; // more than 2 frames at 60 Hz

// Concatenate drained chunks; `lost` > 0 means a ring overflowed between
// two reads and the window is not complete.
// A chunk that could not be read makes the timeline incomplete: a missing
// final read would otherwise hide a core that stopped at the end.
export function mergeTimeline(chunks) {
  const out = { presents: [], vi: [], lost: { presents: 0, vi: 0 }, viSupported: true, viWhy: null, failedReads: 0, complete: true, displayed: [], displayedLost: 0, displayedWhy: null };
  if (!chunks.length) out.complete = false;
  for (const c of chunks) {
    if (!c || c.error) { out.failedReads += 1; out.complete = false; continue; }
    c.presents.t.forEach((t, i) => out.presents.push({ t, vi: c.presents.vi[i] }));
    out.lost.presents += c.presents.lost ?? 0;
    if (!c.vi?.supported) { out.viSupported = false; out.viWhy = c.vi?.why ?? out.viWhy; }
    c.vi?.t?.forEach((t, i) => out.vi.push({ t, ticks: c.vi.ticks[i], sinceBoot: c.vi.sinceBoot[i], sinceLoad: c.vi.sinceLoad[i] }));
    out.lost.vi += c.vi?.lost ?? 0;
    // What each BeginFrame put on screen (worker rAF, when the harness asked).
    if (c.displayed) c.displayed.t.forEach((t, i) => out.displayed.push({ t, submits: c.displayed.submits[i], vi: c.displayed.vi[i] }));
    else out.displayedWhy = c.displayedWhy ?? out.displayedWhy ?? "engine without the display counter";
    out.displayedLost += c.displayedLost ?? 0;
  }
  if (out.lost.presents || out.lost.vi) out.complete = false;
  // Both rings must be on one clock (timeOrigin + now). Presentations and VI
  // outputs of one run cannot be minutes apart; if they are, the timeline is
  // unusable rather than silently wrong.
  if (out.presents.length && out.vi.length) {
    const p = out.presents[out.presents.length >> 1].t, v = out.vi[out.vi.length >> 1].t;
    if (Math.abs(p - v) > 60000) { out.complete = false; out.clockMismatch = Math.round(p - v); }
  }
  return out;
}

// What the screen showed (research/deep-frame-pacing.md §3.1): Chrome keeps
// only the last picture submitted between two BeginFrames, so the submitted
// presents overstate what is seen. One entry per BeginFrame (worker rAF):
// submits 0 = nothing new, 1 = one picture shown, n > 1 = n - 1 dropped.
// vsyncMs is the median BeginFrame interval (16.7 ms in headless Chrome,
// whatever the real screen). judderPct: displayed intervals that are not the
// dominant number of vsyncs (uneven pacing; a steady 30 fps is not judder);
// offOneVsyncPct: displayed intervals other than one vsync.
export function displayStats(timeline) {
  const frames = timeline.displayed ?? [];
  if (frames.length < 3) return { supported: false, why: timeline.displayedWhy ?? "no BeginFrame in the window" };
  const begin = frames.slice(1).map((f, i) => f.t - frames[i].t);
  const vsyncMs = percentile(begin, 50);
  const shown = frames.filter((f) => f.submits > 0);
  const shownMs = shown.slice(1).map((f, i) => f.t - shown[i].t);
  const vsyncs = shownMs.map((ms) => Math.max(1, Math.round(ms / vsyncMs)));
  const counts = new Map();
  for (const v of vsyncs) counts.set(v, (counts.get(v) ?? 0) + 1);
  const mode = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  const spanS = (frames.at(-1).t - frames[0].t) / 1000;
  const submitted = frames.reduce((n, f) => n + f.submits, 0);
  const dropped = frames.reduce((n, f) => n + Math.max(0, f.submits - 1), 0);
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  return {
    supported: true,
    vsyncMs: Math.round(vsyncMs * 100) / 100,
    beginFrames: frames.length,
    displayedPerSecond: spanS > 0 ? Math.round((shown.length / spanS) * 10) / 10 : null,
    submittedPerSecond: spanS > 0 ? Math.round((submitted / spanS) * 10) / 10 : null,
    dropped,
    droppedPerMin: spanS > 0 ? Math.round((dropped / spanS) * 600) / 10 : null,
    displayedP50: percentile(shownMs, 50), displayedP95: percentile(shownMs, 95), displayedP99: percentile(shownMs, 99),
    dominantVsyncs: mode,
    judderPct: pct(vsyncs.filter((v) => v !== mode).length, vsyncs.length),
    offOneVsyncPct: pct(vsyncs.filter((v) => v !== 1).length, vsyncs.length),
    noUpdatePct: pct(frames.filter((f) => f.submits === 0).length, frames.length),
    lost: timeline.displayedLost ?? 0
  };
}

export function windowOf(timeline, t0, t1) {
  return {
    ...timeline,
    displayed: (timeline.displayed ?? []).filter((f) => f.t >= t0 && f.t <= t1),
    presents: timeline.presents.filter((p) => p.t >= t0 && p.t <= t1),
    vi: timeline.vi.filter((v) => v.t >= t0 && v.t <= t1)
  };
}

const gaps = (events) => events.slice(1).map((e, i) => ({ start: events[i].t, end: e.t, ms: e.t - events[i].t }));

// Presentation timing: every interval, freezes where the core kept producing
// VI outputs while nothing was presented.
// Every hitch of a window (a presentation interval over HITCH_MS), to see
// whether two runs or two sides hitch at the same place: [ms since `origin`
// (the window's start), interval ms, VI outputs since the savestate load at
// the hitch's end (the place in the scene, the same whatever the speed; null
// without a VI timeline)]. Over `cap`, the longest are kept, in time order,
// and `count` says how many there were.
export function hitchList(timeline, { origin = timeline.presents[0]?.t ?? 0, cap = 200 } = {}) {
  const all = gaps(timeline.presents).map((g, i) => ({ ...g, vi: timeline.presents[i + 1].vi })).filter((g) => g.ms > HITCH_MS);
  // VI outputs since boot minus since load: one offset for the whole window.
  const v = timeline.vi.find((x) => Number.isFinite(x.sinceBoot) && Number.isFinite(x.sinceLoad));
  const offset = v ? v.sinceBoot - v.sinceLoad : null;
  const kept = all.length > cap ? [...all].sort((a, b) => b.ms - a.ms).slice(0, cap).sort((a, b) => a.end - b.end) : all;
  return {
    count: all.length,
    truncated: all.length > kept.length,
    hitches: kept.map((g) => [Math.round(g.end - origin), Math.round(g.ms * 10) / 10, offset != null && g.vi >= 0 ? g.vi - offset : null])
  };
}

export function presentationStats(timeline) {
  const intervals = gaps(timeline.presents);
  const ms = intervals.map((g) => g.ms);
  const durationMin = timeline.presents.length > 1 ? (timeline.presents.at(-1).t - timeline.presents[0].t) / 60000 : 0;
  const freezes = intervals
    .filter((g) => g.ms >= PRESENT_FREEZE_MS)
    .map((g) => ({ atMs: g.start, durationMs: Math.round(g.ms), viOutputs: timeline.vi.filter((v) => v.t > g.start && v.t < g.end).length }))
    .filter((f) => !timeline.viSupported || f.viOutputs > 0);
  return {
    presents: timeline.presents.length,
    frameP50: percentile(ms, 50),
    frameP95: percentile(ms, 95),
    frameP99: percentile(ms, 99),
    frameMax: ms.length ? Math.max(...ms) : null,
    hitchesPerMin: durationMin > 0 ? ms.filter((v) => v > HITCH_MS).length / durationMin : null,
    freezes
  };
}

// Core timing from VI outputs: emulated speed over each wall-clock second,
// and freezes (no VI output for CORE_FREEZE_MS while the run went on).
export function coreStats(timeline, { ticksPerSecond, until = null } = {}) {
  if (!timeline.viSupported) return { supported: false };
  const vi = timeline.vi;
  const freezes = gaps(vi).filter((g) => g.ms >= CORE_FREEZE_MS).map((g) => ({ atMs: g.start, durationMs: Math.round(g.ms) }));
  // A core that stopped and never resumed shows as a gap up to the end of
  // the window.
  if (until != null && vi.length && until - vi.at(-1).t >= CORE_FREEZE_MS) freezes.push({ atMs: vi.at(-1).t, durationMs: Math.round(until - vi.at(-1).t), ongoing: true });
  if (until != null && !vi.length) freezes.push({ atMs: null, durationMs: null, ongoing: true, reason: "no VI output in the window" });
  const speeds = [];
  if (ticksPerSecond > 0 && vi.length > 1) {
    let start = 0;
    for (let i = 1; i < vi.length; i += 1) {
      if (vi[i].t - vi[start].t >= 1000) {
        const emulated = (vi[i].ticks - vi[start].ticks) / ticksPerSecond;
        speeds.push({ atMs: vi[start].t, speed: (100 * emulated * 1000) / (vi[i].t - vi[start].t) });
        start = i;
      }
    }
  }
  const s = speeds.map((x) => x.speed);
  return {
    supported: true,
    viOutputs: vi.length,
    speed: median(s),
    speedP5: percentile(s, 5),
    speedMin: s.length ? Math.min(...s) : null,
    speedDips: speeds.filter((x) => x.speed < 90).map((x) => ({ atMs: Math.round(x.atMs), speed: Math.round(x.speed) })),
    freezes
  };
}
