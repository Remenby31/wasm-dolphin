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
import { assembleRegion, regionModuleEntries } from "../src/aot-region-module.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";
import { HELPER_SIGNATURES, STOP, checkCoreSlice, loadAotCore } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK } from "./helpers/jit-oracle.mjs";

const core = await loadAotCore();
const skip = !core && "core without _DolphinWeb_AotTranslateForTest (patch 0075)";
const TEXT = 0x80003100;

const add = (d, a, b) => (31 << 26) | (d << 21) | (a << 16) | (b << 11) | (266 << 1);
const stw = (s, a, off) => (36 << 26) | (s << 21) | (a << 16) | (off & 0xffff);
const lwz = (d, a, off) => (32 << 26) | (d << 21) | (a << 16) | (off & 0xffff);
const mtlr = (s) => (31 << 26) | (s << 21) | (8 << 16) | (467 << 1);

// Calls, a stack frame, loads and stores through it, a loop, a tail branch.
const PROGRAM = assemble(TEXT, [
  "main", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), asm.li(3, 7), (pc, l) => asm.bl(pc, l.double),
  (pc, l) => asm.bl(pc, l.sum), (pc, l) => asm.bl(pc, l.count), lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0),
  (pc, l) => asm.b(pc, l.tailend),
  "double", add(3, 3, 3), asm.blr(),
  "sum", asm.li(4, 100), stw(4, 1, 8), lwz(5, 1, 8), add(3, 3, 5), asm.ori(4, 4, 0x0f), asm.blr(),
  "count", asm.li(8, 0),
  "count_loop", asm.addi(8, 8, 3), asm.cmplwi(8, 30), (pc, l) => asm.bgt(pc, l.count_done), (pc, l) => asm.b(pc, l.count_loop),
  "count_done", asm.blr(),
  "tailend", asm.ori(7, 3, 1), asm.lis(6, 0x1234), asm.blr()
]);
const program = () => buildDol({ textAddr: TEXT, text: PROGRAM.words, entry: PROGRAM.labels.main });
const { double: DOUBLE, count: COUNT, main: MAIN } = PROGRAM.labels;

function setup(dol) {
  const { image, entryPoint } = imageFromDol(dol);
  return { image, plan: planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } }) };
}

test("the core translates a block into a fragment the region assembler links", { skip }, () => {
  const { image } = setup(program());
  for (const s of image.segments) core.load(s.start, s.bytes);
  const fragment = core.translate(DOUBLE); // add, blr: one block
  assert.ok(fragment, "translated");
  assert.equal(fragment.entry, DOUBLE);
  assert.equal(fragment.code.at(-1), 0x0b, "body ends with end");
  for (const r of fragment.relocs) if (r.kind === "import") assert.ok(HELPER_SIGNATURES[r.name], `known helper ${r.name}`);
  const { bytes, entries } = assembleRegion([fragment], { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
  assert.deepEqual(entries, [[DOUBLE, 0]]);
  assert.deepEqual(fragment.relocs.map((r) => r.kind), ["dispatch"], "blr leaves through the dispatcher");
  assert.ok(core.compile(bytes) > 0, "the core compiles and links the region module");
  assert.deepEqual(regionModuleEntries(new WebAssembly.Module(bytes)), [DOUBLE], "entries travel with the module (cache loads)");
});

test("a function becomes one fragment of its blocks, calls leave through jump relocs", { skip }, () => {
  const { image, plan } = setup(program());
  for (const s of image.segments) core.load(s.start, s.bytes);
  const fn = (pc) => plan.modules[0].functions.find((f) => f.entry === pc);
  const count = core.translate(COUNT, { ranges: fn(COUNT).ranges });
  // Blocks depend on the analyzer (branch following may merge the loop's b
  // into its successor), not on labels: the entry first, the exit in, all inside.
  assert.equal(count.entries[0], COUNT);
  assert.ok(count.entries.includes(PROGRAM.labels.count_done));
  assert.ok(count.entries.length >= 3 && count.entries.every((pc) => pc >= COUNT && pc < PROGRAM.labels.tailend));
  const main = core.translate(MAIN, { ranges: fn(MAIN).ranges });
  const jumps = main.relocs.filter((r) => r.kind === "jump").map((r) => r.targetPc);
  const entries = new Set(plan.modules[0].functions.map((f) => f.entry));
  assert.ok(jumps.length >= 1 && jumps.every((pc) => entries.has(pc) && pc !== MAIN), "b/bl to other functions");
  assert.ok(main.entries.length >= 4, "the return points after each bl are blocks of main");
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
  // double's add r3,r3,r3 (local.get 11; local.get 11; i32.add) becomes a sub.
  const planted = (f) => {
    const fr = core.translate(f.entry, { ranges: f.ranges });
    if (!fr || f.entry !== DOUBLE) return fr ? [fr] : [];
    const code = fr.code.slice();
    const at = code.findIndex((_, i) => [0x20, 11, 0x20, 11, 0x6a].every((b, j) => code[i + j] === b));
    assert.ok(at > 0, "the add is in the fragment");
    code[at + 4] = 0x6b;
    return [{ ...fr, code }];
  };
  const report = checkCoreSlice({ core, ...s, slice: 0, slices: 1, fragmentsOf: planted });
  assert.ok(report.mismatches.length >= 1, "the interpreter and the regions disagree");
  assert.ok(report.mismatches.some((m) => m.state), "on the registers");
});

// The cpufuzz homebrew (ours, MIT), when built.
const CPUFUZZ = new URL("../harness/homebrew/out/cpufuzz.dol", import.meta.url);
test("cpufuzz over 4 slices: regions end like the interpreter", {
  skip: skip || (!existsSync(CPUFUZZ) && "harness/homebrew/out/cpufuzz.dol not built"), timeout: 600000
}, (t) => {
  const s = setup(readFileSync(CPUFUZZ));
  const total = { functions: 0, translated: 0, checked: 0, equal: 0, regionRuns: 0, regionCycles: 0, interpCycles: 0, ends: {}, mismatches: [], skipped: {} };
  for (let k = 0; k < 4; k++) {
    const r = checkCoreSlice({ core, ...s, slice: k, slices: 4, maxFunctions: 40 });
    for (const key of ["functions", "translated", "checked", "equal", "regionRuns", "regionCycles", "interpCycles"]) total[key] += r[key];
    total.mismatches.push(...r.mismatches);
    for (const [why, n] of Object.entries(r.skipped)) total.skipped[why] = (total.skipped[why] ?? 0) + n;
    for (const [end, n] of Object.entries(r.ends)) total.ends[end] = (total.ends[end] ?? 0) + n;
  }
  t.diagnostic(JSON.stringify({ ...total, mismatches: total.mismatches.slice(0, 8), mismatchCount: total.mismatches.length }));
  assert.equal(total.functions, s.plan.modules.reduce((n, m) => n + m.functions.length, 0));
  // Only traps (MMIO, mtdec: no hardware behind the test CPU) are not compared.
  assert.ok(total.checked >= 0.9 * total.translated, `${total.checked} of ${total.translated} compared`);
  assert.deepEqual(total.mismatches, []);
});

// 0077 (?fpsingle=1): the known-single analysis runs on region code too
// (the translator emits each block with the same emitter and its own mask).
test("known-single FPRs apply to region code: less code, the skip counter moves", { skip: skip || (!core?.has("DolphinWeb_JitFpKnownSingleSkips") && "core without 0077") }, () => {
  const A = (op, d, a, b, c, xo) => ((op << 26) | (d << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
  // lfs f1,0(r1); lfs f2,4(r1); fmadds f3,f1,f2,f4; fmuls f5,f1,f2; blr
  const words = [((48 << 26) | (1 << 21) | (1 << 16)) >>> 0, ((48 << 26) | (2 << 21) | (1 << 16) | 4) >>> 0, A(59, 3, 1, 4, 2, 29), A(59, 5, 1, 0, 2, 25), 0x4e800020];
  const bytes = new Uint8Array(4 * words.length);
  words.forEach((w, i) => new DataView(bytes.buffer).setUint32(4 * i, w));
  core.load(TEXT, bytes);
  core.reset(new Array(32).fill(0x80100000), TEXT, STOP, 400000);
  const skips = () => core.module._DolphinWeb_JitFpKnownSingleSkips() >>> 0;
  const ranges = [[TEXT, TEXT + bytes.length]];
  const s0 = skips();
  const off = core.translate(TEXT, { ranges });
  const s1 = skips();
  const on = core.translate(TEXT, { ranges, mask: (PRODUCTION_DISABLE_MASK | (1 << 28)) >>> 0 });
  assert.ok(off && on);
  assert.equal(s1, s0, "off: nothing skipped");
  assert.equal(skips() - s1, 2, "on: frC of fmadds and fmuls known single");
  assert.ok(on.code.length < off.code.length, `${on.code.length} < ${off.code.length}`);
});

// 0091: nothing is translated under the MMU (regions would run on after a
// DSI); the block JIT refuses there too (cached-interpreter-mmu-guard-source).
test("under the MMU the translator refuses every entry, and translates again once it is off", { skip: skip || (!core.setMMUMode && "core without DolphinWeb_AotMMUModeForTest (0091)") }, () => {
  const { image } = setup(program());
  for (const s of image.segments) core.load(s.start, s.bytes);
  core.setMMUMode(true);
  try {
    assert.equal(core.translate(DOUBLE), null);
    assert.equal(core.translate(MAIN, { ranges: [[TEXT, TEXT + 4 * PROGRAM.words.length]] }), null);
  } finally {
    core.setMMUMode(false);
  }
  assert.ok(core.translate(DOUBLE), "translated with the MMU off");
});
