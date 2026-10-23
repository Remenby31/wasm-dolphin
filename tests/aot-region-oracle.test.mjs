// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Oracle region mode (P4 step 4): the oracle's random programs (every JIT
// instruction class, branches, CTR loops, unmapped and misaligned accesses,
// FP exceptions under FE0/FE1) translated as one fragment, assembled as a
// region and run by the core against its interpreter from the oracle's
// random states. A small cycle budget makes the region stop in the middle of
// the program (downcount exit); the run is then compared at that downcount.

import assert from "node:assert/strict";
import test from "node:test";

import { assembleRegion } from "../src/aot-region-module.js";
import { HELPER_SIGNATURES, ORACLE_CODE, compareRegionProgram, loadAotCore, runOracleProgramsAsRegions } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK, SHORT_PREFIX_MASK, makeRng, randomState } from "./helpers/jit-oracle.mjs";

const core = await loadAotCore();
const skip = !core?.has("DolphinWeb_AotTestLoadState") && "core without the region test exports (patch 0075)";
for (const [name, mask] of [["production mask", PRODUCTION_DISABLE_MASK], ["short prefixes", SHORT_PREFIX_MASK]]) {
  test(`oracle programs as regions, ${name}: interpreter and regions agree, mid-region exits included`, { skip, timeout: 600000 }, (t) => {
    const tally = runOracleProgramsAsRegions(core, { seed: 0x4e9 ^ mask, count: 400, length: 24, mask });
    t.diagnostic(JSON.stringify({ ...tally, mismatches: tally.mismatches.slice(0, 4), mismatchCount: tally.mismatches.length }));
    assert.deepEqual(tally.mismatches.slice(0, 4), []);
    assert.equal(tally.hintsDropped, 0, "every branch hint of the core lands on an `if` (0131)");
    // A program whose first instruction the direct tier does not take has no
    // fragment (its entry must be a block): about a quarter of them.
    assert.ok(tally.translated >= 0.7 * tally.programs, `${tally.translated} of ${tally.programs} translated`);
    assert.ok((tally.ends.budget ?? 0) >= 50, "regions stopped by downcount in the middle");
    assert.ok((tally.ends.exception ?? 0) >= 20, "exceptions taken inside regions");
    assert.ok((tally.ends.stop ?? 0) >= 100, "programs ran to their blr");
  });
}

// 0105: FPU ops the direct tier does not emit run inside the region as
// helper calls (fp or interpret). Their exceptions and GPR writes, against the
// interpreter from the same state (full state, SRR0 and downcount included).
const compilerVersion = () => {
  if (typeof core?.module?._DolphinWeb_AotKeyParts !== "function") return 0;
  const p = core.module._malloc(8);
  try { core.module._DolphinWeb_AotKeyParts(p); return new Uint32Array(core.module.HEAPU8.buffer, p, 2)[0]; } finally { core.module._free(p); }
};
const fpuSkip = skip || (compilerVersion() < 6 && "core before 0105 (compiler version < 6)");
const MSR_FP = 0x2000, MSR_FE0 = 0x800, MSR_FE1 = 0x100;
const addi = (d, a, imm) => (14 << 26) | (d << 21) | (a << 16) | (imm & 0xffff);
const add = (d, a, b) => (31 << 26) | (d << 21) | (a << 16) | (b << 11) | (266 << 1);
const faddsRc = (d, a, b) => (59 << 26) | (d << 21) | (a << 16) | (b << 11) | (21 << 1) | 1;
const psqLux = (d, a, b) => (4 << 26) | (d << 21) | (a << 16) | (b << 11) | (38 << 1); // W=0, GQR0
const BLR = 0x4e800020;
const f64Words = (x) => Array.from(new Uint32Array(new Float64Array([x]).buffer));
const baseState = (seed) => {
  const s = randomState(makeRng(seed));
  s[37] = 0x00002032; // FP, IR, DR, RI
  s[33] = 0; // XER clear: with SO set a fragment refuses to run (0111)
  s[36] = 0; // FPSCR: round to nearest, no enable, no sticky bit
  s[38] = 0; // GQR0: float loads and stores
  return s;
};
const expectSame = (r, what) => {
  assert.ok(r.translated, `${what}: translated`);
  assert.ok(!r.trap && !r.error, `${what}: ${r.error ?? "trap"}`);
  assert.ok(r.got.regionRuns >= 1, `${what}: the region ran`);
  // The op stays in the region as a helper call (fp, through EmitFpCall, or
  // interpret), not as a region exit.
  assert.ok(r.fragment.relocs.some((x) => x.kind === "import" && (x.name === "fp" || x.name === "interpret")), `${what}: the op is a helper call inside the region`);
  assert.equal(r.fragment.entries.length, 1, `${what}: one block, not cut before the op`);
  assert.ok(r.equal, `${what}: ${JSON.stringify(r.difference)}`);
};

test("an FPU op kept in the region as a helper call, with MSR.FP clear, takes FP unavailable in the region, like the interpreter (0105)", { skip: fpuSkip }, () => {
  const program = [addi(3, 3, 1), faddsRc(3, 1, 2), addi(3, 3, 1), BLR];
  const translateState = baseState(11);
  const state = translateState.slice();
  state[37] &= ~MSR_FP;
  const r = compareRegionProgram(core, program, state, { translateState });
  expectSame(r, "FP unavailable");
  assert.equal(r.got.end, "exception");
});

test("an enabled FP exception (FE0/FE1, VE) of an FPU op kept in the region is a program exception at its pc, partial downcount, like the interpreter (0105)", { skip: fpuSkip }, () => {
  const program = [addi(3, 3, 1), faddsRc(3, 1, 2), addi(3, 3, 1), BLR];
  const state = baseState(12);
  state[37] |= MSR_FE0 | MSR_FE1;
  state[36] = 0x00000080; // VE: invalid operation enabled
  state.set([...f64Words(Infinity), ...f64Words(Infinity)], 48 + 1 * 4);
  state.set([...f64Words(-Infinity), ...f64Words(-Infinity)], 48 + 2 * 4); // inf + -inf: VXISI
  const r = compareRegionProgram(core, program, state);
  if (core.has("DolphinWeb_RegionGuardRefusals")) {
    // 0121: no region is entered with FE0/FE1 set (its code takes them clear):
    // the CPU loop runs blocks there, and the exception is the interpreter's.
    assert.ok(r.translated && !r.trap && !r.error, JSON.stringify(r.error ?? r.difference));
    assert.equal(r.got.regionRuns, 0, "refused by the 0121 guards");
    assert.ok(r.equal, JSON.stringify(r.difference));
    assert.equal(r.got.end, "exception");
    return;
  }
  expectSame(r, "program exception");
  assert.equal(r.got.end, "exception");
});

test("psq_lux kept in the region updates a GPR the block had cached dirty, like the interpreter (0105)", { skip: fpuSkip }, () => {
  // r5 written (dirty in the GPR cache) before psq_lux reads it from the
  // state and writes it back (rA + rB); r7 reads the new r5 after it.
  const program = [addi(5, 5, 16), psqLux(1, 5, 6), add(7, 5, 5), BLR];
  const state = baseState(13);
  state[5] = 0x80004000;
  state[6] = 8;
  const r = compareRegionProgram(core, program, state);
  expectSame(r, "psq_lux");
  assert.equal(r.got.end, "stop");
});

// 0133: a fragment's head finds the block of the pc with one br_table on
// rotr(pc - lowest start, 2), or, when the blocks fill less than a quarter of
// their span, a compact br_if chain;
// a body goes straight to a later body its npc names. A loop (back edge
// through the head), a forward branch (direct br_if), a span too wide for the
// table, each against the interpreter at budgets that stop it mid-loop.
const sleb = (v) => { const o = []; for (;;) { const b = v & 0x7f; v >>= 7; if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
const dispatchSkip = skip || (compilerVersion() < 25 && "core before 0133 (compiler version < 25)");
test("the br_table head, direct forward edges and the wide-span chain run like the interpreter (0133)", { skip: dispatchSkip }, () => {
  const cmpw = (a, b) => (31 << 26) | (a << 16) | (b << 11);
  const cmpwi = (a, imm) => (11 << 26) | (a << 16) | (imm & 0xffff);
  const bc = (bo, bi, disp) => (16 << 26) | (bo << 21) | (bi << 16) | (disp & 0xfffc);
  const b = (disp) => (18 << 26) | (disp & 0x3fffffc);
  const loop = [addi(3, 0, 0), addi(4, 0, 7), addi(3, 3, 1), cmpw(3, 4), bc(12, 0, -8), add(5, 3, 3), BLR];
  const forward = [cmpwi(3, 0), bc(12, 2, 12), addi(5, 5, 1), addi(6, 6, 1), add(7, 5, 6), BLR];
  const wide = new Array(0x40).fill(0);
  wide.splice(0, 3, addi(3, 0, 0), addi(4, 0, 3), b(4 * 0x3c - 8));
  wide.splice(0x3c, 4, addi(3, 3, 1), cmpw(3, 4), bc(12, 0, -8), BLR);
  const cases = [["loop", loop, true], ["forward", forward, true], ["sparse span", wide, false]];
  for (const [what, program, table] of cases) {
    for (const [budget, seed] of [[400000, 51], [9, 52], [23, 53], [400000, 54]]) {
      const state = baseState(seed);
      if (seed === 54) state[11] = 0; // forward: r3 == 0, the branch taken
      const r = compareRegionProgram(core, program, state, { budget });
      assert.ok(r.translated && !r.trap && !r.error, `${what}: ${r.error ?? "trap or untranslated"}`);
      assert.ok(r.got.regionRuns >= 1, `${what}: the region ran`);
      assert.ok(r.equal, `${what} at ${budget}: ${JSON.stringify(r.difference)}`);
      assert.ok(r.fragment.entries.length >= 2, `${what}: ${r.fragment.entries.length} blocks`);
      const code = Array.from(r.fragment.code);
      const rotrTable = code.some((x, i) => x === 0x78 && code[i + 1] === 0x0e);
      assert.equal(rotrTable, table, `${what}: br_table head ${table}`);
    }
  }
  // The forward case's taken branch is a direct br_if to the target body:
  // i32.const target; i32.eq; br_if (the head is a br_table, no br_if there).
  const target = ORACLE_CODE + 16;
  const fwd = Array.from(compareRegionProgram(core, forward, baseState(55)).fragment.code);
  const direct = [0x41, ...sleb(target | 0), 0x46, 0x0d];
  assert.ok(fwd.some((_, i) => direct.every((x, j) => fwd[i + j] === x)), "a direct br_if to the forward target");
});

// 0133: the table's boundary (span = 4 × blocks: table; one word more:
// chain), and a pc the table must not take (below the lowest start, not on a
// word, between two starts): the fragment does not run (1, not an entry) and
// leaves the state as it was.
test("the br_table threshold, and pcs that are not block starts go to the dispatcher (0133)", { skip: dispatchSkip }, () => {
  const b = (disp) => (18 << 26) | (disp & 0x3fffffc);
  // Two blocks: `b X` at 0 and `blr` at word X; span X + 1.
  const jumpTo = (x) => { const w = new Array(x + 1).fill(0); w[0] = b(4 * x); w[x] = BLR; return w; };
  for (const [x, table] of [[7, true], [8, false]]) {
    const r = compareRegionProgram(core, jumpTo(x), baseState(60 + x));
    assert.ok(r.translated && r.equal, `span ${x + 1}: ${JSON.stringify(r.difference ?? r.error)}`);
    assert.equal(r.fragment.entries.length, 2);
    const code = Array.from(r.fragment.code);
    assert.equal(code.some((v, i) => v === 0x78 && code[i + 1] === 0x0e), table, `span ${x + 1}: table ${table}`);
  }
  const program = jumpTo(7);
  const state = baseState(70);
  const r = compareRegionProgram(core, program, state);
  const { bytes } = assembleRegion([r.fragment], { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
  const handle = core.compile(bytes);
  assert.ok(handle > 0);
  for (const pc of [ORACLE_CODE - 4, ORACLE_CODE - 0x1000, ORACLE_CODE + 2, ORACLE_CODE + 8, ORACLE_CODE + 4 * 8]) {
    core.loadState(state, pc);
    core.setDowncount(1000);
    const before = core.state();
    assert.equal(core.runRegion(handle), 1, `pc ${pc.toString(16)}: not an entry`);
    assert.deepEqual(core.state(), before, `pc ${pc.toString(16)}: state untouched`);
    assert.equal(core.downcount(), 1000);
  }
});

// 0135 (was 0128): a memory helper's slow path inside a fragment (a misaligned
// lmw) leaves pc, npc and downcount as the interpreter does, after ops that
// moved the frame locals. (Without MMU emulation an unmapped address neither
// faults nor halts: loads read 0, stores are dropped.)
const frameSkip = skip || (compilerVersion() < 27 && "core before 0135 (compiler version < 27)");
test("a memory helper's slow path in a fragment leaves pc, npc and downcount like the interpreter (0135)", { skip: frameSkip }, () => {
  const lmw = (d, a, off) => (46 << 26) | (d << 21) | (a << 16) | (off & 0xffff);
  const program = [addi(3, 3, 1), addi(4, 4, 2), lmw(29, 1, 2), addi(3, 3, 1), BLR];
  const r = compareRegionProgram(core, program, baseState(41));
  assert.ok(r.translated && !r.trap && !r.error, `${r.error ?? "trap or untranslated"}`);
  assert.ok(r.got.regionRuns >= 1, "the region ran");
  assert.ok(r.equal, JSON.stringify(r.difference));
});

// 0135: a helper that does not get pc and npc written before the call (the
// interpret path, memory and FPU helpers) and a program exception there, after
// a branch moved the frame locals; and the exits on their own: a b out of the
// fragment's ranges (jump, return_call) and a bctr to a pc no fragment holds
// (dispatch). Each against the interpreter, at budgets that stop it midway.
test("program exceptions after a branch, the jump-out and the dispatch-miss exits end like the interpreter (0135)", { skip: frameSkip }, () => {
  const b = (disp) => (18 << 26) | (disp & 0x3fffffc);
  const tw = 0x7fe00008; // tw 31, r0, r0: always traps
  const mfmsr = (d) => (31 << 26) | (d << 21) | (83 << 1); // privileged under MSR.PR
  const addis = (d, a, imm) => (15 << 26) | (d << 21) | (a << 16) | (imm & 0xffff);
  const ori = (a, s, imm) => (24 << 26) | (s << 21) | (a << 16) | (imm & 0xffff);
  const mtctr = (s) => (31 << 26) | (s << 21) | (9 << 16) | (467 << 1);
  const BCTR = 0x4e800420;
  const at = (w) => ORACLE_CODE + 4 * w;
  const cases = [
    ["tw after a branch", [addi(3, 3, 1), b(4), tw, addi(3, 3, 1), BLR], (s) => s],
    ["mfmsr under MSR.PR after a branch", [addi(3, 3, 1), b(4), mfmsr(5), addi(3, 3, 1), BLR], (s) => { s[37] |= 0x4000; return s; }],
    ["b out of the ranges", [addi(3, 3, 1), b(4), addi(4, 4, 1), BLR], (s) => s, [[at(0), at(2)]]],
    ["bctr to a pc no fragment holds", [addis(6, 0, at(6) >>> 16), ori(6, 6, at(6) & 0xffff), mtctr(6), BCTR, addi(3, 3, 1), addi(3, 3, 2), addi(4, 4, 1), BLR], (s) => s, [[at(0), at(4)]]]
  ];
  for (const [what, program, setUp, ranges] of cases) {
    for (const [budget, seed] of [[400000, 81], [3, 82], [400000, 83]]) {
      const state = setUp(baseState(seed));
      const r = compareRegionProgram(core, program, state, { budget, ...(ranges ? { ranges } : {}) });
      assert.ok(r.translated && !r.trap && !r.error, `${what}: ${r.error ?? "trap or untranslated"}`);
      assert.ok(r.got.regionRuns >= 1, `${what}: the region ran`);
      assert.ok(r.equal, `${what} at ${budget}: ${JSON.stringify(r.difference)}`);
    }
  }
});
