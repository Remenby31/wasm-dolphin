// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Region equivalence on the core (P4 step 2): fragments from the core's
// translator, linked by the region assembler, run on the core against its
// interpreter. Skipped with a core that predates patch 0075.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { imageFromDol } from "../src/aot-image.js";
import { planDol } from "../src/aot-plan.js";
import { assembleRegion, regionModuleEntries } from "../src/aot-region-module.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";
import { HELPER_SIGNATURES, checkCoreSlice, loadAotCore } from "./helpers/aot-core-equivalence.mjs";

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
  assert.deepEqual(fragment.relocs.map((r) => r.kind).filter((k) => k !== "hint"), ["dispatch"], "blr leaves through the dispatcher");
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

// The cpufuzz homebrew (ours, MIT): the committed fixture
// (harness/homebrew/fixtures, rebuilt identically by rebuild-fixtures.sh), so
// CI runs it on the core it builds.
const CPUFUZZ = new URL("../harness/homebrew/fixtures/cpufuzz.dol", import.meta.url);
test("cpufuzz over 4 slices: regions end like the interpreter", {
  skip: skip || (!existsSync(CPUFUZZ) && "harness/homebrew/fixtures/cpufuzz.dol missing"), timeout: 600000
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

// 0088: Dolphin's idle skip in regions. A block that loops to its own start
// without side effects (PPCAnalyzer::IsBusyWaitLoop) must stay out of the
// region whole: cut before its branch, the region went on at the branch's
// address, where no idle loop is seen any more, and the loop spun inside the
// region without ever reaching CoreTiming::Idle. Outside, the block path runs
// it from its start with CheckIdle; the region resumes after the loop.
const { coreStatus } = await import("../tools/core-artifacts.mjs");
const idleSkip = skip || ((await coreStatus(fileURLToPath(new URL("..", import.meta.url)))).current
  ? false : "the core in cores/dolphin predates these sources (CI builds this branch's core)");
test("an idle loop stays out of the region: its start is not a region block, the region resumes after it", { skip: idleSkip }, () => {
  const IDLE = assemble(TEXT, [
    "wait", asm.addi(5, 5, 1),
    "wait_loop", lwz(3, 4, 0), asm.cmplwi(3, 0), (pc, l) => asm.beq(pc, l.wait_loop),
    "after", asm.addi(6, 6, 1), asm.blr()
  ]);
  const { image } = setup(buildDol({ textAddr: TEXT, text: IDLE.words, entry: IDLE.labels.wait }));
  for (const s of image.segments) core.load(s.start, s.bytes);
  const { wait, wait_loop: loop, after } = IDLE.labels;
  const end = TEXT + 4 * IDLE.words.length;
  const fragment = core.translate(wait, { ranges: [[TEXT, end]] });
  assert.ok(fragment, "translated");
  const beq = loop + 8;
  assert.ok(!fragment.entries.includes(loop), `the idle loop's start ${loop.toString(16)} is not in the region`);
  assert.ok(!fragment.entries.includes(beq), "nor its branch, which no longer looks idle on its own");
  assert.ok(fragment.entries.includes(after), "the region resumes after the loop");
  assert.equal(core.translate(loop, { ranges: [[TEXT, end]] }), null, "an idle loop is no region entry");
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

// 0126: region code swaps the bytes of a 32-bit value as
// (rotl(x, 8) & 0x00ff00ff) | (rotr(x, 8) & 0xff00ff00). The exact bytes
// EmitBswap32FromLocal emits, run against a reference bswap32 on edge values
// and random ones; with a 0126 core, a translated lwz carries that sequence.
const compilerVersion = () => {
  if (typeof core?.module?._DolphinWeb_AotKeyParts !== "function") return 0;
  const p = core.module._malloc(8);
  try { core.module._DolphinWeb_AotKeyParts(p); return new Uint32Array(core.module.HEAPU8.buffer, p, 2)[0]; } finally { core.module._free(p); }
};
const sleb = (v) => { const o = []; for (;;) { const b = v & 0x7f; v >>= 7; if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
// EmitBswap32FromLocal(local): the memory emitters swap from local 2.
const rotateSwap = (local) => [0x20, local, 0x41, 8, 0x77, 0x41, ...sleb(0x00ff00ff), 0x71, 0x20, local, 0x41, 8, 0x78, 0x41, ...sleb(0xff00ff00 | 0), 0x71, 0x72];
test("the rotate byte swap of region code is a bswap32, on edge and random values (0126)", () => {
  const body = [0, ...rotateSwap(0), 0x0b];
  const bytes = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f, 3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 0, 10, body.length + 2, 1, body.length, ...body]);
  const swap = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.f;
  const ref = (x) => (((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24)) >>> 0;
  const values = [0, 1, 0xff, 0xff00, 0xff0000, 0xff000000, 0xffffffff, 0x80000000, 0x7fffffff, 0x12345678, 0x00ff00ff, 0xff00ff00, 0x01020304, 0xdeadbeef];
  let s = 0x9e3779b9;
  for (let i = 0; i < 5000; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; values.push(s); }
  for (const v of values) assert.equal(swap(v | 0) >>> 0, ref(v), `0x${v.toString(16)}`);
});

test("a translated lwz carries the rotate byte swap (0126)", { skip: skip || (compilerVersion() < 17 && "core before 0126 (compiler version < 17)") }, () => {
  const lwzR3 = (32 << 26) | (3 << 21) | (4 << 16) | 8;
  const at = 0x80021100;
  core.load(at, Uint8Array.of(lwzR3 >>> 24, (lwzR3 >>> 16) & 0xff, (lwzR3 >>> 8) & 0xff, lwzR3 & 0xff, 0x4e, 0x80, 0x00, 0x20));
  const fragment = core.translate(at, { ranges: [[at, at + 8]] });
  assert.ok(fragment, "translated");
  const code = Array.from(fragment.code);
  const seq = rotateSwap(2);
  assert.ok(code.some((_, i) => seq.every((b, j) => code[i + j] === b)), "the rotate sequence is in the fragment");
});

// 0131: region code marks its `if`s whose outcome it knows. A lwz's RAM fast
// path is likely; the SO guard at entry and the downcount running out are
// not (its slow path calls the read helper without a halt check). Every hint
// lands on an `if`, and the assembled module carries them as a
// metadata.code.branch_hint section.
test("a translated lwz carries branch hints on its ifs, and the module a branch_hint section (0131)", { skip: skip || (compilerVersion() < 23 && "core before 0131 (compiler version < 23)") }, () => {
  const lwzR3 = (32 << 26) | (3 << 21) | (4 << 16) | 8;
  const at = 0x80021200;
  core.load(at, Uint8Array.of(lwzR3 >>> 24, (lwzR3 >>> 16) & 0xff, (lwzR3 >>> 8) & 0xff, lwzR3 & 0xff, 0x4e, 0x80, 0x00, 0x20));
  const fragment = core.translate(at, { ranges: [[at, at + 8]] });
  assert.ok(fragment, "translated");
  const hints = fragment.relocs.filter((r) => r.kind === "hint");
  for (const h of hints) assert.equal(fragment.code[h.offset], 0x04, `the hint at ${h.offset} is on an if`);
  assert.ok(hints.some((h) => h.likely), "the RAM fast path is likely");
  assert.ok(hints.filter((h) => !h.likely).length >= 2, "SO guard and downcount unlikely");
  const { bytes, hintsDropped } = assembleRegion([fragment], { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
  assert.equal(hintsDropped, 0, "no hint of the core falls off an `if`");
  const [section] = WebAssembly.Module.customSections(new WebAssembly.Module(bytes), "metadata.code.branch_hint");
  assert.ok(section, "the module carries the hints");
  assert.ok(core.compile(bytes) > 0, "the core compiles and links the hinted module");
});
