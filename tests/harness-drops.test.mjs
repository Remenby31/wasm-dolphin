// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { causeOf, PHASE_FLOOR, PHASE_PRIMARY, dropEvents, dropSummary, interpolate, loadSegments, noiseOf, rowsOf, stallOverlap, trendLine, trendTable, verdictOf, visitVerdict, windowsOf } from "../harness/lib/drops.mjs";
import { exitCodeOf, falsePositiveRate, markersOnVi, noVerdictReasons, regressionKeys, stepsFor, validateScenario } from "../harness/probes/drop-meter.mjs";
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
  const ok = Array.from({ length: 3 }, () => ({ summary: { hitches100: 1, worstSecond: 80 }, phases: [{ label: "race", dropLostMs: 0, presentMax: 30 }] }));
  assert.equal(visitVerdict(ok, ok).inconclusive, false);
  assert.equal(visitVerdict(ok.slice(0, 2), ok).inconclusive, true);
  // a phase a side never reached has no verdict
  assert.equal(visitVerdict(ok, ok.map((a) => ({ ...a, phases: [...a.phases, { label: "extra", dropLostMs: 0, presentMax: 30 }] }))).inconclusive, true);
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

// Review of #261 (P1-4): a 50 ms stall on a load the throttle then makes up
// shows in the drop-only loss and the phase's longest gap, not in lostMs.
test("a 50 ms stall made up afterwards: lostMs nets to ~0, dropLostMs and presentMax show it", () => {
  const vi = viOf(3000, (t) => (t >= 1000 && t < 1100 ? 50 : t >= 1100 && t < 1200 ? 150 : 100));
  const presents = presentsOf(vi).filter((p) => p.t < 1000 || p.t > 1060);
  const w = windowsOf({ vi, presents, tps: TPS });
  const s = dropSummary({ windows: w, presents, vi });
  assert.ok(Math.abs(s.lostMs) < 10, `lostMs ${s.lostMs}`);
  assert.ok(s.dropLostMs >= 40, `dropLostMs ${s.dropLostMs}`); // VI interpolation smears the edges
  assert.ok(s.presentMax > 55);
  const phase = (x) => ({ summary: { hitches100: 0, worstSecond: 99 }, phases: [{ label: "race-load", ...x }] });
  const base = [0, 2, 1].map((d) => phase({ dropLostMs: d, presentMax: 20 }));
  const cand = [50, 52, 49].map((d) => phase({ dropLostMs: d, presentMax: 70 }));
  const v = visitVerdict(base, cand, { run: null, phases: { "race-load": { dropLostMs: { n: 6, stdev: 2 }, presentMax: { n: 6, stdev: 2 } } } });
  assert.equal(v.regression, true);
  assert.deepEqual(v.regressions.map((r) => r.metric).sort(), ["dropLostMs", "presentMax"]);
});

test("phase floors: a second under 95 % alone is never a regression (pctBelow95 is reported only)", () => {
  assert.ok(PHASE_FLOOR.pctBelow95 >= 0.5 && PHASE_FLOOR.dropLostMs === 20 && PHASE_FLOOR.presentMax === 20);
  assert.ok(!("pctBelow95" in PHASE_PRIMARY));
});

test("the false-positive rate on identical runs stays low; a real shift is found", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const run = (id, d) => [1].map((visit) => ({ id, visit, analysis: { summary: { hitches100: 1, worstSecond: 80 + (random() - 0.5) * 4 }, phases: [{ label: "race-load", dropLostMs: d + random() * 4, presentMax: 25 + random() * 3 }] } }))[0];
  const same = Array.from({ length: 9 }, (_, i) => run(`a${i}`, 0));
  const fp = falsePositiveRate(same, { visits: 1, draws: 300, random });
  assert.ok(fp.singleBatch < 0.1, `single ${fp.singleBatch}`);
  assert.ok(fp.confirmed <= fp.singleBatch);
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
