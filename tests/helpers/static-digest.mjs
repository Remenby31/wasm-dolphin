// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Digests of translated code that do not move with the core's static data:
// translated code embeds absolute addresses of static tables of the core
// (an i32.const the heap relocs do not cover, then an i32.add or a load or
// store), which any patch that adds static data ahead of them shifts.
// Hash each as its distance to the lowest of the sample (regshape-x64, 0195).

// Every i32.const of the code: [start, end, value, next opcode] (an 0x41 byte that is part
// of another immediate decodes the same way on every core, so the scan stays
// deterministic).
function* i32Consts(code) {
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] !== 0x41) continue;
    let v = 0, shift = 0, j = i + 1, byte = 0;
    do { byte = code[j++]; v |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80 && shift < 35 && j < code.length);
    if (shift < 32 && (byte & 0x40)) v |= -1 << shift;
    yield [i, j, v, code[j]];
  }
}
const isStatic = (v, next, { low, high }) => v >= low && v < high && (next === 0x6a || (next >= 0x28 && next <= 0x3e));
export const staticConstants = (code, range) => [...i32Consts(code)].filter(([, , v, next]) => isStatic(v, next, range)).map(([, , v]) => v);
export function staticNormalizedCode(code, { low, high, base }) {
  const out = [];
  let at = 0;
  for (const [i, j, v, next] of i32Consts(code)) {
    if (i < at || !isStatic(v, next, { low, high })) continue;
    out.push(...code.subarray(at, i), 0x41, ...Buffer.from(`static+${v - base};`));
    at = j;
  }
  out.push(...code.subarray(at));
  return Uint8Array.from(out);
}
