// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Patch 0163: an instruction that raises the alignment exception (lmw/stmw and
// the FP loads and stores at an address that is not a multiple of 4) leaves
// it pending, and the next instructions run: Dolphin's interpreter takes an
// exception right after an instruction only for DSI (Interpreter.cpp,
// SingleStepInner), the alignment one at its next CheckExceptions, as Jit64
// does. The tiers do the same (their helpers' checks stop on DSI and PROGRAM
// only), the pending bit included (oracle word 46). But the FP update forms
// wrote rA anyway, where the interpreter returns before the update: 0163
// writes it only at an aligned address. Each case: an integer op before (a
// dirty register), the faulting op, integer ops after, in a block and in a
// region; every FP load/store form, update and indexed ones included.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { compareRegionProgram, loadAotCore } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK, describeDifference, hex, loadOracleCore, makeRng, randomState } from "./helpers/jit-oracle.mjs";

const lock = JSON.parse(readFileSync(new URL("../provenance/dolphin-source.lock.json", import.meta.url), "utf8"));
const builtUrl = new URL("../cores/dolphin/dolphin-core-upstream.build.json", import.meta.url);
const built = existsSync(builtUrl) ? JSON.parse(readFileSync(builtUrl, "utf8")) : null;
const coreHas0163 = built?.source?.patchSeriesSha256 === lock.patchSeriesSha256 &&
  lock.patches.some((p) => p.path.includes("/0163-"));
const core = coreHas0163 ? await loadOracleCore() : null;
const skip = !coreHas0163 ? "core built from a patch series without 0163 (CI builds this branch's core)" : !core ? "no core" : false;

const u = (v) => v >>> 0;
const D = (op, rt, ra, d) => u((op << 26) | (rt << 21) | (ra << 16) | (d & 0xffff));
const X = (rt, ra, rb, xo) => u((31 << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (xo << 1));
const ADDI = (rt, ra, v) => D(14, rt, ra, v);
const BLR = 0x4e800020;
// r1: the 8-aligned scratch base; r6 = 2 for the indexed forms.
const FAULTING = [
  ["lfs", D(48, 1, 1, 2)], ["lfsu", D(49, 1, 1, 2)], ["lfd", D(50, 1, 1, 6)], ["lfdu", D(51, 1, 1, 2)],
  ["stfs", D(52, 2, 1, 2)], ["stfsu", D(53, 2, 1, 2)], ["stfd", D(54, 2, 1, 6)], ["stfdu", D(55, 2, 1, 2)],
  ["lfsx", X(1, 1, 6, 535)], ["lfsux", X(1, 1, 6, 567)], ["lfdx", X(1, 1, 6, 599)], ["lfdux", X(1, 1, 6, 631)],
  ["stfsx", X(2, 1, 6, 663)], ["stfsux", X(2, 1, 6, 695)], ["stfdx", X(2, 1, 6, 727)], ["stfdux", X(2, 1, 6, 759)],
  ["stfiwx", X(2, 1, 6, 983)], ["lmw", D(46, 28, 1, 2)], ["stmw", D(47, 28, 1, 2)]
];
const program = (w) => [ADDI(5, 5, 1), w, ADDI(31, 31, 1), ADDI(31, 31, 1), ADDI(30, 30, 1), BLR];
const stateFor = (k) => {
  const s = randomState(makeRng(0x162 + k));
  s[6] = 2;
  s[33] = 0; // XER: SO refuses a region entry (0111)
  s[36] = 0;
  s[37] = 0x00002032; // MSR: FP, IR, DR, RI
  return s;
};

test("blocks: an alignment exception stays pending and the block runs on, like the interpreter", { skip }, () => {
  for (const [k, [name, w]] of FAULTING.entries()) {
    const words = Uint32Array.from(program(w));
    const r = core.run(words, stateFor(k), PRODUCTION_DISABLE_MASK);
    assert.ok((r.interp[46] & 0x20) !== 0 && r.interp[47] >>> 0 !== 0x600, `${name}: the interpreter leaves the alignment exception pending`);
    assert.ok(r.code === 0, `${name} ${Array.from(words, hex).join(" ")}: ${r.code === 1 ? describeDifference(r.interp, r.jit).slice(0, 6).join("; ") : r.message || r.code}`);
    assert.ok(r.compiledOps >= 4, `${name}: compiled (${r.compiledOps} ops)`);
  }
});

const aot = skip ? null : await loadAotCore();
const regionSkip = skip || (!aot?.has("DolphinWeb_AotTestLoadState") && "core without the region test exports");
test("regions: an alignment exception stays pending and the region runs on, like the interpreter", { skip: regionSkip }, () => {
  let ran = 0;
  for (const [k, [name, w]] of FAULTING.entries()) {
    const res = compareRegionProgram(aot, program(w), stateFor(k), { mask: PRODUCTION_DISABLE_MASK });
    if (!res.translated) continue;
    assert.ok(!res.trap && !res.error, `${name}: ${res.error ?? "trap"}`);
    assert.ok(res.equal, `${name}: ${JSON.stringify(res.difference)}`);
    ran++;
  }
  assert.ok(ran >= 15, `${ran} region programs ran`);
});
