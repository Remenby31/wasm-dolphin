// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests cputest/fctiw.cpp: convert to integer word in
// each FPSCR[RN] mode, against the reference of the Programming Environments
// Manual, appendix C.4.2, as the hwtest adapted it to Broadway (bit 32 set
// for negative zeroes). The hwtest walks ~2^31 single inputs per mode; this
// port takes a fixed sample of the same input families (exact integers,
// one ulp above, .5 and its neighbours, the next integer minus one ulp, both
// signs; then large values up to 2^31 and beyond).
import { makeState, ppc, read, hex64, hex32, bitsOfDouble, bitsOfFloat, floatOfBits, BLR } from "../../lib/ppc.mjs";

export const source = "cputest/fctiw.cpp";

const MODES = ["Nearest", "TowardsZero", "TowardsPositiveInfinity", "TowardsNegativeInfinity"];

export function fctiwExpected(b, mode) {
  const upper = 0xfff8000000000000n;
  if (Number.isNaN(b)) return upper | 0x80000000n;
  const bi = bitsOfDouble(b);
  const sign = Number(bi >> 63n);
  let exp = Number((bi >> 52n) & 0x7ffn);
  let frac = BigInt.asUintN(64, (bi & 0xfffffffffffffn) << 11n);
  if (exp > 0) frac |= 1n << 63n;
  exp = exp > 0 ? exp - 1023 : -1022;
  let g = false, r = false, x = false;
  for (let i = 0; i < 63 - exp; i++) {
    x ||= r; r = g; g = (frac & 1n) === 1n; frac >>= 1n;
  }
  let inc = 0n;
  if (mode === 0 && g && ((frac & 1n) === 1n || r || x)) inc = 1n;
  if (mode === 2 && !sign && (g || r || x)) inc = 1n;
  if (mode === 3 && sign && (g || r || x)) inc = 1n;
  frac = BigInt.asUintN(64, frac + inc);
  if (!sign && frac > 0x7fffffffn) frac = 0x7fffffffn;
  else if (frac > 0x80000000n) frac = 0x80000000n;
  else if (sign) frac = BigInt((~Number(frac & 0xffffffffn)) >>> 0) + 1n;
  return upper | frac;
}

// xorshift32 with a fixed seed: the same sample on every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}

function inputs() {
  const next = rng(0xfc71);
  const smallEnd = 0x200000;
  const small = [0, 1, 2, 3, 4, 5, 6, 7, 8, 0x1fffff];
  for (let k = 0; k < 24; k++) small.push(next() % smallEnd);
  const out = new Set();
  for (const i of small) {
    const zero = bitsOfFloat(i), half = bitsOfFloat(Math.fround(i) + 0.5), one = bitsOfFloat(i + 1);
    for (const v of [zero, zero + 1, half - 1, half, half + 1, one - 1]) out.add(v >>> 0);
  }
  const largeStart = bitsOfFloat(smallEnd), largeEnd = bitsOfFloat(0x80000000 + (1 << 22));
  for (const v of [largeStart, largeEnd - 1, bitsOfFloat(0x7fffff80), bitsOfFloat(0x80000000)]) out.add(v >>> 0);
  for (let k = 0; k < 24; k++) out.add((largeStart + (next() % (largeEnd - largeStart))) >>> 0);
  return [...out].flatMap((v) => [v, (v | 0x80000000) >>> 0]);
}

export function cases() {
  const list = inputs();
  return MODES.flatMap((mode, rn) => list.map((i) => {
    const input = floatOfBits(i);
    const expected = fctiwExpected(input, rn);
    return {
      id: `fctiw/${hex32(i)} RN=${rn}`,
      program: [ppc.fctiw(1, 2), BLR],
      state: makeState({ fpscr: rn, fpr: { 2: bitsOfDouble(input) } }),
      check: (s) => ({ got: hex64(read.ps0(s, 1)), expected: hex64(expected) })
    };
  }));
}
