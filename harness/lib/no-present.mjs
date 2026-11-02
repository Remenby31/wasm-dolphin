// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Why a BeginFrame showed no new picture while the core had one to show.
// The attribution (lib/drops.mjs) names these frames "no-present": the core
// made the frame (the XFB exists), the worker was not late, yet the VI's
// picture missed its BeginFrame. This module takes each such BeginFrame, the
// VI output that was due there, and follows that output down the pipeline:
//
//   VI (CPU thread, VI ring)  -> swap pulled by the video thread (swap ring,
//   patch 0214: when, how many FIFO chunks it still had to replay, whether it
//   found a new XFB)  -> its ViTag replayed by the worker (pipeline log)  ->
//   its present queued for the rAF (pipeline log)  -> the BeginFrame that
//   showed it (display counter, --display).
//
// Each missed BeginFrame gets one cause:
//   fifo-behind     the swap found no new XFB (or patch 0211 held the last
//                   picture) while the video thread was still behind the FIFO
//                   written before the VI: the swap overtook its own copy
//   gpu-busy        the video thread pulled the swap late (VI -> swap over
//                   its run median by more than `excessMs`), the largest excess
//   replay-late     the worker replayed the swap late (swap -> ViTag replay),
//                   the largest excess
//   beat            a normal pipeline would have missed too (the time from
//                   the VI to the BeginFrame under the run's median VI ->
//                   queued) and the VI's phase on the BeginFrame grid lies in
//                   `band` (from 0.8 to 0.1 of the refresh period after the
//                   previous BeginFrame, by default): the VI fell just before
//                   or just after a vsync
//   swap-not-ready  not ready at the vsync for no excess of its own, the VI
//                   outside the band: the pipeline's normal latency is longer
//                   than the band allows; also, without the pipeline data,
//                   every miss outside the band (the delay is not split)
//   other           with a reason: the VI itself came after the BeginFrame
//                   outside the band (vi-late: emulation), the swap found no
//                   new XFB with the FIFO caught up (duplicate: the game's own
//                   repeat), the present queued before the BeginFrame yet not
//                   shown (queued-not-shown), the present step itself late
//                   (present-late), the due output never shown (skipped), or
//                   the VI not recorded (vi-unknown)
//
// Every input that is missing is null and the cause says so; nothing is read
// as 0. Thresholds are the caller's: nothing here knows a game or a scene.
import { interpolate } from "./drops.mjs";
import { median, round } from "./stats.mjs";

export const NO_PRESENT_BAND = Object.freeze({ from: 0.8, to: 0.1 });
export const NO_PRESENT_EXCESS_MS = 2;
export const NO_PRESENT_CAUSES = Object.freeze(["fifo-behind", "gpu-busy", "replay-late", "beat", "swap-not-ready", "other"]);

// The VI's phase is in the band [from, 1) U [0, to] (a band that wraps), or
// [from, to] when from <= to.
export function inBand(phase, { from, to } = NO_PRESENT_BAND) {
  if (!Number.isFinite(phase)) return null;
  return from > to ? phase >= from || phase <= to : phase >= from && phase <= to;
}

// The refresh period: the median BeginFrame interval among those near the
// shortest (a missed BeginFrame is two periods, never averaged in).
export function refreshPeriodMs(displayed) {
  const d = [];
  for (let i = 1; i < displayed.length; i += 1) {
    const x = displayed[i].t - displayed[i - 1].t;
    if (x > 0) d.push(x);
  }
  if (d.length < 4) return null;
  const shortest = Math.min(...d);
  return median(d.filter((x) => x < 1.5 * shortest));
}

// Index of the last element with t <= `t` in a list sorted by t (-1: none).
function lastAtOrBefore(list, t) {
  let lo = 0, hi = list.length - 1, out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= t) { out = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return out;
}

// The first record per VI output (a swap, a replayed tag, a queued present).
function firstByVi(list) {
  const out = new Map();
  for (const x of list ?? []) if (Number.isFinite(x.vi) && x.vi >= 0 && !out.has(x.vi)) out.set(x.vi, x);
  return out;
}

// The GPU thread's working share over [t - aroundMs, t + aroundMs], from the
// drop sampler's cumulative rows ({ t, gpuWorkUs }, lib/drops.mjs rowsOf);
// null when not sampled there.
export function gpuBusyAround(rows, t, aroundMs = 50) {
  if (!rows?.length) return null;
  const a = interpolate(rows, "gpuWorkUs", t - aroundMs), b = interpolate(rows, "gpuWorkUs", t + aroundMs);
  if (a == null || b == null) return null;
  return round(Math.min(1, Math.max(0, (b - a) / 1000 / (2 * aroundMs))), 3);
}

// The pipeline's delays for VI output `vi` (ms; null where a stage is not
// recorded): VI -> swap (video thread), swap -> ViTag replayed (worker),
// replayed -> present queued, and VI -> queued.
function delaysOf(vi, viT, { swaps, tags, queued }) {
  const s = swaps.get(vi) ?? null, g = tags.get(vi) ?? null, q = queued.get(vi) ?? null;
  const d = (a, b) => (a != null && b != null && Number.isFinite(a) && Number.isFinite(b) ? b - a : null);
  return {
    swap: s, replayT: g?.t ?? null, queuedT: q?.t ?? null,
    delays: { swap: d(viT, s?.t), replay: d(s?.t, g?.t), present: d(g?.t, q?.t), total: d(viT, q?.t) }
  };
}

// Every BeginFrame in [from, to) that showed no new picture although a VI
// output after the one on screen existed by then or came within the next
// period, with that output followed down the pipeline. timeline: { vi: [{ t,
// sinceBoot }], displayed: [{ t, submits, vi }], swaps?: [{ vi, t, behind,
// fifoBytes, fresh, held }], pipeline?: { tags: [{ vi, t }], queued: [{ vi,
// t }], ticks: [{ t, cb, vi }] } }; rows: the drop sampler's (rowsOf).
export function missedFrames(timeline, { from = -Infinity, to = Infinity, rows = null } = {}) {
  const displayed = timeline.displayed ?? [];
  if (!displayed.length) throw new Error("missedFrames needs the pictures displayed: record with --display");
  const T = refreshPeriodMs(displayed);
  const viT = new Map();
  for (const v of timeline.vi ?? []) if (Number.isFinite(v.sinceBoot) && !viT.has(v.sinceBoot)) viT.set(v.sinceBoot, v.t);
  const pipe = timeline.pipeline ?? null;
  const stages = { swaps: firstByVi(timeline.swaps), tags: firstByVi(pipe?.tags), queued: firstByVi(pipe?.queued) };
  // the presenter's callback time per BeginFrame (frameTime -> cb)
  const cbOf = new Map((pipe?.ticks ?? []).map((k) => [k.t, k.cb]));
  // the first BeginFrame that showed each output
  const shownAt = new Map();
  for (const b of displayed) if (b.submits > 0 && b.vi >= 0 && !shownAt.has(b.vi)) shownAt.set(b.vi, b.t);
  const out = [];
  let last = null; // the output on screen
  for (const b of displayed) {
    const fresh = b.submits > 0 && b.vi >= 0 && (last == null || b.vi > last);
    if (fresh) { last = b.vi; continue; }
    if (last == null || !(b.t >= from && b.t < to)) continue;
    const due = last + 1;
    const t = viT.get(due) ?? null;
    // nothing due: the next output comes more than a period after this one
    if (t != null && T != null && t > b.t + T) continue;
    const deadline = cbOf.get(b.t) ?? b.t;
    const k = t == null ? -1 : lastAtOrBefore(displayed, t);
    const phase = t == null || T == null || k < 0 ? null : round(((t - displayed[k].t) % T) / T, 4);
    // the first later BeginFrame that showed `due` or a newer output
    let later = null;
    for (const [vi, at] of shownAt) if (vi >= due && at > b.t && (later == null || at < later)) later = at;
    out.push({
      t: b.t, deadline, dueVi: due, viT: t, phase, slackMs: t == null ? null : round(deadline - t, 3),
      shownVi: shownAt.has(due) ? due : null, shownAt: shownAt.get(due) ?? later,
      ...delaysOf(due, t, stages), gpuBusy: t == null ? null : gpuBusyAround(rows, t)
    });
  }
  return { periodMs: T, missed: out, hasSwaps: Array.isArray(timeline.swaps), hasPipeline: Boolean(pipe) };
}

// The run's normal pipeline: the median of each delay over every VI output in
// [from, to) with that stage recorded (null when none is).
export function pipelineBaseline(timeline, { from = -Infinity, to = Infinity } = {}) {
  const pipe = timeline.pipeline ?? null;
  const stages = { swaps: firstByVi(timeline.swaps), tags: firstByVi(pipe?.tags), queued: firstByVi(pipe?.queued) };
  const acc = { swap: [], replay: [], present: [], total: [] };
  for (const v of timeline.vi ?? []) {
    if (!(v.t >= from && v.t < to)) continue;
    const { delays } = delaysOf(v.sinceBoot, v.t, stages);
    for (const k of Object.keys(acc)) if (delays[k] != null) acc[k].push(delays[k]);
  }
  return Object.fromEntries(Object.entries(acc).map(([k, xs]) => [k, xs.length ? round(median(xs), 3) : null]));
}

// One missed BeginFrame's cause: { cause, reason }.
export function classifyMissed(m, baseline, { band = NO_PRESENT_BAND, excessMs = NO_PRESENT_EXCESS_MS } = {}) {
  const banded = inBand(m.phase, band);
  if (m.viT == null) return { cause: "other", reason: "vi-unknown" };
  // the VI itself came after the deadline: nothing could be ready
  if (m.viT > m.deadline) return banded ? { cause: "beat", reason: "vi-after-vsync" } : { cause: "other", reason: "vi-late" };
  const s = m.swap;
  if (s) {
    const stale = s.fresh === false || s.held === true;
    if (stale && s.behind != null && s.behind > 0) return { cause: "fifo-behind", reason: s.held ? "held" : "duplicate" };
    if (s.fresh === false && s.held !== true && s.behind === 0) return { cause: "other", reason: "duplicate" };
  }
  if (m.queuedT != null && m.queuedT <= m.deadline) return { cause: "other", reason: "queued-not-shown" };
  if (m.shownAt == null) return { cause: "other", reason: "skipped" };
  const d = m.delays ?? {};
  // no pipeline data: only the phase can speak
  if (d.total == null || baseline?.total == null) return banded ? { cause: "beat", reason: "phase" } : { cause: "swap-not-ready", reason: "pipeline not recorded" };
  // a normal pipeline would have missed this vsync too
  if (m.slackMs < baseline.total) return banded ? { cause: "beat", reason: "phase" } : { cause: "swap-not-ready", reason: "normal latency" };
  const excess = [
    ["gpu-busy", d.swap, baseline.swap],
    ["replay-late", d.replay, baseline.replay],
    ["present-late", d.present, baseline.present]
  ].filter(([, x, b]) => x != null && b != null).map(([c, x, b]) => [c, x - b]).sort((a, b) => b[1] - a[1]);
  const top = excess[0];
  if (!top || !(top[1] > excessMs)) return { cause: "swap-not-ready", reason: "no stage over its median" };
  return top[0] === "present-late" ? { cause: "other", reason: "present-late" } : { cause: top[0], reason: `+${round(top[1], 1)} ms` };
}

// The deciles of the VI phase on the BeginFrame grid: every VI output in
// [from, to), and the missed ones.
function phaseDeciles(timeline, missed, periodMs, { from, to }) {
  const all = Array(10).fill(0), miss = Array(10).fill(0);
  const displayed = timeline.displayed ?? [];
  if (periodMs) for (const v of timeline.vi ?? []) {
    if (!(v.t >= from && v.t < to)) continue;
    const k = lastAtOrBefore(displayed, v.t);
    if (k < 0) continue;
    all[Math.min(9, Math.floor((((v.t - displayed[k].t) % periodMs) / periodMs) * 10))] += 1;
  }
  for (const m of missed) if (m.phase != null) miss[Math.min(9, Math.floor(m.phase * 10))] += 1;
  return { all, missed: miss };
}

// The missed BeginFrames of [from, to), classified, and the table.
export function analyzeNoPresent(timeline, { from = -Infinity, to = Infinity, rows = null, band = NO_PRESENT_BAND, excessMs = NO_PRESENT_EXCESS_MS } = {}) {
  const { periodMs, missed, hasSwaps, hasPipeline } = missedFrames(timeline, { from, to, rows });
  const baseline = pipelineBaseline(timeline, { from, to });
  const frames = missed.map((m) => ({ ...m, ...classifyMissed(m, baseline, { band, excessMs }) }));
  const byCause = Object.fromEntries(NO_PRESENT_CAUSES.map((c) => [c, 0]));
  const reasons = {};
  for (const f of frames) {
    byCause[f.cause] += 1;
    const key = `${f.cause}:${f.reason}`;
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  const n = frames.length;
  const delays = (k) => { const xs = frames.map((f) => f.delays?.[k]).filter((x) => x != null); return xs.length ? round(median(xs), 3) : null; };
  return {
    periodMs: periodMs == null ? null : round(periodMs, 3), band, excessMs, hasSwaps, hasPipeline,
    missed: n, byCause, share: Object.fromEntries(Object.entries(byCause).map(([c, k]) => [c, n ? round(k / n, 3) : null])), reasons,
    baseline, missedDelays: { swap: delays("swap"), replay: delays("replay"), present: delays("present"), total: delays("total") },
    phaseDeciles: phaseDeciles(timeline, frames, periodMs, { from, to }),
    frames
  };
}

// Several runs' tables summed (frames dropped from each).
export function sumNoPresent(results) {
  const byCause = Object.fromEntries(NO_PRESENT_CAUSES.map((c) => [c, 0]));
  const reasons = {};
  const all = Array(10).fill(0), miss = Array(10).fill(0);
  let missed = 0;
  for (const r of results) {
    missed += r.missed;
    for (const [c, k] of Object.entries(r.byCause)) byCause[c] += k;
    for (const [c, k] of Object.entries(r.reasons)) reasons[c] = (reasons[c] ?? 0) + k;
    r.phaseDeciles.all.forEach((k, i) => { all[i] += k; });
    r.phaseDeciles.missed.forEach((k, i) => { miss[i] += k; });
  }
  return { runs: results.length, missed, byCause, share: Object.fromEntries(Object.entries(byCause).map(([c, k]) => [c, missed ? round(k / missed, 3) : null])), reasons, phaseDeciles: { all, missed: miss } };
}

// The table as text lines.
export function noPresentLines(r) {
  const lines = [`missed BeginFrames: ${r.missed}${r.runs ? ` over ${r.runs} run(s)` : ""}`];
  for (const c of NO_PRESENT_CAUSES) lines.push(`  ${c.padEnd(16)} ${String(r.byCause[c]).padStart(5)}  ${r.share[c] == null ? "" : `${(100 * r.share[c]).toFixed(1)} %`}`);
  const reasons = Object.entries(r.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
  if (reasons) lines.push(`  reasons: ${reasons}`);
  lines.push(`  VI phase deciles, all VIs:  ${r.phaseDeciles.all.join(" ")}`);
  lines.push(`  VI phase deciles, missed:   ${r.phaseDeciles.missed.join(" ")}`);
  return lines;
}
