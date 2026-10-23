// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Region entry guards (patch 0121): region code takes MSR.FP on, LE, FE0 and
// FE1 off and HID2.LSQE on for granted instead of testing them per op. The
// region is refused (the dispatcher runs blocks) when they do not hold, so a
// state that changes between two entries never runs code built for the
// other. Compared with the interpreter, full state.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assembleRegion } from "../src/aot-region-module.js";
import { HELPER_SIGNATURES, ORACLE_CODE, bigEndian, compareCall, loadAotCore } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK, makeRng, randomState } from "./helpers/jit-oracle.mjs";

const core = await loadAotCore();
const lock = JSON.parse(readFileSync(new URL("../provenance/dolphin-source.lock.json", import.meta.url), "utf8"));
const built = JSON.parse(readFileSync(new URL("../cores/dolphin/dolphin-core-upstream.build.json", import.meta.url), "utf8"));
const thisSeries = built.source?.patchSeriesSha256 === lock.patchSeriesSha256 && lock.patches.some((p) => p.path.includes("/0121-"));
const skip = !core?.has("DolphinWeb_AotTestLoadState") ? "core without the region test exports (patch 0075)"
  : !thisSeries && !core.has("DolphinWeb_SetFprfForTest") ? "core built from a patch series without 0121" : false;

const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
const lfs = (d, a, off) => ((48 << 26) | (d << 21) | (a << 16) | (off & 0xffff)) >>> 0;
const stfs = (s, a, off) => ((52 << 26) | (s << 21) | (a << 16) | (off & 0xffff)) >>> 0;
// fadd f1,f2,f3 ; lfs f4,0(r1) ; fadds f5,f4,f1 ; stfs f5,8(r1) ; blr
const PROGRAM = [A(63, 1, 2, 3, 0, 21), lfs(4, 1, 0), A(59, 5, 4, 1, 0, 21), stfs(5, 1, 8), 0x4e800020];
const MSR = 37;
const LE = 1, FE1 = 1 << 8, FE0 = 1 << 11;

function region() {
  // The test translator takes FP ops with MSR.FP on only (production's does
  // whatever the MSR): translate from an FP-on state.
  const state = randomState(makeRng(0x121));
  state[MSR] = 0x00002032;
  core.loadState(state, ORACLE_CODE);
  core.load(ORACLE_CODE, bigEndian(PROGRAM));
  const fragment = core.translate(ORACLE_CODE, { mask: PRODUCTION_DISABLE_MASK, ranges: [[ORACLE_CODE, ORACLE_CODE + 4 * PROGRAM.length]] });
  assert.ok(fragment, "the FP program is a fragment");
  const { bytes } = assembleRegion([fragment], { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
  const handle = core.compile(bytes);
  assert.ok(handle > 0);
  return new Map(fragment.entries.map((pc) => [pc >>> 0, handle]));
}

function run(regionAt, msr) {
  const state = randomState(makeRng(0x121));
  state[MSR] = msr;
  const baseline = core.ram().slice();
  return compareCall(core, regionAt, () => {
    core.ram().set(baseline);
    core.loadState(state, ORACLE_CODE);
    core.setDowncount(400000);
  });
}

test("guards hold: the region runs and matches the interpreter", { skip }, () => {
  const result = run(region(), 0x00002032);
  assert.ok(!result.error && !result.trap, JSON.stringify(result));
  assert.ok(result.got.regionRuns >= 1);
  assert.ok(result.equal, JSON.stringify(result.difference));
});

for (const [name, bits] of [["FE0", FE0], ["FE1", FE1], ["FE0 and FE1", FE0 | FE1], ["LE", LE]]) {
  test(`${name} set between two entries: the region is refused, the interpreter's state`, { skip }, () => {
    const regionAt = region();
    const before = run(regionAt, 0x00002032);
    assert.ok(before.got.regionRuns >= 1, "first entry: the region runs");
    const after = run(regionAt, (0x00002032 | bits) >>> 0);
    assert.ok(!after.error && !after.trap, JSON.stringify(after));
    assert.equal(after.got.regionRuns, 0, "second entry: refused");
    assert.ok(after.equal, JSON.stringify(after.difference));
  });
}
