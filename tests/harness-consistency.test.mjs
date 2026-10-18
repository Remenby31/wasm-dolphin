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

test("baseline nondeterministic, candidate stable and one of main's pictures: known, not blocking (the PR #7 case)", () => {
  const g = gate(["a", "b", "c"], ["b", "b", "b"]);
  assert.equal(g.ok, true);
  assert.equal(g.rows[0].status, "known-failure");
  assert.equal(g.rows[0].detail, "baseline-nondeterministic");
});

// Review of #10: main varies and the candidate is stably wrong. It used to
// pass as "known".
test("baseline nondeterministic, candidate stably wrong: blocks", () => {
  const W = 32, H = 32;
  const pic = (shift, flip = -1) => {
    const data = new Uint8Array(W * H * 4).map((_, i) => ((((i >> 2) % W + shift) >> 2) & 1 ? 200 : 40));
    if (flip >= 0) data[flip] ^= 0x5a;
    return { width: W, height: H, data };
  };
  const f = { m1: pic(0, 0), m2: pic(0, 400), m3: pic(0, 800), right: pic(0), wrong: { width: W, height: H, data: new Uint8Array(W * H * 4).fill(90) } };
  const known = [{ cell: "g/c", check: "renderVsBaseline" }];
  const run = (base, cand, opts) => crossCommitGate(renderVsBaseline(runs(base), runs(cand), { loadFrame: (x) => f[x], ...opts }));
  // Not listed: a picture main never produced is inconclusive (blocks).
  assert.equal(run(["m1", "m2", "m3"], ["right", "right", "right"]).ok, false);
  // Listed: within main's own variation passes, beyond it blocks.
  assert.equal(run(["m1", "m2", "m3"], ["right", "right", "right"], { known }).ok, true);
  const broken = run(["m1", "m2", "m3"], ["wrong", "wrong", "wrong"], { known });
  assert.equal(broken.ok, false);
  assert.match(broken.rows[0].detail, /outside main's variation/);
  // An object removed (8 % of pixels) "matches" at default thresholds but is
  // far outside a one-pixel nondeterminism: blocks.
  const objectGone = { width: W, height: H, data: pic(0).data.map((v, i) => ((i >> 2) % W < 3 && (i >> 2) < W * 3 ? 90 : v)) };
  f.gone = objectGone;
  assert.equal(run(["m1", "m2", "m3"], ["gone", "gone", "gone"], { known }).ok, false);
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
