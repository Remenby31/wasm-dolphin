// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// renderVsBaseline "report-only" mode: a cell listed in known-failures.json
// whose picture no baseline can hold (dual-core race state) is shown, never
// blocking on renderVsBaseline; its other checks still block. The exact
// render check moves to cpu=single cells.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { cellChecks } from "../harness/lib/correctness.mjs";
import { correctnessGate, crossCommitGate, mergeGates } from "../harness/lib/gate.mjs";
import { renderChecks, renderModes, renderVsBaseline, reportOnlyCells } from "../harness/lib/render-check.mjs";

const img = (v) => ({ width: 4, height: 4, data: new Uint8Array(64).map((_, i) => (i * 37 + v) & 255) });
const frames = { a: img(1), b: img(2), c: img(3), z: img(9) };
const runs = (files, { config = "dual", ...extra } = {}) => files.map((file, i) => ({
  game: "g", config, run: i + 1, capture: { file, index: 120, fromLoad: true },
  summary: { errorCount: 0 }, render: { status: "pass" }, ...extra
}));
const reportOnly = [{ cell: "g/dual", check: "renderVsBaseline", mode: "report-only", reason: "dual-core race state" }];
const json = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
// The gate as `harness/run gate` composes it, for one cell.
const gate = (base, cand, known = reportOnly) => {
  const cell = (rs) => ({ game: rs[0].game, config: rs[0].config, checks: cellChecks(rs) });
  return mergeGates(correctnessGate([cell(base)], [cell(cand)]), crossCommitGate(renderVsBaseline(base, cand, { loadFrame: (f) => frames[f], known })));
};
const rvb = (g) => g.rows.filter((r) => r.check.startsWith("renderVsBaseline"));

test("report-only: renderVsBaseline is shown, never blocking", () => {
  for (const [base, cand] of [[["a", "b", "c"], ["z", "z", "z"]], [["a", "a", "a"], ["z", "b", "c"]], [["a", "a", "a"], ["z", "z", "z"]]]) {
    const g = gate(runs(base), runs(cand));
    assert.equal(g.ok, true);
    assert.ok(rvb(g).every((r) => r.status === "report-only" && /would be (fail|inconclusive)/.test(r.candidate)));
    assert.match(rvb(g)[0].detail, /dual-core race state/);
  }
  // Without the entry, the same comparison blocks.
  assert.equal(gate(runs(["a", "a", "a"]), runs(["z", "z", "z"]), []).ok, false);
});

test("report-only: a crash on the candidate still blocks", () => {
  const g = gate(runs(["a", "a", "a"]), runs(["a", "a", "a"], { crashed: true, errors: [{ text: "RuntimeError: unreachable" }] }));
  assert.equal(g.ok, false);
  assert.deepEqual(g.blocking.map((r) => r.check), ["crash"]);
});

test("a report-only entry needs a reason; a cell has one mode", () => {
  assert.throws(() => renderModes([{ cell: "g/c", check: "renderVsBaseline", mode: "report-only" }]), /needs a reason/);
  assert.throws(() => renderModes([{ cell: "g/c", check: "renderVsBaseline", mode: "report-only", reason: " " }]), /needs a reason/);
  assert.throws(() => renderModes([{ cell: "g/c", check: "renderVsBaseline", mode: "report-only", reason: "x" }, { cell: "g/c", check: "renderVsBaseline", mode: "set-equal", reason: "x" }]), /both/);
});

test("single-core cells keep the exact comparison", () => {
  const single = (files) => runs(files, { config: "single", url: "http://127.0.0.1/?cpu=single" });
  assert.equal(gate(single(["a", "a", "a"]), single(["a", "a", "a"])).ok, true);
  const g = gate(single(["a", "a", "a"]), single(["z", "z", "z"]));
  assert.equal(g.ok, false);
  assert.ok(rvb(g).every((r) => r.status === "regressed"));
  // Within one commit, a single-core cell is not held to a dual-core
  // reference's picture (not the same emulated frame at VI N).
  const recs = [...runs(["a"], { config: "rec", url: "http://x/?cpu=dual&video=software", label: "rec" }), ...runs(["z"], { config: "rec-single", url: "http://x/?cpu=single&video=software" })];
  recs.forEach((r) => delete r.render);
  renderChecks(recs, "rec", (f) => frames[f]);
  assert.equal(recs[1].render.status, "unjudged");
});

test("the race matrix has single-core cells, and the repo's list holds them exactly", () => {
  const known = json("../harness/known-failures.json");
  const matrix = json("../harness/matrices/local-kart-race.json");
  const singles = matrix.configs.filter((c) => c.set?.cpu === "single").map((c) => `${matrix.games[0].id}/${c.id}`);
  assert.deepEqual(singles, ["kart-race/rec-single", "kart-race/wgpu-single"]);
  const modes = renderModes(known);
  for (const cell of singles) assert.equal(modes.has(cell), false);
  assert.deepEqual([...reportOnlyCells(known)].sort(), ["kart-race/rec", "kart-race/wgpu"]);
  // 0081 made single-core boots deterministic: the attract cell is no longer listed.
  assert.equal(known.some((x) => x.cell.startsWith("kart-attract/")), false);
});
