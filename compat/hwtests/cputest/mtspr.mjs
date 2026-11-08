// Copyright 2013 Dolphin Emulator Project (hwtests), 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-only
// Port of dolphin-emu/hwtests cputest/mtspr.cpp: reserved bits of GQR and XER
// read back after writing all ones (values measured on hardware).
import { makeState, ppc, read, hex32, BLR } from "../../lib/ppc.mjs";

export const source = "cputest/mtspr.cpp";

export function cases() {
  const one = (name, spr, expected) => ({
    id: `mtspr/${name}`,
    program: [ppc.li(3, -1), ppc.mtspr(spr, 3), ppc.mfspr(3, spr), BLR],
    state: makeState(),
    check: (s) => ({ got: hex32(read.gpr(s, 3)), expected: hex32(expected) })
  });
  return [one("GQRUnusedBits", 914, 0xffffffff), one("XERUnusedBits", 1, 0xe000ff7f)];
}
