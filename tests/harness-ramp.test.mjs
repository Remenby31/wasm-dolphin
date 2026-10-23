// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { kpiTable } from "../harness/lib/kpi.mjs";
import { gameSpeedSeries, rampFailure, rampOf, summarizeRamp } from "../harness/lib/ramp.mjs";

const T0 = 1_000_000;
// One sample per second from t0 + 1 s: the speeds given.
const series = (speeds, from = T0) => speeds.map((speed, i) => ({ atMs: from + 1000 * (i + 1), speed }));
// Cumulative XFB copies, one sample per second from `from`, at these frames/s.
const frames = (fps, from) => fps.reduce((acc, f, i) => [...acc, { t: from + 1000 * (i + 1), xfb: acc.at(-1).xfb + f }], [{ t: from, xfb: 0 }]);

test("ramp (VI only, an engine without the XFB counter): 90 % and 95 % held 5 s, a slower second restarts the count", () => {
  const r = rampOf(series([20, 50, 92, 92, 80, 91, 93, 96, 96, 96, 96, 96, 97, 97, 97, 97, 97, 97]), T0,
    [{ t: T0 + 2500, installed: 0, queued: 40 }, { t: T0 + 5500, installed: 12, queued: 30 }, { t: T0 + 18000, installed: 55, queued: 0 }]);
  assert.equal(r.metric, "vi");
  assert.equal(r.timeTo90Ms, 6000); // 92, 92, 80 breaks; from the 6th second on
  assert.equal(r.timeToFullMs, 8000);
  assert.equal(r.plateauSpeed, 97);
  assert.equal(r.regionsAt90, 12);
  assert.equal(r.regionsAtEnd, 55);
  assert.deepEqual(r.speedSeries[0], [1000, 20]);
  assert.deepEqual(r.regionSeries.at(-1), [18000, 55, 0]);
});

test("game frames per second over the native rate; a decoupled run at VI 100 % still fails on its game frames", () => {
  assert.deepEqual(gameSpeedSeries(frames([30, 60], T0), 60).map((x) => [x.atMs - T0, x.speed, x.fps]), [[0, 50, 30], [1000, 100, 60]]);
  assert.deepEqual(gameSpeedSeries(frames([30], T0), 0), []);
  // The heavy scene: VI at 100 % from the start, game frames ~36/s over the
  // intro (60 %), scene starting 13 s after the hand-over.
  const sceneAt = T0 + 13000;
  const vi = series(Array(40).fill(100));
  const games = gameSpeedSeries(frames([...Array(17).fill(36), ...Array(10).fill(60)], sceneAt), 60);
  const r = rampOf(vi, T0, [], { games, sceneAt, plateau: [0, 17] });
  assert.equal(r.metric, "game");
  assert.equal(r.vi.timeTo90Ms, 1000);
  assert.equal(r.vi.plateauSpeed, 100);
  assert.equal(r.plateauSpeed, 60); // the intro window, not the tail at 100 %
  assert.equal(r.timeTo90Ms, 17000); // counted from the scene's start
  assert.equal(r.timeToTail90Ms, 0);
  assert.equal(r.sceneAtMs, 13000);
  assert.deepEqual(r.gameSeries[0], [13000, 60, 36]);
  // Never 90 % within the window: a failure of the KPI.
  const stuck = rampOf(vi, T0, [], { games: gameSpeedSeries(frames(Array(20).fill(36), sceneAt), 60), sceneAt, plateau: [0, 17] });
  assert.match(rampFailure({ ramp: stuck }, 20), /useful game frames never 90 % for 5 s in 20 s \(plateau 60 %\)/);
});

test("ramp: a CPU-bound VI series never reaches 90 %, its relative ramp still reads", () => {
  const r = rampOf(series([10, 30, 50, 58, 60, 61, 60, 59, 60, 61, 60, 60, 61, 60]), T0);
  assert.equal(r.timeTo90Ms, null);
  assert.equal(r.plateauSpeed, 60);
  assert.equal(r.timeToTail90Ms, 4000); // >= 54 % from the 4th second
  assert.match(rampFailure({ ramp: r }, 60), /VI speed never 90 % for 5 s in 60 s \(plateau 60 %\)/);
  assert.equal(rampOf(series([95, 95]), T0).plateauSpeed, null); // too short for a plateau
});

test("ramp summary: medians over the good runs, overloaded runs apart, failures listed", () => {
  const sceneAt = T0 + 5000;
  const ok = (ms) => ({ ramp: { ...rampOf(series(Array(12).fill(99)), T0, [], { games: gameSpeedSeries(frames(Array(12).fill(59), sceneAt), 60), sceneAt }), timeTo90Ms: ms } });
  const s = summarizeRamp([{ run: 1, ...ok(9000) }, { run: 2, ...ok(11000) }, { run: 3, overloaded: true, ...ok(30000) }, { run: 4, error: "boot timeout" }], 60);
  assert.equal(s.metric, "game");
  assert.equal(s.goodRuns, 2);
  assert.equal(s.timeTo90Ms.median, 10000);
  assert.equal(s.vi.plateauSpeed.median, 99);
  assert.deepEqual(s.overloadedRuns, [3]);
  assert.deepEqual(s.failed, [{ run: 4, why: "boot timeout" }]);
  assert.equal(s.targetMs, 15000);
});

test("ramp KPI rows: one per scene, game-frame results only, max-load 6 at most, a run under 90 % fails the row", () => {
  const summary = (scene, extra = {}) => ({ kind: "first-launch-ramp", file: scene, json: { probe: "first-launch-ramp", scene, metric: "game", query: "core=upstream&video=software&aot=1&metrics=1", at: "2026-10-23T02:00:00Z", maxLoad: 6, chrome: { path: "chrome stable", args: "" },
    served: { commit: "T1", dirty: false }, windowSec: 60, timeTo90Ms: { median: 12000 }, timeToFullMs: { median: 14000 }, plateauSpeed: { median: 99 }, timeToTail90Ms: { median: 12000 }, regionsAt90: { median: 40 }, regionsAtEnd: { median: 80 },
    vi: { plateauSpeed: { median: 100 } }, failed: [], ...extra } });
  const rows = (results) => Object.fromEntries(kpiTable(results, {}, { trunk: new Set(["T1"]) }).map((r) => [r.id, r]));
  const both = rows([summary("race"), summary("heavy", { timeTo90Ms: { median: null }, failed: [{ run: 1, why: "useful game frames never 90 % for 5 s in 60 s (plateau 60 %)" }] })]);
  assert.equal(both.firstLaunchRampRace.value, 12000);
  assert.equal(both.firstLaunchRampRace.status, "OK");
  assert.match(both.firstLaunchRampRace.detail, /images de jeu utiles depuis le début de la scène : 95 % à 14000 ms, plateau 99 %.*vitesse VI plateau 100 %/);
  assert.equal(both.firstLaunchRampHeavy.status, "KO");
  assert.equal(both.firstLaunchRampHeavy.counted, false);
  assert.match(both.firstLaunchRampHeavy.why, /plateau 60 %/);
  const day = rows([summary("race", { maxLoad: 12 })]);
  assert.equal(day.firstLaunchRampRace.status, "n/a");
  assert.match(day.firstLaunchRampRace.why, /hors règle/);
  // A wgpu + aot=1 result feeds the wgpu rows only (the target product after 0116).
  const wgpu = rows([summary("race", { query: "core=upstream&video=wgpu&aot=1&metrics=1", timeTo90Ms: { median: 3000 } })]);
  assert.equal(wgpu.firstLaunchRampRaceWgpu.value, 3000);
  assert.equal(wgpu.firstLaunchRampRaceWgpu.counted, false);
  assert.equal(wgpu.firstLaunchRampRace.status, "n/a");
  assert.equal(both.firstLaunchRampRaceWgpu.status, "n/a");
  // The first version's results (VI speed only) never feed the rows.
  const old = rows([summary("race", { metric: undefined })]);
  assert.equal(old.firstLaunchRampRace.status, "n/a");
});

test("first-launch-ramp --visits: a visit's region facts, its churn, and the medians per visit", async () => {
  const { churnOf, summarizeVisits, visitRegions } = await import("../harness/probes/first-launch-ramp.mjs");
  const events = [
    { t: 1, type: "install", loaded: 120, failed: 0 }, { t: 2, type: "install", loaded: 20, failed: 1, after: "first-image" },
    { t: 50, type: "done", total: 145, refused: 2, compiled: 5, deferred: 0, budgetRefused: 0, ms: 4000 }
  ];
  const regions = [{ t: 1100, installed: 120, ticks: 486e6 }, { t: 2100, installed: 140, ticks: 2 * 486e6 }, { t: 3100, installed: 145, ticks: 3 * 486e6 }, { t: 4100, installed: 145, ticks: 4 * 486e6 }];
  const f = visitRegions(events, regions, { t0: 1000, ticksAtBoot: 0, ticksPerSecond: 486e6 });
  assert.deepEqual(f, {
    done: { total: 145, refused: 2, compiled: 5, deferred: 0, budgetRefused: 0, ms: 4000 },
    compiled: 5, budgetRefused: 0, fromCache: 140, installFailed: 1, installedAtEnd: 145, lastInstallMs: 2100, lastInstallGuestSec: 3
  });
  assert.equal(churnOf(f), 0.0345);
  assert.equal(churnOf({ compiled: null, installedAtEnd: 145 }), null, "no done event: no churn");
  // An engine before #167: no budgetRefused, kept as null.
  assert.equal(visitRegions([{ t: 1, type: "done", compiled: 0 }], [], { t0: 0, ticksAtBoot: 0, ticksPerSecond: 1 }).budgetRefused, null);
  const run = (c1, c2) => ({ visits: [{ visit: 1, regionFacts: { compiled: c1, installedAtEnd: 100 }, churn: c1 / 100 }, { visit: 2, regionFacts: { compiled: c2, installedAtEnd: 100 }, churn: c2 / 100 }] });
  const sum = summarizeVisits([run(100, 4), run(100, 2), { visits: [{ visit: 1, error: "boot" }] }], 2);
  assert.equal(sum[0].runs, 2, "a failed visit is left out");
  assert.equal(sum[0].compiled, 100);
  assert.equal(sum[1].churn, 0.03);
});

test("first-launch-ramp --visits: the local profile's size on disk per visit, and visits without one", async () => {
  const { profileBytes, summarizeVisits } = await import("../harness/probes/first-launch-ramp.mjs");
  assert.equal(profileBytes([{ name: "disc-sha256-v1_ab.bin", bytes: 12000 }, { name: "x.tmp", bytes: 100 }]), 12100);
  assert.equal(profileBytes([]), null, "no file: no profile");
  assert.equal(profileBytes({ error: "NotFoundError" }), null, "no aot-profile directory");
  const sum = summarizeVisits([{ visits: [{ visit: 1, profileBytes: 12000 }] }, { visits: [{ visit: 1, profileBytes: null }] }], 1);
  assert.equal(sum[0].withoutProfile, 1);
  assert.equal(sum[0].profileBytes, 12000);
});
