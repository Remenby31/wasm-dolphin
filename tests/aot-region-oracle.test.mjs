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

import { loadAotCore, runOracleProgramsAsRegions } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK, SHORT_PREFIX_MASK } from "./helpers/jit-oracle.mjs";

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
