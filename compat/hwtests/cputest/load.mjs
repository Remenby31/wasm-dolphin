// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests cputest/load.cpp: word, halfword (zero and
// sign extended) and byte loads in their D, X, update and update-indexed
// forms, with the operand roles of the hwtest's asm (which register is the
// address and which the offset, and which one the update form writes).
import { makeState, ppc, read, hex32, SCRATCH, BLR } from "../../lib/ppc.mjs";

export const source = "cputest/load.cpp";

const WORDS = [0xffffffff, 0x00000000, 0x41414141, 0x11111111];
const HALVES = [0xffff, 0xf000, 0x0000, 0x0f0f, 0xf0f0, 0x8888];
const BYTES = Array.from({ length: 256 }, (_, i) => i);

// [instruction, element size, values, form, sign extend]
// Forms: "elem" D form on &values[i] with displacement 0; "disp" D form on
// &values[0] with displacement i * size; "x:addr"/"x:off" X form whose rA is
// the address (or the offset) register.
const TESTS = [
  ["lwz", 4, WORDS, "elem"], ["lwzu", 4, WORDS, "disp"], ["lwzx", 4, WORDS, "x:off"], ["lwzux", 4, WORDS, "x:off"],
  ["lhz", 2, HALVES, "elem"], ["lhzx", 2, HALVES, "x:addr"], ["lhzu", 2, HALVES, "disp"], ["lhzux", 2, HALVES, "x:off"],
  ["lha", 2, HALVES, "disp", true], ["lhax", 2, HALVES, "x:addr", true], ["lhau", 2, HALVES, "disp", true],
  ["lhaux", 2, HALVES, "x:addr", true],
  ["lbz", 1, BYTES, "elem"], ["lbzx", 1, BYTES, "x:addr"], ["lbzu", 1, BYTES, "elem"], ["lbzux", 1, BYTES, "x:off"]
];

function bytesOf(values, size) {
  const out = [];
  for (const v of values) for (let k = size - 1; k >= 0; k--) out.push((v >>> (8 * k)) & 0xff);
  return out;
}

export function cases() {
  const out = [];
  for (const [name, size, values, form, signed] of TESTS) {
    const mem = bytesOf(values, size);
    const update = name.includes("u");
    values.forEach((v, i) => {
      const ea = SCRATCH + i * size;
      // r3 result, r4 address, r5 offset.
      let program, gpr, updated;
      if (form === "elem") {
        program = ppc[name](3, 0, 4); gpr = { 4: ea }; updated = 4;
      } else if (form === "disp") {
        program = ppc[name](3, i * size, 4); gpr = { 4: SCRATCH }; updated = 4;
      } else {
        const [ra, rb] = form === "x:addr" ? [4, 5] : [5, 4];
        program = ppc[name](3, ra, rb); gpr = { 4: SCRATCH, 5: i * size }; updated = ra;
      }
      const value = signed ? (v << 16) >> 16 : v;
      out.push({
        id: `load/${name}(${i})`,
        program: [program, BLR],
        state: makeState({ gpr, mem }),
        check: (s) => ({
          got: hex32(read.gpr(s, 3)) + (update ? ` ea=${hex32(read.gpr(s, updated))}` : ""),
          expected: hex32(value) + (update ? ` ea=${hex32(ea)}` : "")
        })
      });
    });
  }
  return out;
}
