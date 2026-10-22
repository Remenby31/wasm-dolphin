// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { armEffects, bootOrder, GUEST_HZ, instructionsPerGuestCycle, laneOf, parsePerfCsv } from "../harness/probes/race-multi.mjs";

test("race-multi: a cyclic Latin square, every arm on every lane equally", () => {
  const seen = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let run = 1; run <= 6; run += 1) {
    const lanes = [0, 1, 2].map((arm) => laneOf(arm, run, 3));
    assert.deepEqual([...lanes].sort(), [0, 1, 2]); // one arm per lane in each run
    lanes.forEach((l, arm) => { seen[arm][l] += 1; });
  }
  assert.deepEqual(seen, [[2, 2, 2], [2, 2, 2], [2, 2, 2]]);
});

test("race-multi: arm effects survive lane differences and run-wide noise", () => {
  // Arm 1 is 3 % faster, arm 2 equal; lane 1 is 2 % slower, lane 2 1 % faster;
  // each run drifts as a whole (load, heat): all of it multiplicative.
  const armF = [1, 1.03, 1], laneF = [1, 0.98, 1.01], runF = [1, 0.97, 1.02, 0.99, 1.04, 0.96];
  const laneIdx = runF.map((_, r) => [0, 1, 2].map((a) => laneOf(a, r + 1, 3)));
  const speeds = runF.map((rf, r) => armF.map((af, a) => 60 * rf * af * laneF[laneIdx[r][a]]));
  const e = armEffects(speeds, laneIdx);
  assert.equal(e.arms[0].laneCorrected, 3);
  assert.equal(e.arms[1].laneCorrected, 0);
  assert.deepEqual(e.lanes, [0, -2, 1]);
  assert.equal(e.residualSd, 0);
  // The raw per-run ratios carry the lanes' differences; their median does not cancel them in general.
  assert.ok(e.arms[0].sd > 1);
});

test("race-multi: perf counts summed over both PMUs, per guest cycle", () => {
  const csv = "# started on Thu Oct 22 10:07:59 2026\n\n<not counted>,,armv8_pmuv3_0/instructions/u,0,0.00,,\n<not counted>,,armv8_pmuv3_0/cycles/u,0,0.00,,\n22921628025,,armv8_pmuv3_1/instructions/u,1468754848,100.00,4.01,insn per cycle\n5714995397,,armv8_pmuv3_1/cycles/u,1468752096,100.00,,\n";
  assert.deepEqual(parsePerfCsv(csv), { instructions: 22921628025, cycles: 5714995397 });
  // 20 s at 50 % speed = 10 emulated seconds = 4.86e9 guest cycles.
  const cold = { speed: 50, windowMs: 20000, counters: { instructions: 2 * 10 * GUEST_HZ } };
  assert.equal(instructionsPerGuestCycle(cold), 2);
  assert.equal(instructionsPerGuestCycle({ speed: 50, windowMs: 20000, counters: { error: "x" } }), null);
});

test("race-multi: boot order rotated too, independently of the lanes", () => {
  const firsts = [0, 0, 0], laneOfFirst = new Set();
  for (let run = 1; run <= 6; run += 1) {
    const order = bootOrder(run, 3);
    assert.deepEqual([...order].sort(), [0, 1, 2]);
    firsts[order[0]] += 1;
    laneOfFirst.add(laneOf(order[0], run, 3));
  }
  assert.deepEqual(firsts, [2, 2, 2]); // each arm boots first twice
  assert.equal(laneOfFirst.size, 3); // the first booted visits every lane
  // Orthogonal for 3 arms: each (lane, boot rank) pair once per 3 runs.
  const pairs = new Set();
  for (let run = 1; run <= 3; run += 1) bootOrder(run, 3).forEach((a, rank) => pairs.add(`${laneOf(a, run, 3)}/${rank}`));
  assert.equal(pairs.size, 9);
});
