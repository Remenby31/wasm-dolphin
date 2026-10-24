// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Patch 0141: ps_madd/msub/nmadd/nmsub/madds0/madds1 run both lanes in one
// f64x2 relaxed_madd where 0129's mode is on (the probe found it fused), with
// the scalar path's guards as lane masks; any lane outside them sends the op
// to the interpreter. Lanes are set one by one here: one lane on the fast
// path and the other a NaN, an infinity, a denormal, an underflowed product,
// a single tie or an overflowing result must still give the interpreter's
// registers and FPSCR, in both modes, blocks and regions alike.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { probeRelaxedMadd } from "../src/relaxed-madd-probe.js";
import { compareRegionProgram, loadAotCore } from "./helpers/aot-core-equivalence.mjs";
import { SHORT_PREFIX_MASK, describeDifference, hex, loadOracleCore, makeRng, randomProgram, randomState } from "./helpers/jit-oracle.mjs";

const coreWasm = new URL("../cores/dolphin/dolphin-core-upstream.wasm", import.meta.url);
const core = existsSync(coreWasm) ? await loadOracleCore() : null;
// Skipped only for a core built from another patch series without 0141 (main's
// committed core, restored on a branch). CI builds this branch's core.
const lock = JSON.parse(readFileSync(new URL("../provenance/dolphin-source.lock.json", import.meta.url), "utf8"));
const builtUrl = new URL("../cores/dolphin/dolphin-core-upstream.build.json", import.meta.url);
const built = existsSync(builtUrl) ? JSON.parse(readFileSync(builtUrl, "utf8")) : null;
const coreHas0141 = built?.source?.patchSeriesSha256 === lock.patchSeriesSha256 &&
  lock.patches.some((p) => p.path.includes("/0141-"));
const skip = !core ? "no core" : !coreHas0141 ? "core built from a patch series without 0141 (CI builds this branch's core)" : false;
const machine = probeRelaxedMadd();
const MODES = [["plain f64", false], ["fused relaxed_madd", true]];
const modeSkip = (base, fused) => base || (fused && machine !== "fused" && `this engine's relaxed_madd is ${machine}`);

const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
const BLR = 0x4e800020;
const words64 = (x) => Array.from(new Uint32Array(new Float64Array([x]).buffer));
const f = (hi, lo = 0) => new Float64Array(new Uint32Array([lo, hi]).buffer)[0];
const single = (bits) => new Float32Array(new Uint32Array([bits]).buffer)[0];
const PS_XOS = [14, 15, 28, 29, 30, 31];
const PS_FMA_NAMES = ["ps_madd", "ps_msub", "ps_nmadd", "ps_nmsub", "ps_madds0", "ps_madds1"];

function assertSame(result, label) {
  assert.ok(result.code === 0 || result.code === 2, `${label}: ${result.code === 1
    ? describeDifference(result.interp, result.jit).slice(0, 8).join("; ")
    : result.message || `oracle code ${result.code}`}`);
}

// Per-lane (a, c, b): fast-path values and every reason the scalar path
// leaves for the interpreter.
const FAST = [[1.5, 2.25, -0.75], [single(0x3f8ccccd), single(0x40490fdb), single(0xbf000001)], [0, 3, -0], [-2, -0, 5], [1e30, 1e-20, 7]];
const SLOW = [
  [NaN, 1, 1], [1, NaN, 1], [1, 1, NaN], [Infinity, 1, 1], [1, 1, -Infinity],
  [f(0x00000000, 1), 1, 1], [1, f(0x00080000), 1], // denormal a, denormal frC
  [f(0x9a700000), f(0x1a700000), 0], // underflowed product (0129's CI case)
  [single(0x42480000), single(0x1b1c72a0), single(0xbc88cc38)], // a single tie
  [2 ** 100, 2 ** 100, 1], [2 ** 1000, 2 ** 20, -(2 ** 1020)], [2 ** -100, 2 ** -100, 0] // overflow, huge, NI flush
];

for (const [label, fused] of MODES) {
  test(`${label}: paired FMA with each lane fast or not matches the interpreter (madds0/1 included)`, { skip: modeSkip(skip, fused) }, () => {
    const previous = core.setFusedMadd(fused);
    try {
      const state = randomState(makeRng(0x141));
      state[36] = 0;
      state[37] = 0x00002032;
      const setPair = (i, x0, x1) => state.set([...words64(x0), ...words64(x1)], 48 + i * 4);
      const cases = [...FAST.flatMap((p) => FAST.map((q) => [p, q])), ...FAST.flatMap((p) => SLOW.flatMap((q) => [[p, q], [q, p]])),
        ...SLOW.map((q) => [q, q])];
      let compiled = 0;
      for (const [k, [l0, l1]] of cases.entries()) {
        setPair(2, l0[0], l1[0]);
        setPair(3, l0[1], l1[1]);
        setPair(4, l0[2], l1[2]);
        for (const xo of PS_XOS) {
          const result = core.run(Uint32Array.from([A(4, 1, 2, 4, 3, xo), BLR]), state, SHORT_PREFIX_MASK);
          assertSame(result, `xo ${xo} case ${k} lanes ${JSON.stringify([l0, l1])}`);
          compiled += result.compiledBlocks;
        }
      }
      assert.ok(compiled >= cases.length * PS_XOS.length, `${compiled} blocks compiled`);
    } finally {
      core.setFusedMadd(previous);
    }
  });

  test(`${label}: random paired-single programs from random states match the interpreter`, { skip: modeSkip(skip, fused) }, () => {
    const previous = core.setFusedMadd(fused);
    try {
      const r = makeRng(fused ? 0x14f : 0x14e);
      for (let k = 0; k < 1500; k++) {
        const program = Uint32Array.from([...randomProgram(r, 10, { names: [...PS_FMA_NAMES, "ps_add", "ps_mul", "ps_merge01", "ps_neg"] }), BLR]);
        assertSame(core.run(program, randomState(r)), `program ${k} ${Array.from(program, hex).join(" ")}`);
      }
    } finally {
      core.setFusedMadd(previous);
    }
  });
}

const aot = skip ? null : await loadAotCore();
const regionSkip = skip || (!aot?.has("DolphinWeb_AotTestLoadState") && "core without the region test exports");
const has = (code, seq) => code.some((_, i) => seq.every((b, j) => code[i + j] === b));
const ALL_TRUE_I64X2 = [0xfd, 0xc3, 0x01];

for (const [label, fused] of MODES) {
  test(`${label}: paired FMA regions match the interpreter, the f64x2 path only in its mode`, { skip: modeSkip(regionSkip, fused) }, () => {
    const previous = aot.module._DolphinWeb_SetFusedMadd(fused ? 1 : 0);
    try {
      const p = aot.module._malloc(8);
      try {
        aot.module._DolphinWeb_AotKeyParts(p);
        assert.ok(new Uint32Array(aot.module.HEAPU8.buffer, p, 2)[0] >= 30, "compiler version: 0141 (30) or a later one");
      } finally {
        aot.module._free(p);
      }
      const r = makeRng(fused ? 0x41ad : 0x41ac);
      let ran = 0, vector = 0;
      for (let k = 0; k < 120; k++) {
        const state = randomState(r);
        state[33] = 0; // XER: SO refuses the entry (0111)
        state[36] = 0;
        state[37] = 0x00002032;
        // Mostly fast-path lanes, so the vector path runs, not only the helper.
        for (let i = 1; i <= 8; i++) {
          const pick = () => r.chance(0.85) ? r.pick(FAST)[r.below(3)] : r.pick(SLOW)[r.below(3)];
          state.set([...words64(pick()), ...words64(pick())], 48 + i * 4);
        }
        const words = [...Array.from({ length: 6 }, () => A(4, 1 + r.below(8), 1 + r.below(8), 1 + r.below(8), 1 + r.below(8), r.pick(PS_XOS))), BLR];
        const res = compareRegionProgram(aot, words, state);
        if (!res.translated) continue;
        assert.ok(!res.trap && !res.error, `program ${k}: ${res.error ?? "trap"}`);
        assert.ok(res.equal, `program ${k}: ${JSON.stringify(res.difference)}`);
        ran += res.got.regionRuns >= 1 ? 1 : 0;
        vector += has(res.fragment.code, ALL_TRUE_I64X2) ? 1 : 0;
      }
      assert.ok(ran >= 60, `${ran} regions ran`);
      if (fused) assert.ok(vector >= 60, `the f64x2 path in ${vector} fragments`);
      else assert.equal(vector, 0, "no f64x2 path in plain-f64 fragments");
    } finally {
      aot.module._DolphinWeb_SetFusedMadd(previous);
    }
  });
}
