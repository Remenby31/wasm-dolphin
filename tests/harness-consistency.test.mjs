// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// renderVsBaseline when a side does not agree with itself across runs
// (false block found on PR #7: main's JIT gave three different captures).

import assert from "node:assert/strict";
import test from "node:test";

import { crossCommitGate } from "../harness/lib/gate.mjs";
import { renderVsBaseline } from "../harness/lib/render-check.mjs";

const img = (v) => ({ width: 4, height: 4, data: new Uint8Array(64).fill(v) });
const frames = { a: img(10), b: img(20), c: img(30) };
const runs = (files, cell = ["g", "c"]) => files.map((file, i) => ({ game: cell[0], config: cell[1], run: i + 1, capture: { file, index: 300 } }));
const gate = (base, cand, opts = {}) => crossCommitGate(renderVsBaseline(runs(base), runs(cand), { loadFrame: (f) => frames[f], ...opts }));

test("both consistent: same picture passes, a different one blocks", () => {
  assert.equal(gate(["a", "a", "a"], ["a", "a", "a"]).ok, true);
  assert.equal(gate(["a", "a", "a"], ["b", "b", "b"]).ok, false);
});

test("baseline nondeterministic, candidate stable: known, not blocking (the PR #7 case)", () => {
  const g = gate(["a", "b", "c"], ["b", "b", "b"]);
  assert.equal(g.ok, true);
  assert.equal(g.rows[0].status, "known-failure");
  assert.equal(g.rows[0].detail, "baseline-nondeterministic");
});

test("candidate introduces nondeterminism: blocks", () => {
  const g = gate(["a", "a", "a"], ["a", "b", "a"]);
  assert.equal(g.ok, false);
  assert.equal(g.rows[0].detail, "candidate-nondeterministic");
});

test("both nondeterministic: blocks unless main lists the cell as a known failure", () => {
  assert.equal(gate(["a", "b"], ["b", "c"]).ok, false);
  const known = [{ cell: "g/c", check: "renderVsBaseline", reason: "JIT nondeterminism" }];
  assert.equal(gate(["a", "b"], ["b", "c"], { known }).ok, true);
});
