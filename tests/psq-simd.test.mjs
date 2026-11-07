// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// psq SIMD: psq_l/psq_lu and psq_st/psq_stu with a float GQR move both lanes
// (W=0) at once: one 8-byte load, a byteswap shuffle and
// f64x2.promote_low_f32x4 (a NaN word takes the per-lane path, which keeps its
// payload and quiet bit), and EmitConvertToSingle on both lanes as i64x2 bit
// operations with one 8-byte store. DISABLE_NATIVE_PS (1 << 29) keeps the
// per-lane path: both must give the interpreter's registers and memory.
// A psq_st then psq_l of the same FPR runs both paths on chosen lanes:
// singles, doubles that flush (exponent <= 896), huge doubles, single
// denormals, infinities, quiet and signaling NaNs with payloads.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { compareRegionProgram, loadAotCore } from "./helpers/aot-core-equivalence.mjs";
import { PRODUCTION_DISABLE_MASK, SHORT_PREFIX_MASK, describeDifference, hex, loadOracleCore, makeRng, randomProgram, randomState } from "./helpers/jit-oracle.mjs";

const lock = JSON.parse(readFileSync(new URL("../provenance/dolphin-source.lock.json", import.meta.url), "utf8"));
const builtUrl = new URL("../cores/dolphin/dolphin-core-upstream.build.json", import.meta.url);
const built = existsSync(builtUrl) ? JSON.parse(readFileSync(builtUrl, "utf8")) : null;
const coreHasPsq = built?.source?.patchSeriesSha256 === lock.patchSeriesSha256 &&
  lock.patches.some((p) => /\/01\d\d-psq-simd/.test(p.path));
const core = coreHasPsq ? await loadOracleCore() : null;
const skip = !coreHasPsq ? "core built from a patch series without the psq SIMD patch (CI builds this branch's core)" : !core ? "no core" : false;

const NATIVE_PS_OFF = 1 << 29;
const MODES = [["pair (v128)", 0], ["per lane (DISABLE_NATIVE_PS)", NATIVE_PS_OFF]];
const PSQ = (op, t, a, w, i, d) => ((op << 26) | (t << 21) | (a << 16) | (w << 15) | (i << 12) | (d & 0xfff)) >>> 0;
const BLR = 0x4e800020;
const f = (hi, lo = 0) => new Float64Array(new Uint32Array([lo, hi]).buffer)[0];
const bits = (x) => Array.from(new Uint32Array(new Float64Array([x]).buffer));

function assertSame(result, label) {
  assert.ok(result.code === 0 || result.code === 2, `${label}: ${result.code === 1
    ? describeDifference(result.interp, result.jit).slice(0, 8).join("; ")
    : result.message || `oracle code ${result.code}`}`);
}

// FPR lane values, as double bit patterns [hi, lo].
const LANES = [
  [0x3ff80000, 0], [0xc0490fdb, 0x40000000], [0, 0], [0x80000000, 0], // singles, +-0
  [0x47efffff, 0xe0000000], [0x7e000000, 0], [0x7fe00000, 1], // FLT_MAX, huge doubles
  [0x38100000, 0], [0x37f00000, 0], [0x36a00000, 0], [0x00000000, 1], // 2^-126, single denormals, a double denormal
  [0x7ff00000, 0], [0xfff00000, 0], // infinities
  [0x7ff80000, 0x12345678], [0x7ff40000, 0x20000000], [0xfff00000, 0xe0000001] // quiet and signaling NaNs with payloads
];

for (const [label, mask] of MODES) {
  test(`${label}: psq_st then psq_l (float GQR, W=0 and W=1, update forms) match the interpreter on every kind of lane`, { skip }, () => {
    const state = randomState(makeRng(0x9f));
    state[36] = 0;
    state[37] = 0x00002032;
    state[38] = 0; // GQR0: float loads and stores
    const scratch = state[1];
    let n = 0;
    for (const [k0, l0] of LANES.entries()) {
      for (const [k1, l1] of LANES.entries()) {
        state.set([l0[1], l0[0], l1[1], l1[0]], 48 + 1 * 4);
        for (const w of [0, 1]) {
          for (const [st, ld, ra] of [[60, 56, 1], [61, 57, 30]]) {
            state[ra] = scratch;
            const program = Uint32Array.from([PSQ(st, 1, ra, w, 0, 16), PSQ(ld, 2, ra, w, 0, ra === 30 ? 0 : 16), BLR]);
            assertSame(core.run(program, state, SHORT_PREFIX_MASK | mask), `lanes ${k0},${k1} W=${w} ${hex(program[0])} ${hex(program[1])}`);
            n += 1;
          }
        }
      }
    }
    assert.equal(n, LANES.length * LANES.length * 4);
  });

  test(`${label}: random psq programs from random states match the interpreter`, { skip }, () => {
    const r = makeRng(mask ? 0x9e : 0x9d);
    for (let k = 0; k < 2000; k++) {
      const program = Uint32Array.from([...randomProgram(r, 10, { names: ["psq_l", "psq_lu", "psq_st", "psq_stu", "ps_add", "ps_merge01"] }), BLR]);
      assertSame(core.run(program, randomState(r), SHORT_PREFIX_MASK | mask), `program ${k} ${Array.from(program, hex).join(" ")}`);
    }
  });
}

const aot = skip ? null : await loadAotCore();
const regionSkip = skip || (!aot?.has("DolphinWeb_AotTestLoadState") && "core without the region test exports");
const has = (code, seq) => code.some((_, i) => seq.every((b, j) => code[i + j] === b));
const LOAD64_ZERO = [0xfd, 0x5d], STORE64_LANE = [0xfd, 0x5b];

for (const [label, mask] of MODES) {
  test(`${label}: psq regions match the interpreter, the pair path only without DISABLE_NATIVE_PS`, { skip: regionSkip }, () => {
    const r = makeRng(mask ? 0x9c : 0x9b);
    let ran = 0, pair = 0;
    for (let k = 0; k < 150; k++) {
      const state = randomState(r);
      state[33] = 0; // XER: SO refuses the entry (0111)
      state[37] = 0x00002032;
      state[38] = 0; // GQR0 float
      const lane = () => { const l = r.pick(LANES); return [l[1], l[0]]; };
      for (let i = 1; i <= 8; i++) state.set([...lane(), ...lane()], 48 + i * 4);
      const words = [];
      for (let j = 0; j < 4; j++) words.push(PSQ(60, 1 + r.below(8), 1, 0, 0, 8 * j), PSQ(56, 1 + r.below(8), 1, 0, 0, 8 * r.below(4)));
      words.push(BLR);
      const res = compareRegionProgram(aot, words, state, { mask: PRODUCTION_DISABLE_MASK | mask });
      if (!res.translated) continue;
      assert.ok(!res.trap && !res.error, `program ${k}: ${res.error ?? "trap"}`);
      assert.ok(res.equal, `program ${k}: ${JSON.stringify(res.difference)}`);
      ran += res.got.regionRuns >= 1 ? 1 : 0;
      pair += has(res.fragment.code, LOAD64_ZERO) && has(res.fragment.code, STORE64_LANE) ? 1 : 0;
    }
    assert.ok(ran >= 60, `${ran} regions ran`);
    if (mask) assert.equal(pair, 0, "no pair path with DISABLE_NATIVE_PS");
    else assert.ok(pair >= 60, `the pair path in ${pair} fragments`);
  });
}
