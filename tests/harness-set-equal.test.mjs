// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// renderVsBaseline "set-equal" mode: a cell listed in known-failures.json
// whose picture order varies between runs is judged on the sets of pictures.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { crossCommitGate } from "../harness/lib/gate.mjs";
import { renderVsBaseline, setEqualCells } from "../harness/lib/render-check.mjs";

// Textured pictures (a flat one counts as blank).
const img = (v) => ({ width: 4, height: 4, data: new Uint8Array(64).map((_, i) => (i * 37 + v) & 255) });
const frames = { a: img(1), b: img(2), c: img(3), z: img(9), blank: { width: 4, height: 4, data: new Uint8Array(64) } };
const runs = (files, extra = {}) => files.map((file, i) => ({ game: "g", config: "c", run: i + 1, capture: { file, index: 120, fromLoad: true }, ...extra }));
const setEqual = [{ cell: "g/c", check: "renderVsBaseline", mode: "set-equal", reason: "dual-core frame order" }];
const asRuns = (x) => (typeof x[0] === "string" ? runs(x) : x);
const gate = (base, cand, known = setEqual) => crossCommitGate(renderVsBaseline(asRuns(base), asRuns(cand), { loadFrame: (f) => frames[f], known })).rows[0];

test("set-equal: same set of pictures in another order passes", () => {
  const row = gate(["a", "b", "c"], ["c", "a", "b"]);
  assert.equal(row.status, "ok");
  assert.match(row.detail, /set-equal/);
});

test("set-equal: a candidate picture never seen on the baseline fails", () => {
  assert.equal(gate(["a", "b", "c"], ["a", "b", "z"]).status, "regressed");
});

test("set-equal: a crash or a blank picture on either side fails", () => {
  assert.equal(gate(runs(["a", "b", "c"]), [...runs(["a", "b"]), { ...runs(["c"])[0], run: 3, crashed: true }]).status, "regressed");
  assert.equal(gate(["a", "b", "blank"], ["a", "b", "c"]).status, "regressed");
});

test("set-equal: too few runs is inconclusive; a baseline picture the candidate did not sample passes", () => {
  assert.equal(gate(["a", "b"], ["b", "a"]).status, "inconclusive");
  assert.equal(gate(["a", "b", "c"], ["a", "b", "a"]).status, "ok");
});

test("an unlisted nondeterministic cell stays inconclusive", () => {
  assert.equal(gate(["a", "b", "c"], ["c", "a", "b"], []).status, "inconclusive");
});

test("a set-equal entry needs a reason, and the repo's list is valid", () => {
  assert.throws(() => setEqualCells([{ cell: "g/c", check: "renderVsBaseline", mode: "set-equal" }]), /needs a reason/);
  assert.throws(() => setEqualCells([{ cell: "g/c", check: "renderVsBaseline", mode: "loose", reason: "x" }]), /unknown mode/);
  const known = JSON.parse(readFileSync(new URL("../harness/known-failures.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => setEqualCells(known));
});
