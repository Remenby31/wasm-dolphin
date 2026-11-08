// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests cputest/rlw.cpp: rlwimi, rlwinm and rlwnm over
// the hwtest's shift and mask grid, against the architectural result.
import { makeState, ppc, read, hex32, BLR } from "../../lib/ppc.mjs";

export const source = "cputest/rlw.cpp";

function mask(mb, me) {
  const begin = 0xffffffff >>> mb;
  const end = me < 31 ? 0xffffffff >>> (me + 1) : 0;
  const m = (begin ^ end) >>> 0;
  return me < mb ? ~m >>> 0 : m;
}
const rotl = (v, sh) => (sh ? ((v << sh) | (v >>> (32 - sh))) >>> 0 : v >>> 0);
const GRID = [[0, 0, 0], [0, 0, 15], [0, 0, 31], [0, 15, 0], [0, 15, 15], [0, 15, 31], [0, 31, 0],
  [15, 0, 0], [15, 0, 15], [15, 0, 31], [15, 15, 0], [15, 15, 15], [15, 15, 31], [15, 31, 0], [15, 31, 15], [15, 31, 31],
  [31, 0, 0], [31, 0, 15], [31, 0, 31], [31, 15, 0], [31, 15, 15], [31, 15, 31], [31, 31, 0], [31, 31, 15], [31, 31, 31]];
const VALUES = [0xffffffff, 0x44444444, 0x41414141, 0x12345678, 0x90abcdef];
const PAIRS = [[0xffffffff, 0x41414141], [0x44444444, 0xffffffff], [0x41414141, 0x22222222]];
const NM = [0, 7, 15, 23, 31];

export function cases() {
  const out = [];
  const one = (id, program, gpr, expected) => out.push({
    id, program: [program, BLR], state: makeState({ gpr }),
    check: (s) => ({ got: hex32(read.gpr(s, 3)), expected: hex32(expected) })
  });
  for (const [sh, mb, me] of GRID)
    for (const [a, sv] of PAIRS)
      one(`rlwimi/${hex32(a)} ${hex32(sv)} ${sh},${mb},${me}`, ppc.rlwimi(3, 4, sh, mb, me), { 3: a, 4: sv },
        ((a & ~mask(mb, me)) | (rotl(sv, sh) & mask(mb, me))) >>> 0);
  for (const [sh, mb, me] of GRID)
    for (const v of VALUES)
      one(`rlwinm/${hex32(v)} ${sh},${mb},${me}`, ppc.rlwinm(3, 4, sh, mb, me), { 4: v }, (rotl(v, sh) & mask(mb, me)) >>> 0);
  for (const mb of NM)
    for (const me of NM)
      for (let sh = 0; sh < 32; sh++)
        for (const v of VALUES)
          one(`rlwnm/${hex32(v)} ${sh},${mb},${me}`, ppc.rlwnm(3, 4, 5, mb, me), { 4: v, 5: sh }, (rotl(v, sh) & mask(mb, me)) >>> 0);
  return out;
}
