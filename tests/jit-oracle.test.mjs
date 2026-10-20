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
import { fileURLToPath } from "node:url";
import { coreStatus } from "../tools/core-artifacts.mjs";
import {
  PRODUCTION_DISABLE_MASK,
  REGALLOC_OFF,
  SHORT_PREFIX_MASK,
  describeDifference,
  exactFmaDouble,
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
// Pull requests carry sources only (docs/repro-build.md): locally the core can
// be main's, older than these sources. CI builds and tests the branch's core.
const skip = core ? false : "the core in cores/dolphin predates these oracle sources (CI builds this branch's core)";

function assertSame(result, label) {
  assert.ok(result.code === 0 || result.code === 2, `${label}: ${result.code === 1
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

test("install failures: out of memory is transient, a full table stops compiling, neither is blacklisted", { skip }, async () => {
  const { default: createDolphinCore } = await import(new URL("../cores/dolphin/dolphin-core-upstream.js", import.meta.url));
  const { readFileSync } = await import("node:fs");
  const module = await createDolphinCore({ wasmBinary: readFileSync(coreWasm), noInitialRun: true, printErr: () => {} });
  // (func (param i32) (result i32) local.get 0), exported as "f"
  const ok = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00, 0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, 0x0a, 0x06, 0x01, 0x04, 0x00, 0x20, 0x00, 0x0b]);
  const ptr = module._malloc(ok.length);
  module.HEAPU8.set(ok, ptr);
  const rejects = module._DolphinWeb_JitEngineRejectCount();
  const warn = console.warn;
  console.warn = () => {};
  try {
    module._DolphinWeb_JitFailNextInstance();
    assert.equal(module._DolphinWeb_JitCompileBytesForTest(ptr, ok.length), -1, "out of memory: transient");
    assert.equal(module._DolphinWeb_JitTransientRejectCount(), 1);
    assert.ok(module._DolphinWeb_JitCompileBytesForTest(ptr, ok.length) > 0, "the same bytes install next time");
    assert.equal(module._DolphinWeb_JitTableFull(), 0);
    module._DolphinWeb_JitFailNextTableGrow();
    assert.equal(module._DolphinWeb_JitCompileBytesForTest(ptr, ok.length), -2, "table full: not transient");
    assert.equal(module._DolphinWeb_JitTableFull(), 1, "the JIT stops compiling for the session");
    assert.equal(module._DolphinWeb_JitTransientRejectCount(), 1);
    assert.equal(module._DolphinWeb_JitEngineRejectCount(), rejects, "never an engine reject");
  } finally {
    console.warn = warn;
    module._free(ptr);
  }
});

test("armed warmup engages at the same field: late first step, state loaded before the first slice", { skip }, async () => {
  const { default: createDolphinCore } = await import(new URL("../cores/dolphin/dolphin-core-upstream.js", import.meta.url));
  const { readFileSync } = await import("node:fs");
  const fresh = async () => createDolphinCore({ wasmBinary: readFileSync(coreWasm), noInitialRun: true, printErr: () => {} });
  const engageField = (m, fields) => { for (const f of fields) { const e = m._DolphinWeb_JitArmedStepForTest(f); if (e >= 0) return e; } return -1; };
  const range = (a, b) => Array.from({ length: b - a }, (_, k) => a + k);

  // Armed before boot (the worker does it in loadCore): field 60, whether the
  // CPU thread's first slice comes at field 0 or later.
  for (const firstStep of [0, 1, 7, 59]) {
    const m = await fresh();
    m._SetPpcWasmJitWarmup(1, 60);
    assert.equal(engageField(m, range(firstStep, 200)), 60, `first step at field ${firstStep}`);
  }
  // A state loaded before the first slice: counted from the loaded field.
  for (const loaded of [0, 349, 1000]) {
    const m = await fresh();
    m._SetPpcWasmJitWarmup(1, 60);
    m._DolphinWeb_JitOnStateLoaded();
    assert.equal(engageField(m, range(loaded, loaded + 200)), loaded + 60, `loaded at ${loaded}`);
  }
  // A load after engage re-arms from the loaded field.
  const m = await fresh();
  m._SetPpcWasmJitWarmup(1, 60);
  assert.equal(engageField(m, range(0, 100)), 60);
  m._DolphinWeb_JitOnStateLoaded();
  assert.equal(engageField(m, range(500, 700)), 560);
});

test("FP program exceptions (FE0/FE1, enabled invalid or zero-divide) end in the same state", { skip }, () => {
  // Compared at the 0x700 vector: SRR0, SRR1, MSR, FPSCR and the FPRs.
  const r = makeRng(0xe1);
  let raised = 0;
  for (const name of ["fctiwz", "frsp", "fdivs", "fmadds", "ps_mul", "fadd", "fsub", "ps_madd"]) {
    for (let k = 0; k < 60; k++) {
      const state = randomState(r);
      state[37] = 0x00002932; // FE0|FE1
      state[36] = (state[36] & ~0x9ff80000) | 0xf8; // sticky bits clear, all enables on
      const program = Uint32Array.from([generate(name, r), 0x4e800020]);
      for (const mask of [SHORT_PREFIX_MASK, SHORT_PREFIX_MASK | REGALLOC_OFF]) {
        const result = core.run(program, state, mask);
        assertSame(result, `${name} ${hex(program[0])} mask ${hex(mask)}`);
        if (result.code === 0 && result.message.startsWith("exception")) raised += 1;
      }
    }
  }
  assert.ok(raised > 100, `too few exception paths compared (${raised})`);
});

test("unmapped and misaligned accesses agree with the interpreter", { skip }, () => {
  const r = makeRng(0xe2);
  for (const name of ["lwz-unmapped", "stw-unmapped", "lfs-unmapped", "stfs-unmapped", "lbz-unmapped", "lmw-misaligned"]) {
    for (let k = 0; k < 40; k++) {
      const program = Uint32Array.from([generate(name, r), 0x4e800020]);
      const result = core.run(program, randomState(r), SHORT_PREFIX_MASK);
      assertSame(result, `${name} ${hex(program[0])}`);
    }
  }
});

// The block JIT's inline mtmsr takes pending exceptions since patch 0076.
const mtmsrSkip = skip || (!core.has("DolphinWeb_JitMtmsrTakesPendingExceptions") && "the core predates patch 0076 (CI builds this branch's core)");
test("mtmsr takes the exceptions held pending and FP exceptions it enables, as the interpreter", { skip: mtmsrSkip }, () => {
  const r = makeRng(0xe3);
  const MFMSR_R5 = 0x7ca000a6, MTMSR_R5 = 0x7ca00124, BLR = 0x4e800020;
  const li5 = (v) => (0x38a00000 | v) >>> 0;
  const ORI_R5_EE = 0x60a58000;
  const EXTERNAL_INT = 0x4; // Gekko.h EXCEPTION_EXTERNAL_INT
  const withWord = (state, i, f) => Uint32Array.from(state, (v, j) => (j === i ? f(v) : v));
  const ends = {};
  for (let k = 0; k < 30; k++) {
    const state = randomState(r);
    state[37] = 0x00002032; // FP, IR, DR, RI; EE, PR, FE0/FE1 off
    const fex = withWord(state, 36, (v) => v | 0x40000000);
    const cases = [
      // A misaligned lmw leaves an alignment exception pending; mtmsr takes it.
      ["held alignment", [generate("lmw-misaligned", r), MFMSR_R5, MTMSR_R5, BLR], state],
      // The same with the new MSR in user mode: taken before PR matters.
      ["held alignment, new PR=1", [generate("lmw-misaligned", r), li5(0x6032), MTMSR_R5, BLR], state],
      // FPSCR.FEX set: FE0, FE1 or both turned on raise an FP program exception.
      ["FE0", [li5(0x2832), MTMSR_R5, BLR], fex],
      ["FE1", [li5(0x2132), MTMSR_R5, BLR], fex],
      ["FE0|FE1", [li5(0x2932), MTMSR_R5, BLR], fex],
      // An external interrupt pending: not taken while EE stays off, taken once on.
      ["external, EE off", [MFMSR_R5, MTMSR_R5, BLR], withWord(state, 46, () => EXTERNAL_INT)],
      ["external, EE on", [li5(0x2032), ORI_R5_EE, MTMSR_R5, BLR], withWord(state, 46, () => EXTERNAL_INT)]
    ];
    for (const [name, words, st] of cases) {
      const program = Uint32Array.from(words);
      for (const mask of [SHORT_PREFIX_MASK, SHORT_PREFIX_MASK | REGALLOC_OFF]) {
        const result = core.run(program, st, mask);
        assertSame(result, `${name}: ${hex(program[0])} mask ${hex(mask)}`);
        assert.ok(result.compiledBlocks > 0, `${name}: the block with mtmsr ran in WASM`);
        const end = result.message.startsWith("exception") ? "exception" : "return";
        ends[`${name}/${end}`] = (ends[`${name}/${end}`] ?? 0) + 1;
      }
    }
  }
  for (const name of ["held alignment", "held alignment, new PR=1", "FE0", "FE1", "FE0|FE1", "external, EE on"]) {
    assert.equal(ends[`${name}/exception`], 60, `${name}: the exception is taken (${JSON.stringify(ends)})`);
  }
  assert.equal(ends["external, EE off/return"], 60, "a pending external stays pending while EE is off");
});

test("inline FMA keeps NI_madd_msub's single rounding, ties included", { skip }, () => {
  // The Mario Strikers Charged inputs from Interpreter_FPUtils.h: the exact
  // product of two singles plus b ties at single precision; the interpreter
  // returns 0xbf55bf17, a double-rounding FMA 0xbf55bf18.
  const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
  const single = (bits) => Array.from(new Uint32Array(new Float64Array([new Float32Array(new Uint32Array([bits]).buffer)[0]]).buffer));
  const state = randomState(makeRng(5));
  state[36] = 0; // round to nearest, no enables
  state[37] = 0x00002032;
  const setF = (i, bits) => { const [lo, hi] = single(bits); state.set([lo, hi, lo, hi], 48 + i * 4); };
  setF(2, 0x42480000);
  setF(3, 0xbc88cc38);
  setF(4, 0x1b1c72a0);
  for (const xo of [29, 28, 31, 30]) {
    for (const op of [59, 4]) {
      const program = Uint32Array.from([A(op, 1, 2, 4, 3, xo), 0x4e800020]);
      for (const mask of [SHORT_PREFIX_MASK, SHORT_PREFIX_MASK | REGALLOC_OFF]) {
        const result = core.run(program, state, mask);
        assert.equal(result.compiledBlocks, 1);
        assertSame(result, `op ${op} xo ${xo}`);
      }
    }
  }
});

test("double FMA with wide significands matches std::fma", { skip }, () => {
  // Products whose significands need 53 or 54 bits, around the edge where
  // a*c stops being exact in double.
  const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
  const r = makeRng(0xf3a);
  const state = randomState(r);
  state[36] = 0;
  state[37] = 0x00002032;
  const setF = (i, lo, hi) => state.set([lo, hi, lo, hi], 48 + i * 4);
  for (let k = 0; k < 400; k++) {
    // a: 26-28 significant bits, c: 26-28 significant bits, b random
    const bits = (n) => (r.next() & ~((1 << (32 - n)) - 1)) >>> 0; // keep the top n-21 fraction bits of the low word
    setF(2, bits(r.below(3) + 5) & 0xffffffff, 0x3ff00000 | (r.next() & 0xfffff));
    setF(3, bits(r.below(3) + 5) & 0xffffffff, 0x40000000 | (r.next() & 0xfffff));
    setF(4, r.next(), 0x3fe00000 | (r.next() & 0xfffff));
    for (const xo of [29, 28, 31, 30]) {
      const program = Uint32Array.from([A(63, 1, 2, 4, 3, xo), 0x4e800020]);
      const result = core.run(program, state, SHORT_PREFIX_MASK);
      assertSame(result, `xo ${xo} case ${k}`);
    }
  }
});

// Skipped only on a core older than these sources (main's, restored on a
// branch): a core built from this tree without the marker fails the test.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fmaSkip = skip || (core.has("DolphinWeb_FmaIsMusl") || (await coreStatus(repoRoot)).current
  ? false : "the core predates the strong musl fma (CI builds this branch's core)");

test("FMA rounds once on double-rounding traps, interpreter and JIT (correct fma linked)", { skip: fmaSkip }, () => {
  assert.ok(core.has("DolphinWeb_FmaIsMusl"), "this core links no strong fma (core/upstream/dolphin_web_fma.h)");
  // c has 24 bits, a = 1/c: a*c rounds to exactly 2^m with a tiny error e.
  // b's ulp is 2^(m+1), so p + b is an exact tie in double and only e
  // decides the rounding; ignoring e rounds to even, wrongly half the time.
  // The interpreter's std::fma is checked against exact arithmetic too: a
  // weak fma() from a linked Rust compiler_builtins once won over musl's and
  // double-rounded exactly these (core/upstream/dolphin_web_fma.h).
  const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
  const d = (x) => Array.from(new Uint32Array(new Float64Array([x]).buffer));
  const r = makeRng(0x7e5);
  const state = randomState(r);
  state[36] = 0;
  state[37] = 0x00002032;
  const setF = (i, x) => { const [lo, hi] = d(x); state.set([lo, hi, lo, hi], 48 + i * 4); };
  const f = (hi, lo) => new Float64Array(new Uint32Array([lo, hi]).buffer)[0];
  // fnmsub of the reported case: b - 16 - 2^-61 rounds to b - ulp, not to b.
  const cases = [[f(0xc02f870e, 0x3619b278), f(0xbff03d60, 0xe0000000), f(0x438fbd2f, 0x3eb1057e)]];
  while (cases.length < 400) {
    const c = Math.fround(1 + r.next() / 2 ** 32);
    const m = r.below(61) - 30;
    const a = (1 / c) * 2 ** m;
    if (a * c !== 2 ** m) continue;
    cases.push([a, c, (r.chance(0.5) ? 1 : -1) * (1 + r.next() / 2 ** 32 + (r.next() >>> 12) / 2 ** 52) * 2 ** (m + 53)]);
  }
  let checked = 0;
  for (const [k, [a, c, b]] of cases.entries()) {
    setF(2, a);
    setF(3, c);
    setF(4, b);
    for (const xo of [29, 28, 31, 30]) {
      for (const op of [63, 59, 4]) {
        const result = core.run(Uint32Array.from([A(op, 1, 2, 4, 3, xo), 0x4e800020]), state, SHORT_PREFIX_MASK);
        assertSame(result, `op ${op} xo ${xo} case ${k}`);
        if (op !== 63) continue;
        const want = exactFmaDouble(a, c, xo === 28 || xo === 30 ? -b : b);
        if (xo >= 30) want[1] = (want[1] ^ 0x80000000) >>> 0;
        assert.deepEqual([result.interp[48 + 4], result.interp[48 + 5]], want, `interpreter fma, xo ${xo} case ${k}: not correctly rounded`);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 1600);
});

test("an underflowed product is never taken as exact (signed zero, ties at the bottom)", { skip }, () => {
  // Review of #27: a*c = ±2^-1075 or less rounds to ±0 although neither
  // operand is zero; p + b would then lose the sign of zero or a tie.
  const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
  const state = randomState(makeRng(0x0f1));
  state[36] = 0;
  state[37] = 0x00002032;
  const setF = (i, hi, lo = 0) => state.set([lo, hi, lo, hi], 48 + i * 4);
  for (const [a, c, [bhi, blo]] of [
    [0x9a700000, 0x1a700000, [0, 0]], [0x9a700000, 0x1a700000, [0x80000000, 0]],
    // a*c = ±2^-1075: an exact tie against b's ulp, lost if p rounds to ±0
    [0x20b00000, 0x1c000000, [0x00100000, 1]], [0xa0b00000, 0x1c000000, [0x00100000, 1]]
  ]) {
    setF(2, a);
    setF(3, c);
    setF(4, bhi, blo);
    // fmadd family (op 63, 59) and paired forms, ps_madds0/1 included (op 4 xo 14, 15)
    for (const [op, xos] of [[63, [28, 29, 30, 31]], [59, [28, 29, 30, 31]], [4, [14, 15, 28, 29, 30, 31]]]) {
      for (const xo of xos) {
        const result = core.run(Uint32Array.from([A(op, 1, 2, 4, 3, xo), 0x4e800020]), state, SHORT_PREFIX_MASK);
        assert.equal(result.compiledBlocks, 1, `op ${op} xo ${xo}: compiled`);
        assertSame(result, `op ${op} xo ${xo} a ${hex(a)} c ${hex(c)}`);
      }
    }
  }
});

test("single FMA with a denormal frC is not mistaken for a zero product", { skip }, () => {
  // Rounding frC to 25 bits turns 2^-1074 into 0, but the interpreter's
  // product is a tiny nonzero value: the inline zero-operand path must not fire.
  const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
  const state = randomState(makeRng(0xde1));
  state[36] = 0;
  state[37] = 0x00002032;
  const setF = (i, lo, hi) => state.set([lo, hi, lo, hi], 48 + i * 4);
  setF(2, 0x2621e9b6, 0x79f3a39d);
  setF(4, 0, 0);
  for (const [lo, hi] of [[1, 0], [0, 0x80000], [0x10000000, 0x80000000]]) {
    setF(3, lo, hi);
    for (const xo of [29, 28, 31, 30]) {
      for (const op of [59, 4]) {
        assertSame(core.run(Uint32Array.from([A(op, 1, 2, 4, 3, xo), 0x4e800020]), state, SHORT_PREFIX_MASK), `op ${op} xo ${xo} c ${hex(hi)}${hex(lo).slice(2)}`);
      }
    }
  }
});

test("inline frsqrte reproduces Gekko's table estimate bit for bit", { skip }, () => {
  // Positive normals across exponent parities and every table segment, plus
  // the cases left to the helper (zero, negative, denormal, inf, NaN).
  const A = (op, t, a, b, c, xo) => ((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1)) >>> 0;
  const r = makeRng(0x45e);
  const state = randomState(r);
  state[36] = 0;
  state[37] = 0x00002032;
  const program = Uint32Array.from([A(63, 1, 0, 2, 0, 26), 0x4e800020]);
  const specials = [[0, 0], [0, 0x80000000], [0, 0xbff00000], [1, 0], [0, 0x7ff00000], [0, 0x7ff80000], [1, 0x7ff00000], [0xffffffff, 0x7fefffff], [0, 0x00100000]];
  const cases = [...specials];
  for (let k = 0; k < 3000; k++) cases.push([r.next(), ((1 + r.below(2045)) << 20 | (r.next() & 0xfffff)) >>> 0]);
  let compiled = 0;
  for (const [lo, hi] of cases) {
    state.set([lo, hi, lo, hi], 48 + 2 * 4);
    const result = core.run(program, state, SHORT_PREFIX_MASK);
    assertSame(result, `frsqrte ${hex(hi)}${hex(lo).slice(2)}`);
    if (result.code === 0) compiled += 1;
  }
  assert.equal(compiled, cases.length);
});

const dumpSkip = skip || (core.has("DolphinWeb_JitDumpBlocksNowForTest") ? false : "the core predates the block export (CI builds this branch's core)");

test("the executed-block export is there, and says when no CPU core runs", { skip: dumpSkip }, () => {
  // The oracle compiles its blocks without the CachedInterpreter block cache,
  // so here the export can only answer that no JIT core is running; the
  // live check reads the blocks of a race (P3 lane 10).
  for (const name of ["DolphinWeb_JitDumpBlocksRequest", "DolphinWeb_JitDumpBlocksDone", "DolphinWeb_JitDumpBlocksCount", "DolphinWeb_JitDumpBlocksBuffer"]) {
    assert.ok(core.has(name), name);
  }
  assert.equal(core.dumpBlocks(), null);
});

const offThreadSkip = skip || (core.has("DolphinWeb_JitReadyBitsPtr") ? false : "the core predates off-thread compiles (CI builds this branch's core)");

test("jitoffthread: a miss is posted once and deferred, compiled once its ready byte is set, in place when the bytes changed", { skip: offThreadSkip }, async () => {
  const { default: createDolphinCore } = await import(new URL("../cores/dolphin/dolphin-core-upstream.js", import.meta.url));
  const { readFileSync } = await import("node:fs");
  const module = await createDolphinCore({ wasmBinary: readFileSync(coreWasm), noInitialRun: true, printErr: () => {} });
  // (func (param i32) (result i32) local.get 0) / i32.const 7, exported as "f"
  const head = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00, 0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, 0x0a];
  const a = Uint8Array.from([...head, 0x06, 0x01, 0x04, 0x00, 0x20, 0x00, 0x0b]);
  const b = Uint8Array.from([...head, 0x06, 0x01, 0x04, 0x00, 0x41, 0x07, 0x0b]);
  const posted = [];
  const savedSelf = globalThis.self;
  // Only compile requests: each in-place compile also posts the bytes for
  // the persistent cache (dolphin-jit-new-compile), as before.
  globalThis.self = { postMessage: (message) => { if (message.type === "dolphin-jit-compile-request") posted.push(message); } };
  module._dolphinJitCache = new Map(); // the pthread cache the persistent JIT cache installs
  const compile = (bytes, inPlace = false) => {
    const ptr = module._malloc(bytes.length);
    module.HEAPU8.set(bytes, ptr);
    try {
      return inPlace ? module._DolphinWeb_JitCompileBytesInPlaceForTest(ptr, bytes.length) : module._DolphinWeb_JitCompileBytesForTest(ptr, bytes.length);
    } finally {
      module._free(ptr);
    }
  };
  try {
    module._SetPpcWasmJitOffThread(1);
    assert.equal(compile(a), -3, "deferred");
    assert.equal(compile(a), -3, "still deferred");
    assert.equal(posted.length, 1, "posted once");
    const [request] = posted;
    assert.equal(request.type, "dolphin-jit-compile-request");
    assert.equal(request.kind, "block");
    assert.deepEqual(Array.from(request.bytes), Array.from(a));
    assert.equal(request.readyPtr, module._DolphinWeb_JitReadyBitsPtr());
    assert.equal(request.readySlot, parseInt(request.key.slice(-64, -60), 16));
    assert.equal(module.HEAPU8[request.readyPtr + request.readySlot], 0);
    // discio: compiled, warmed and retained (or failed) -> 1
    Atomics.store(module.HEAPU8, request.readyPtr + request.readySlot, 1);
    assert.ok(compile(a) > 0, "ready: compiled synchronously");
    // The block's bytes changed before its retry: compiled in place, not deferred.
    assert.ok(compile(b, true) > 0, "changed bytes compile in place");
    assert.equal(posted.length, 1, "nothing posted for the in-place retry");
    // A 1 left in a slot by another key is read while clearing it (-4: the
    // caller lets that slot's waiters retry), never silently lost.
    const c = Uint8Array.from([...head, 0x06, 0x01, 0x04, 0x00, 0x41, 0x0b, 0x0b]);
    const posts = posted.length;
    // c's slot from its request; then a colliding key's 1 lands there and c
    // is posted again (fresh in-flight set, as after a cache clear).
    assert.equal(compile(c), -3);
    const slotOfC = posted[posts].readySlot;
    globalThis._dolphinJitInflight?.clear();
    Atomics.store(module.HEAPU8, request.readyPtr + slotOfC, 1);
    assert.equal(compile(c), -4, "the cleared 1 is reported");
    assert.equal(module.HEAPU8[request.readyPtr + slotOfC], 0);
    // Off: compiled in place as before.
    module._SetPpcWasmJitOffThread(0);
    assert.ok(compile(Uint8Array.from([...head, 0x06, 0x01, 0x04, 0x00, 0x41, 0x09, 0x0b])) > 0);
    assert.equal(posted.length, posts + 2);
  } finally {
    module._SetPpcWasmJitOffThread(0);
    globalThis.self = savedSelf;
  }
});

const layoutSkip = skip || (core.has("DolphinWeb_JitStateLayout") ? false : "the core predates region modules (CI builds this branch's core)");

test("the state layout export gives distinct, aligned pc, npc and downcount offsets", { skip: layoutSkip }, () => {
  const [pc, npc, downcount, version] = core.stateLayout();
  assert.equal(version, 1);
  assert.equal(npc, pc + 4, "npc follows pc in PowerPCState");
  for (const offset of [pc, npc, downcount]) assert.equal(offset % 4, 0);
  assert.notEqual(downcount, pc);
});
