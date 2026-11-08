// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests cputest/reciprocal.cpp: frsqrte and fres
// against the estimate tables (Common/FloatUtils.h, compat/lib/float-ref.mjs)
// for doubles whose low word is zero. The hwtest walks all 2^32 high words
// and compares fres with the NI=1 model; this port takes 4096 evenly spaced
// high words plus 1024 pseudo-random ones, with FPSCR[NI] set.
import { makeState, ppc, read, hex64, BLR } from "../../lib/ppc.mjs";
import { fresExpected, frsqrteExpected } from "../../lib/float-ref.mjs";

export const source = "cputest/reciprocal.cpp";

function highWords() {
  const out = new Set();
  for (let k = 0; k < 4096; k++) out.add((k * 0x100000 + (k & 0xff)) >>> 0);
  let s = 0x7ec1;
  for (let k = 0; k < 1024; k++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out.add(s); }
  return [...out];
}

export function cases() {
  const out = [];
  for (const hi of highWords()) {
    const input = BigInt(hi) << 32n;
    const state = () => makeState({ fpscr: 0b100, fpr: { 2: input } });
    out.push({
      id: `reciprocal/frsqrte ${hex64(input)}`,
      program: [ppc.frsqrte(1, 2), BLR], state: state(),
      check: (s) => ({ got: hex64(read.ps0(s, 1)), expected: hex64(frsqrteExpected(input)) })
    });
    out.push({
      id: `reciprocal/fres ${hex64(input)}`,
      program: [ppc.fres(1, 2), BLR], state: state(),
      check: (s) => ({ got: hex64(read.ps0(s, 1)), expected: hex64(fresExpected(input, true)) })
    });
  }
  return out;
}
