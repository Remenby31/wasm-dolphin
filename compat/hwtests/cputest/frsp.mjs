// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests cputest/frsp.cpp: round to single precision
// under FPSCR[NI] and FPSCR[RN] (values measured on hardware).
import { makeState, ppc, read, hex64, BLR } from "../../lib/ppc.mjs";

export const source = "cputest/frsp.cpp";

// input, expected output, NI RN
const VALUES = [
  [0x0000000000000000n, 0x0000000000000000n, 0b000], // +0
  [0x8000000000000000n, 0x8000000000000000n, 0b000], // -0
  [0x0000000000000001n, 0x0000000000000000n, 0b000], // smallest positive double subnormal
  [0x000fffffffffffffn, 0x0000000000000000n, 0b000], // largest double subnormal
  [0x3690000000000000n, 0x0000000000000000n, 0b000], // largest number rounded to zero
  [0x3690000000000001n, 0x36a0000000000000n, 0b000], // smallest positive single subnormal
  [0x380fffffe0000001n, 0x0000000000000000n, 0b110], // boundary of architecture-dependent behavior in non-IEEE mode
  [0x380ffffff0000000n, 0x0000000000000000n, 0b100], // boundary of architecture-dependent behavior in non-IEEE mode
  [0x380fffffffffffffn, 0x0000000000000000n, 0b100], // largest single subnormal
  [0x3810000000000000n, 0x3810000000000000n, 0b100], // smallest positive single normal
  [0xb80fffffe0000001n, 0x8000000000000000n, 0b111], // boundary of architecture-dependent behavior in non-IEEE mode
  [0xb80ffffff0000000n, 0x8000000000000000n, 0b100], // boundary of architecture-dependent behavior in non-IEEE mode
  [0xb80fffffffffffffn, 0x8000000000000000n, 0b100], // smallest single subnormal
  [0xb810000000000000n, 0xb810000000000000n, 0b100], // largest negative single normal
  [0x7ff0000000000000n, 0x7ff0000000000000n, 0b000], // +infinity
  [0xfff0000000000000n, 0xfff0000000000000n, 0b000], // -infinity
  [0xfff7ffffffffffffn, 0xffffffffe0000000n, 0b000], // a SNaN
  [0xffffffffffffffffn, 0xffffffffe0000000n, 0b000] // a QNaN
];

export function cases() {
  return VALUES.map(([input, expected, niRn]) => ({
    id: `frsp/${hex64(input)} NI=${niRn >> 2} RN=${niRn & 3}`,
    program: [ppc.frsp(1, 2), BLR],
    state: makeState({ fpscr: niRn, fpr: { 2: input } }),
    check: (s) => ({ got: hex64(read.ps0(s, 1)), expected: hex64(expected) })
  }));
}
