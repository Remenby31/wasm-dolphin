// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cellChecks, runChecks } from "../harness/lib/correctness.mjs";
import { correctnessGate, expectedFailures, decide, findingsGate, gateMarkdown, perfReport, runsByCell } from "../harness/lib/gate.mjs";
import { summarizeMatrix } from "../harness/lib/matrix.mjs";
import { summarizeRun } from "../harness/lib/metrics.mjs";
import { renderChecks } from "../harness/lib/render-check.mjs";
import { coreStats, mergeTimeline, presentationStats } from "../harness/lib/timeline.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const TPS = 486_000_000;

// A drained timeline: presents at `presentTimes`, one VI output every 16.7 ms
// of host time over [0, ms) except during `stops` ([from, to) host ms).
function timeline({ presentTimes, ms = 10000, stops = [] }) {
  const vi = { t: [], ticks: [], sinceBoot: [], sinceLoad: [], lost: 0, supported: true };
  let n = 0;
  for (let t = 0; t < ms; t += 1000 / 60) {
    if (stops.some(([a, b]) => t >= a && t < b)) continue;
    n += 1;
    vi.t.push(t); vi.ticks.push(n * (TPS / 60)); vi.sinceBoot.push(n); vi.sinceLoad.push(n);
  }
  return mergeTimeline([{ presents: { t: presentTimes, frame: presentTimes.map(() => 0), vi: presentTimes.map(() => 0), lost: 0 }, vi, now: ms }]);
}
const every = (step, ms = 10000, skip = () => false) => {
  const out = [];
  for (let t = 0; t < ms; t += step) if (!skip(t)) out.push(t);
  return out;
};

// Review round 3: a 300 ms real gap, observed with an offset, became a 500 ms
// freeze. Every presentation is in the timeline now: no observation offset.
test("round 3: freezes come from every presentation, not from samples", () => {
  const steady = every(16.7, 10000, (t) => t > 4000 && t < 4300);
  assert.equal(presentationStats(timeline({ presentTimes: steady })).freezes.length, 0);
  const frozen = every(16.7, 10000, (t) => t > 4000 && t < 4650);
  const f = presentationStats(timeline({ presentTimes: frozen })).freezes;
  assert.equal(f.length, 1);
  assert.ok(f[0].durationMs >= 600 && f[0].viOutputs > 30);
});

test("core speed and core freezes come from the VI timeline", () => {
  const tl = timeline({ presentTimes: every(16.7), stops: [[3000, 5500]] });
  const c = coreStats(tl, { ticksPerSecond: TPS, until: 10000 });
  assert.equal(c.freezes.length, 1);
  assert.ok(c.freezes[0].durationMs >= 2400);
  assert.ok(Math.abs(coreStats(timeline({ presentTimes: every(16.7) }), { ticksPerSecond: TPS }).speed - 100) < 2);
  // Stopped for good: the gap runs to the end of the window.
  const dead = coreStats(timeline({ presentTimes: [], stops: [[2000, 10000]] }), { ticksPerSecond: TPS, until: 10000 });
  assert.equal(dead.freezes.at(-1).ongoing, true);
});

const record = (extra = {}) => {
  const tl = timeline({ presentTimes: every(16.7) });
  return {
    game: "g", config: "c", run: 1, label: "g__c__r1", url: "http://x/?video=software",
    summary: summarizeRun({ samples: [{ t: 0, frame: 0, vis: 30 }, { t: 10000, frame: 600, vis: 30 }], timeline: tl, ticksPerSecond: TPS, windowEnd: 10000, monitor: { errors: { error: 0 } } }),
    crashed: false, errors: [], ...extra
  };
};

// Review round 3: a timeout returned a capture anyway; a fade to black in a
// wall-clock screenshot made a healthy run CASSÉ.
test("round 3: render is judged on exact captures only, and a failed capture is unjudged", () => {
  const W = 64, H = 48;
  const img = (dx) => ({ width: W, height: H, data: new Uint8Array(W * H * 4).map((_, i) => (((((i >> 2) % W) - dx) >> 3) & 1 ? 200 : 30)) });
  const frames = { ref: img(0), same: img(0), shifted: img(4), black: { width: W, height: H, data: new Uint8Array(W * H * 4) } };
  const recs = [
    { ...record(), config: "sw", label: "a", capture: { file: "ref", index: 300, ticks: 100 }, finalShot: "black" },
    { ...record(), config: "jit", label: "b", capture: { file: "same", index: 300, ticks: 107 } },
    { ...record(), config: "fast", label: "c", capture: { file: "shifted", index: 300, ticks: 100 } },
    { ...record(), config: "late", label: "d", capture: { file: "same", index: 301, ticks: 101 } },
    { ...record(), config: "timeout", label: "e", capture: { error: "VI output 600 never reached within 60000 ms" } }
  ];
  renderChecks(recs, "sw", (f) => frames[f]);
  assert.deepEqual(recs.map((r) => r.render.status), ["pass", "pass", "fail", "unjudged", "unjudged"]);
  assert.equal(recs[1].render.detail, "identical");
  // Review round 3: a 4 px error on a still scene scored as a match.
  assert.equal(recs[2].render.exact, true);
  assert.match(recs[4].render.detail, /never reached/);
});

const cells = (checksByCell) => checksByCell.map(([config, checks]) => ({ game: "g", config, checks }));
const ok = { crash: { status: "pass" }, errors: { status: "pass" }, coreFreeze: { status: "pass" }, render: { status: "pass" }, audio: { status: "pass" } };

test("correctness gate: regressions and unjudgeable candidates block, shared failures do not", () => {
  assert.equal(correctnessGate(cells([["c", ok]]), cells([["c", ok]])).ok, true);
  const failing = { ...ok, render: { status: "fail", detail: "different" } };
  assert.equal(correctnessGate(cells([["c", ok]]), cells([["c", failing]])).ok, false);
  const shared = correctnessGate(cells([["c", failing]]), cells([["c", failing]]));
  assert.equal(shared.ok, true);
  assert.equal(shared.rows.find((r) => r.check === "render").status, "known-failure");
  const unjudged = correctnessGate(cells([["c", ok]]), cells([["c", { ...ok, render: { status: "unjudged" } }]]));
  assert.equal(unjudged.ok, false);
  assert.equal(unjudged.inconclusive, true);
  assert.equal(correctnessGate(cells([["c", ok]]), []).ok, false); // a cell vanished
  assert.equal(correctnessGate([], []).ok, false); // nothing compared is not a pass
  // Load is not a correctness excuse: an overloaded run's errors still fail.
  const loaded = record({ overloaded: true, summary: { ...record().summary, errorCount: 5 } });
  assert.equal(cellChecks([record(), loaded]).errors.status, "fail");
  assert.equal(runChecks(record()).coreFreeze.status, "pass");
});

test("expected failures: the pinned failure is XFAIL, any other failure and a pass (XPASS) block", () => {
  const entry = { cell: "g/c", check: "render", mode: "expected-fail", reason: "readback is a stub", until: "PR #99", detail: "^missing-detail$" };
  const expected = expectedFailures([entry]);
  const failing = { ...ok, render: { status: "fail", detail: "missing-detail" } };
  const xfail = correctnessGate(cells([["c", failing]]), cells([["c", failing]]), { expected });
  assert.equal(xfail.ok, true);
  const row = xfail.rows.find((r) => r.check === "render");
  assert.equal(row.status, "xfail");
  assert.match(row.detail, /until PR #99: readback is a stub/);
  assert.doesNotMatch(row.detail, /WARNING/);
  // Another failure of the same check is not the expected one: a blank or
  // garbled picture stays a regression.
  for (const detail of ["blank", "geometry-missing"]) {
    const g = correctnessGate(cells([["c", ok]]), cells([["c", { ...ok, render: { status: "fail", detail } }]]), { expected });
    assert.equal(g.ok, false, detail);
    assert.equal(g.rows.find((r) => r.check === "render").status, "regressed");
  }
  assert.equal(expectedFailures([{ ...entry, detail: "blank|missing-detail" }]).size, 1);
  const blankEvenIfPinned = correctnessGate(cells([["c", ok]]), cells([["c", { ...ok, render: { status: "fail", detail: "blank" } }]]),
    { expected: expectedFailures([{ ...entry, detail: "blank|missing-detail" }]) });
  assert.equal(blankEvenIfPinned.ok, false, "blank is never an expected failure");
  // XPASS blocks and says what to do.
  const xpass = correctnessGate(cells([["c", failing]]), cells([["c", ok]]), { expected });
  assert.equal(xpass.ok, false);
  assert.equal(xpass.rows.find((r) => r.check === "render").status, "xpass");
  assert.match(gateMarkdown({ correctness: xpass }), /XPASS \(blocks\)[\s\S]*remove its entry/);
  // Only the listed check of the listed cell is relaxed.
  const crash = { ...failing, crash: { status: "fail", detail: "x" } };
  assert.equal(correctnessGate(cells([["c", ok]]), cells([["c", crash]]), { expected }).ok, false);
});

test("expected failures: a baseline that passes the check is flagged, a stale entry blocks", () => {
  const entry = { cell: "g/c", check: "render", mode: "expected-fail", reason: "r", until: "u", detail: "^missing-detail$" };
  const failing = { ...ok, render: { status: "fail", detail: "missing-detail" } };
  const fresh = correctnessGate(cells([["c", ok]]), cells([["c", failing]]), { expected: expectedFailures([entry]) });
  assert.equal(fresh.ok, true);
  assert.match(fresh.rows.find((r) => r.check === "render").detail, /WARNING: the baseline passes this check/);
  assert.match(gateMarkdown({ correctness: fresh }), /XFAIL \(not blocking\) ⚠/);
  // The run has game g but no g/gone: the entry is stale.
  const stale = correctnessGate(cells([["c", ok]]), cells([["c", ok]]), { expected: expectedFailures([{ ...entry, cell: "g/gone" }]) });
  assert.equal(stale.ok, false);
  assert.equal(stale.rows.at(-1).status, "stale-expected");
  // Another matrix without game g does not judge it.
  assert.equal(correctnessGate(cells([["c", ok]]), cells([["c", ok]]), { expected: expectedFailures([{ ...entry, cell: "other/c" }]) }).ok, true);
});

test("expected failures: entries need a cell, a check, a reason, until and the expected detail, once", () => {
  const entry = { cell: "g/c", check: "render", mode: "expected-fail", reason: "r", until: "u", detail: "^missing-detail$" };
  assert.throws(() => expectedFailures([{ ...entry, cell: undefined }]), /needs a cell/);
  assert.throws(() => expectedFailures([{ ...entry, until: "" }]), /needs a until/);
  assert.throws(() => expectedFailures([{ ...entry, detail: undefined }]), /needs a detail/);
  assert.throws(() => expectedFailures([{ ...entry, check: "renderVsBaseline" }]), /needs a check among/);
  assert.throws(() => expectedFailures([entry, { ...entry, reason: "again" }]), /listed twice/);
});

test("the committed known-failures.json parses for both gates", async () => {
  const { readFileSync } = await import("node:fs");
  const known = JSON.parse(readFileSync(new URL("../harness/known-failures.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => expectedFailures(known));
  assert.ok(expectedFailures(known).has("efbpeek/wgpu-interp\u0000render"));
});

test("fuzz and pads findings: new kinds regress, a missing result is inconclusive", () => {
  assert.equal(findingsGate("fuzz", [{ iso: "a", kind: "jit-crash" }], [{ iso: "a", kind: "jit-crash" }]).ok, true);
  assert.equal(findingsGate("fuzz", [], [{ iso: "a", kind: "divergence" }]).ok, false);
  assert.equal(findingsGate("pads", [], null).inconclusive, true);
});

// Review round 3: 100 % → 20 % passed (LENT/LENT) without a savestate.
// Performance is compared run against run, not through verdict classes.
test("round 3: a clear paired performance regression blocks, noise does not", () => {
  const runAt = (config, run, speed) => ({ game: "g", config, run, summary: { speed, vis: 30, frameP95: 17 } });
  const base = [1, 2, 3, 4, 5].map((r) => runAt("c", r, 100));
  const slow = [1, 2, 3, 4, 5].map((r) => runAt("c", r, 20));
  const noisy = [1, 2, 3, 4, 5].map((r, i) => runAt("c", r, [92, 104, 95, 99, 101][i]));
  const perf = perfReport(runsByCell(base), runsByCell(slow), { initialRuns: 3 });
  assert.equal(perf.find((p) => p.metric === "speed").regressed, true);
  const correctness = correctnessGate(cells([["c", ok]]), cells([["c", ok]]));
  assert.deepEqual(decide({ correctness, perf }), { ok: false, reason: "performance" });
  assert.equal(perfReport(runsByCell(base), runsByCell(noisy), { initialRuns: 3 }).some((p) => p.regressed), false);
});

// Review round 4: 3 runs at 80 % vs 100 % blocked as "confirmed" with no
// confirmation run at all.
test("round 4: a perf drop without confirmation runs is reported, never blocking", () => {
  const runAt = (run, speed) => ({ game: "g", config: "c", run, summary: { speed, vis: 30, frameP95: 17 } });
  const perf = perfReport(runsByCell([1, 2, 3].map((r) => runAt(r, 100))), runsByCell([1, 2, 3].map((r) => runAt(r, 80))), { initialRuns: 3 });
  const speed = perf.find((p) => p.metric === "speed");
  assert.equal(speed.worse, true);
  assert.equal(speed.regressed, false);
  assert.equal(decide({ correctness: correctnessGate(cells([["c", ok]]), cells([["c", ok]])), perf }).ok, true);
});

// Review round 3: `ab` said FAIL and `gate` on its own output said PASS.
// Both now decide from the same persisted summaries.
test("round 3: `harness/run gate` on persisted results gives the persisted decision", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "harness-test-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // 3 planned runs + 2 confirmation runs, as ab persists them.
  const write = (side, speed, render) => {
    const records = [1, 2, 3, 4, 5].map((run) => ({ ...record(), run, label: `g__c__r${run}`, summary: { ...record().summary, speed }, checks: { ...ok, render: { status: render } } }));
    mkdirSync(path.join(root, side));
    writeFileSync(path.join(root, side, "summary.json"), JSON.stringify({ spec: { runs: 3 }, cells: summarizeMatrix(records), results: records }));
  };
  write("base", 100, "pass");
  write("same", 99, "pass");
  write("slow", 40, "pass");
  write("broken", 100, "fail");
  const gate = (cand) => spawnSync(process.execPath, [path.join(REPO, "harness/cli.mjs"), "gate", "--baseline", path.join(root, "base"), "--candidate", path.join(root, cand)], { encoding: "utf8" });
  assert.equal(gate("same").status, 0);
  assert.match(gate("slow").stdout, /performance regression/);
  assert.equal(gate("slow").status, 1);
  assert.match(gate("broken").stdout, /correctness regression/);
});
