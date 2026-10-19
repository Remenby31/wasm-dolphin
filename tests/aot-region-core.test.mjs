// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Region equivalence on the core (P4 step 2): fragments from the core's
// translator, linked by the region assembler, run on the core against its
// interpreter. Skipped with a core that predates patch 0075.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { imageFromDol } from "../src/aot-image.js";
import { planDol } from "../src/aot-plan.js";
import { assembleRegion } from "../src/aot-region-module.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";
import { HELPER_SIGNATURES, checkCoreSlice, loadAotCore } from "./helpers/aot-core-equivalence.mjs";

const core = await loadAotCore();
const skip = !core && "core without _DolphinWeb_AotTranslateForTest (patch 0075)";
const TEXT = 0x80003100;

const add = (d, a, b) => (31 << 26) | (d << 21) | (a << 16) | (b << 11) | (266 << 1);
const stw = (s, a, off) => (36 << 26) | (s << 21) | (a << 16) | (off & 0xffff);
const lwz = (d, a, off) => (32 << 26) | (d << 21) | (a << 16) | (off & 0xffff);
const mtlr = (s) => (31 << 26) | (s << 21) | (8 << 16) | (467 << 1);

// Calls, a stack frame, loads and stores through it, a tail branch.
function program() {
  const t = assemble(TEXT, [
    "main", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), asm.li(3, 7), (pc, l) => asm.bl(pc, l.double),
    (pc, l) => asm.bl(pc, l.sum), lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), (pc, l) => asm.b(pc, l.tailend),
    "double", add(3, 3, 3), asm.blr(),
    "sum", asm.li(4, 100), stw(4, 1, 8), lwz(5, 1, 8), add(3, 3, 5), asm.ori(4, 4, 0x0f), asm.blr(),
    "tailend", asm.ori(7, 3, 1), asm.lis(6, 0x1234), asm.blr()
  ]);
  return buildDol({ textAddr: TEXT, text: t.words, entry: t.labels.main });
}
const DOUBLE = TEXT + 4 * 10, TAILEND = TEXT + 4 * 18; // labels of program()

function setup(dol) {
  const { image, entryPoint } = imageFromDol(dol);
  return { image, plan: planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } }) };
}

test("the core translates a block into a fragment the region assembler links", { skip }, () => {
  const { image } = setup(program());
  for (const s of image.segments) core.load(s.start, s.bytes);
  const fragment = core.translate(DOUBLE); // add, blr
  assert.ok(fragment, "translated");
  assert.equal(fragment.entry, DOUBLE);
  assert.equal(fragment.code.at(-1), 0x0b, "body ends with end");
  for (const r of fragment.relocs) assert.ok(HELPER_SIGNATURES[r.name], `known helper ${r.name}`);
  const { bytes, entries } = assembleRegion([fragment], { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
  assert.deepEqual(entries, [[DOUBLE, 0]]);
  assert.ok(core.compile(bytes) > 0, "the core compiles and links the region module");
});

test("every function of a call graph, over 3 slices: regions end like the interpreter", { skip }, () => {
  const s = setup(program());
  let checked = 0, translated = 0;
  for (let k = 0; k < 3; k++) {
    const report = checkCoreSlice({ core, ...s, slice: k, slices: 3, maxFunctions: 2 });
    assert.deepEqual(report.mismatches, [], `slice ${k}`);
    assert.equal(report.equal, report.checked);
    checked += report.checked;
    translated += report.translated;
  }
  assert.equal(translated, s.plan.modules[0].functions.length, "the core translates every entry block");
  assert.equal(checked, translated, "every function returns to its caller");
});

test("a planted translator bug is caught", { skip }, () => {
  const s = setup(program());
  // The translator hands tailend's block for double's entry.
  const swapped = (f) => {
    const fr = core.translate(f.entry);
    if (!fr || f.entry !== DOUBLE) return fr ? [fr] : [];
    return [{ ...core.translate(TAILEND), entry: DOUBLE, entries: [DOUBLE] }];
  };
  const report = checkCoreSlice({ core, ...s, slice: 0, slices: 1, fragmentsOf: swapped });
  assert.ok(report.mismatches.length >= 1, "the interpreter and the regions disagree");
  assert.ok(report.mismatches.some((m) => m.state), "on the registers");
});

// The cpufuzz homebrew (ours, MIT), when built.
const CPUFUZZ = new URL("../harness/homebrew/out/cpufuzz.dol", import.meta.url);
test("cpufuzz over 4 slices: regions end like the interpreter", {
  skip: skip || (!existsSync(CPUFUZZ) && "harness/homebrew/out/cpufuzz.dol not built"), timeout: 600000
}, (t) => {
  const s = setup(readFileSync(CPUFUZZ));
  const total = { functions: 0, translated: 0, checked: 0, equal: 0, regionRuns: 0, mismatches: [], skipped: {} };
  for (let k = 0; k < 4; k++) {
    const r = checkCoreSlice({ core, ...s, slice: k, slices: 4, maxFunctions: 40 });
    for (const key of ["functions", "translated", "checked", "equal", "regionRuns"]) total[key] += r[key];
    total.mismatches.push(...r.mismatches);
    for (const [why, n] of Object.entries(r.skipped)) total.skipped[why] = (total.skipped[why] ?? 0) + n;
  }
  t.diagnostic(JSON.stringify({ ...total, mismatches: total.mismatches.slice(0, 8), mismatchCount: total.mismatches.length }));
  assert.equal(total.functions, s.plan.modules.reduce((n, m) => n + m.functions.length, 0));
  assert.ok(total.checked > 0);
  assert.deepEqual(total.mismatches, []);
});
