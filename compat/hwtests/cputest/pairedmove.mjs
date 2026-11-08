// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests cputest/pairedmove.cpp: after lfd, Broadway's
// paired-single moves (ps_merge, ps_mr, ps_neg, ps_abs, ps_nabs, ps_sel,
// ps_sum0/1) round ps0's mantissa to single precision in the FPSCR[RN] mode
// and truncate ps1's; ps_res and ps_rsqrte give the table estimates. Each
// test is the hwtest's asm block, word for word, over its 55 inputs, both
// signs, NI 0/1 and the 4 rounding modes.
import { makeState, ppc, read, hex64, BLR, SCRATCH } from "../../lib/ppc.mjs";
import { DOUBLE_SIGN, fresExpected, frsqrteExpected, roundMantissaBits, roundMantissaBitsAssumeFinite,
  truncateMantissaBits } from "../../lib/float-ref.mjs";

export const source = "cputest/pairedmove.cpp";

export const INPUTS = [
  0x0000000000000000n, 0x3ff0000000000000n, 0x3fe0000000000000n, 0x3fd5555555555555n, 0x3fc999999999999an,
  0x3fc2492492492492n, 0x0000000000000001n, 0x36a0000000000000n, 0x3690000000000000n, 0x36a8000000000000n,
  0x36a8000000000000n, 0x36b0000000000000n, 0x36c0000000000000n, 0x37e0000000000000n, 0x37f0000000000000n,
  0x3800000000000000n, 0x000fffffc0000000n, 0x380fffff80000000n, 0x000fffffffffffffn, 0x001fffffffffffffn,
  0x380fffffc0000000n, 0x380fffffe0000000n, 0x380ffffff0000000n, 0x380fffffffffffffn, 0x7fefffffffffffffn,
  0x47efffffe0000000n, 0x47effffff0000000n, 0x0000000010000000n, 0x0000000010000001n, 0x000000001fffffffn,
  0x0000000020000000n, 0x0000000030000000n, 0x500fffffd0000000n, 0x500fffffd0000001n, 0x500ffffff0000000n,
  0x3fffffffffffffffn, 0x3fffffffd0000000n, 0x3fffffffe0000000n, 0x3fffffffe0000001n, 0x3fffffffffffffffn,
  0x1fffffffd0000000n, 0x1fffffffe0000000n, 0x1fffffffe0000001n, 0x47cfffffc0000000n, 0x47d0000000000000n,
  0x47e0000000000000n, 0x47f0000000000000n, 0x4800000000000000n, 0x0123456789abcdefn, 0x76543210fedcba09n,
  0x7ff0000000000000n, 0x7ff8000000000000n, 0x7ff4000000000000n, 0x7ffaaaaaaaaaaaaan, 0x7ff5555555555555n
];

const ONE = 0x3ff0000000000000n;
const bytes = (b) => Array.from({ length: 8 }, (_, k) => Number((b >> BigInt(56 - 8 * k)) & 0xffn));
const pair = (s, a, b) => `${hex64(read.ps0(s, a))} ${hex64(read.ps0(s, b))}`;

// f1/f2 (and f3/f4 for ps_sel) results, f5 = 1.0, r3 = &input.
function tests(input, rn, ni) {
  const lfd = ppc.lfd(1, 0, 3);
  const reload = (op) => [lfd, ppc.ps_merge00(1, 1, 1), ppc.isync(), lfd, ppc.isync(), op];
  const flip = (name, value) => ({
    name,
    program: [...reload(ppc[name](1, 1)), ppc.ps_merge11(2, 1, 1)],
    read: (s) => pair(s, 1, 2),
    expected: `${hex64(roundMantissaBits(value, rn))} ${hex64(truncateMantissaBits(value))}`
  });
  let resPs1 = truncateMantissaBits(fresExpected(input, ni));
  const resPs0 = resPs1;
  // A nonzero input that truncates to zero: ps1 takes the input's sign.
  const truncatesToZero = (input & 0x7fffffffe0000000n) === 0n && (input & ~DOUBLE_SIGN) !== 0n;
  if (truncatesToZero) resPs1 |= DOUBLE_SIGN;
  const rsqPs0 = truncateMantissaBits(frsqrteExpected(input));
  const rsqPs1 = truncatesToZero ? 0x7ff8000000000000n : truncateMantissaBits(frsqrteExpected(truncateMantissaBits(input)));
  return [
    { name: "ps_merge",
      program: [ppc.ps_mr(2, 2), ppc.isync(), ppc.lfd(2, 0, 3), ppc.isync(), ppc.ps_merge00(1, 2, 2), ppc.ps_merge11(2, 1, 1)],
      read: (s) => pair(s, 1, 2),
      expected: `${hex64(roundMantissaBits(input, rn))} ${hex64(truncateMantissaBits(input))}` },
    { name: "ps_mr", program: [lfd, ppc.ps_mr(1, 1)], read: (s) => hex64(read.ps0(s, 1)),
      expected: hex64(roundMantissaBits(input, rn)) },
    flip("ps_neg", input ^ DOUBLE_SIGN),
    flip("ps_abs", input & ~DOUBLE_SIGN),
    flip("ps_nabs", input | DOUBLE_SIGN),
    { name: "ps_sel",
      program: [...reload(ppc.ps_merge00(1, 1, 1)), ppc.lfd(3, 0, 3), ppc.ps_merge00(3, 3, 3), ppc.isync(), ppc.lfd(3, 0, 3),
        ppc.isync(), ppc.ps_merge00(3, 3, 3), ppc.ps_merge00(5, 5, 5), ppc.ps_sel(1, 5, 1, 5), ppc.ps_merge11(2, 1, 1),
        ppc.ps_neg(5, 5), ppc.ps_sel(3, 5, 5, 3), ppc.ps_merge11(4, 3, 3)],
      read: (s) => `${pair(s, 1, 2)} ${pair(s, 3, 4)}`,
      expected: (() => { const p = `${hex64(roundMantissaBits(input, rn))} ${hex64(truncateMantissaBits(input))}`; return `${p} ${p}`; })() },
    { name: "ps_sum0", program: [...reload(ppc.ps_sum0(1, 1, 1, 5)), ppc.ps_merge11(1, 1, 1)],
      read: (s) => hex64(read.ps0(s, 1)), expected: hex64(truncateMantissaBits(input)) },
    { name: "ps_sum1", program: reload(ppc.ps_sum1(1, 1, 1, 5)),
      read: (s) => hex64(read.ps0(s, 1)), expected: hex64(roundMantissaBitsAssumeFinite(input, rn)) },
    { name: "ps_res",
      program: [ppc.ps_mr(1, 1), lfd, ppc.ps_merge00(2, 1, 1), ppc.ps_res(1, 1), ppc.ps_res(2, 2), ppc.ps_merge11(2, 2, 2)],
      read: (s) => pair(s, 1, 2), expected: `${hex64(resPs0)} ${hex64(resPs1)}` },
    { name: "ps_rsqrte",
      program: [ppc.ps_mr(1, 1), lfd, ppc.ps_merge00(2, 1, 1), ppc.ps_rsqrte(1, 1), ppc.ps_rsqrte(2, 2), ppc.ps_merge11(2, 2, 2)],
      read: (s) => pair(s, 1, 2), expected: `${hex64(rsqPs0)} ${hex64(rsqPs1)}` }
  ];
}

export function cases() {
  const out = [];
  for (const ni of [0, 1]) {
    for (let rn = 0; rn < 4; rn++) {
      for (const sign of [0n, 1n]) {
        INPUTS.forEach((base, i) => {
          const input = base | (sign << 63n);
          for (const t of tests(input, rn, ni === 1)) {
            out.push({
              id: `pairedmove/${t.name} #${i} ${hex64(input)} NI=${ni} RN=${rn}`,
              program: [...t.program, BLR],
              state: makeState({ fpscr: (ni << 2) | rn, gpr: { 3: SCRATCH }, fpr: { 5: ONE }, mem: bytes(input) }),
              check: (s) => ({ got: t.read(s), expected: t.expected })
            });
          }
        });
      }
    }
  }
  return out;
}
