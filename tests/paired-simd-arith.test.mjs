// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Patch 0143: ps_add, ps_sub, ps_mul, ps_muls0 and ps_muls1 compute both lanes
// in f64x2, with the scalar path's guards as lane masks; any lane outside them
// sends the op to the interpreter. DISABLE_NATIVE_PS (1 << 29) keeps the
// scalar lanes: both forms must give the interpreter's registers and FPSCR,
// FPRF on and off, blocks and regions alike. Each guard has lanes that only
// it sends to the interpreter: a result below 2^-126 (the NI flush and
// underflow), one past the FLT_MAX midpoint (overflow), a denormal frC (the
// interpreter's Force25Bit normalizes it), and an frC with bits below the 25
// kept (Force25Bit itself).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { compareRegionProgram, loadAotCore } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK, SHORT_PREFIX_MASK, describeDifference, hex, loadOracleCore, makeRng, randomProgram, randomState } from "./helpers/jit-oracle.mjs";

const coreWasm = new URL("../cores/dolphin/dolphin-core-upstream.wasm", import.meta.url);
const core = existsSync(coreWasm) ? await loadOracleCore() : null;
// Skipped only for a core built from another patch series without 0143 (main's
// committed core, restored on a branch). CI builds this branch's core.
const lock = JSON.parse(readFileSync(new URL("../provenance/dolphin-source.lock.json", import.meta.url), "utf8"));
const builtUrl = new URL("../cores/dolphin/dolphin-core-upstream.build.json", import.meta.url);
const built = existsSync(builtUrl) ? JSON.parse(readFileSync(builtUrl, "utf8")) : null;
const coreHas0143 = built?.source?.patchSeriesSha256 === lock.patchSeriesSha256 &&
  lock.patches.some((p) => p.path.includes("/0143-"));
const skip = !core ? "no core" : !coreHas0143 ? "core built from a patch series without 0143 (CI builds this branch's core)" : false;

const NATIVE_PS_OFF = 1 << 29;
const MODES = [["f64x2", 0], ["scalar lanes (DISABLE_NATIVE_PS)", NATIVE_PS_OFF]];
const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
const BLR = 0x4e800020;
const words64 = (x) => Array.from(new Uint32Array(new Float64Array([x]).buffer));
const f = (hi, lo = 0) => new Float64Array(new Uint32Array([lo, hi]).buffer)[0];
// ps_add, ps_sub (frA, frB) and ps_mul, ps_muls0, ps_muls1 (frA, frC).
const OPS = [["ps_add", 21, "b"], ["ps_sub", 20, "b"], ["ps_mul", 25, "c"], ["ps_muls0", 12, "c"], ["ps_muls1", 13, "c"]];
const word = ([, xo, form]) => form === "b" ? A(4, 1, 2, 4, 0, xo) : A(4, 1, 2, 0, 3, xo);

function assertSame(result, label) {
  assert.ok(result.code === 0 || result.code === 2, `${label}: ${result.code === 1
    ? describeDifference(result.interp, result.jit).slice(0, 8).join("; ")
    : result.message || `oracle code ${result.code}`}`);
}

// Per-lane (a, x), x being frB (add/sub) or frC (mul): fast lanes, and lanes
// each guard alone sends to the interpreter.
const FAST = [[1.5, 2.25], [-3, 0.125], [0, -0], [1e30, 1e-20], [Math.fround(0.1), Math.fround(3.7)]];
const SLOW = [
  [1e-20, 1e-20], [2 ** -130, 2 ** -131], // results below 2^-126: mul, and add/sub
  [3e38, 3e38], [2 ** 127, 4], // past the FLT_MAX midpoint: add, mul
  [1.5, f(0x00080000)], [1.5, f(0x00000000, 0x12345)], // denormal frC (mul) or tiny b (add)
  [3, 1 + 2 ** -30], [7, f(0x3ff00000, 0x0c000000)], // frC bits below the 25 kept: Force25Bit
  [NaN, 1], [1, Infinity], [Infinity, -Infinity]
];

for (const [label, mask] of MODES) {
  for (const fprf of [false, true]) {
    test(`${label}, FPRF ${fprf ? "on" : "off"}: paired add/sub/mul with each lane fast or not match the interpreter`, { skip }, () => {
      core.setFprf(fprf);
      try {
        const state = randomState(makeRng(0x143));
        state[36] = 0;
        state[37] = 0x00002032;
        const setPair = (i, x0, x1) => state.set([...words64(x0), ...words64(x1)], 48 + i * 4);
        const cases = [...FAST.flatMap((p) => FAST.map((q) => [p, q])), ...FAST.flatMap((p) => SLOW.flatMap((q) => [[p, q], [q, p]])),
          ...SLOW.map((q) => [q, q])];
        let compiled = 0;
        for (const [k, [l0, l1]] of cases.entries()) {
          setPair(2, l0[0], l1[0]);
          for (const r of [3, 4]) setPair(r, l0[1], l1[1]);
          for (const o of OPS) {
            const result = core.run(Uint32Array.from([word(o), BLR]), state, SHORT_PREFIX_MASK | mask);
            assertSame(result, `${o[0]} case ${k} lanes ${JSON.stringify([l0, l1])}`);
            compiled += result.compiledBlocks;
          }
        }
        assert.ok(compiled >= cases.length * OPS.length, `${compiled} blocks compiled`);
      } finally {
        core.setFprf(false);
      }
    });
  }

  test(`${label}: random paired-single programs from random states match the interpreter`, { skip }, () => {
    const r = makeRng(mask ? 0x143e : 0x143f);
    for (let k = 0; k < 1500; k++) {
      const program = Uint32Array.from([...randomProgram(r, 10, { names: ["ps_add", "ps_sub", "ps_mul", "ps_muls0", "ps_muls1", "ps_madd", "ps_merge10"] }), BLR]);
      assertSame(core.run(program, randomState(r), SHORT_PREFIX_MASK | mask), `program ${k} ${Array.from(program, hex).join(" ")}`);
    }
  });
}

const aot = skip ? null : await loadAotCore();
const regionSkip = skip || (!aot?.has("DolphinWeb_AotTestLoadState") && "core without the region test exports");
const has = (code, seq) => code.some((_, i) => seq.every((b, j) => code[i + j] === b));
const F64X2_ADD = [0xfd, 0xf0, 0x01], F64X2_MUL = [0xfd, 0xf2, 0x01];

for (const [label, mask] of MODES) {
  test(`${label}: paired add/sub/mul regions match the interpreter, the f64x2 path only without DISABLE_NATIVE_PS`, { skip: regionSkip }, () => {
    const p = aot.module._malloc(8);
    try {
      aot.module._DolphinWeb_AotKeyParts(p);
      assert.ok(new Uint32Array(aot.module.HEAPU8.buffer, p, 2)[0] >= 32, "compiler version: 0143 (32) or a later one");
    } finally {
      aot.module._free(p);
    }
    const r = makeRng(mask ? 0x43ac : 0x43ad);
    let ran = 0, vector = 0;
    for (let k = 0; k < 120; k++) {
      const state = randomState(r);
      state[33] = 0; // XER: SO refuses the entry (0111)
      state[36] = 0;
      state[37] = 0x00002032;
      for (let i = 1; i <= 8; i++) {
        const pick = () => r.chance(0.85) ? r.pick(FAST)[r.below(2)] : r.pick(SLOW)[r.below(2)];
        state.set([...words64(pick()), ...words64(pick())], 48 + i * 4);
      }
      const words = [...Array.from({ length: 6 }, () => {
        const o = r.pick(OPS);
        return o[2] === "b" ? A(4, 1 + r.below(8), 1 + r.below(8), 1 + r.below(8), 0, o[1]) : A(4, 1 + r.below(8), 1 + r.below(8), 0, 1 + r.below(8), o[1]);
      }), BLR];
      const res = compareRegionProgram(aot, words, state, { mask: PRODUCTION_DISABLE_MASK | mask });
      if (!res.translated) continue;
      assert.ok(!res.trap && !res.error, `program ${k}: ${res.error ?? "trap"}`);
      assert.ok(res.equal, `program ${k}: ${JSON.stringify(res.difference)}`);
      ran += res.got.regionRuns >= 1 ? 1 : 0;
      vector += has(res.fragment.code, F64X2_ADD) || has(res.fragment.code, F64X2_MUL) ? 1 : 0;
    }
    assert.ok(ran >= 60, `${ran} regions ran`);
    if (mask) assert.equal(vector, 0, "no f64x2 add/mul with DISABLE_NATIVE_PS");
    else assert.ok(vector >= 60, `the f64x2 path in ${vector} fragments`);
  });
}
