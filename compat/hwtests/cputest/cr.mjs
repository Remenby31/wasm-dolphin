// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests cputest/cr.cpp: cmpwi into cr0 with XER[SO]
// set or clear, then one crset/crclr on a cr0 bit, read back with mfcr.
import { makeState, ppc, read, BLR } from "../../lib/ppc.mjs";

export const source = "cputest/cr.cpp";

const VALUES = [[0, 0b0010], [10, 0b0100], [-10, 0b1000]];
// [name, instruction or null, bit (PowerPC order), set]
const MODS = [["none", null], ["SetLT", 0, 1], ["ClearLT", 0, 0], ["SetGT", 1, 1], ["ClearGT", 1, 0],
  ["SetEQ", 2, 1], ["ClearEQ", 2, 0], ["SetSO", 3, 1], ["ClearSO", 3, 0]];

export function cases() {
  const out = [];
  for (const [input, flags] of VALUES) {
    for (const [mod, bit, set] of MODS) {
      for (const so of [0, 1]) {
        let expected = flags | so;
        const program = [ppc.mtspr(1, 4), ppc.cmpwi(0, 3, 0)];
        if (mod !== "none") {
          program.push(set ? ppc.crset(bit) : ppc.crclr(bit));
          const mask = 1 << (3 - bit);
          expected = set ? expected | mask : expected & ~mask;
        }
        program.push(ppc.mfcr(5), BLR);
        out.push({
          id: `cr/cmpwi(${input}) ${mod} so=${so}`,
          program,
          state: makeState({ gpr: { 3: input, 4: so << 31 } }),
          check: (s) => ({ got: `0b${(read.gpr(s, 5) >>> 28).toString(2).padStart(4, "0")}`,
            expected: `0b${expected.toString(2).padStart(4, "0")}` })
        });
      }
    }
  }
  return out;
}
