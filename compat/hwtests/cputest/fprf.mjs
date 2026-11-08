// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests cputest/fprf.cpp: FPSCR[FPRF] after fadd(s)
// and after fcmpo (with the C bit set or clear beforehand), and cr0 after
// fcmpo (values measured on hardware). Dolphin computes FPRF only when
// Config::MAIN_FPRF is on (off by default): `fprf` runs with it on,
// `fprf@default` with the core's default.
import { makeState, ppc, read, hex32, bitsOfDouble, bitsOfFloat, doubleBitsOfFloatBits, BLR } from "../../lib/ppc.mjs";

export const source = "cputest/fprf.cpp";

const VALUES = [
  ["QNaN", NaN, 0b10001, 0b0001],
  ["-inf", -Infinity, 0b01001, 0b1000],
  ["-1", -1, 0b01000, 0b1000],
  ["-denorm_min", "-dmin", 0b11000, 0b1000],
  ["-0", -0, 0b10010, 0b0010],
  ["+0", 0, 0b00010, 0b0010],
  ["denorm_min", "dmin", 0b10100, 0b0100],
  ["1", 1, 0b00100, 0b0100],
  ["+inf", Infinity, 0b00101, 0b0100]
];

const bin = (v, n) => `0b${v.toString(2).padStart(n, "0")}`;

export function makeCases(suite, config) {
  const out = [];
  for (const single of [false, true]) {
    const w = single ? "single" : "double";
    // A float argument sits in the FPR as its double widening.
    const enc = (v) => {
      if (v === "dmin" || v === "-dmin") {
        const b = single ? doubleBitsOfFloatBits(1) : 1n;
        return v[0] === "-" ? b | (1n << 63n) : b;
      }
      return single ? doubleBitsOfFloatBits(bitsOfFloat(v)) : bitsOfDouble(v);
    };
    const add = single ? ppc.fadds : ppc.fadd;
    for (const [name, v, arith, compare] of VALUES) {
      // f1 input, f2 -0, f5 the value that sets C, f6 +0.
      const state = (c) => makeState({ fpr: { 1: enc(v), 2: enc(-0), 5: enc(c ? NaN : 0), 6: enc(0) } });
      out.push({
        id: `${suite}/${w} arith ${name}`, config,
        program: [add(3, 1, 2), ppc.mffs(4), BLR], state: state(false),
        check: (s) => ({ got: bin((Number(read.ps0(s, 4) & 0xffffffffn) >>> 12) & 0x1f, 5), expected: bin(arith, 5) })
      });
      for (const c of [false, true]) {
        const program = [add(3, 5, 6), ppc.fcmpo(0, 1, 2), ppc.mffs(4), ppc.mfcr(3), BLR];
        out.push({
          id: `${suite}/${w} compare cr ${name} c=${+c}`, config, program, state: state(c),
          check: (s) => ({ got: bin(read.gpr(s, 3) >>> 28, 4), expected: bin(compare, 4) })
        });
        out.push({
          id: `${suite}/${w} compare fprf ${name} c=${+c}`, config, program, state: state(c),
          check: (s) => ({ got: bin((Number(read.ps0(s, 4) & 0xffffffffn) >>> 12) & 0x1f, 5),
            expected: bin(compare | (c ? 0x10 : 0), 5) })
        });
      }
    }
  }
  return out;
}

export const cases = () => makeCases("fprf", { fprf: true });
