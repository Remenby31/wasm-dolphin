// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Patch 0184 (?regshape=x64, enable bit 28 of the codegen mask): a block keeps
// in WASM locals only the GPRs it uses at least twice, at most four, instead
// of every GPR it touches; the others are read and written in the guest
// state. The block JIT and the regions, against the interpreter, with and
// without the mode, on the oracle's random programs.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ORACLE_CODE, bigEndian, loadAotCore, runOracleProgramsAsRegions } from "./helpers/aot-core-equivalence.mjs";
import { staticConstants, staticNormalizedCode } from "./helpers/static-digest.mjs";
import { PRODUCTION_DISABLE_MASK, SHORT_PREFIX_MASK, describeDifference, hex, loadOracleCore, makeRng, randomProgram, randomState } from "./helpers/jit-oracle.mjs";

const REGSHAPE_X64 = 1 << 28;
const lock = JSON.parse(readFileSync(new URL("../provenance/dolphin-source.lock.json", import.meta.url), "utf8"));
const built = JSON.parse(readFileSync(new URL("../cores/dolphin/dolphin-core-upstream.build.json", import.meta.url), "utf8"));
const thisSeries = built.source?.patchSeriesSha256 === lock.patchSeriesSha256 && lock.patches.some((p) => p.path.includes("/0184-"));
const oracle = thisSeries ? await loadOracleCore() : null;
const aot = thisSeries ? await loadAotCore() : null;
const skip = !thisSeries ? "core built from a patch series without 0184" : false;

test("block JIT, random blocks with branches and CTR loops, x64 shape on and off: the interpreter's state", { skip }, () => {
  const r = makeRng(0x184);
  let compiled = 0;
  for (let i = 0; i < 300; i += 1) {
    const program = randomProgram(r, 24);
    const state = randomState(r);
    for (const mask of [PRODUCTION_DISABLE_MASK, PRODUCTION_DISABLE_MASK | REGSHAPE_X64, SHORT_PREFIX_MASK | REGSHAPE_X64]) {
      const result = oracle.run(program, state, mask);
      assert.ok(result.code === 0 || result.code === 2, `${i} mask ${hex(mask)}: ${result.code === 1
        ? describeDifference(result.interp, result.jit).slice(0, 8).join("; ") : result.message || `oracle code ${result.code}`}`);
      if (result.code === 0) compiled += 1;
    }
  }
  assert.ok(compiled > 300, `too few compiled blocks (${compiled})`);
});

test("regions, oracle programs with the x64 shape: interpreter and regions agree, mid-region exits included", { skip, timeout: 600000 }, (t) => {
  const tally = runOracleProgramsAsRegions(aot, { seed: 0x184184, count: 300, length: 24, mask: PRODUCTION_DISABLE_MASK | REGSHAPE_X64 });
  t.diagnostic(JSON.stringify({ ...tally, mismatches: tally.mismatches.slice(0, 4), mismatchCount: tally.mismatches.length }));
  assert.deepEqual(tally.mismatches.slice(0, 4), []);
  assert.ok(tally.translated >= 0.7 * tally.programs, `${tally.translated} of ${tally.programs} translated`);
  assert.ok((tally.ends.budget ?? 0) >= 30 && (tally.ends.exception ?? 0) >= 10, JSON.stringify(tally.ends));
});

// A fixed sample: 300 oracle programs (seed 0x1840ff) translated as regions,
// hashed (entries, code bytes, relocs). Measured on the core before 0184
// (spark:015bf17) and on 0184's (spark:564fed6), mode off: the same 282
// fragments, this digest. With bit 28 every one of them changes on 0184's
// core (none on the core before it): a bit that does not reach the
// prologue would leave this test red.
// The mask the digest was measured with: production before #322 turned
// 0183's bit 27 on (the sample's code with it on is another code).
const MASK_BEFORE_0183 = PRODUCTION_DISABLE_MASK & ~(1 << 27);
// Translated code embeds the absolute address of static globals of the core
// (i32.const the heap relocs do not cover: 1,339,340 and 1,339,596 on main
// de9e2d4a), so any patch that adds static data ahead of them shifted the
// digest with no codegen change (0203 and its follow-ups moved it 3 times in
// a week). The digest hashes each such constant as its distance to the
// lowest one of the sample: a uniform shift of the static data leaves it as
// it is. A static address: a constant between 64 KiB and the RAM base (the
// heap bases have their relocs) that an i32.add or a load or store uses next.
// Masks in that range (0x1c0000, 0x1ffe00...) go to an i32.and: kept as they
// are.
// Same digest on the core before 0203 (080da515) and on main de9e2d4a
// (raw digests c005124c and ce8ff6ca).
const MODE_OFF_DIGEST = "db66f5e64305dedd62bbb9d885fd2698a15162d4cb8c930f64b83c387774a071";
test("mode off translates byte for byte as before 0184; bit 28 changes the code", { skip }, () => {
  const r = makeRng(0x1840ff);
  const h = createHash("sha256");
  let differ = 0;
  const fragments = [];
  for (let i = 0; i < 300; i += 1) {
    const program = randomProgram(r, 24);
    const state = randomState(r);
    aot.loadState(state, ORACLE_CODE);
    aot.load(ORACLE_CODE, bigEndian(program));
    const ranges = [[ORACLE_CODE, ORACLE_CODE + 4 * program.length]];
    const off = aot.translate(ORACLE_CODE, { mask: MASK_BEFORE_0183, ranges });
    if (!off) continue;
    fragments.push(off);
    const on = aot.translate(ORACLE_CODE, { mask: MASK_BEFORE_0183 | REGSHAPE_X64, ranges });
    if (on && Buffer.compare(Buffer.from(off.code), Buffer.from(on.code)) !== 0) differ += 1;
  }
  assert.equal(fragments.length, 282);
  const ramBase = Math.min(...(fragments[0].heapBases ?? [0x1000000]));
  const range = { low: 0x10000, high: ramBase };
  const statics = fragments.flatMap((f) => staticConstants(f.code, range));
  assert.ok(statics.length > 0, "the sample holds static addresses (else the normalization proves nothing)");
  const base = Math.min(...statics);
  for (const f of fragments) {
    h.update(JSON.stringify(f.entries)); h.update(staticNormalizedCode(f.code, { ...range, base })); h.update(JSON.stringify(f.relocs));
  }
  assert.equal(h.digest("hex"), MODE_OFF_DIGEST, "mode off: the code before 0184");
  assert.ok(differ >= 250, `bit 28 changed ${differ} of ${fragments.length} fragments`);
});

test("?regshape=x64 sets the enable bit 28; a raw ?disable= never does", () => {
  const host = readFileSync(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(host, /regshape: {8}1 << 28,/);
  assert.match(host, /if \(params\.get\("regshape"\) === "x64"\) \{\n\s*mask \|= CACHED_INTERPRETER_DISABLE_BITS\.regshape;/);
  assert.match(host, /mask &= ~\(CACHED_INTERPRETER_DISABLE_BITS\.regionmtmsr \| CACHED_INTERPRETER_DISABLE_BITS\.regshape \|\n\s*CACHED_INTERPRETER_DISABLE_BITS\.regionchaincache \| CACHED_INTERPRETER_DISABLE_BITS\.regionfragments\);/);
  const patch = readFileSync(new URL("../patches/dolphin-wasm/snapshot/0184-regshape-x64.patch", import.meta.url), "utf8");
  assert.match(patch, /\+constexpr u32 DOLPHIN_WEB_ENABLE_REGSHAPE_X64 = 1u << 28;/);
  assert.match(patch, /\+constexpr u32 REGSHAPE_X64_GPR_CAP = 4;/);
});
