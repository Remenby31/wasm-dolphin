// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { beginFrameGaps, causeOf, displaySummaryOf, PHASE_FLOOR, PHASE_PRIMARY, stallMsOfRows, tQuantile, dropEvents, dropSummary, interpolate, loadSegments, noiseOf, rowsOf, stallOverlap, trendLine, trendTable, verdictOf, visitVerdict, windowsOf } from "../harness/lib/drops.mjs";
import { coreOf, exitCodeOf, falsePositiveRate, noiseCoreOf, markersOnVi, noVerdictReasons, regressionKeys, runFiles, stepsFor, validateScenario } from "../harness/probes/drop-meter.mjs";
import { createDropSampler, histogramSum } from "../src/harness-drop-sampler.js";

const TPS = 486e6;
// VI outputs every 1000/60 ms of host time over `ms`, the guest advancing at
// speed(t) % of real time.
function viOf(ms, speed = () => 100) {
  const vi = [];
  let ticks = 0;
  for (let t = 0; t <= ms; t += 1000 / 60) {
    vi.push({ t, ticks });
    ticks += (TPS / 60) * (speed(t) / 100);
  }
  return vi;
}
const presentsOf = (vi) => vi.map((v) => ({ t: v.t }));
// Sampler rows every 50 ms: cumulative columns from f(t).
const rowsAt = (ms, f) => Array.from({ length: Math.floor(ms / 50) + 1 }, (_, i) => ({ t: i * 50, lagMs: 0, ...f(i * 50) }));

test("the sampler paces itself on its schedule and records how late each tick ran", () => {
  let now = 0;
  const timers = [];
  const s = createDropSampler({ columns: ["a"], read: () => [now * 2], now: () => now, setTimer: (fn, ms) => timers.push({ fn, at: now + ms }), clearTimer: () => {} });
  s.start(50);
  const run = (at) => { const t = timers.shift(); now = at; t.fn(); };
  run(50); run(180); run(200);
  const d = s.drain();
  assert.deepEqual(d.columns, ["t", "lagMs", "a"]);
  assert.deepEqual(d.rows.map((r) => r[1]), [0, 0, 80, 0]); // the third tick was due at 100
  assert.equal(d.lagMaxMs, 80);
  assert.equal(s.drain().rows.length, 0);
  assert.equal(s.stop().running, false);
});

test("a read that throws leaves nulls and is counted, the sampler goes on", () => {
  let now = 0;
  const s = createDropSampler({ columns: ["a", "b"], read: () => { throw new Error("gone"); }, now: () => now, setTimer: () => 1, clearTimer: () => {} });
  s.start();
  const d = s.drain();
  assert.deepEqual(d.rows[0].slice(2), [null, null]);
  assert.equal(d.errors, 1);
  assert.equal(d.lastError, "gone");
});

test("histogram sums take each bin at its middle, the overflow bin at its edge", () => {
  const w = new Uint32Array(8);
  w[2] = 2; w[3] = 1; w[5] = 4; // bins 0, 1 and 3 (last) of a 4-bin histogram at offset 2
  assert.deepEqual(histogramSum(w, 2, 4, 100), { sum: 2 * 50 + 1 * 150 + 4 * 300, count: 7 });
});

test("u32 columns that wrap are unwrapped before any difference", () => {
  const rows = rowsOf([{ columns: ["t", "lagMs", "jitModuleUs", "ticks"], rows: [[0, 0, 2 ** 32 - 10, 5], [50, 0, 20, 6]] }]);
  assert.equal(rows[1].jitModuleUs - rows[0].jitModuleUs, 30);
  assert.equal(rows[1].ticks, 6);
});

test("interpolation and stall overlap", () => {
  const pts = [{ t: 0, x: 0 }, { t: 100, x: 10 }];
  assert.equal(interpolate(pts, "x", 50), 5);
  assert.equal(interpolate(pts, "x", 150), null);
  // a tick 70 ms late at t = 120 covers 50..120: 50 ms of the window 0..100
  assert.equal(stallOverlap([{ t: 120, lagMs: 70 }], 0, 100), 50);
  assert.equal(stallOverlap([{ t: 120, lagMs: 10 }], 0, 100), 0); // under STALL_MIN_MS
});

test("windows: speed and lost time from the VI ticks, causes from the counters", () => {
  // 2 s; between 1.0 and 1.3 s the guest runs at 20 %, the CPU thread
  // compiling blocks 240 ms (patch 0167's jitUs) and never sleeping.
  const slow = (t) => (t >= 1000 && t < 1300 ? 20 : 100);
  const vi = viOf(2000, slow);
  const rows = rowsAt(2000, (t) => ({
    jitUs: t <= 1000 ? 0 : t >= 1300 ? 240000 : (t - 1000) * 800,
    cpuSleepUs: t < 1000 ? t * 500 : t < 1300 ? 500000 : 500000 + (t - 1300) * 500
  }));
  const w = windowsOf({ vi, presents: presentsOf(vi), rows, tps: TPS, markers: [{ t: 0, label: "menus" }, { t: 1000, label: "race-load" }] });
  assert.equal(w.length, 19);
  assert.ok(Math.abs(w[0].speed - 100) < 2);
  assert.ok(w[11].speed < 25 && w[11].lostMs > 75);
  assert.equal(w[11].label, "race-load");
  assert.ok(Math.abs(w[11].causes.jit - 80) < 1);
  const events = dropEvents(w);
  assert.equal(events.length, 1);
  assert.equal(events[0].cause, "jit");
  assert.equal(events[0].label, "race-load");
  assert.ok(events[0].lostMs > 200 && events[0].lostMs < 260);
  const s = dropSummary({ windows: w, presents: presentsOf(vi), vi });
  assert.ok(s.lostMs > 200);
  assert.ok(s.worstSecond < 80);
});

test("a drop with no cause counted: uncounted-busy when the CPU never slept, else unexplained", () => {
  const w = (sleptMs) => ({ t0: 0, speed: 50, lostMs: 50, sleptMs, causes: { jit: 0, disc: 1 } });
  assert.equal(causeOf([w(0), w(0)]).cause, "uncounted-busy");
  assert.equal(causeOf([w(40), w(40)]).cause, "unexplained");
});

test("present gaps make a drop even at full speed; hitch counts", () => {
  const vi = viOf(1000);
  const presents = presentsOf(vi).filter((p) => p.t < 400 || p.t > 520);
  const w = windowsOf({ vi, presents, tps: TPS });
  const ev = dropEvents(w);
  assert.equal(ev.length, 1);
  assert.ok(ev[0].maxPresentGap > 100);
  const s = dropSummary({ windows: w, presents, vi });
  assert.equal(s.hitches100, 1);
  assert.equal(s.hitches50, 1);
});

test("loads: sustained disc reads, music streaming left out; excess is host minus guest", () => {
  const vi = viOf(4000, (t) => (t >= 1000 && t < 2000 ? 50 : 100));
  const rows = rowsAt(4000, (t) => ({ discBytes: t * 200 + (t >= 1000 && t < 2000 ? (t - 1000) * 6000 : t >= 2000 ? 6e6 : 0) }));
  const w = windowsOf({ vi, presents: presentsOf(vi), rows, tps: TPS });
  const loads = loadSegments(w);
  assert.equal(loads.length, 1);
  assert.ok(Math.abs(loads[0].hostMs - 1000) <= 200);
  assert.ok(Math.abs(loads[0].excessMs - 500) <= 100);
});

const L = { metrics: { lostMs: "up" } };
test("verdict: a move beyond the noise is a regression, inside it is not", () => {
  const base = [{ lostMs: 300 }, { lostMs: 320 }, { lostMs: 310 }];
  assert.equal(verdictOf(base, [{ lostMs: 305 }, { lostMs: 315 }, { lostMs: 325 }], L).regression, false);
  const v = verdictOf(base, [{ lostMs: 600 }, { lostMs: 620 }, { lostMs: 610 }], L);
  assert.equal(v.regression, true);
  assert.equal(v.rows[0].metric, "lostMs");
  // An A/A whose spread is 200 ms: a 300 ms move of medians of 3 is noise.
  assert.equal(verdictOf(base, [{ lostMs: 600 }, { lostMs: 620 }, { lostMs: 610 }], { ...L, noise: { lostMs: { n: 6, stdev: 200 } } }).regression, false);
  // worstSecond (a primary): lower is worse.
  assert.equal(verdictOf([{ worstSecond: 90 }, { worstSecond: 91 }, { worstSecond: 89 }], [{ worstSecond: 40 }, { worstSecond: 41 }, { worstSecond: 42 }]).regression, true);
});

// Review of #261 (P0): a comparison that measured too little is never "no
// regression": inconclusive, and the probe exits 3.
test("too few runs, or none, is inconclusive even with an A/A", () => {
  const noise = { lostMs: { n: 6, stdev: 100 } };
  assert.equal(verdictOf([{ lostMs: 854 }], [{ lostMs: 957 }], { ...L, noise }).inconclusive, true);
  assert.equal(verdictOf([], [], { ...L, noise }).inconclusive, true);
  assert.equal(verdictOf([], [], { ...L, noise }).regression, false);
  const ok = Array.from({ length: 3 }, () => ({ summary: { hitches100: 1, worstSecond: 80 }, phases: [{ label: "race", stallMs: 0, presentExcessMs: 0, hitches50: 0, presentsPerGuestSec: 60 }] }));
  assert.equal(visitVerdict(ok, ok).inconclusive, false);
  assert.equal(visitVerdict(ok.slice(0, 2), ok).inconclusive, true);
  // a phase a side never reached has no verdict
  assert.equal(visitVerdict(ok, ok.map((a) => ({ ...a, phases: [...a.phases, { label: "extra", stallMs: 0, presentExcessMs: 0, hitches50: 0, presentsPerGuestSec: 60 }] }))).inconclusive, true);
});

test("exit codes: 3 without a verdict, 2 only on a reproduced regression when confirming", () => {
  const sum = (regressions, extra = {}) => ({ visitSummary: [{ visit: 1, verdict: { regressions } }], ...extra });
  const reg = [{ where: "race-load", metric: "dropLostMs" }];
  assert.equal(exitCodeOf(sum([]), { compared: true, failed: false }), 0);
  assert.equal(exitCodeOf(sum(reg), { compared: true, failed: false }), 2);
  assert.deepEqual(regressionKeys(sum(reg)), ["1|race-load:dropLostMs"]);
  assert.equal(exitCodeOf(sum([], { noVerdict: ["load gave up"] }), { compared: true, failed: false }), 3);
  assert.equal(exitCodeOf(sum(reg, { confirmation: { confirmed: false } }), { compared: true, failed: false }), 0);
  assert.equal(exitCodeOf(sum(reg, { confirmation: { confirmed: true } }), { compared: true, failed: false }), 2);
  assert.equal(exitCodeOf(sum(reg, { confirmation: { confirmed: false, noVerdict: ["x"] } }), { compared: true, failed: false }), 3);
});

test("no verdict when a side has too few usable runs or the sides were sampled differently", () => {
  const a = (side, overloaded = false, sampled = true) => ({ side, visit: 1, analysis: { overloaded, sampled } });
  const verdicts = { 1: { inconclusive: false } };
  assert.equal(noVerdictReasons({ analyses: [a("baseline"), a("baseline"), a("baseline"), a("candidate"), a("candidate"), a("candidate")], visits: 1, verdicts }), null);
  assert.match(noVerdictReasons({ analyses: [a("baseline"), a("baseline"), a("baseline", true), a("candidate"), a("candidate"), a("candidate")], visits: 1, verdicts })[0], /2 usable baseline/);
  assert.match(noVerdictReasons({ analyses: [a("baseline", false, false), a("baseline", false, false), a("baseline", false, false), a("candidate"), a("candidate"), a("candidate")], visits: 1, verdicts }).join(), /sampled alike/);
});

// Review of #261 (P1-4, then P1-b): a 50 ms stall the throttle then makes
// up nets ~0 in lostMs and depends on the 100 ms grid in dropLostMs; the
// stall metric reads it from the VI intervals, wherever it falls.
test("a 50 ms stall made up afterwards: stallMs shows it at any offset of the grid", () => {
  for (const at of [1000, 1030, 1070]) {
    const vi = [];
    let ticks = 0;
    for (let t = 0; t <= 3000; t += 1000 / 60) {
      if (t >= at && t < at + 50) continue; // the core stood still 50 ms
      vi.push({ t, ticks });
      ticks += TPS / 60;
    }
    // made up: three fields come fast after it
    const presents = presentsOf(vi);
    const w = windowsOf({ vi, presents, tps: TPS });
    const s = dropSummary({ windows: w, presents, vi, tps: TPS });
    assert.ok(s.stallMs >= 45 && s.stallMs <= 70, `at ${at}: stallMs ${s.stallMs}`);
  }
  const phase = (x) => ({ summary: { hitches100: 0, worstSecond: 99 }, phases: [{ label: "race-load", ...x }] });
  const base = [0, 2, 1].map((d) => phase({ stallMs: d, hitches50: 0 }));
  const cand = [50, 52, 49].map((d) => phase({ stallMs: d, hitches50: 6 }));
  const v = visitVerdict(base, cand, { run: null, phases: { "race-load": { stallMs: { n: 6, stdev: 2 }, hitches50: { n: 6, stdev: 0 } } } });
  assert.equal(v.regression, true);
  assert.deepEqual(v.regressions.map((r) => r.metric).sort(), ["hitches50", "stallMs"]);
});

test("phase floors: a second under 95 % alone is never a regression (pctBelow95 is reported only)", () => {
  assert.ok(PHASE_FLOOR.pctBelow95 >= 0.5 && PHASE_FLOOR.stallMs === 20 && PHASE_FLOOR.hitches50 === 0.5);
  assert.ok(!("pctBelow95" in PHASE_PRIMARY));
});

test("the false-positive rate on identical runs stays low; a real shift is found", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const run = (id, d) => [1].map((visit) => ({ id, visit, analysis: { summary: { hitches100: 1, worstSecond: 80 + (random() - 0.5) * 4 }, phases: [{ label: "race-load", stallMs: d + random() * 4, hitches50: Math.round(random()) }] } }))[0];
  const same = Array.from({ length: 9 }, (_, i) => run(`a${i}`, 0));
  const fp = falsePositiveRate(same, { visits: 1, draws: 300, random });
  assert.ok(fp.singleBatch < 0.1, `single ${fp.singleBatch}`);
  assert.ok(fp.confirmed <= fp.singleBatch);
});

// Follow-up of #261's review: a stall inside a long VI gap (no VI entry to
// measure it) still shows through the sampler's ticks.
test("stallMs reads the sampler's ticks too: a stall in a VI gap is not missed", () => {
  const vi = [{ t: 0, ticks: 0 }, { t: 1000, ticks: TPS * 0.95 }]; // one long VI gap, 50 ms lost inside
  const rows = [];
  for (let t = 0, g = 0; t <= 1000; t += 50) {
    rows.push({ t, lagMs: 0, ticks: g });
    g += t >= 400 && t < 450 ? 0 : TPS * 0.05; // 50 ms of guest time per row, none in the stall
  }
  const s = dropSummary({ windows: [], vi, tps: TPS, rows });
  assert.ok(s.stallRowsMs >= 45 && s.stallRowsMs <= 55, `rows ${s.stallRowsMs}`);
  assert.ok(s.stallMs >= s.stallRowsMs);
});

test("the sampler reading catches a 50 ms stall straddling two rows, and stays ~0 on the throttle's bursts", () => {
  const rows = [];
  let g = 0;
  for (let t = 0; t <= 1000; t += 50) {
    rows.push({ t, lagMs: 0, ticks: g });
    // the next 50 ms: guest time, minus the part of [425, 475) inside it
    const lost = Math.max(0, Math.min(t + 50, 475) - Math.max(t, 425));
    g += TPS * (50 - lost) / 1000;
  }
  const ms = stallMsOfRows(rows, TPS);
  assert.ok(ms >= 45 && ms <= 55, `straddled: ${ms}`);
  // bursts: rows alternating 0.8 and 1.2 of real time never add up
  const bursty = [];
  g = 0;
  for (let i = 0, t = 0; i <= 40; i += 1, t += 50) { bursty.push({ t, lagMs: 0, ticks: g }); g += TPS * (i % 2 ? 0.06 : 0.04); }
  assert.equal(stallMsOfRows(bursty, TPS), 0);
});

// Review of #267 (P1): the presenter can stall while the core runs on (a
// wgpu pipeline compiled at draw time): stallMs and worstSecond read 0; the
// gap excess per phase must catch 2-3 new 100 ms gaps.
test("presenter stalls with a regular core: presentExcessMs catches 2-3 new 100 ms gaps", () => {
  const vi = viOf(10000);
  const presents = presentsOf(vi);
  const gapped = presents.filter((p) => !((p.t > 2000 && p.t < 2100) || (p.t > 5000 && p.t < 5100) || (p.t > 8000 && p.t < 8100)));
  const w = windowsOf({ vi, presents: gapped, tps: TPS });
  const s = dropSummary({ windows: w, presents: gapped, vi, tps: TPS });
  assert.equal(s.stallMs, 0);
  assert.ok(s.presentExcessMs >= 180, `excess ${s.presentExcessMs}`);
  const phase = (x) => ({ summary: { hitches100: 0, worstSecond: 99 }, phases: [{ label: "race", stallMs: 0, hitches50: 0, ...x }] });
  const noise = { run: { hitches100: { n: 6, stdev: 0, mean: 0, median: 0 }, worstSecond: { n: 6, stdev: 1 } },
    phases: { race: { stallMs: { n: 6, stdev: 3 }, presentExcessMs: { n: 6, stdev: 5, mean: 3 }, hitches50: { n: 6, stdev: 0, mean: 0, median: 0 } } } };
  const v = visitVerdict([2, 4, 3].map((e) => phase({ presentExcessMs: e })), [190, 200, 210].map((e) => phase({ presentExcessMs: e, hitches50: 3 })), noise);
  assert.ok(v.regressions.some((r) => r.metric === "presentExcessMs"));
  assert.ok(v.regressions.some((r) => r.metric === "hitches50"), "3 new gaps over 50 ms where none were: a count regression too");
});

// Review of #267 follow-ups: a sustained slowness is no stall; at 30
// images/s the nominal gap and its jitter are no presenter stall.
test("80 % speed for 4 s: no stall from the ticks (slowRowsMs reports it); 30 images/s: no present excess", () => {
  const rows = [];
  let g = 0;
  for (let t = 0; t <= 4000; t += 50) { rows.push({ t, lagMs: 0, ticks: g }); g += TPS * 0.04; } // 80 %
  assert.equal(stallMsOfRows(rows, TPS), 0);
  assert.ok(stallMsOfRows(rows, TPS, 0.85) > 500, "the slowness, read apart");
  const p30 = [];
  for (let t = 0, i = 0; t < 10000; t += 1000 / 30 + (i++ % 2 ? 4 : -4)) p30.push({ t }); // 30 i/s with jitter
  const vi = viOf(10000);
  const s = dropSummary({ windows: windowsOf({ vi, presents: p30, tps: TPS }), presents: p30, vi, tps: TPS });
  assert.equal(s.presentExcessMs, 0);
  const stalled = p30.filter((p) => p.t < 5000 || p.t > 5150);
  const s2 = dropSummary({ windows: windowsOf({ vi, presents: stalled, tps: TPS }), presents: stalled, vi, tps: TPS });
  assert.ok(s2.presentExcessMs > 80, `a 180 ms gap at 30 i/s: ${s2.presentExcessMs}`);
});

// --display (review of #265): what the screen showed. 60 BeginFrames a
// second; a new image on every frame, but for a 3-vsync hole and a 120 ms one.
test("screen side: distinct images, intervals of 3 vsyncs or more, gaps over 100 ms, excess", () => {
  const displayed = [];
  let vi = 0;
  for (let i = 0, t = 0; i < 600; i += 1, t += 1000 / 60) {
    const hole = (i >= 100 && i < 102) || (i >= 300 && i < 307); // 2 frames then 7 frames with nothing new
    displayed.push({ t, submits: hole ? 0 : 1, vi: hole ? vi : ++vi });
  }
  const d = displaySummaryOf(displayed);
  assert.ok(d.displayedPerSecond > 58 && d.displayedPerSecond < 60);
  assert.equal(d.displayRepeats3, 2);
  assert.equal(d.displayGaps100, 1);
  assert.ok(d.displayExcessMs > 90 && d.displayExcessMs < 120, `excess ${d.displayExcessMs}`);
  // the same image shown again (submits, same VI) is no new image
  const same = displayed.map((f, i) => (i >= 200 && i < 205 ? { ...f, vi: displayed[199].vi } : f));
  assert.equal(displaySummaryOf(same).displayRepeats3, 3);
  assert.equal(displaySummaryOf([]), null);
});

test("with --display the gating reads the screen, the presentation metrics stay reported", () => {
  const run = (x) => ({ summary: { displayGaps100: 0, worstSecond: 99, hitches100: 0, presentExcessMs: 0 }, phases: [{ label: "race", stallMs: 0, displayExcessMs: 0, displayRepeats3: 0, presentExcessMs: 0, hitches50: 0, presentsPerGuestSec: 60, displayedPerGuestSec: 60, ...x }] });
  const base = [run({}), run({}), run({})];
  // presents worse (present-vsync: a late image is a 3-vsync interval), screen unchanged
  const cand = [run({ presentExcessMs: 60, hitches50: 7 }), run({ presentExcessMs: 62, hitches50: 7 }), run({ presentExcessMs: 61, hitches50: 7 })];
  assert.equal(visitVerdict(base, cand).regression, true, "on the presentations");
  assert.equal(visitVerdict(base, cand, null, { display: true }).regression, false, "not on the screen");
  const worse = [run({ displayExcessMs: 90, displayRepeats3: 6 }), run({ displayExcessMs: 95, displayRepeats3: 6 }), run({ displayExcessMs: 92, displayRepeats3: 7 })];
  assert.deepEqual(visitVerdict(base, worse, null, { display: true }).regressions.map((r) => r.metric).sort(), ["displayExcessMs", "displayRepeats3"]);
});

// Review of #269: a straddled 50 ms stall the core then makes up at x2
// was caught 46 % of the time against a fixed 0.6; against the local speed
// it is caught whole, wherever it falls.
test("a straddled 50 ms stall followed by a x2 catch-up is caught at any offset", () => {
  for (const at of [400, 410, 425, 440, 449]) {
    const rows = [];
    let g = 0;
    for (let t = 0; t <= 1500; t += 50) {
      rows.push({ t, lagMs: 0, ticks: g });
      const lost = Math.max(0, Math.min(t + 50, at + 50) - Math.max(t, at));
      const back = Math.max(0, Math.min(t + 50, at + 100) - Math.max(t, at + 50)); // 50 ms at x2 right after
      g += TPS * (50 - lost + back) / 1000;
    }
    // The part of the stall sharing a 50 ms row with the catch-up nets out
    // inside that row (no reading at 50 ms can see it): at least half of the
    // 50 ms, over the 20 ms floor wherever the stall falls. stallMs takes the
    // VI reading too, which sees it whole when the VI outputs go on.
    const ms = stallMsOfRows(rows, TPS);
    assert.ok(ms >= 25 && ms <= 55, `stall at ${at}: ${ms}`);
  }
});

test("a cadence halved with the core at 100 %: images per guest second regress", () => {
  const vi = viOf(5000);
  const p60 = presentsOf(vi), p30 = p60.filter((_, i) => i % 2 === 0);
  const s60 = dropSummary({ windows: windowsOf({ vi, presents: p60, tps: TPS }), presents: p60, vi, tps: TPS });
  const s30 = dropSummary({ windows: windowsOf({ vi, presents: p30, tps: TPS }), presents: p30, vi, tps: TPS });
  assert.ok(Math.abs(s60.presentsPerGuestSec - 60) < 1 && Math.abs(s30.presentsPerGuestSec - 30) < 1);
  assert.equal(s30.presentExcessMs, 0, "no gap past the median: the old gating saw nothing");
  const phase = (x) => ({ summary: { hitches100: 0, worstSecond: 99 }, phases: [{ label: "race", stallMs: 0, presentExcessMs: 0, hitches50: 0, ...x }] });
  const v = visitVerdict([60, 60, 60].map((n) => phase({ presentsPerGuestSec: n })), [30, 30, 30].map((n) => phase({ presentsPerGuestSec: n })));
  assert.deepEqual(v.regressions.map((r) => r.metric), ["presentsPerGuestSec"]);
});

// Review of #270: guest time advancing in coarse steps (33 ms jumps), or a
// sustained 50 % speed, is no stall; at 30 images/s a 2-vsync interval is
// the cadence, not a repeat.
test("coarse guest steps and sustained slowness read no stall; repeats are relative to the cadence", () => {
  // guest time in quanta of q ms of host time (VI-paced steps), at 100 %; and 50 % sustained
  const quanta = (q) => (t) => Math.floor(t / q) * q;
  for (const [name, guestAt] of [["33 ms steps", quanta(1000 / 30)], ["66 ms steps", quanta(2000 / 30)], ["50 % for 4 s", (t) => t / 2]]) {
    const rows = [];
    for (let t = 0; t <= 4000; t += 50) rows.push({ t, lagMs: 0, ticks: (guestAt(t) * TPS) / 1000 });
    assert.ok(stallMsOfRows(rows, TPS) < 30, `${name}: ${stallMsOfRows(rows, TPS)}`);
  }
  const displayed = [];
  for (let i = 0, t = 0, vi = 0; i < 600; i += 1, t += 1000 / 60) displayed.push({ t, submits: i % 2 ? 0 : 1, vi: i % 2 ? vi : ++vi }); // 30 images/s
  assert.equal(displaySummaryOf(displayed).displayRepeats3, 0);
});

// Review of #271: low rows that are contiguous are a stall, whatever the
// share: a 500 ms stall in a long VI gap, a 50 ms one in a phase at 70 %.
test("contiguous low rows are a stall: 500 ms at 100 %, 50 ms at 70 %", () => {
  for (const [name, speed, from, to, expect] of [["500 ms at 100 %", 1, 1000, 1500, 500], ["50 ms at 70 %", 0.7, 1000, 1050, 35]]) {
    const rows = [];
    let g = 0;
    for (let t = 0; t <= 3000; t += 50) {
      rows.push({ t, lagMs: 0, ticks: g });
      const lost = Math.max(0, Math.min(t + 50, to) - Math.max(t, from));
      g += TPS * speed * (50 - lost) / 1000;
    }
    const ms = stallMsOfRows(rows, TPS);
    assert.ok(ms >= 0.9 * expect && ms <= 1.1 * (to - from), `${name}: ${ms}`);
  }
});

// The A/A --display of main had one run with a 4.4 s BeginFrame gap: the
// phase's sd went from ~10 to 1773 ms. Robust noise: that run is counted as
// an outlier, the threshold stays that of the others.
test("robust A/A noise: one far-off run is reported, it does not widen the threshold", () => {
  // 6 runs: the outlier is counted, not left out (a 6-run MAD is noisy)
  const six = noiseOf([0, 17, 0, 17, 4350, 0].map((v) => ({ displayExcessMs: v })));
  assert.equal(six.displayExcessMs.outliers, 1);
  assert.equal(six.displayExcessMs.trimmedSd, undefined);
  // 10 runs: left out of the threshold's sd, df = runs kept - 1
  const n = noiseOf([0, 17, 0, 17, 4350, 0, 9, 3, 12, 5].map((v) => ({ displayExcessMs: v })));
  assert.equal(n.displayExcessMs.outliers, 1);
  assert.equal(n.displayExcessMs.keptN, 9);
  assert.ok(n.displayExcessMs.trimmedSd < 30 && n.displayExcessMs.stdev > 1000);
  // mostly 0 with a few 20 ms readings: that is the spread, no outlier
  const z = noiseOf([0, 22, 0, 18, 0, 27, 0, 0, 21, 0].map((v) => ({ stallMs: v })));
  assert.equal(z.stallMs.outliers, 0);
  assert.equal(z.stallMs.trimmedSd, undefined);
  const b = [{ displayExcessMs: 0 }, { displayExcessMs: 10 }, { displayExcessMs: 5 }], c = [{ displayExcessMs: 300 }, { displayExcessMs: 320 }, { displayExcessMs: 310 }];
  assert.equal(verdictOf(b, c, { metrics: { displayExcessMs: "up" }, noise: n, floor: PHASE_FLOOR }).regression, true);
  assert.equal(verdictOf(b, c, { metrics: { displayExcessMs: "up" }, noise: six, floor: PHASE_FLOOR }).regression, false, "with 6 runs the outlier's sd stays: no verdict through it");
});

test("BeginFrame gaps: the worker's rAF and the page's, apart", () => {
  const displayed = [{ t: 0, submits: 1, vi: 1 }, { t: 16, submits: 1, vi: 2 }, { t: 4400, submits: 263, vi: 265 }];
  const page = [];
  for (let t = 0, r = 0; t <= 4400; t += 50) page.push({ t, lagMs: 0, rafs: (r += 3) }); // the page's rAF kept going
  assert.deepEqual(beginFrameGaps(displayed, page), { workerBeginFrameGapMs: 4384, pageBeginFrameGapMs: 0 });
  const stopped = page.map((r) => (r.t > 1000 && r.t < 3000 ? { ...r, rafs: 60 } : r)).map((r, i, a) => ({ ...r, rafs: r.t >= 3000 ? 60 + i : r.rafs }));
  assert.ok(beginFrameGaps(displayed, stopped).pageBeginFrameGapMs >= 1900);
});

test("hitch counts never get an sd under Poisson's: an A/A that always saw 3 is not certainty", () => {
  const b = [{ hitches50: 3 }, { hitches50: 3 }, { hitches50: 3 }], c = [{ hitches50: 5 }, { hitches50: 5 }, { hitches50: 5 }];
  const v = verdictOf(b, c, { metrics: { hitches50: "up" }, noise: { hitches50: { n: 6, stdev: 0, mean: 3, median: 3 } }, floor: PHASE_FLOOR });
  assert.equal(v.regression, false, "two more gaps where 3 come and go");
  const big = verdictOf(b, [{ hitches50: 14 }, { hitches50: 15 }, { hitches50: 14 }], { metrics: { hitches50: "up" }, noise: { hitches50: { n: 6, stdev: 0, mean: 3, median: 3 } }, floor: PHASE_FLOOR });
  assert.equal(big.regression, true);
});

// Review rule: an A/A's noise holds for its core only; the summary records
// each side's core, and an A/A without one counts as stale.
test("the core of a served tree and of an A/A summary", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = mkdtempSync(path.join(os.tmpdir(), "drops-core-"));
  assert.equal(coreOf(root), null);
  mkdirSync(path.join(root, "cores", "dolphin"), { recursive: true });
  writeFileSync(path.join(root, "cores", "dolphin", "core.lock.json"), JSON.stringify({ schemaVersion: 1, sha256: "ab".repeat(32) }));
  assert.equal(coreOf(root), "ab".repeat(32));
  writeFileSync(path.join(root, "aa.json"), JSON.stringify({ probe: "drop-meter", cores: { candidate: "cd".repeat(32) } }));
  writeFileSync(path.join(root, "old.json"), JSON.stringify({ probe: "drop-meter" }));
  assert.equal(noiseCoreOf(path.join(root, "aa.json")), "cd".repeat(32));
  assert.equal(noiseCoreOf(path.join(root, "old.json")), null);
});

test("t quantiles: a small A/A widens the threshold", () => {
  assert.ok(tQuantile(5) > 4 && tQuantile(5) < 4.1);
  assert.equal(tQuantile(100), 2.576);
  const base = [{ hitches100: 1 }, { hitches100: 1 }, { hitches100: 1 }];
  const t5 = verdictOf(base, base, { noise: { hitches100: { n: 6, stdev: 1 } } }).rows.find((r) => r.metric === "hitches100").threshold;
  const t30 = verdictOf(base, base, { noise: { hitches100: { n: 31, stdev: 1 } } }).rows.find((r) => r.metric === "hitches100").threshold;
  assert.ok(t5 > 1.4 * t30); // 4.03 against 2.75
});

test("a retried run replaces its failed attempt", () => {
  assert.deepEqual(runFiles(["candidate-1-v1.json", "candidate-1-v1-retry.json", "candidate-2-v1.json", "x.json"], /^(candidate|baseline)-(\d+)-v(\d+)(-retry)?\.json$/), ["candidate-1-v1-retry.json", "candidate-2-v1.json"]);
});

test("phase bounds come from the VI ring at their guest second, not from the poll's host time", () => {
  const vi = viOf(2000);
  const raw = { tps: TPS, markers: [{ t: 1234, label: "x", guest: 1 }], endT: 9999, endGuest: 1.5 };
  const m = markersOnVi(raw, vi);
  assert.ok(Math.abs(m.markers[0].t - 1000) < 17);
  assert.ok(Math.abs(m.endT - 1500) < 17);
});

test("A/A noise, trend line and table", () => {
  const n = noiseOf([{ lostMs: 100, worstSecond: 50 }, { lostMs: 140, worstSecond: 52 }]);
  assert.equal(n.lostMs.median, 120);
  assert.ok(n.lostMs.minDiff > 0);
  const line = trendLine({ at: "2026-10-25T23:00:00Z", commit: "abcdef0123", visitSummary: [{ visit: 2, runs: 3, noise: n, worst: [{ label: "race-load", cause: "jit", lostMs: 212.4 }] }] });
  assert.equal(line.visits[0].lostMs, 120);
  assert.match(trendTable([line]), /\| 2026-10-25T23:00 \| abcdef01 \| warm \| 3 \|.*\| 120 \|.*race-load:jit:212ms/);
});

test("the scenario: steps in guest seconds, cold-only and warm-only steps", async () => {
  const s = validateScenario(JSON.parse(await readFile(new URL("../harness/probes/drop-scenario.json", import.meta.url), "utf8")));
  assert.ok(stepsFor(s, 1).length > stepsFor(s, 2).length);
  assert.ok(stepsFor(s, 2).every((x) => x.only !== "cold"));
  assert.throws(() => validateScenario({ steps: [{ at: 5, tap: "KeyX" }, { at: 2, tap: "KeyX" }], end: 10 }), /previous step/);
  assert.throws(() => validateScenario({ steps: [{ at: 1, tap: "KeyX", only: "never" }], end: 10 }), /only/);
});

// Patch 0167: off unless the harness turns it on, one relaxed load per block
// compile; the worker turns it on with the drop sampler only.
test("0167 times the CPU thread's block compiles behind a flag the sampler sets", async () => {
  const patch = await readFile(new URL("../patches/dolphin-wasm/snapshot/0167-jit-compile-time-counter.patch", import.meta.url), "utf8");
  const added = patch.split("\n").filter((l) => l.startsWith("+")).join("\n");
  assert.match(added, /std::atomic<bool> s_jit_time_stats\{false\};/);
  assert.match(added, /if \(s_jit_time_stats\.load\(std::memory_order_relaxed\)\)\n\+\s*\{\n\+\s*const auto start = std::chrono::steady_clock::now\(\);\n\+\s*Jit\(em_address, true\);/);
  assert.match(added, /extern "C" EMSCRIPTEN_KEEPALIVE void DolphinWeb_JitTimeStats\(u32\* out\)/);
  const w = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(w, /case "validationDropSampler":\n\s*return harnessDropSampler\(payload\);/);
  assert.match(w, /function harnessDropSampler\(payload = \{\}\) \{\n\s*if \(!harnessEnabled\) return/);
  assert.match(w, /if \(payload\.action === "start"\) \{\n\s*moduleInstance\?\._DolphinWeb_SetJitTimeStatsEnabled\?\.\(1\);/);
  // The wgpu timers cost nothing unless the sampler runs.
  assert.match(w, /const createdAt = dropSampler\?\.running && !prewarmed \? performance\.now\(\) : 0;/);
});
