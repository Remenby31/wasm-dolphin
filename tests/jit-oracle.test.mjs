// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// The WASM JIT must compute exactly what the interpreter computes. A small,
// fixed-seed slice of the oracle fuzz (tests/jit-oracle-fuzz.mjs runs the
// large one): every instruction class from random states, with and without
// the GPR register cache, then random blocks with branches and CTR loops
// under the production CachedInterpreter mask. Plus the engine-reject guard.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  PRODUCTION_DISABLE_MASK,
  REGALLOC_OFF,
  SHORT_PREFIX_MASK,
  describeDifference,
  generate,
  hex,
  instructionNames,
  loadOracleCore,
  makeRng,
  randomProgram,
  randomState
} from "./helpers/jit-oracle.mjs";

const coreWasm = new URL("../cores/dolphin/dolphin-core-upstream.wasm", import.meta.url);
const core = existsSync(coreWasm) ? await loadOracleCore() : null;
const skip = core ? false : "the committed core has no JIT oracle";

function assertSame(result, label) {
  assert.ok(result.code === 0 || result.code === 2 || result.code === 3, `${label}: ${result.code === 1
    ? describeDifference(result.interp, result.jit).slice(0, 8).join("; ")
    : result.message || `oracle code ${result.code}`}`);
}

test("every JIT instruction class matches the interpreter (regalloc on and off)", { skip }, () => {
  const r = makeRng(0x0c1e);
  let compiled = 0;
  for (const name of instructionNames()) {
    for (let k = 0; k < 12; k++) {
      const program = Uint32Array.from([generate(name, r), 0x4e800020]);
      const state = randomState(r);
      for (const mask of [SHORT_PREFIX_MASK, SHORT_PREFIX_MASK | REGALLOC_OFF]) {
        const result = core.run(program, state, mask);
        assertSame(result, `${name} ${hex(program[0])} mask ${hex(mask)}`);
        if (result.code === 0) compiled += 1;
      }
    }
  }
  assert.ok(compiled > 1000, `too few compiled single-instruction blocks (${compiled})`);
});

test("random blocks with branches and CTR loops match the interpreter", { skip }, () => {
  const r = makeRng(0xb10c);
  let compiled = 0;
  for (let i = 0; i < 300; i++) {
    const program = randomProgram(r, 24);
    const state = randomState(r);
    for (const mask of [PRODUCTION_DISABLE_MASK, PRODUCTION_DISABLE_MASK | REGALLOC_OFF]) {
      const result = core.run(program, state, mask);
      assertSame(result, `program ${i} mask ${hex(mask)}: ${Array.from(program, hex).join(" ")}`);
      if (result.code === 0) compiled += 1;
    }
  }
  assert.ok(compiled > 300, `too few compiled programs (${compiled})`);
});

test("a module the engine rejects returns handle 0 instead of throwing", { skip }, async () => {
  const { default: createDolphinCore } = await import(new URL("../cores/dolphin/dolphin-core-upstream.js", import.meta.url));
  const { readFileSync } = await import("node:fs");
  const module = await createDolphinCore({ wasmBinary: readFileSync(coreWasm), noInitialRun: true, printErr: () => {} });
  // A function body that leaves two values on the stack: the exact class of
  // CompileError ("expected 1 elements on the stack for fallthru") the
  // emitter used to produce on libogc's console code.
  const bad = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
    0x0a, 0x08, 0x01, 0x06, 0x00, 0x41, 0x01, 0x41, 0x02, 0x0b
  ]);
  const ptr = module._malloc(bad.length);
  module.HEAPU8.set(bad, ptr);
  const before = module._DolphinWeb_JitEngineRejectCount();
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(module._DolphinWeb_JitCompileBytesForTest(ptr, bad.length), 0);
  } finally {
    console.warn = warn;
    module._free(ptr);
  }
  assert.equal(module._DolphinWeb_JitEngineRejectCount(), before + 1);
});

test("FPRF stays the interpreter's when a later op keeps it (VE=1 invalid op)", { skip }, () => {
  // fadd f1 (normal result) writes FPRF; fsub f4 = inf - inf is invalid and,
  // with VE=1, leaves FPRF alone. The JIT may skip the first FPRF write only
  // when the second one is certain to happen.
  const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
  const state = randomState(makeRng(3));
  const setF = (i, hi) => state.set([0, hi, 0, hi], 48 + i * 4);
  setF(2, 0x3ff00000);
  setF(3, 0x40000000);
  setF(5, 0x7ff00000);
  setF(6, 0x7ff00000);
  const program = Uint32Array.from([A(63, 1, 2, 3, 0, 21), A(63, 4, 5, 6, 0, 20), 0x4e800020]);
  for (const fpscr of [0x80, 0x10, 0x00]) {
    state[36] = fpscr;
    for (const mask of [SHORT_PREFIX_MASK, SHORT_PREFIX_MASK | REGALLOC_OFF]) {
      const result = core.run(program, state, mask);
      assert.equal(result.compiledBlocks, 1);
      assertSame(result, `fpscr ${hex(fpscr)} mask ${hex(mask)}`);
    }
  }
});

test("addresses outside the 0x8/0xC views go through the MMU, as in the interpreter", { skip }, () => {
  // lwz/stw/lfs through r5 = 0x00100080 and 0x40100080: not mapped by the
  // standard BATs. The JIT's direct RAM path must not read MEM1 for them.
  const D = (op, rt, ra, imm) => ((op << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0;
  for (const base of [0x00100080, 0x40100080, 0x80100080, 0xc0100080]) {
    const state = randomState(makeRng(base >>> 20));
    state[5] = base;
    const program = Uint32Array.from([D(32, 3, 5, 0), D(36, 6, 5, 8), D(48, 1, 5, 16), 0x4e800020]);
    const result = core.run(program, state, SHORT_PREFIX_MASK);
    assertSame(result, `base ${hex(base)}`);
  }
});
