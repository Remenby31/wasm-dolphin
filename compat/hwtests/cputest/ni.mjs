// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests cputest/ni.cpp: FPSCR[NI] (non-IEEE mode)
// flushes denormal outputs to zero but not denormal inputs (measured on
// hardware). Each check is the instruction the hwtest's C expression compiles to.
import { makeState, ppc, read, hex64, hex32, bitsOfDouble, doubleOfBits, bitsOfFloat, doubleBitsOfFloatBits, BLR } from "../../lib/ppc.mjs";

export const source = "cputest/ni.cpp";

const zero = 0n;
const smallestDenormal = 1n;
const large = 0x7fefffffffffffffn;
const product = 0x3ccfffffffffffffn;
const smallestNormal = 0x0010000000000000n;
const divisor = 0x4330000000000000n;
const oneMinusUlp = 0x3fefffffffffffffn;
const smallestNormalSingle = 0x00800000;
const oneMinusUlpSingle = 0x3f7fffff;

export function cases() {
  const out = [];
  for (const ni of [0, 1]) {
    const fpscr = ni << 2;
    const flushOut = ni === 1;
    const fpr = { 1: zero, 2: smallestDenormal, 4: large, 5: smallestNormal, 6: divisor, 7: oneMinusUlp,
      8: doubleBitsOfFloatBits(smallestNormalSingle), 9: doubleBitsOfFloatBits(oneMinusUlpSingle) };
    const state = () => makeState({ fpscr, fpr });
    out.push({
      id: `ni/compare zero >= denormal NI=${ni}`,
      program: [ppc.fcmpu(0, 1, 2), ppc.mfcr(3), BLR],
      state: state(),
      check: (s) => ({ got: String(((read.gpr(s, 3) >>> 28) & 0b0110) !== 0), expected: "false" })
    });
    const f = (name, program, expected) => out.push({
      id: `ni/${name} NI=${ni}`, program: [...program, BLR], state: state(),
      check: (s) => ({ got: hex64(read.ps0(s, 3)), expected: hex64(expected) })
    });
    f("multiply denormal by large", [ppc.fmul(3, 2, 4)], product);
    f("divide smallest normal by normal", [ppc.fdiv(3, 5, 6)], flushOut ? zero : smallestDenormal);
    f("multiply smallest normal by 1 minus ulp", [ppc.fmul(3, 5, 7)], flushOut ? zero : smallestNormal);
    out.push({
      id: `ni/multiply smallest normal single by 1 minus ulp NI=${ni}`,
      program: [ppc.fmuls(3, 8, 9), BLR],
      state: state(),
      check: (s) => ({ got: hex32(bitsOfFloat(doubleOfBits(read.ps0(s, 3)))),
        expected: hex32(flushOut ? 0 : smallestNormalSingle) })
    });
  }
  return out;
}
