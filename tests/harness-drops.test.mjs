// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { causeOf, PHASE_FLOOR, dropEvents, dropSummary, interpolate, loadSegments, noiseOf, rowsOf, stallOverlap, trendLine, trendTable, verdictOf, windowsOf } from "../harness/lib/drops.mjs";
import { stepsFor, validateScenario } from "../harness/probes/drop-meter.mjs";
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

test("a drop with no cause counted: emulation when the CPU never slept, else unexplained", () => {
  const w = (sleptMs) => ({ t0: 0, speed: 50, lostMs: 50, sleptMs, causes: { jit: 0, disc: 1 } });
  assert.equal(causeOf([w(0), w(0)]).cause, "emulation");
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

test("verdict: a move beyond the noise is a regression, inside it is not", () => {
  const base = [{ lostMs: 300 }, { lostMs: 320 }, { lostMs: 310 }];
  assert.equal(verdictOf(base, [{ lostMs: 305 }, { lostMs: 315 }, { lostMs: 325 }]).regression, false);
  const v = verdictOf(base, [{ lostMs: 600 }, { lostMs: 620 }, { lostMs: 610 }]);
  assert.equal(v.regression, true);
  assert.equal(v.rows[0].metric, "lostMs");
  // An A/A that says lostMs moves by 400 ms between series: not a regression.
  assert.equal(verdictOf(base, [{ lostMs: 600 }, { lostMs: 620 }, { lostMs: 610 }], { noise: { lostMs: { n: 3, minDiff: 400 } } }).regression, false);
  // worstSecond: lower is worse.
  assert.equal(verdictOf([{ worstSecond: 90 }, { worstSecond: 91 }, { worstSecond: 89 }], [{ worstSecond: 40 }, { worstSecond: 41 }, { worstSecond: 42 }]).regression, true);
  // One run a side and no A/A: no verdict (an A/A gave "regression" that way).
  const one = verdictOf([{ lostMs: 854 }], [{ lostMs: 957 }]);
  assert.equal(one.regression, false);
  assert.equal(one.inconclusive, true);
  assert.equal(verdictOf([{ lostMs: 854 }], [{ lostMs: 957 }], { noise: { lostMs: { n: 6, minDiff: 300 } } }).inconclusive, false);
});

test("per phase: a 50 ms loss on a stable load is a regression the whole run's noise would hide", () => {
  const base = [{ lostMs: 175 }, { lostMs: 168 }, { lostMs: 182 }];
  const cand = [{ lostMs: 228 }, { lostMs: 221 }, { lostMs: 232 }];
  assert.equal(verdictOf(base, cand, { noise: { lostMs: { n: 6, minDiff: 211 } } }).regression, false); // the run's noise
  assert.equal(verdictOf(base, cand, { noise: { lostMs: { n: 6, minDiff: 9 } }, floor: PHASE_FLOOR }).regression, true); // the phase's
});

test("A/A noise, trend line and table", () => {
  const n = noiseOf([{ lostMs: 100, worstSecond: 50 }, { lostMs: 140, worstSecond: 52 }]);
  assert.equal(n.lostMs.median, 120);
  assert.ok(n.lostMs.minDiff > 0);
  const line = trendLine({ at: "2026-10-25T23:00:00Z", commit: "abcdef0123", visitSummary: [{ visit: 2, runs: 3, noise: n, worst: [{ label: "race-load", cause: "jit", lostMs: 212.4 }] }] });
  assert.equal(line.visits[0].lostMs, 120);
  assert.match(trendTable([line]), /\| 2026-10-25T23:00 \| abcdef01 \| warm \| 3 \| 120 \|.*race-load:jit:212ms/);
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
