// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// The wasm features the JIT's generated code relies on, tested by the engine
// itself (WebAssembly.validate of a one-function module each), so a missing
// one turns its user off instead of failing every module it emits:
// - simd: v128 ops in blocks and regions (0141, 0143). The core itself is
//   built with -msimd128: without SIMD it does not load at all, so this one is
//   reported only.
// - tailCall: return_call / return_call_indirect, which region fragments and
//   the region assembler's stubs are made of. Without them every region
//   module fails to compile: regions stay off and the CPU runs on blocks.
// Relaxed SIMD (relaxed_madd) has its own probe, which also checks that it is
// fused (relaxed-madd-probe.js).

const header = [0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
const section = (id, bytes) => [id, bytes.length, ...bytes];
const module = (type, body) => new Uint8Array([
  ...header,
  ...section(1, [1, ...type]),
  ...section(3, [1, 0]),
  ...section(10, [1, body.length, ...body])
]);

// (func (result v128) (v128.const i64x2 0 0))
const SIMD = module([0x60, 0, 1, 0x7b], [0x00, 0xfd, 0x0c, ...new Array(16).fill(0), 0x0b]);
// (func (return_call 0))
const TAIL_CALL = module([0x60, 0, 0], [0x00, 0x12, 0x00, 0x0b]);

export function probeWasmFeatures(wasm = globalThis.WebAssembly) {
  const valid = (bytes) => {
    try {
      return wasm.validate(bytes) === true;
    } catch {
      return false;
    }
  };
  return { simd: valid(SIMD), tailCall: valid(TAIL_CALL) };
}

// For tests: the probe modules, valid where the feature is.
export const PROBE_MODULES_FOR_TEST = { simd: SIMD, tailCall: TAIL_CALL };
