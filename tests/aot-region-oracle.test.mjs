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
import { HELPER_SIGNATURES, compareCall, loadAotCore } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK, SHORT_PREFIX_MASK, makeRng, randomProgram, randomState } from "./helpers/jit-oracle.mjs";

const core = await loadAotCore();
const skip = !core?.has("DolphinWeb_AotTestLoadState") && "core without the region test exports (patch 0075)";
const CODE = 0x80003000;

function bigEndian(words) {
  const out = new Uint8Array(4 * words.length);
  const v = new DataView(out.buffer);
  words.forEach((w, i) => v.setUint32(4 * i, w >>> 0, false));
  return out;
}

function runPrograms({ seed, count, length, mask }) {
  const r = makeRng(seed);
  const tally = { programs: 0, translated: 0, compared: 0, equal: 0, trap: 0, ends: {}, regionRuns: 0, mismatches: [] };
  for (let n = 0; n < count; n++) {
    const words = randomProgram(r, length);
    const state = randomState(r);
    const smallBudget = 1 + r.below(60);
    tally.programs += 1;
    core.load(CODE, bigEndian(words));
    const fragment = core.translate(CODE, { mask, ranges: [[CODE, CODE + 4 * words.length]] });
    if (!fragment) continue;
    tally.translated += 1;
    const { bytes } = assembleRegion([fragment], { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
    const handle = core.compile(bytes);
    assert.ok(handle > 0, "the core links the region");
    const regionAt = new Map(fragment.entries.map((pc) => [pc >>> 0, handle]));
    const baseline = core.ram().slice();
    for (const budget of [400000, smallBudget]) {
      const result = compareCall(core, regionAt, () => {
        core.ram().set(baseline);
        core.loadState(state, CODE);
        core.setDowncount(budget);
      });
      if (result.trap) { tally.trap += 1; continue; }
      tally.compared += 1;
      if (result.error) { tally.mismatches.push({ n, budget, error: result.error }); continue; }
      tally.ends[result.got.end] = (tally.ends[result.got.end] ?? 0) + 1;
      tally.regionRuns += result.got.regionRuns;
      if (result.equal) tally.equal += 1;
      else tally.mismatches.push({ n, budget, program: Array.from(words, (w) => w.toString(16)), ...result.difference });
    }
  }
  return tally;
}

for (const [name, mask] of [["production mask", PRODUCTION_DISABLE_MASK], ["short prefixes", SHORT_PREFIX_MASK]]) {
  test(`oracle programs as regions, ${name}: interpreter and regions agree, mid-region exits included`, { skip, timeout: 600000 }, (t) => {
    const tally = runPrograms({ seed: 0x4e9 ^ mask, count: 400, length: 24, mask });
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
