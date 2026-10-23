// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Patch 0129: the FMA emitter uses f64x2.relaxed_madd where the page's probe
// found it fused, the plain-f64 path elsewhere. Both modes must compute what
// the interpreter computes (std::fma, NI_madd_msub's single tie fix), blocks
// and regions alike. The fused mode is forced only where this machine fuses
// (V8 on ARM64, x64 with FMA3): elsewhere the core never selects it.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { probeRelaxedMadd } from "../src/relaxed-madd-probe.js";
import { compareRegionProgram, loadAotCore } from "./helpers/aot-core-equivalence.mjs";
import { SHORT_PREFIX_MASK, describeDifference, hex, loadOracleCore, makeRng, randomProgram, randomState } from "./helpers/jit-oracle.mjs";

test("the probe tells fused, unfused, unsupported and inconsistent engines apart", () => {
  const engine = (f, compiles = true) => ({
    Module: class { constructor() { if (!compiles) throw new Error("relaxed SIMD"); } },
    Instance: class { constructor() { this.exports = { f }; } }
  });
  const fused = (a, c, b) => (a === 1 + 2 ** -30 ? -(2 ** -60) : 5.551115123125783e-17);
  assert.equal(probeRelaxedMadd(engine(fused)), "fused");
  assert.equal(probeRelaxedMadd(engine((a, c, b) => a * c + b)), "unfused");
  assert.equal(probeRelaxedMadd(engine(fused, false)), "unsupported");
  assert.equal(probeRelaxedMadd(engine(() => NaN)), "inconsistent");
  assert.ok(["fused", "unfused", "unsupported"].includes(probeRelaxedMadd()), "this engine");
});

const coreWasm = new URL("../cores/dolphin/dolphin-core-upstream.wasm", import.meta.url);
const core = existsSync(coreWasm) ? await loadOracleCore() : null;
// Skipped only for a core built from another patch series without 0129 (main's
// committed core, restored on a branch): a core built from this tree's series
// (CI builds this branch's) without the export fails.
const lock = JSON.parse(readFileSync(new URL("../provenance/dolphin-source.lock.json", import.meta.url), "utf8"));
const builtUrl = new URL("../cores/dolphin/dolphin-core-upstream.build.json", import.meta.url);
const built = existsSync(builtUrl) ? JSON.parse(readFileSync(builtUrl, "utf8")) : null;
const coreFromThisSeries = built?.source?.patchSeriesSha256 === lock.patchSeriesSha256 &&
  lock.patches.some((p) => p.path.includes("/0129-"));
const skip = !core ? "no core" :
  !coreFromThisSeries && !core.has("DolphinWeb_SetFusedMadd") ? "core built from a patch series without 0129" : false;
const machine = probeRelaxedMadd();
const MODES = [["plain f64", false], ["fused relaxed_madd", true]];
// The fused mode only where this engine fuses (the core never selects it elsewhere).
const modeSkip = (base, fused) => base || (fused && machine !== "fused" && `this engine's relaxed_madd is ${machine}`);

const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
const BLR = 0x4e800020;
const d = (x) => Array.from(new Uint32Array(new Float64Array([x]).buffer));
const f = (hi, lo) => new Float64Array(new Uint32Array([lo, hi]).buffer)[0];
const singleBits = (bits) => new Float32Array(new Uint32Array([bits]).buffer)[0];
// fmadd family (op 63, 59) and paired forms, ps_madds0/1 included (op 4 xo 14, 15).
const FORMS = [[63, [28, 29, 30, 31]], [59, [28, 29, 30, 31]], [4, [14, 15, 28, 29, 30, 31]]];
const FMA_NAMES = ["fmadd", "fmsub", "fnmadd", "fnmsub", "fmadds", "fmsubs", "fnmadds", "fnmsubs",
  "ps_madd", "ps_msub", "ps_nmadd", "ps_nmsub", "ps_madds0", "ps_madds1"];

function assertSame(result, label) {
  assert.ok(result.code === 0 || result.code === 2, `${label}: ${result.code === 1
    ? describeDifference(result.interp, result.jit).slice(0, 8).join("; ")
    : result.message || `oracle code ${result.code}`}`);
}

// a, c, b: the Strikers tie, the double-rounding traps (a = 1/c), underflowed
// products, denormal frC, and huge and tiny magnitudes around the old guards.
function edgeCases(r) {
  const cases = [
    [singleBits(0x42480000), singleBits(0x1b1c72a0), singleBits(0xbc88cc38)],
    [f(0xc02f870e, 0x3619b278), f(0xbff03d60, 0xe0000000), f(0x438fbd2f, 0x3eb1057e)],
    [f(0x9a700000, 0), f(0x1a700000, 0), 0], [f(0x9a700000, 0), f(0x1a700000, 0), -0],
    [f(0x20b00000, 0), f(0x1c000000, 0), f(0x00100000, 1)], [f(0xa0b00000, 0), f(0x1c000000, 0), f(0x00100000, 1)],
    [f(0x79f3a39d, 0x2621e9b6), f(0, 1), 0], [f(0x79f3a39d, 0x2621e9b6), f(0x80000, 0), 0],
    [2 ** 1000, 2 ** 20, -(2 ** 1020)], [2 ** 1023, 2, -(2 ** 1023)], [2 ** -1000, 2 ** -60, 2 ** -1074],
    [2 ** 996, 1.5, 1], [3, 2 ** -900, -(2 ** -899)]
  ];
  while (cases.length < 240) {
    const c = Math.fround(1 + r.next() / 2 ** 32);
    const m = r.below(61) - 30;
    const a = (1 / c) * 2 ** m;
    if (a * c !== 2 ** m) continue;
    cases.push([a, c, (r.chance(0.5) ? 1 : -1) * (1 + r.next() / 2 ** 32 + (r.next() >>> 12) / 2 ** 52) * 2 ** (m + 53)]);
  }
  return cases;
}

for (const [label, fused] of MODES) {
  test(`${label}: FMA edge cases (ties, double-rounding traps, underflow, denormal frC) match the interpreter`, { skip: modeSkip(skip, fused) }, () => {
    const previous = core.setFusedMadd(fused);
    try {
      const r = makeRng(0xf5ed);
      const state = randomState(r);
      state[36] = 0;
      state[37] = 0x00002032;
      const setF = (i, x) => { const [lo, hi] = d(x); state.set([lo, hi, lo, hi], 48 + i * 4); };
      let compiled = 0;
      for (const [k, [a, c, b]] of edgeCases(r).entries()) {
        setF(2, a);
        setF(3, c);
        setF(4, b);
        for (const [op, xos] of FORMS) {
          for (const xo of xos) {
            const result = core.run(Uint32Array.from([A(op, 1, 2, 4, 3, xo), BLR]), state, SHORT_PREFIX_MASK);
            assertSame(result, `op ${op} xo ${xo} case ${k}`);
            compiled += result.compiledBlocks;
          }
        }
      }
      assert.ok(compiled >= 240 * 14, `${compiled} blocks compiled`);
    } finally {
      core.setFusedMadd(previous);
    }
  });

  test(`${label}: random FMA blocks from random states match the interpreter`, { skip: modeSkip(skip, fused) }, () => {
    const previous = core.setFusedMadd(fused);
    try {
      const r = makeRng(fused ? 0xfa5 : 0xe1a);
      for (let k = 0; k < 600; k++) {
        const program = Uint32Array.from([...randomProgram(r, 8, { names: [...FMA_NAMES, "fadd", "fmuls", "frsp"] }), BLR]);
        assertSame(core.run(program, randomState(r)), `program ${k} ${Array.from(program, hex).join(" ")}`);
      }
    } finally {
      core.setFusedMadd(previous);
    }
  });
}

const aot = skip ? null : await loadAotCore();
const regionSkip = skip || (!aot?.has("DolphinWeb_AotTestLoadState") && "core without the region test exports");
const MADD = [0xfd, 0x87, 0x02];
const hasMadd = (code) => code.some((_, i) => MADD.every((b, j) => code[i + j] === b));

for (const [label, fused] of MODES) {
  test(`${label}: FMA regions match the interpreter, relaxed_madd emitted only in its mode`, { skip: modeSkip(regionSkip, fused) }, () => {
    const previous = aot.module._DolphinWeb_SetFusedMadd(fused ? 1 : 0);
    try {
      const keyParts = () => {
        const p = aot.module._malloc(8);
        try { aot.module._DolphinWeb_AotKeyParts(p); return Array.from(new Uint32Array(aot.module.HEAPU8.buffer, p, 2)); } finally { aot.module._free(p); }
      };
      assert.ok(keyParts()[0] >= 21, "compiler version: 0129 (21) or a later one");
      assert.equal((keyParts()[1] >>> 30) & 1, fused ? 1 : 0, "key parts bit 30");
      assert.equal(aot.module._DolphinWeb_FusedMadd(), fused ? 1 : 0, "the core reads its mode back");
      const r = makeRng(fused ? 0x4ead : 0x4eac);
      let ran = 0, withMadd = 0;
      for (let k = 0; k < 120; k++) {
        const state = randomState(r);
        state[33] = 0; // XER: SO refuses the entry (0111)
        state[36] = 0;
        state[37] = 0x00002032;
        const words = [...Array.from({ length: 6 }, () => r.pick(FORMS.flatMap(([op, xos]) => xos.map((xo) => [op, xo])))).map(([op, xo]) =>
          A(op, 1 + r.below(8), 1 + r.below(8), 1 + r.below(8), 1 + r.below(8), xo)), BLR];
        const res = compareRegionProgram(aot, words, state);
        if (!res.translated) continue;
        assert.ok(!res.trap && !res.error, `program ${k}: ${res.error ?? "trap"}`);
        assert.ok(res.equal, `program ${k}: ${JSON.stringify(res.difference)}`);
        ran += res.got.regionRuns >= 1 ? 1 : 0;
        withMadd += hasMadd(res.fragment.code) ? 1 : 0;
      }
      assert.ok(ran >= 60, `${ran} regions ran`);
      if (fused) assert.ok(withMadd >= 60, `relaxed_madd in ${withMadd} fragments`);
      else assert.equal(withMadd, 0, "no relaxed_madd in plain-f64 fragments");
    } finally {
      aot.module._DolphinWeb_SetFusedMadd(previous);
    }
  });
}

test("the two modes never share a region: layout hashes differ", { skip: regionSkip }, () => {
  const m = aot.module;
  const previous = m._DolphinWeb_SetFusedMadd(0);
  try {
    const plain = m._DolphinWeb_AotLayoutHash() >>> 0;
    m._DolphinWeb_SetFusedMadd(1);
    assert.notEqual(m._DolphinWeb_AotLayoutHash() >>> 0, plain);
  } finally {
    m._DolphinWeb_SetFusedMadd(previous);
  }
});
