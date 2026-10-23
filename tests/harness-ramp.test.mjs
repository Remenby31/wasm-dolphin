// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { kpiTable } from "../harness/lib/kpi.mjs";
import { rampFailure, rampOf, summarizeRamp } from "../harness/lib/ramp.mjs";

const T0 = 1_000_000;
// One sample per second from t0 + 1 s: the speeds given.
const series = (speeds) => speeds.map((speed, i) => ({ atMs: T0 + 1000 * (i + 1), speed }));

test("ramp: 90 % and 95 % held 5 s, a slower second restarts the count", () => {
  const r = rampOf(series([20, 50, 92, 92, 80, 91, 93, 96, 96, 96, 96, 96, 97, 97, 97, 97, 97, 97]), T0,
    [{ t: T0 + 2500, installed: 0, queued: 40 }, { t: T0 + 5500, installed: 12, queued: 30 }, { t: T0 + 18000, installed: 55, queued: 0 }]);
  assert.equal(r.timeTo90Ms, 6000); // 92, 92, 80 breaks; from the 6th second on
  assert.equal(r.timeToFullMs, 8000);
  assert.equal(r.plateauSpeed, 97);
  assert.equal(r.regionsAt90, 12);
  assert.equal(r.regionsAtEnd, 55);
  assert.deepEqual(r.speedSeries[0], [1000, 20]);
  assert.deepEqual(r.regionSeries.at(-1), [18000, 55, 0]);
});

test("ramp: a CPU-bound scene never reaches 90 %, its relative ramp still reads", () => {
  const r = rampOf(series([10, 30, 50, 58, 60, 61, 60, 59, 60, 61, 60, 60, 61, 60]), T0);
  assert.equal(r.timeTo90Ms, null);
  assert.equal(r.plateauSpeed, 60);
  assert.equal(r.timeToTail90Ms, 4000); // >= 54 % from the 4th second
  assert.match(rampFailure({ ramp: r }, 60), /never 90 % for 5 s in 60 s \(plateau 60 %\)/);
  assert.equal(rampOf(series([95, 95]), T0).plateauSpeed, null); // too short for a plateau
});

test("ramp summary: medians over the good runs, overloaded runs apart, failures listed", () => {
  const ok = (ms) => ({ ramp: { ...rampOf(series(Array(12).fill(99)), T0), timeTo90Ms: ms } });
  const s = summarizeRamp([{ run: 1, ...ok(9000) }, { run: 2, ...ok(11000) }, { run: 3, overloaded: true, ...ok(30000) }, { run: 4, error: "boot timeout" }], 60);
  assert.equal(s.goodRuns, 2);
  assert.equal(s.timeTo90Ms.median, 10000);
  assert.deepEqual(s.overloadedRuns, [3]);
  assert.deepEqual(s.failed, [{ run: 4, why: "boot timeout" }]);
  assert.equal(s.targetMs, 15000);
});

test("ramp KPI rows: one per scene, night measures only, a run under 90 % fails the row", () => {
  const summary = (scene, extra = {}) => ({ kind: "first-launch-ramp", file: scene, json: { probe: "first-launch-ramp", scene, at: "2026-10-23T02:00:00Z", maxLoad: 6, chrome: { path: "chrome stable", args: "" },
    served: { commit: "T1", dirty: false }, windowSec: 60, timeTo90Ms: { median: 12000 }, timeToFullMs: { median: 14000 }, plateauSpeed: { median: 99 }, timeToTail90Ms: { median: 12000 }, regionsAt90: { median: 40 }, regionsAtEnd: { median: 80 }, failed: [], ...extra } });
  const rows = (results) => Object.fromEntries(kpiTable(results, {}, { trunk: new Set(["T1"]) }).map((r) => [r.id, r]));
  const both = rows([summary("race"), summary("heavy", { timeTo90Ms: { median: null }, failed: [{ run: 1, why: "never 90 % for 5 s in 60 s (plateau 60 %)" }] })]);
  assert.equal(both.firstLaunchRampRace.value, 12000);
  assert.equal(both.firstLaunchRampRace.status, "OK");
  assert.match(both.firstLaunchRampRace.detail, /plateau 99 %/);
  assert.equal(both.firstLaunchRampHeavy.status, "KO");
  assert.equal(both.firstLaunchRampHeavy.counted, false);
  assert.match(both.firstLaunchRampHeavy.why, /plateau 60 %/);
  const day = rows([summary("race", { maxLoad: 12 })]);
  assert.equal(day.firstLaunchRampRace.status, "n/a");
  assert.match(day.firstLaunchRampRace.why, /hors règle/);
});
