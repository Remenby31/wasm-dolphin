// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Relaxed SIMD opcodes (0xfd prefix, 0x100..0x113 as a two-byte LEB:
// 0x80..0x93 then 0x02) in emitted wasm bytes. A byte scan, not a decoder: it
// can only over-report (an immediate that happens to hold these three bytes),
// so zero sites proves the code holds no relaxed op.
export function relaxedOpcodeSites(code) {
  const sites = [];
  for (let i = 0; i + 2 < code.length; i++) {
    if (code[i] === 0xfd && code[i + 1] >= 0x80 && code[i + 1] <= 0x93 && code[i + 2] === 0x02) sites.push(i);
  }
  return sites;
}
