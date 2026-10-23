// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// FPRF follows Config::MAIN_FPRF in every tier (patch 0121): off by default
// as upstream, on for the games whose INI asks for it. The interpreter, the
// block JIT and regions agree bit for bit in both modes (full state, nothing
// masked), and the mode really decides whether an FP result sets FPRF.

import assert from "node:assert/strict";
import test from "node:test";

import { loadAotCore, runOracleProgramsAsRegions } from "./helpers/aot-core-equivalence.mjs";
import {
  PRODUCTION_DISABLE_MASK, SHORT_PREFIX_MASK, describeDifference, generate, hex, instructionNames, loadOracleCore, makeRng,
  randomProgram, randomState
} from "./helpers/jit-oracle.mjs";

const oracle = await loadOracleCore().catch(() => null);
const skip = !oracle?.has("DolphinWeb_SetFprfForTest") && "core before patch 0121 (FPRF follows the setting)";
const FPSCR = 36;
const FPRF_BITS = 0x1f << 12;

function assertSame(result, label) {
  assert.ok(result.code === 0 || result.code === 2, `${label}: ${result.code === 1
    ? describeDifference(result.interp, result.jit).slice(0, 8).join("; ")
    : result.message || `oracle code ${result.code}`}`);
}

function withFprf(on, fn) {
  oracle.setFprf(on);
  try {
    return fn();
  } finally {
    oracle.setFprf(false);
  }
}

test("an FP result sets FPRF only with FPRF on, in the interpreter and the JIT alike", { skip }, () => {
  const fadd = ((63 << 26) | (1 << 21) | (2 << 16) | (3 << 11) | (21 << 1)) >>> 0;
  const state = randomState(makeRng(0xf9f));
  state.set([0, 0x3ff00000, 0, 0x3ff00000], 48 + 2 * 4); // f2 = 1.0
  state.set([0, 0x40000000, 0, 0x40000000], 48 + 3 * 4); // f3 = 2.0
  state[FPSCR] = (state[FPSCR] & ~FPRF_BITS & ~0xf8) >>> 0; // FPRF 0, no FP exceptions enabled
  for (const on of [false, true]) {
    const result = withFprf(on, () => oracle.run(Uint32Array.from([fadd, 0x4e800020]), state, SHORT_PREFIX_MASK));
    assertSame(result, `fadd, FPRF ${on ? "on" : "off"}`);
    const fprf = (result.interp[FPSCR] & FPRF_BITS) >>> 12;
    assert.equal(fprf, on ? 0x04 : 0, `FPRF ${on ? "on: positive normal" : "off: untouched"}`);
  }
});

test("FPRF on: every JIT instruction class matches the interpreter", { skip }, () => {
  const r = makeRng(0xf9f1);
  withFprf(true, () => {
    for (const name of instructionNames()) {
      for (let k = 0; k < 6; k++) {
        const program = Uint32Array.from([generate(name, r), 0x4e800020]);
        assertSame(oracle.run(program, randomState(r), SHORT_PREFIX_MASK), `${name} ${hex(program[0])}`);
      }
    }
  });
});

test("FPRF on: random blocks with branches and CTR loops match the interpreter", { skip }, () => {
  const r = makeRng(0xf9f2);
  withFprf(true, () => {
    for (let i = 0; i < 150; i++) {
      const program = randomProgram(r, 24);
      assertSame(oracle.run(program, randomState(r), PRODUCTION_DISABLE_MASK), `program ${i}: ${Array.from(program, hex).join(" ")}`);
    }
  });
});

const regionCore = skip ? null : await loadAotCore();
for (const on of [false, true]) {
  test(`FPRF ${on ? "on" : "off"}: oracle programs as regions match the interpreter`, { skip: skip || (!regionCore?.has("DolphinWeb_AotTestLoadState") && "core without the region test exports"), timeout: 600000 }, (t) => {
    regionCore.module._DolphinWeb_SetFprfForTest(on ? 1 : 0);
    try {
      const tally = runOracleProgramsAsRegions(regionCore, { seed: on ? 0xf9f3 : 0xf9f4, count: 200, length: 24, mask: PRODUCTION_DISABLE_MASK });
      t.diagnostic(JSON.stringify({ ...tally, mismatches: tally.mismatches.slice(0, 2) }));
      assert.deepEqual(tally.mismatches.slice(0, 4), []);
      assert.ok(tally.compared >= 200);
    } finally {
      regionCore.module._DolphinWeb_SetFprfForTest(0);
    }
  });
}
