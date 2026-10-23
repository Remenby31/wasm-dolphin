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

import { compareRegionProgram, loadAotCore, runOracleProgramsAsRegions } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK, SHORT_PREFIX_MASK, makeRng, randomState } from "./helpers/jit-oracle.mjs";

const core = await loadAotCore();
const skip = !core?.has("DolphinWeb_AotTestLoadState") && "core without the region test exports (patch 0075)";
for (const [name, mask] of [["production mask", PRODUCTION_DISABLE_MASK], ["short prefixes", SHORT_PREFIX_MASK]]) {
  test(`oracle programs as regions, ${name}: interpreter and regions agree, mid-region exits included`, { skip, timeout: 600000 }, (t) => {
    const tally = runOracleProgramsAsRegions(core, { seed: 0x4e9 ^ mask, count: 400, length: 24, mask });
    t.diagnostic(JSON.stringify({ ...tally, mismatches: tally.mismatches.slice(0, 4), mismatchCount: tally.mismatches.length }));
    assert.deepEqual(tally.mismatches.slice(0, 4), []);
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

// 0134 (was 0127): a GPR the block writes before reading it is not loaded in the
// prologue. Written first by a load whose fast path fails (a helper writes
// it, the slow path reloads it), by an immediate, and read right after,
// against the interpreter.
const lwz = (d, a, off) => (32 << 26) | (d << 21) | (a << 16) | (off & 0xffff);
const deadSkip = skip || (compilerVersion() < 26 && "core before 0134 (compiler version < 26)");
test("GPRs written before read are not loaded, the slow path and the reads after agree with the interpreter (0134)", { skip: deadSkip }, () => {
  const cases = [
    ["slow-path load", [lwz(5, 6, 0), add(7, 5, 5), addi(5, 5, 1), BLR], (s) => { s[6] = 0x00100080; }],
    ["fast-path load", [lwz(5, 6, 4), add(7, 5, 5), BLR], (s) => { s[6] = 0x80004000; }],
    ["immediate", [addi(5, 0, 7), add(7, 5, 6), addi(5, 7, 0), BLR], () => {}]
  ];
  for (const [what, program, set] of cases) {
    const state = baseState(31);
    set(state);
    const r = compareRegionProgram(core, program, state);
    assert.ok(r.translated && !r.trap && !r.error, `${what}: ${r.error ?? "trap or untranslated"}`);
    assert.ok(r.got.regionRuns >= 1, `${what}: the region ran`);
    assert.ok(r.equal, `${what}: ${JSON.stringify(r.difference)}`);
  }
});

test("a GPR written first by a load whose slow path halts keeps its value (0134, lmw)", { skip: deadSkip }, () => {
  // lmw r29, 2(r1): unaligned, the helper takes an alignment exception before
  // writing r29..r31; their values must stay as they were.
  const lmw = (d, a, off) => (46 << 26) | (d << 21) | (a << 16) | (off & 0xffff);
  const state = baseState(32);
  const r = compareRegionProgram(core, [lmw(29, 1, 2), add(7, 29, 30), BLR], state);
  assert.ok(r.translated && !r.trap && !r.error, `${r.error ?? "trap or untranslated"}`);
  assert.ok(r.equal, JSON.stringify(r.difference));
});

test("a load that faults before the integer write of an unloaded GPR leaves that GPR as it was (0134)", { skip: deadSkip }, () => {
  // The halt's flush is emitted before the later write: r5 is neither loaded
  // nor dirty there, and must keep its value. The faulting load is a lwz from
  // 0x00004000, which no BAT maps: a DSI, which halts the region. (Neither an
  // unaligned access, whose alignment exception stays pending to the block's
  // end as in Dolphin's JITs, nor an lfs with MSR.FP clear, which regions
  // take for granted since 0121, halts one.)
  const cases = [
    ["lwz (DSI)", [lwz(6, 1, 0), addi(5, 0, 1), add(7, 5, 5), BLR], null],
    ["lwz (DSI), r5 read before", [add(7, 5, 5), lwz(6, 1, 0), addi(5, 0, 1), BLR], null]
  ];
  for (const [what, program, run] of cases) {
    const translateState = baseState(33);
    translateState[9] = 0x00004000;
    const state = translateState.slice();
    run?.(state);
    const r = compareRegionProgram(core, program, state, { translateState });
    assert.ok(r.translated && !r.trap && !r.error, `${what}: ${r.error ?? "trap or untranslated"}`);
    assert.equal(r.got.end, "exception", `${what}: faults`);
    assert.ok(r.equal, `${what}: ${JSON.stringify(r.difference)}`);
  }
});
