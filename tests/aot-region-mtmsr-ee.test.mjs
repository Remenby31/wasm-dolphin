// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Patch 0183 (?regionmtmsr=1, enable bit 27 of the codegen mask): a region
// goes on past a mtmsr that changes no MSR bit but EE (interrupts off, then
// back on), instead of returning to the dispatcher there. Its block checks the
// other bits after the mtmsr and leaves when one changed; an exception the new
// EE lets in is taken by the mtmsr's system call, as the interpreter takes it.
// Compared with the interpreter from the same state: full state, RAM and
// downcount (the cycle count), the exceptions included.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assembleRegion } from "../src/aot-region-module.js";
import { HELPER_SIGNATURES, ORACLE_CODE, bigEndian, compareCall, loadAotCore } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK, makeRng, randomState } from "./helpers/jit-oracle.mjs";

const core = await loadAotCore();
const lock = JSON.parse(readFileSync(new URL("../provenance/dolphin-source.lock.json", import.meta.url), "utf8"));
const built = JSON.parse(readFileSync(new URL("../cores/dolphin/dolphin-core-upstream.build.json", import.meta.url), "utf8"));
const thisSeries = built.source?.patchSeriesSha256 === lock.patchSeriesSha256 && lock.patches.some((p) => p.path.includes("/0183-"));
const skip = !core?.has("DolphinWeb_AotTestLoadState") ? "core without the region test exports (patch 0075)"
  : !thisSeries ? "core built from a patch series without 0183" : false;

const REGION_MTMSR_EE = 1 << 27;
const MSR = 37, EXCEPTIONS = 46;
const EXCEPTION_DECREMENTER = 0x1, EXCEPTION_EXTERNAL_INT = 0x4;
const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
const mfmsr = (d) => ((31 << 26) | (d << 21) | (83 << 1)) >>> 0;
const mtmsr = (s) => ((31 << 26) | (s << 21) | (146 << 1)) >>> 0;
const rlwinm = (a, s, sh, mb, me) => ((21 << 26) | (s << 21) | (a << 16) | (sh << 11) | (mb << 6) | (me << 1)) >>> 0;
const ori = (a, s, imm) => ((24 << 26) | (s << 21) | (a << 16) | (imm & 0xffff)) >>> 0;
const addi = (d, a, imm) => ((14 << 26) | (d << 21) | (a << 16) | (imm & 0xffff)) >>> 0;
const add = (d, a, b) => A(31, d, a, b, 0, 266);
const BLR = 0x4e800020;

// OSDisableInterrupts / OSRestoreInterrupts' shape, with work in between and
// after: EE cleared by rlwinm (bits 17..15 kept), restored from the saved MSR.
const EE_OFF_ON = [mfmsr(5), rlwinm(6, 5, 0, 17, 15), mtmsr(6), add(7, 3, 4), addi(8, 7, 12), mtmsr(5), add(9, 8, 3), addi(10, 9, -4), BLR];
const MTMSR_AT = [2, 5].map((i) => (ORACLE_CODE + 4 * i) >>> 0);
// OSEnableInterrupts' shape: EE set by ori, from a state where it is off.
const EE_ON = [mfmsr(5), ori(6, 5, 0x8000), add(7, 3, 4), mtmsr(6), add(9, 7, 3), addi(10, 9, -4), BLR];
// Not EE alone: the region must leave after the mtmsr (and enter again at the
// next instruction, an entry of the same fragment). Each with work after it
// that the changed bit would make run differently (FP unavailable, a load
// without data translation) and one that changes SE.
const fadd = (d, a, b) => A(63, d, a, b, 0, 21);
const lwz = (d, a, off) => ((32 << 26) | (d << 21) | (a << 16) | (off & 0xffff)) >>> 0;
// What shows the guard left: runs = region runs (left, then entered again at
// the next instruction); else the rest ran on the block path (interpCycles).
const NOT_EE_ALONE = [
  ["FP off", [mfmsr(5), rlwinm(6, 5, 0, 19, 17), mtmsr(6), add(7, 3, 4), BLR], { runs: 2 }],
  // Entered again at the fadd with FP off: the fragment refuses it (0157)
  // and the block path raises FP unavailable. This case alone would not catch
  // a missing guard: run on past the mtmsr, the region still raises FP
  // unavailable at the fadd itself, as every FPU op in a region tests MSR.FP
  // at run time (0159; checked on a core with the guard neutralized, branch
  // tmp/0183-noguard: code 3, pc 0x800). FP off, DR off and SE on catch it.
  ["FP off, then fadd", [mfmsr(5), rlwinm(6, 5, 0, 19, 17), mtmsr(6), fadd(1, 2, 3), add(7, 3, 4), BLR], { runs: 1, end: "exception" }],
  // No region in real mode (TryRunRegion): the rest runs on the block path.
  ["DR off", [mfmsr(5), rlwinm(6, 5, 0, 28, 26), mtmsr(6), add(7, 3, 4), BLR], { runs: 1, interp: true }],
  ["DR off, then lwz", [mfmsr(5), rlwinm(6, 5, 0, 28, 26), mtmsr(6), lwz(7, 1, 0), add(8, 7, 4), BLR], { runs: 1, interp: true }],
  ["SE on", [mfmsr(5), ori(6, 5, 0x400), mtmsr(6), add(7, 3, 4), BLR], { runs: 2 }]
];

const stateWith = (seed, { msr = 0x0000a032, exceptions = 0 } = {}) => {
  const s = randomState(makeRng(seed));
  s[MSR] = msr; // EE, FP, IR, DR, RI
  s[33] = 0; // XER clear: with SO set a fragment refuses to run (0111)
  s[36] = 0; // FPSCR: no enable, no sticky bit
  s[EXCEPTIONS] = exceptions;
  return s;
};

function runBoth(words, state, mask, { downcount = 400000 } = {}) {
  core.loadState(state, ORACLE_CODE);
  core.load(ORACLE_CODE, bigEndian(words));
  const fragment = core.translate(ORACLE_CODE, { mask, ranges: [[ORACLE_CODE, ORACLE_CODE + 4 * words.length]] });
  assert.ok(fragment, "translated");
  const { bytes } = assembleRegion([fragment], { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
  const handle = core.compile(bytes);
  const regionAt = new Map(fragment.entries.map((pc) => [pc >>> 0, handle]));
  const baseline = core.ram().slice();
  const result = compareCall(core, regionAt, () => {
    core.ram().set(baseline);
    core.loadState(state, ORACLE_CODE);
    core.setDowncount(downcount);
  }, { strictCycles: true });
  assert.ok(!result.error && !result.trap, JSON.stringify(result));
  return { fragment, result };
}
const ON = PRODUCTION_DISABLE_MASK | REGION_MTMSR_EE;

test("mode off: the fragment still stops at the mtmsr (the code is as before)", { skip }, () => {
  const { fragment, result } = runBoth(EE_OFF_ON, stateWith(0x183), PRODUCTION_DISABLE_MASK);
  assert.ok(!fragment.entries.includes(MTMSR_AT[0] + 4), "no block past the first mtmsr");
  assert.ok(result.equal, JSON.stringify(result.difference));
});

test("EE off then on, nothing pending: one region run through both mtmsr, the interpreter's state and cycles", { skip }, () => {
  const { fragment, result } = runBoth(EE_OFF_ON, stateWith(0x184), ON);
  for (const at of MTMSR_AT) assert.ok(fragment.entries.includes(at + 4), `a block past the mtmsr at ${at.toString(16)}`);
  assert.equal(result.got.regionRuns, 1, "never back to the dispatcher");
  assert.equal(result.got.end, "stop");
  assert.ok(result.equal, JSON.stringify(result.difference));
});

for (const [name, words, expect] of NOT_EE_ALONE) {
  test(`${name}: the guard leaves after the mtmsr, the interpreter's state and cycles`, { skip }, () => {
    const { fragment, result } = runBoth(words, stateWith(0x186), ON);
    assert.ok(fragment.entries.includes(ORACLE_CODE + 12), "the block past the mtmsr is in the fragment (an entry)");
    // Without the guard the region runs on to the blr: one run, nothing on
    // the block path, and the fadd or lwz run as region code built for the
    // old mode.
    assert.equal(result.got.regionRuns, expect.runs, "left at the mtmsr");
    if (expect.interp) assert.ok(result.got.interpCycles > 0, "the rest ran on the block path");
    if (expect.end) assert.equal(result.got.end, expect.end);
    assert.ok(result.equal, JSON.stringify(result.difference));
  });
}

for (const [name, exceptions] of [["an external interrupt", EXCEPTION_EXTERNAL_INT], ["the decrementer", EXCEPTION_DECREMENTER],
  ["both", EXCEPTION_EXTERNAL_INT | EXCEPTION_DECREMENTER]]) {
  test(`${name} pending with EE off: taken at the mtmsr that turns EE on, state and downcount as the interpreter's`, { skip }, () => {
    const { result } = runBoth(EE_ON, stateWith(0x185 + exceptions, { msr: 0x00002032, exceptions }), ON);
    assert.equal(result.got.end, "exception", "taken, not run past");
    assert.equal(result.reference.end, "exception");
    assert.ok(result.equal, JSON.stringify(result.difference));
  });
}

test("downcount running out on each instruction, the mtmsr blocks included: same exit point and state", { skip }, () => {
  for (const [words, msr, exceptions] of [[EE_OFF_ON, 0x0000a032, 0], [EE_ON, 0x00002032, 0], [EE_ON, 0x00002032, EXCEPTION_EXTERNAL_INT]]) {
    for (let downcount = 1; downcount <= 2 * words.length + 2; downcount += 1) {
      for (const mask of [PRODUCTION_DISABLE_MASK, ON]) {
        const { result } = runBoth(words, stateWith(0x188, { msr, exceptions }), mask, { downcount });
        assert.ok(result.equal, `downcount ${downcount} mask ${mask.toString(16)}: ${JSON.stringify(result.difference)}`);
      }
    }
  }
});

test("random MSR, downcount and pending exceptions, with and without the mode: the interpreter's state, RAM and cycles", { skip }, () => {
  const rng = makeRng(0x183183);
  const programs = [EE_OFF_ON, EE_ON, ...NOT_EE_ALONE.map(([, words]) => words)];
  let ran = 0;
  for (let i = 0; i < 96; i += 1) {
    const exceptions = rng.pick([0, 0, EXCEPTION_DECREMENTER, EXCEPTION_EXTERNAL_INT, EXCEPTION_DECREMENTER | EXCEPTION_EXTERNAL_INT]);
    // EE on or off, SE, FE0/FE1, around FP, IR, DR, RI.
    const msr = (0x00002032 | (rng.chance(0.5) ? 0x8000 : 0) | (rng.chance(0.1) ? 0x400 : 0) | (rng.chance(0.1) ? 0x900 : 0)) >>> 0;
    const downcount = rng.chance(0.5) ? 1 + rng.below(24) : 400000;
    const words = rng.pick(programs);
    for (const mask of [PRODUCTION_DISABLE_MASK, ON]) {
      const { result } = runBoth(words, stateWith(0x1830000 + i, { msr, exceptions }), mask, { downcount });
      assert.ok(result.equal, `${i} msr ${msr.toString(16)} dc ${downcount} exc ${exceptions} mask ${mask.toString(16)} ${JSON.stringify(result.difference)}`);
      ran += 1;
    }
  }
  assert.equal(ran, 192);
});

test("?regionmtmsr=1 sets the enable bit 27 of the codegen mask; off by default", async () => {
  const host = readFileSync(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(host, /regionmtmsr: {5}1 << 27,/);
  assert.match(host, /if \(params\.get\("regionmtmsr"\) === "1"\) \{\n\s*mask \|= CACHED_INTERPRETER_DISABLE_BITS\.regionmtmsr;/);
  const patch = readFileSync(new URL("../patches/dolphin-wasm/snapshot/0183-region-mtmsr-ee.patch", import.meta.url), "utf8");
  assert.match(patch, /\+constexpr u32 DOLPHIN_WEB_ENABLE_REGION_MTMSR_EE = 1u << 27;/);
  // A raw ?disable= mask never turns the enable bit on.
  assert.match(host, /mask &= ~CACHED_INTERPRETER_DISABLE_BITS\.regionmtmsr;/);
});
