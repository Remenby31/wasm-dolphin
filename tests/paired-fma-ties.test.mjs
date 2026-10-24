// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Patch 0161: a paired FMA lane whose fma(a, Force25(c), b) is a single tie
// (29 low bits 0x10000000) gets NI_madd_msub's tie fix inline, on both lanes,
// instead of the interpreter: the fma's error (2Sum) moves r one double ulp
// toward the exact result, a zero error leaves the demotion's ties-to-even.
// Quantized vertex math ties on most lanes (a heavy scene sent 135k a second
// to the helper). Cases: a true tie (error 0), an exact result just below and
// just above a tie where ties-to-even would round the other way, both lanes
// and one lane, every paired FMA form, and the tie at the overflow bound
// (still the interpreter). Then a sweep of random ties. Bit-exact against the
// interpreter, with the helper's call count.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { probeRelaxedMadd } from "../src/relaxed-madd-probe.js";
import { compareRegionProgram, loadAotCore } from "./helpers/aot-core-equivalence.mjs";
import { SHORT_PREFIX_MASK, describeDifference, exactFmaDouble, force25Bit, hex, loadOracleCore, makeRng, randomState } from "./helpers/jit-oracle.mjs";

const lock = JSON.parse(readFileSync(new URL("../provenance/dolphin-source.lock.json", import.meta.url), "utf8"));
const builtUrl = new URL("../cores/dolphin/dolphin-core-upstream.build.json", import.meta.url);
const built = existsSync(builtUrl) ? JSON.parse(readFileSync(builtUrl, "utf8")) : null;
const coreHas0161 = built?.source?.patchSeriesSha256 === lock.patchSeriesSha256 &&
  lock.patches.some((p) => p.path.includes("/0161-"));
const core = coreHas0161 ? await loadOracleCore() : null;
const machine = probeRelaxedMadd();
const skip = !coreHas0161 ? "core built from a patch series without 0161 (CI builds this branch's core)" :
  !core ? "no core" : machine !== "fused" ? `this engine's relaxed_madd is ${machine}` : false;

const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
const BLR = 0x4e800020;
const words64 = (x) => Array.from(new Uint32Array(new Float64Array([x]).buffer));
const single = (bits) => new Float32Array(new Uint32Array([bits]).buffer)[0];
// [xo, name, b sign for a tie (sub forms negate b), c lane (madds0/1)]
const FORMS = [[29, "ps_madd", 1, null], [28, "ps_msub", -1, null], [31, "ps_nmadd", 1, null], [30, "ps_nmsub", -1, null],
  [14, "ps_madds0", 1, 0], [15, "ps_madds1", 1, 1]];

// (a, c, b) with b's sign for ps_madd: a * c + b
const ONE_UP = single(0x3f800001), ONE_DOWN = single(0x3f7fffff); // 1 + 2^-23, 1 - 2^-24
const TRUE_TIE = [1, -500, single(0xc2583968)]; // the heavy scene's case: -554.0560607910156, error 0
const BELOW = [ONE_UP, single(0x3f7ffffe), 16777218]; // (1 - 2^-46) + (2^24 + 2) = 2^24 + 3 - 2^-46: rounds down to 2^24 + 2, even says + 4
const ABOVE = [-ONE_UP, single(0x3f7ffffe), 16777222]; // 2^24 + 5 + 2^-46: rounds up to 2^24 + 6, even says + 4
const OVERFLOW = [1, single(0x7f7fffff), 2 ** 103]; // FLT_MAX + half an ulp: a tie at the overflow bound
const NOT_TIE = [1.5, 2.25, -0.75];

// What the interpreter does with one lane (NI_madd_msub, single): the tie and
// the error's sign, for the test's own bookkeeping.
function classify([a, c, b]) {
  const cr = force25Bit(c);
  const [lo] = exactFmaDouble(a, cr, b);
  return (lo & 0x1fffffff) >>> 0 === 0x10000000 ? "tie" : "no tie";
}

function assertSame(result, label) {
  assert.ok(result.code === 0 || result.code === 2, `${label}: ${result.code === 1
    ? describeDifference(result.interp, result.jit).slice(0, 8).join("; ")
    : result.message || `oracle code ${result.code}`}`);
}

function runForm(xo, cLane, l0, l1, { regions = null } = {}) {
  const state = randomState(makeRng(0x161 + xo));
  state[36] = 0;
  state[37] = 0x00002032;
  // f2 = a, f3 = c, f4 = b; f1 = d
  const lane = (l, i) => l[i];
  const c0 = cLane === null ? l0[1] : (cLane === 0 ? l0[1] : l1[1]);
  const c1 = cLane === null ? l1[1] : c0;
  state.set([...words64(lane(l0, 0)), ...words64(lane(l1, 0))], 48 + 2 * 4);
  state.set([...words64(cLane === 1 ? l0[1] : c0), ...words64(cLane === 0 ? l1[1] : c1)], 48 + 3 * 4);
  if (cLane === 1) state.set([...words64(l0[1]), ...words64(l1[1])], 48 + 3 * 4);
  state.set([...words64(lane(l0, 2)), ...words64(lane(l1, 2))], 48 + 4 * 4);
  const program = Uint32Array.from([A(4, 1, 2, 4, 3, xo), A(4, 5, 2, 4, 3, xo), BLR]);
  if (regions) return compareRegionProgram(regions, Array.from(program), state);
  return { result: core.run(program, state, SHORT_PREFIX_MASK), program };
}

// A form's lane values: sub forms negate b so the lane still ties.
const forForm = (bSign, l) => [l[0], l[1], bSign * l[2]];

test("the constructed lanes tie where they should", () => {
  for (const l of [TRUE_TIE, BELOW, ABOVE, OVERFLOW]) assert.equal(classify(l), "tie", l.join(","));
  assert.equal(classify(NOT_TIE), "no tie");
});

test("the fp helper counter moves when a lane leaves the fast path (a NaN), so the counts below mean something", { skip }, () => {
  const previous = core.setFusedMadd(true);
  try {
    const before = core.fpHelperCalls();
    const { result } = runForm(29, null, [NaN, 1, 1], NOT_TIE);
    assertSame(result, "NaN lane");
    assert.ok(result.compiledOps >= 2 && core.fpHelperCalls() - before >= 1, `${core.fpHelperCalls() - before} fp helper calls`);
  } finally {
    core.setFusedMadd(previous);
  }
});

test("paired FMA single ties: bit-exact with the interpreter, inline (no fp helper) except at the overflow bound", { skip }, () => {
  const previous = core.setFusedMadd(true);
  try {
    for (const [xo, name, bSign, cLane] of FORMS) {
      const lanes = [TRUE_TIE, BELOW, ABOVE, NOT_TIE].map((l) => forForm(bSign, l));
      for (const l0 of lanes) {
        for (const l1 of lanes) {
          const before = core.fpHelperCalls();
          const { result, program } = runForm(xo, cLane, l0, l1);
          assertSame(result, `${name} lanes ${l0} / ${l1} ${Array.from(program, hex).join(" ")}`);
          assert.ok(result.compiledOps >= 2, `${name}: compiled`);
          // madds0/1 take c from one lane: the other lane's c may not tie
          if (cLane === null) assert.equal(core.fpHelperCalls() - before, 0, `${name} lanes ${l0} / ${l1}: no fp helper call`);
        }
      }
      const over = forForm(bSign, OVERFLOW);
      if (cLane === null) {
        const before = core.fpHelperCalls();
        const { result } = runForm(xo, cLane, over, forForm(bSign, NOT_TIE));
        assertSame(result, `${name} overflow-bound tie`);
        const calls = core.fpHelperCalls() - before;
        assert.ok(result.compiledOps >= 2 && calls >= 1, `${name}: the overflow-bound tie goes to the interpreter (code ${result.code}, ${result.compiledOps} ops compiled, ${calls} fp helper calls)`);
      }
    }
  } finally {
    core.setFusedMadd(previous);
  }
});

test("a sweep of random paired FMA ties matches the interpreter bit for bit", { skip }, () => {
  const previous = core.setFusedMadd(true);
  try {
    const r = makeRng(0x7161);
    const sgn = () => (r.below(2) ? 1 : -1);
    const f24 = (e) => sgn() * (1 + (r.next() & 0x7fffff) / 2 ** 23) * 2 ** e; // a single with 24 bits
    // As the scene's vertex math: an integer-like product (a, c with few bits)
    // plus a b whose exponent is 1-4 below it, so b's low bits fall under the
    // sum's single ulp: a true tie (error 0) once in 2-16 lanes.
    const trueTie = () => {
      const a = sgn() * (1 + r.below(255)), c = sgn() * (1 + r.below(255)) * 2 ** (r.below(4) - 2);
      const e = Math.floor(Math.log2(Math.abs(a * c))) - 1 - r.below(4);
      return [a, c, Math.fround(f24(e))];
    };
    // As BELOW / ABOVE: (1 + 2^-23)(1 - 2^-23) = 1 - 2^-46 scaled, plus b on a
    // grid of 2: the double rounding lands on a tie with a nonzero error,
    // above or below, for random scales, signs and grid points.
    const errTie = () => {
      const s = r.below(20) - 10, sa = sgn();
      const m = 2 ** 24 + 2 * r.below(2 ** 22);
      return [sa * ONE_UP * 2 ** s, single(0x3f7ffffe), -sa * sgn() === 1 ? m * 2 ** s : -m * 2 ** s];
    };
    let ties = 0, runs = 0;
    for (let k = 0; k < 3000; k++) {
      const make = () => (r.below(3) ? trueTie() : errTie());
      const l0 = make(), l1 = make();
      ties += (classify(l0) === "tie") + (classify(l1) === "tie");
      const [xo, name, bSign, cLane] = FORMS[r.below(FORMS.length)];
      const { result, program } = runForm(xo, cLane, forForm(bSign, l0), forForm(bSign, l1));
      assertSame(result, `${name} sweep ${k} lanes ${l0} / ${l1} ${Array.from(program, hex).join(" ")}`);
      runs++;
    }
    assert.ok(ties >= 300, `${ties} tie lanes in ${runs} runs`);
  } finally {
    core.setFusedMadd(previous);
  }
});

const aot = skip ? null : await loadAotCore();
const regionSkip = skip || (!aot?.has("DolphinWeb_AotTestLoadState") && "core without the region test exports");
test("regions: paired FMA single ties match the interpreter", { skip: regionSkip }, () => {
  const previous = aot.module._DolphinWeb_SetFusedMadd(1);
  try {
    let ran = 0;
    for (const [xo, name, bSign, cLane] of FORMS) {
      for (const l of [TRUE_TIE, BELOW, ABOVE]) {
        const res = runForm(xo, cLane, forForm(bSign, l), forForm(bSign, BELOW), { regions: aot });
        if (!res.translated) continue;
        assert.ok(!res.trap && !res.error, `${name}: ${res.error ?? "trap"}`);
        assert.ok(res.equal, `${name} ${l}: ${JSON.stringify(res.difference)}`);
        ran++;
      }
    }
    assert.ok(ran >= 12, `${ran} region runs`);
  } finally {
    aot.module._DolphinWeb_SetFusedMadd(previous);
  }
});
