// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Patch 0129: does f64x2.relaxed_madd round once here (a fused multiply-add,
// as std::fma), so the JIT can use it for PowerPC fmadd and its kin? Relaxed
// SIMD lets an engine pick fused or unfused per machine (V8: fused on ARM64,
// and on x64 with FMA3); Safari has no relaxed SIMD and fails to compile it.
// The only place the page decides: "fused" turns it on in the core, anything
// else keeps the plain-f64 path (bit-identical everywhere, slower).

// (func (param f64 f64 f64) (result f64)
//   (f64x2.extract_lane 0 (f64x2.relaxed_madd (splat a) (splat c) (splat b))))
const BODY = [0x00,
  0x20, 0, 0xfd, 0x14, 0x20, 1, 0xfd, 0x14, 0x20, 2, 0xfd, 0x14,
  0xfd, 0x87, 0x02, 0xfd, 0x21, 0, 0x0b];
const MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  1, 8, 1, 0x60, 3, 0x7c, 0x7c, 0x7c, 1, 0x7c,
  3, 2, 1, 0,
  7, 5, 1, 1, 0x66, 0, 0,
  10, BODY.length + 2, 1, BODY.length, ...BODY]);

// a * c + b, rounded once and rounded twice (product, then sum).
const CASES = [
  [1 + 2 ** -30, 1 - 2 ** -30, -1, -(2 ** -60), 0],
  [0.1, 10, -1, 5.551115123125783e-17, 0]
];

export function probeRelaxedMadd(wasm = globalThis.WebAssembly) {
  let f;
  try {
    f = new wasm.Instance(new wasm.Module(MODULE)).exports.f;
  } catch {
    return "unsupported";
  }
  const got = CASES.map(([a, c, b]) => f(a, c, b));
  if (got.every((r, i) => Object.is(r, CASES[i][3]))) return "fused";
  if (got.every((r, i) => Object.is(r, CASES[i][4]))) return "unfused";
  return "inconsistent";
}
