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
  const out = { presents: [], vi: [], lost: { presents: 0, vi: 0 }, viSupported: true, viWhy: null, failedReads: 0, complete: true };
  if (!chunks.length) out.complete = false;
  for (const c of chunks) {
    if (!c || c.error) { out.failedReads += 1; out.complete = false; continue; }
    c.presents.t.forEach((t, i) => out.presents.push({ t, vi: c.presents.vi[i] }));
    out.lost.presents += c.presents.lost ?? 0;
    if (!c.vi?.supported) { out.viSupported = false; out.viWhy = c.vi?.why ?? out.viWhy; }
    c.vi?.t?.forEach((t, i) => out.vi.push({ t, ticks: c.vi.ticks[i], sinceBoot: c.vi.sinceBoot[i], sinceLoad: c.vi.sinceLoad[i] }));
    out.lost.vi += c.vi?.lost ?? 0;
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

export function windowOf(timeline, t0, t1) {
  return {
    ...timeline,
    presents: timeline.presents.filter((p) => p.t >= t0 && p.t <= t1),
    vi: timeline.vi.filter((v) => v.t >= t0 && v.t <= t1)
  };
}

const gaps = (events) => events.slice(1).map((e, i) => ({ start: events[i].t, end: e.t, ms: e.t - events[i].t }));

// Presentation timing: every interval, freezes where the core kept producing
// VI outputs while nothing was presented.
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
