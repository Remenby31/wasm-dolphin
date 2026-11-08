// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests cputest/srawix.cpp: srawi result and carry
// (read with addze) for every shift. The hwtest feeds 0x1000 rand() inputs
// per shift; this port takes INT_MIN and 63 fixed pseudo-random inputs.
import { makeState, ppc, read, hex32, BLR } from "../../lib/ppc.mjs";

export const source = "cputest/srawix.cpp";

function carry(value, shift) {
  if (shift === 0) return 0;
  return value < 0 && ((value >> shift) << shift) !== value ? 1 : 0;
}

export function cases() {
  let s = 0x5a3a;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s | 0; };
  const out = [];
  for (let shift = 0; shift < 32; shift++) {
    for (let i = 0; i < 64; i++) {
      const input = i ? next() : -0x80000000;
      out.push({
        id: `srawix/${hex32(input)} >> ${shift}`,
        program: [ppc.srawi(3, 3, shift), ppc.addze(4, 4), BLR],
        state: makeState({ gpr: { 3: input, 4: 0 } }),
        check: (st) => ({ got: `${hex32(read.gpr(st, 3))} ca=${read.gpr(st, 4)}`,
          expected: `${hex32(input >> shift)} ca=${carry(input, shift)}` })
      });
    }
  }
  return out;
}
