// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// dcbz on the direct tier (patch 0120): a region translates a block that
// starts with dcbz (memset-like loops cut regions there before) and runs it
// as the interpreter does: the cache line of the effective address (any
// offset in it) zeroed in MEM1 and its uncached mirror, nothing written
// where no memory is mapped, the low-range hack and the helper path alike.
// dcbz_l (4/1014) stays out of the tier.

import assert from "node:assert/strict";
import test from "node:test";

import { assembleRegion } from "../src/aot-region-module.js";
import { HELPER_SIGNATURES, ORACLE_CODE, bigEndian, compareCall, loadAotCore } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK, makeRng, randomState } from "./helpers/jit-oracle.mjs";

const core = await loadAotCore();
const regionSkip = !core?.has("DolphinWeb_AotTestLoadState") && "core without the region test exports (patch 0075)";

const dcbz = (ra, rb) => ((31 << 26) | (ra << 16) | (rb << 11) | (1014 << 1)) >>> 0;
const dcbzL = (ra, rb) => ((4 << 26) | (ra << 16) | (rb << 11) | (1014 << 1)) >>> 0;
const addi = (d, a, v) => ((14 << 26) | (d << 21) | (a << 16) | (v & 0xffff)) >>> 0;
const BLR = 0x4e800020;

// Two lines zeroed with a loop-like stride, then return.
const PROGRAM = [dcbz(3, 4), addi(3, 3, 64), dcbz(3, 4), BLR];

const CASES = [
  ["an aligned line in MEM1", 0x80104000, 0],
  ["an offset inside the line (the line is still zeroed)", 0x80104000, 37],
  ["the uncached mirror", 0xc0104000, 0],
  ["unmapped: nothing written, no exception without the MMU", 0x00100080, 0],
  ["the low range of Dolphin's dcbz hack", 0x80000100, 0]
];

function translate(words) {
  core.load(ORACLE_CODE, bigEndian(words));
  return core.translate(ORACLE_CODE, { mask: PRODUCTION_DISABLE_MASK, ranges: [[ORACLE_CODE, ORACLE_CODE + 4 * words.length]] });
}

// A core before 0120 translates no block starting with dcbz (CI builds this
// branch's core and runs the tests on it).
const skip = regionSkip || (!translate([dcbz(3, 4), BLR]) && "core before patch 0120 (dcbz on the direct tier)");

test("a block starting with dcbz is translated into a region; dcbz_l is not", { skip }, () => {
  assert.ok(translate(PROGRAM), "dcbz first: a fragment");
  assert.equal(translate([dcbzL(3, 4), BLR]), null, "dcbz_l first: no fragment");
});

for (const [name, base, offset] of CASES) {
  test(`dcbz in a region, ${name}: the interpreter's registers, RAM and cycles`, { skip }, () => {
    const fragment = translate(PROGRAM);
    assert.ok(fragment);
    const { bytes } = assembleRegion([fragment], { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
    const handle = core.compile(bytes);
    assert.ok(handle > 0, `core accepted the module (${handle})`);
    const regionAt = new Map(fragment.entries.map((pc) => [pc >>> 0, handle]));
    const fill = new Uint8Array(256).fill(0xab);
    const baseline = core.ram().slice();
    const state = randomState(makeRng(0x0dc + offset));
    state[3] = base;
    state[4] = offset;
    const result = compareCall(core, regionAt, () => {
      core.ram().set(baseline);
      if ((base >>> 28) === 0x8 || (base >>> 28) === 0xc) core.load((base & 0x01ffffff) | 0x80000000, fill);
      core.loadState(state, ORACLE_CODE);
      core.setDowncount(400000);
    });
    assert.ok(!result.trap && !result.error, JSON.stringify(result));
    assert.ok(result.got.regionRuns >= 1, "the region ran");
    assert.deepEqual(result.difference ?? null, null);
    assert.ok(result.equal);
  });
}
