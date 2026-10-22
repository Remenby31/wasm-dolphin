// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Memory-access counts (patch 0104, DolphinWeb_MemAccessStats): layout v1
// agreed with the harness, reset applied at a slice boundary, the kinds of
// memory instructions, and the regions' estimate (their cycles times their
// code's static rates). The Node core has no CachedInterpreter instance, so
// block ends are counted only in a browser run (race-perf --mem-stats).

import assert from "node:assert/strict";
import test from "node:test";

import { imageFromDol } from "../src/aot-image.js";
import { planDol } from "../src/aot-plan.js";
import { assembleRegion } from "../src/aot-region-module.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";
import { HELPER_SIGNATURES, STOP, functionFragments, loadAotCore, regionGroups, seedGprs } from "./helpers/aot-core-equivalence.mjs";

const core = await loadAotCore();
const skip = !core?.has("DolphinWeb_MemAccessStats") && "core without memory-access counts (patch 0104)";
const m = core?.module;

const FIELDS = ["guestInstructions",
  "intLoad", "intStore", "fpLoad", "fpStore", "psqLoad", "psqStore",
  "slowIntLoad", "slowIntStore", "slowFpLoad", "slowFpStore", "slowPsqLoad", "slowPsqStore",
  "cyclesCovered", "cyclesTotal", "regionAccessesEstimated", "regionInstructionsEstimated", "staticSaturations"];

// reset >= 0 asks for a reset at the next slice boundary; the Node core has
// no CPU loop, so the test applies it (serviceRegions) and publishes.
function memStats(reset = -1, { boundary = false } = {}) {
  const p = m._DolphinWeb_MemAccessStats(reset) >>> 0;
  if (boundary) core.serviceRegions();
  m._DolphinWeb_AotPublishStatsForTest();
  const head = new Uint32Array(m.HEAPU8.buffer, p, 4);
  const f = new Float64Array(m.HEAPU8.buffer, p + 16, 22);
  return { version: head[0], sizeBytes: head[1], on: head[2], reserved: head[3], ...Object.fromEntries(FIELDS.map((n, i) => [n, f[i]])), spare: Array.from(f.subarray(18)) };
}

test("layout v1: 192 bytes, off until a reset reaches a slice boundary, then on and zero", { skip }, () => {
  const before = memStats();
  assert.deepEqual([before.version, before.sizeBytes, before.on, before.reserved], [1, 192, 0, 0]);
  assert.equal(memStats(0).on, 0, "the request waits for the slice boundary");
  const after = memStats(-1, { boundary: true });
  assert.equal(after.on, 1);
  for (const n of FIELDS) assert.equal(after[n], 0, n);
  assert.deepEqual(after.spare, [0, 0, 0, 0]);
});

const D = (op, rd = 3, ra = 1) => ((op << 26) | (rd << 21) | (ra << 16)) >>> 0;
const X = (sub, rc = 0) => ((31 << 26) | (3 << 21) | (1 << 16) | (2 << 11) | (sub << 1) | rc) >>> 0;
const PS = (sub6) => ((4 << 26) | (3 << 21) | (1 << 16) | (2 << 11) | (sub6 << 1)) >>> 0;
const KINDS = {
  "lwz": [D(32), 0], "lbzu": [D(35), 0], "lha": [D(42), 0], "lmw": [D(46, 28), 0], "lwzx": [X(23), 0], "lwbrx": [X(534), 0], "lwarx": [X(20), 0], "lswi": [X(597), 0],
  "stw": [D(36), 1], "sthu": [D(45), 1], "stmw": [D(47, 28), 1], "stbx": [X(215), 1], "stwcx.": [X(150, 1), 1], "stswx": [X(661), 1],
  "lfs": [D(48), 2], "lfdu": [D(51), 2], "lfsx": [X(535), 2], "lfdx": [X(599), 2],
  "stfs": [D(52), 3], "stfd": [D(54), 3], "stfsx": [X(663), 3], "stfiwx": [X(983), 3],
  "psq_l": [D(56), 4], "psq_lu": [D(57), 4], "psq_lx": [PS(6), 4],
  "psq_st": [D(60), 5], "psq_stu": [D(61), 5], "psq_stx": [PS(7), 5],
  "add": [X(266), -1], "addi": [D(14), -1], "dcbz": [X(1014), -1], "dcbz_l": [((4 << 26) | (1014 << 1)) >>> 0, -1], "dcbf": [X(86), -1], "eciwx": [X(310), -1]
};

test("the kinds memory instructions count under (cache operations and eciwx/ecowx are not counted)", { skip }, () => {
  for (const [name, [word, kind]] of Object.entries(KINDS)) {
    assert.equal(m._DolphinWeb_MemAccessKindForTest(word), kind, name);
  }
});

const TEXT = 0x80003100;
const stw = (s, a, off) => (36 << 26) | (s << 21) | (a << 16) | (off & 0xffff);
const lwz = (d, a, off) => (32 << 26) | (d << 21) | (a << 16) | (off & 0xffff);
const mtlr = (s) => (31 << 26) | (s << 21) | (8 << 16) | (467 << 1);
const PROGRAM = assemble(TEXT, [
  "main", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), asm.li(3, 7), (pc, l) => asm.bl(pc, l.count),
  lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  "count", asm.li(8, 0),
  "count_loop", asm.addi(8, 8, 3), stw(8, 1, 8), asm.cmplwi(8, 30), (pc, l) => asm.bgt(pc, l.count_done), (pc, l) => asm.b(pc, l.count_loop),
  "count_done", asm.blr()
]);

test("regions add their cycles times their code's static accesses and instructions per cycle", { skip }, () => {
  const dol = buildDol({ textAddr: TEXT, text: PROGRAM.words, entry: PROGRAM.labels.main });
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  for (const s of image.segments) core.load(s.start, s.bytes);
  core.invalidate(TEXT, 4 * PROGRAM.words.length);
  core.module._DolphinWeb_AotForgetRegionsForTest?.();
  core.setRegionsEnabled(true);
  const groups = regionGroups(plan, 100);
  assert.equal(groups.length, 1, "one region holds the program");
  const fragments = groups[0].flatMap(functionFragments(core));
  const { bytes, entries } = assembleRegion(fragments, { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
  core.queueRegion(bytes, entries.map(([pc]) => pc), groups[0].map((f) => ({ ranges: f.ranges, hash: f.hash })));
  core.serviceRegions();

  // The static rate of the region's code, by the core's own kinds.
  let words = 0, accesses = 0;
  for (const f of groups[0]) {
    for (const [start, end] of f.ranges) {
      for (let a = start; a < end; a += 4) {
        words += 1;
        if (m._DolphinWeb_MemAccessKindForTest(PROGRAM.words[(a - TEXT) / 4] >>> 0) >= 0) accesses += 1;
      }
    }
  }
  assert.ok(words > 0 && accesses > 0);

  memStats(0, { boundary: true });
  core.reset(seedGprs(PROGRAM.labels.main), PROGRAM.labels.main, STOP, 400000);
  let ran = 0;
  for (let n = 0; n < 1000 && core.pc() !== STOP; n++) {
    if (core.dispatchRegion()) ran += 1;
    else assert.equal(core.interpretOne(), 0);
  }
  assert.equal(core.pc(), STOP);
  assert.ok(ran >= 1);
  const s = memStats();
  assert.equal(s.on, 1);
  assert.ok(s.regionInstructionsEstimated > 0);
  assert.ok(Math.abs(s.regionAccessesEstimated / s.regionInstructionsEstimated - accesses / words) < 1e-9,
    `accesses per instruction ${s.regionAccessesEstimated / s.regionInstructionsEstimated} vs ${accesses}/${words}`);
  // No block path and no slice here: nothing counted, no slow access (the
  // stack is in MEM1).
  for (const n of ["guestInstructions", "intLoad", "intStore", "cyclesCovered", "cyclesTotal", "slowIntLoad", "slowIntStore", "staticSaturations"]) {
    assert.equal(s[n], 0, n);
  }

  // A read leaves the totals; a reset zeroes them at the next boundary.
  assert.equal(memStats(-1, { boundary: true }).regionInstructionsEstimated, s.regionInstructionsEstimated);
  const zero = memStats(0, { boundary: true });
  assert.equal(zero.on, 1);
  assert.equal(zero.regionAccessesEstimated, 0);
});
