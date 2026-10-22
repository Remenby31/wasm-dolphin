// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { armEffects, laneOf } from "../harness/probes/race-multi.mjs";

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
