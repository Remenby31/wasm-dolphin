// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests cputest/fctiwz.cpp: convert to integer word,
// round toward zero, whole 64-bit result (values measured on hardware).
import { makeState, ppc, read, hex64, BLR } from "../../lib/ppc.mjs";

export const source = "cputest/fctiwz.cpp";

const VALUES = [
  [0x0000000000000000n, 0xfff8000000000000n], // +0
  [0x8000000000000000n, 0xfff8000100000000n], // -0 (!)
  [0x0000000000000001n, 0xfff8000000000000n], // smallest positive subnormal
  [0x000fffffffffffffn, 0xfff8000000000000n], // largest subnormal
  [0x3ff0000000000000n, 0xfff8000000000001n], // +1
  [0xbff0000000000000n, 0xfff80000ffffffffn], // -1
  [0xc1e0000000000000n, 0xfff8000080000000n], // -(2^31)
  [0x41dfffffffc00000n, 0xfff800007fffffffn], // 2^31 - 1
  [0x7ff0000000000000n, 0xfff800007fffffffn], // +infinity
  [0xfff0000000000000n, 0xfff8000080000000n], // -infinity
  [0xfff8000000000000n, 0xfff8000080000000n], // a QNaN
  [0xfff4000000000000n, 0xfff8000080000000n] // a SNaN
];

export function cases() {
  return VALUES.map(([input, expected]) => ({
    id: `fctiwz/${hex64(input)}`,
    program: [ppc.fctiwz(1, 2), BLR],
    state: makeState({ fpr: { 2: input } }),
    check: (s) => ({ got: hex64(read.ps0(s, 1)), expected: hex64(expected) })
  }));
}
