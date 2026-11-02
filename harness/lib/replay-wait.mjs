// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// What holds a ViTag between its swap (video thread, patch 0214's ring) and
// its replay by the worker (pipeline log): the replay delay that, with the
// VI's phase, decides whether a picture makes its BeginFrame
// (research/no-present-2p.md). From the pipeline log's drain records (each
// start of the replay: how it was woken, when it was scheduled or parked),
// each tag is split into
//   wait        from its swap to the start of the drain that replayed it,
//               charged to that drain's wake (timer0: a 0 ms timer chained
//               from the previous drain; timerIdle: the idle or blocked poll;
//               parker: waitAsync on the write index; presentation: the
//               presentation loop's own drain)
//   lag         that drain's start minus when it was scheduled or parked
//               (the timer's clamp, the event loop's queue, the parker's
//               wake); null when unknown
//   processing  from max(swap, drain start) to the tag: the records replayed
//               ahead of it in that drain
//   missed      drains that started after the swap yet did not replay it
//               (the record not yet visible, or a drain that stopped early)
// Missing data is null, never 0. Nothing here knows a game or a scene.
import { median, round } from "./stats.mjs";

export const WAKE_NAMES = Object.freeze(["timer0", "timerIdle", "parker", "presentation"]);

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return round(s[Math.min(s.length - 1, Math.floor(p * s.length))], 3);
};

// The last index of `list` (sorted by t) with t <= `t` (-1: none).
function lastAtOrBefore(list, t) {
  let lo = 0, hi = list.length - 1, out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= t) { out = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return out;
}

// Per tag in [from, to) (by its swap's time): { vi, swapT, tagT, replayMs,
// wake, waitMs, lagMs, processingMs, missed }. null when the timeline has no
// swaps or no drain records (a log from before them).
export function replayWaitsOf(timeline, { from = -Infinity, to = Infinity } = {}) {
  const drains = timeline.pipeline?.drains;
  if (!Array.isArray(timeline.swaps) || !Array.isArray(drains) || !drains.length) return null;
  const ds = [...drains].sort((a, b) => a.t - b.t);
  const tags = new Map();
  for (const g of timeline.pipeline.tags ?? []) if (!tags.has(g.vi)) tags.set(g.vi, g.t);
  const out = [];
  const seen = new Set();
  for (const s of timeline.swaps) {
    if (!(s.t >= from && s.t < to) || seen.has(s.vi)) continue;
    seen.add(s.vi);
    const tagT = tags.get(s.vi);
    if (tagT == null) continue;
    const k = lastAtOrBefore(ds, tagT);
    const d = k < 0 ? null : ds[k];
    const first = lastAtOrBefore(ds, s.t) + 1; // first drain after the swap
    const after = d && d.t >= s.t;
    out.push({
      vi: s.vi, swapT: s.t, tagT, replayMs: round(tagT - s.t, 3),
      wake: d ? (WAKE_NAMES[d.wake] ?? null) : null,
      waitMs: d ? round(Math.max(0, d.t - s.t), 3) : null,
      lagMs: d && d.setAt != null ? round(d.t - d.setAt, 3) : null,
      processingMs: d ? round(tagT - Math.max(d.t, s.t), 3) : null,
      missed: d ? (after ? Math.max(0, k - first) : 0) : null
    });
  }
  return out;
}

// The summary: replay delay, the share of the wait per wake, each wake's
// wait and lag, the processing, the missed drains; and the same over the
// tags replayed later than `lateMs`.
export function replayWaitSummary(waits, { lateMs = 2 } = {}) {
  if (!waits) return null;
  const one = (ws) => {
    const byWake = {};
    const waitTotal = ws.reduce((a, w) => a + (w.waitMs ?? 0), 0);
    for (const name of WAKE_NAMES) {
      const xs = ws.filter((w) => w.wake === name);
      byWake[name] = {
        tags: xs.length,
        waitShare: waitTotal > 0 ? round(xs.reduce((a, w) => a + (w.waitMs ?? 0), 0) / waitTotal, 3) : null,
        waitP50: pct(xs.map((w) => w.waitMs).filter((x) => x != null), 0.5),
        waitP90: pct(xs.map((w) => w.waitMs).filter((x) => x != null), 0.9),
        lagP50: pct(xs.map((w) => w.lagMs).filter((x) => x != null), 0.5),
        lagP90: pct(xs.map((w) => w.lagMs).filter((x) => x != null), 0.9)
      };
    }
    const proc = ws.map((w) => w.processingMs).filter((x) => x != null);
    return {
      tags: ws.length,
      replayP50: pct(ws.map((w) => w.replayMs), 0.5), replayP90: pct(ws.map((w) => w.replayMs), 0.9), replayP99: pct(ws.map((w) => w.replayMs), 0.99),
      waitMedian: ws.length ? round(median(ws.map((w) => w.waitMs ?? 0)), 3) : null,
      processingP50: pct(proc, 0.5), processingP90: pct(proc, 0.9),
      missedAny: ws.filter((w) => w.missed > 0).length,
      byWake
    };
  };
  return { all: one(waits), late: one(waits.filter((w) => w.replayMs > lateMs)), lateMs };
}
