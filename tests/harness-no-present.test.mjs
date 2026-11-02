// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";

import { mergeTimeline } from "../harness/lib/timeline.mjs";
import { createPipelineLog } from "../src/harness-pipeline-log.js";
import { analyzeNoPresent, classifyMissed, gpuBusyAround, inBand, missedFrames, pipelineBaseline, refreshPeriodMs, sumNoPresent } from "../harness/lib/no-present.mjs";

const T = 16.667;
// BeginFrames every T from 1000; output k shown at BeginFrame k unless
// `skip` holds k's BeginFrame (nothing new: shown at the next one).
function scene({ n = 40, viLead = 8, skip = [], viAt = {} } = {}) {
  const displayed = [], vi = [];
  let next = 0;
  for (let i = 0; i < n; i += 1) {
    const t = 1000 + i * T;
    vi.push({ t: viAt[i] ?? t - viLead, sinceBoot: i });
    if (skip.includes(i)) displayed.push({ t, submits: 0, vi: -1 });
    else { displayed.push({ t, submits: 1, vi: i }); next = i + 1; }
  }
  return { displayed, vi, next };
}
// the pipeline of every output: swap `swapMs` after its VI, replayed
// `replayMs` later, queued `presentMs` after that
function withPipeline(s, { swapMs = 1, replayMs = 1, presentMs = 0.5, per = {} } = {}) {
  const swaps = [], tags = [], queued = [];
  for (const v of s.vi) {
    const p = { swapMs, replayMs, presentMs, behind: 0, fresh: true, held: false, ...(per[v.sinceBoot] ?? {}) };
    const st = v.t + p.swapMs, rt = st + p.replayMs;
    swaps.push({ vi: v.sinceBoot, t: st, behind: p.behind, fifoBytes: p.behind == null ? null : p.behind * 32, fresh: p.fresh, held: p.held });
    tags.push({ vi: v.sinceBoot, t: rt });
    if (p.fresh) queued.push({ vi: v.sinceBoot, t: rt + p.presentMs });
  }
  return { ...s, swaps, pipeline: { tags, queued, ticks: s.displayed.map((b) => ({ t: b.t, cb: b.t + 0.5, vi: b.vi })) } };
}

test("inBand: the default band wraps over the BeginFrame; unknown phase is null", () => {
  assert.equal(inBand(0.85), true);
  assert.equal(inBand(0.05), true);
  assert.equal(inBand(0.5), false);
  assert.equal(inBand(0.3, { from: 0.2, to: 0.4 }), true);
  assert.equal(inBand(null), null);
  assert.equal(inBand(NaN), null);
});

test("refreshPeriodMs: a missed BeginFrame (two periods) does not stretch the period", () => {
  const ts = [0, T, 2 * T, 4 * T, 5 * T, 6 * T].map((t) => ({ t }));
  assert.ok(Math.abs(refreshPeriodMs(ts) - T) < 1e-9);
  assert.equal(refreshPeriodMs([{ t: 0 }, { t: T }]), null);
});

test("missedFrames: a BeginFrame showing nothing new while the next output existed", () => {
  const s = scene({ skip: [10], viAt: { 10: 1000 + 10 * T - 1 } });
  const { missed } = missedFrames(s);
  assert.equal(missed.length, 1);
  const m = missed[0];
  assert.equal(m.dueVi, 10);
  assert.equal(m.shownVi, null, "output 10 is never shown: the next BeginFrame shows 11");
  assert.ok(Math.abs(m.shownAt - (1000 + 11 * T)) < 1e-9);
  assert.ok(Math.abs(m.slackMs - 1) < 1e-6);
  assert.ok(m.phase > 0.9 && m.phase < 1);
  // nothing recorded downstream: null, never 0
  assert.equal(m.swap, null);
  assert.deepEqual(m.delays, { swap: null, replay: null, present: null, total: null });
  assert.equal(m.gpuBusy, null);
});

test("missedFrames: nothing is due when the next output comes over a period later (emulation stall)", () => {
  const s = scene({ skip: [10] });
  s.vi[10].t = 1000 + 12 * T;
  assert.equal(missedFrames(s).missed.length, 0);
});

test("missedFrames: needs the pictures displayed", () => {
  assert.throws(() => missedFrames({ vi: [], displayed: [] }), /--display/);
});

test("classifyMissed without the pipeline: the phase alone, beat in the band", () => {
  const s = scene({ skip: [10, 20], viAt: { 10: 1000 + 10 * T - 1, 20: 1000 + 20 * T - 6 } });
  const r = analyzeNoPresent(s);
  assert.equal(r.missed, 2);
  assert.equal(r.frames[0].cause, "beat");
  assert.equal(r.frames[1].cause, "swap-not-ready");
  assert.equal(r.frames[1].reason, "pipeline not recorded");
  assert.equal(r.hasSwaps, false);
  assert.equal(r.baseline.total, null);
});

test("classifyMissed: a VI after the deadline is beat in the band, vi-late outside it", () => {
  const b = { total: 2.5, swap: 1, replay: 1, present: 0.5 };
  assert.deepEqual(classifyMissed({ viT: 1001, deadline: 1000, phase: 0.05 }, b), { cause: "beat", reason: "vi-after-vsync" });
  assert.deepEqual(classifyMissed({ viT: 1008, deadline: 1000, phase: 0.45 }, b), { cause: "other", reason: "vi-late" });
  assert.deepEqual(classifyMissed({ viT: null, deadline: 1000, phase: null }, b), { cause: "other", reason: "vi-unknown" });
});

test("classifyMissed: the swap overtook its copy (FIFO behind) - duplicate or 0211 hold", () => {
  const s = withPipeline(scene({ skip: [10], viAt: { 10: 1000 + 10 * T - 8 } }), { per: { 10: { fresh: false, behind: 4 } } });
  const r = analyzeNoPresent(s);
  assert.equal(r.missed, 1);
  assert.equal(r.frames[0].cause, "fifo-behind");
  assert.equal(r.frames[0].reason, "duplicate");
  const held = withPipeline(scene({ skip: [10], viAt: { 10: 1000 + 10 * T - 8 } }), { per: { 10: { fresh: true, held: true, behind: 2, presentMs: 30 } } });
  assert.equal(analyzeNoPresent(held).frames[0].cause, "fifo-behind");
  assert.equal(analyzeNoPresent(held).frames[0].reason, "held");
});

test("classifyMissed: a duplicate with the FIFO caught up is the game's own repeat; behind unknown is not 0", () => {
  const dup = withPipeline(scene({ skip: [10], viAt: { 10: 1000 + 10 * T - 8 } }), { per: { 10: { fresh: false, behind: 0 } } });
  assert.deepEqual(analyzeNoPresent(dup).frames.map((f) => [f.cause, f.reason]), [["other", "duplicate"]]);
  // behind null (single core): neither fifo-behind nor a duplicate of the game
  const unknown = withPipeline(scene({ skip: [10], viAt: { 10: 1000 + 10 * T - 8 } }), { per: { 10: { fresh: false, behind: null } } });
  const f = analyzeNoPresent(unknown).frames[0];
  assert.notEqual(f.cause, "fifo-behind");
  assert.notEqual(f.reason, "duplicate");
});

test("classifyMissed: the stage over its median names the cause (gpu-busy, replay-late)", () => {
  const late = (per) => withPipeline(scene({ skip: [10], viAt: { 10: 1000 + 10 * T - 8 } }), { per: { 10: per } });
  const g = analyzeNoPresent(late({ swapMs: 9 }));
  assert.equal(g.frames[0].cause, "gpu-busy");
  assert.equal(g.baseline.swap, 1);
  const r = analyzeNoPresent(late({ replayMs: 9 }));
  assert.equal(r.frames[0].cause, "replay-late");
  const p = analyzeNoPresent(late({ presentMs: 9 }));
  assert.deepEqual([p.frames[0].cause, p.frames[0].reason], ["other", "present-late"]);
});

test("classifyMissed: a normal pipeline that could not make the vsync is beat in the band, swap-not-ready outside", () => {
  // normal latency 2.5 ms; slack 1.5 ms (phase ~0.94) and 2 ms with a 3 ms-late VI at phase ~0.7 (band 0.8-0.1)
  const s = withPipeline(scene({ skip: [10, 20], viAt: { 10: 1000 + 10 * T - 1, 20: 1000 + 20 * T - 1.5 } }));
  const r = analyzeNoPresent(s, { band: { from: 0.95, to: 0.1 } });
  assert.deepEqual(r.frames.map((f) => f.cause), ["swap-not-ready", "swap-not-ready"]);
  const r2 = analyzeNoPresent(s);
  assert.deepEqual(r2.frames.map((f) => f.cause), ["beat", "beat"]);
  assert.equal(r2.byCause.beat, 2);
  assert.equal(r2.share.beat, 1);
});

test("classifyMissed: queued before the deadline yet not shown", () => {
  const m = { viT: 990, deadline: 1000, phase: 0.4, queuedT: 995, shownAt: 1016, delays: { total: 5 } };
  assert.deepEqual(classifyMissed(m, { total: 3 }), { cause: "other", reason: "queued-not-shown" });
});

test("pipelineBaseline: null for every stage not recorded", () => {
  assert.deepEqual(pipelineBaseline(scene()), { swap: null, replay: null, present: null, total: null });
  const b = pipelineBaseline(withPipeline(scene()));
  assert.equal(b.swap, 1);
  assert.equal(b.replay, 1);
  assert.equal(b.present, 0.5);
  assert.equal(b.total, 2.5);
});

test("gpuBusyAround: the GPU thread's share from cumulative rows; null outside them", () => {
  const rows = [{ t: 0, gpuWorkUs: 0 }, { t: 100, gpuWorkUs: 50000 }, { t: 200, gpuWorkUs: 60000 }];
  assert.equal(gpuBusyAround(rows, 50), 0.5);
  assert.equal(gpuBusyAround(rows, 190), null);
  assert.equal(gpuBusyAround(null, 50), null);
  assert.equal(gpuBusyAround([{ t: 0, gpuWorkUs: null }, { t: 100, gpuWorkUs: null }], 50), null);
});

test("analyzeNoPresent: phase deciles of every VI and of the missed ones; sums over runs", () => {
  const s = scene({ n: 60, viLead: 8, skip: [10], viAt: { 10: 1000 + 10 * T - 1 } });
  const r = analyzeNoPresent(s);
  // output 0 comes before the first BeginFrame: off the grid, not counted
  assert.equal(r.phaseDeciles.all.reduce((a, b) => a + b, 0), 59);
  assert.equal(r.phaseDeciles.missed[9], 1);
  const sum = sumNoPresent([r, r]);
  assert.equal(sum.missed, 2);
  assert.equal(sum.byCause.beat, 2);
  assert.equal(sum.phaseDeciles.all.reduce((a, b) => a + b, 0), 118);
});


test("pipeline log: tags, queued presents and ticks drained in order; an overwrite is counted lost", () => {
  const log = createPipelineLog({ capacity: 4 });
  log.tag(7, 100);
  log.queued(7, 101.5);
  log.tick(116.7, 117.2, 7);
  assert.deepEqual(log.drain(), { tags: { vi: [7], t: [100] }, queued: { vi: [7], t: [101.5] }, ticks: { t: [116.7], cb: [117.2], vi: [7] }, lost: 0 });
  assert.deepEqual(log.drain().lost, 0);
  for (let i = 0; i < 6; i += 1) log.tick(200 + i, 201 + i, null);
  const r = log.drain();
  assert.equal(r.lost, 2);
  assert.deepEqual(r.ticks.t, [202, 203, 204, 205]);
  assert.deepEqual(r.ticks.vi, [-1, -1, -1, -1], "an output the worker did not know is -1, left out by the reader");
});

test("mergeTimeline: swaps and the pipeline log, null when not recorded", () => {
  const base = { presents: { t: [], frame: [], vi: [], lost: 0 }, vi: { supported: true, t: [], ticks: [], sinceBoot: [], sinceLoad: [], lost: 0 }, displayed: null, displayedWhy: "x", displayedLost: 0 };
  const off = mergeTimeline([{ ...base, swaps: null, swapsWhy: "not requested", pipeline: null }]);
  assert.equal(off.swaps, null);
  assert.equal(off.pipeline, null);
  assert.equal(off.swapsWhy, "not requested");
  const log = createPipelineLog();
  log.tag(3, 10); log.queued(3, 11); log.tick(16.7, 17, 3);
  const on = mergeTimeline([{ ...base, swaps: { vi: [3], t: [9], behind: [null], fifoBytes: [null], fresh: [true], held: [false], lost: 1 }, swapsWhy: null, pipeline: log.drain() }]);
  assert.deepEqual(on.swaps, [{ vi: 3, t: 9, behind: null, fifoBytes: null, fresh: true, held: false }]);
  assert.equal(on.swapsLost, 1);
  assert.deepEqual(on.pipeline, { tags: [{ vi: 3, t: 10 }], queued: [{ vi: 3, t: 11 }], ticks: [{ t: 16.7, cb: 17, vi: 3 }] });
  assert.equal(on.complete, true, "the diag never makes an older timeline incomplete");
});

test("missedFrames: the presenter's callback time is the deadline when the log has it", () => {
  const s = withPipeline(scene({ skip: [10], viAt: { 10: 1000 + 10 * T - 1 } }));
  const m = missedFrames(s).missed[0];
  assert.ok(Math.abs(m.deadline - (1000 + 10 * T + 0.5)) < 1e-9);
  assert.ok(Math.abs(m.slackMs - 1.5) < 1e-6);
});

test("drop-meter: the no-present table per phase of the scenario, summed over usable runs", async () => {
  const { noPresentAcross, noPresentByPhase } = await import("../harness/probes/drop-meter.mjs");
  const s = scene({ n: 60, skip: [10, 40], viAt: { 10: 1000 + 10 * T - 1, 40: 1000 + 40 * T - 1 } });
  const raw = { markers: [{ label: "menus", t: 1000 }, { label: "race", t: 1000 + 30 * T }], endT: 1000 + 60 * T };
  const np = noPresentByPhase(raw, { ...s, swaps: null, pipeline: null, swapsWhy: "not requested" }, []);
  assert.deepEqual(Object.keys(np.phases), ["menus", "race"]);
  assert.equal(np.phases.menus.missed, 1);
  assert.equal(np.phases.race.missed, 1);
  assert.equal(np.phases.race.frames, undefined, "the table only");
  assert.equal(np.swapsWhy, "not requested");
  const runs = [{ side: "candidate", visit: 1, analysis: { noPresent: np } }, { side: "candidate", visit: 1, analysis: { noPresent: np, overloaded: true } }];
  const across = noPresentAcross(runs);
  assert.equal(across.length, 2);
  const race = across.find((g) => g.phase === "race");
  assert.equal(race.runs, 1, "an overloaded run is left out");
  assert.equal(race.pipeline, false);
  assert.equal(race.byCause.beat, 1);
});
