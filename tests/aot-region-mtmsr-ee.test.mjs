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
// The FP bit cleared instead: not EE alone, the region must leave.
const FP_OFF = [mfmsr(5), rlwinm(6, 5, 0, 19, 17), mtmsr(6), add(7, 3, 4), BLR];

const stateWith = (seed, { msr = 0x0000a032, exceptions = 0 } = {}) => {
  const s = randomState(makeRng(seed));
  s[MSR] = msr; // EE, FP, IR, DR, RI
  s[33] = 0; // XER clear: with SO set a fragment refuses to run (0111)
  s[36] = 0; // FPSCR: no enable, no sticky bit
  s[EXCEPTIONS] = exceptions;
  return s;
};

function runBoth(words, state, mask) {
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
    core.setDowncount(400000);
  });
  assert.ok(!result.error && !result.trap, JSON.stringify(result));
  return { fragment, result };
}

test("mode off: the fragment still stops at the mtmsr (the code is as before)", { skip }, () => {
  const { fragment, result } = runBoth(EE_OFF_ON, stateWith(0x183), PRODUCTION_DISABLE_MASK);
  assert.ok(!fragment.entries.includes(MTMSR_AT[0] + 4), "no block past the first mtmsr");
  assert.ok(result.equal, JSON.stringify(result.difference));
});

test("EE off then on, nothing pending: one region run through both mtmsr, the interpreter's state and cycles", { skip }, () => {
  const { fragment, result } = runBoth(EE_OFF_ON, stateWith(0x184), PRODUCTION_DISABLE_MASK | REGION_MTMSR_EE);
  for (const at of MTMSR_AT) assert.ok(fragment.entries.includes(at + 4), `a block past the mtmsr at ${at.toString(16)}`);
  assert.equal(result.got.regionRuns, 1, "never back to the dispatcher");
  assert.equal(result.got.end, "stop");
  assert.ok(result.equal, JSON.stringify(result.difference));
});

for (const [name, exceptions] of [["an external interrupt", EXCEPTION_EXTERNAL_INT], ["the decrementer", EXCEPTION_DECREMENTER]]) {
  test(`${name} pending while EE is off: taken at the mtmsr that turns EE back on, as the interpreter takes it`, { skip }, () => {
    // Pending from the start: masked by the first mtmsr (EE off), let in by
    // the second. The interpreter's order (CheckExceptions) decides which.
    const { result } = runBoth(EE_OFF_ON, stateWith(0x185 + exceptions, { exceptions }), PRODUCTION_DISABLE_MASK | REGION_MTMSR_EE);
    assert.ok(result.equal, JSON.stringify(result.difference));
    assert.notEqual(result.got.end, "stop", "the exception was taken, not run past");
  });
}

test("a mtmsr that changes FP (not EE alone): the region leaves after it, the interpreter's state", { skip }, () => {
  const { result } = runBoth(FP_OFF, stateWith(0x186), PRODUCTION_DISABLE_MASK | REGION_MTMSR_EE);
  assert.ok(result.equal, JSON.stringify(result.difference));
  assert.ok(result.got.regionRuns >= 1);
});

test("EE on from the start with an interrupt pending and the mode bit: the first mtmsr (EE off) keeps it pending", { skip }, () => {
  // EE is on at entry with an external interrupt pending: the region runs
  // (the dispatcher takes exceptions between slices, as without regions), the
  // first mtmsr turns EE off without taking it, the second takes it.
  const { result } = runBoth(EE_OFF_ON, stateWith(0x187, { exceptions: EXCEPTION_EXTERNAL_INT }), PRODUCTION_DISABLE_MASK | REGION_MTMSR_EE);
  assert.ok(result.equal, JSON.stringify(result.difference));
});

test("random states, EE program with and without the mode: same state, RAM and cycles as the interpreter", { skip }, () => {
  const rng = makeRng(0x183183);
  let ran = 0;
  for (let i = 0; i < 64; i += 1) {
    const exceptions = rng.below(4) === 0 ? rng.pick([EXCEPTION_DECREMENTER, EXCEPTION_EXTERNAL_INT, EXCEPTION_DECREMENTER | EXCEPTION_EXTERNAL_INT]) : 0;
    const msr = rng.chance(0.5) ? 0x0000a032 : 0x00002032;
    for (const mask of [PRODUCTION_DISABLE_MASK, PRODUCTION_DISABLE_MASK | REGION_MTMSR_EE]) {
      const { result } = runBoth(EE_OFF_ON, stateWith(0x1830000 + i, { msr, exceptions }), mask);
      assert.ok(result.equal, `${i} mask ${mask.toString(16)} ${JSON.stringify(result.difference)}`);
      ran += 1;
    }
  }
  assert.equal(ran, 128);
});

test("?regionmtmsr=1 sets the enable bit 27 of the codegen mask; off by default", async () => {
  const host = readFileSync(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(host, /regionmtmsr: {5}1 << 27,/);
  assert.match(host, /if \(params\.get\("regionmtmsr"\) === "1"\) \{\n\s*mask \|= CACHED_INTERPRETER_DISABLE_BITS\.regionmtmsr;/);
  const patch = readFileSync(new URL("../patches/dolphin-wasm/snapshot/0183-region-mtmsr-ee.patch", import.meta.url), "utf8");
  assert.match(patch, /\+constexpr u32 DOLPHIN_WEB_ENABLE_REGION_MTMSR_EE = 1u << 27;/);
});
