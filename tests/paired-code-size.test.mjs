// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Patch 0146: the paired-single SIMD paths (0141, 0143) in fewer bytes, region
// code being what keeps a hot loop inside its module's budget. Bytes per op in
// a fragment: (8 x op + blr) - (blr), / 8. Measured on 0146's core: fused
// ps_madd 459 (690 before), ps_add 166 (237), ps_mul 235 (348), ps_muls0 257
// (370). The bounds leave a little room; a change that grows these paths past
// them is a size regression to look at.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { probeRelaxedMadd } from "../src/relaxed-madd-probe.js";
import { compareRegionProgram, loadAotCore } from "./helpers/aot-core-equivalence.mjs";
import { makeRng, randomState } from "./helpers/jit-oracle.mjs";

const lock = JSON.parse(readFileSync(new URL("../provenance/dolphin-source.lock.json", import.meta.url), "utf8"));
const builtUrl = new URL("../cores/dolphin/dolphin-core-upstream.build.json", import.meta.url);
const built = existsSync(builtUrl) ? JSON.parse(readFileSync(builtUrl, "utf8")) : null;
const coreHas0146 = built?.source?.patchSeriesSha256 === lock.patchSeriesSha256 &&
  lock.patches.some((p) => p.path.includes("/0146-"));
const core = coreHas0146 ? await loadAotCore() : null;
const skip = !coreHas0146 ? "core built from a patch series without 0146 (CI builds this branch's core)" :
  !core?.has("DolphinWeb_AotTestLoadState") ? "core without the region test exports" : false;

const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
const BLR = 0x4e800020;

function bytesPerOp(op, xo) {
  const size = (words) => {
    const s = randomState(makeRng(1));
    s[33] = 0;
    s[36] = 0;
    s[37] = 0x00002032;
    const r = compareRegionProgram(core, words, s);
    assert.ok(r.translated, "translated");
    return r.fragment.code.length;
  };
  const words = Array.from({ length: 8 }, (_, k) => A(op, 1 + k, 9 + k, 17 + k, 25 + (k % 6), xo));
  return (size([...words, BLR]) - size([BLR])) / 8;
}

test("paired add/sub/mul stay compact (bytes per op in a region)", { skip }, () => {
  for (const [name, op, xo, max] of [["ps_add", 4, 21, 180], ["ps_sub", 4, 20, 180], ["ps_mul", 4, 25, 250], ["ps_muls0", 4, 12, 275]]) {
    const n = bytesPerOp(op, xo);
    assert.ok(n <= max, `${name}: ${n} bytes per op, more than ${max}`);
  }
});

test("fused paired FMA stays compact (bytes per op in a region)", { skip: skip || (probeRelaxedMadd() !== "fused" && "this engine does not fuse relaxed_madd") }, () => {
  const previous = core.module._DolphinWeb_SetFusedMadd(1);
  try {
    for (const [name, xo, max] of [["ps_madd", 29, 640], ["ps_nmsub", 30, 645], ["ps_madds0", 14, 660]]) {
      const n = bytesPerOp(4, xo);
      assert.ok(n <= max, `${name}: ${n} bytes per op, more than ${max}`);
    }
  } finally {
    core.module._DolphinWeb_SetFusedMadd(previous);
  }
});
