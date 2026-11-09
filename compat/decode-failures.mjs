#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// The machine reports carry each hwtest failure message as an FNV-1a hash
// (compat/homebrew/hwtests-report.cpp). This recovers the text by formatting
// the hwtest's own message template (fmt syntax, source at the pinned commit)
// over its parameters and matching the hash: the notes of
// compat/machine-expected.json can be checked against it.
//
//   node compat/decode-failures.mjs    prints every decodable failure of machine-expected.json

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function fnv(text) {
  let h = 2166136261;
  for (const c of Buffer.from(text)) { h ^= c; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const nextUp = (x) => { f32[0] = x; u32[0] += 1; return f32[0]; };

// Candidate messages per program, as the hwtest formats them.
const CANDIDATES = {
  // gxtest/clipping.cpp:219-226 (step, test_x, test_y; shown or hidden).
  * gxtest_clipping() {
    for (let step = 0; step < 32; step++) for (let x = 0; x < 200; x++) for (let y = 0; y < 50; y++)
      for (const v of ["shown", "hidden"])
        yield `Clipping test failed at step ${step} (expected quad to be ${v} at pixel (${x}, ${y}), but it was not)`;
  },
  // gxtest/rasterization.cpp:69-72 and 116-119: the two sub-pixel sweeps
  // ({:.6f} and {:.12f} of a float), result and expectation 0 or 255.
  * gxtest_rasterization() {
    const sweeps = [[0.583328247070, 0.583328306675, 6], [0.583297669888, 0.583328306675, 12]];
    for (const [a, b, prec] of sweeps) {
      for (let x = Math.fround(a); x <= Math.fround(b); x = nextUp(x)) {
        const sub = Math.trunc(Math.fround(x * 12)) % 12;
        for (const res of [0, 255]) for (const exp of [0, 255])
          yield `Incorrect rasterization (result=${res},expected=${exp},screencoord=${x.toFixed(prec)},subsample_index=${sub})`;
      }
    }
  }
};

/** Map hash -> message for the hashes asked, over the program's candidates. */
export function decode(program, hashes) {
  const want = new Set(hashes);
  const found = new Map();
  const gen = CANDIDATES[program];
  if (!gen) return found;
  for (const text of gen()) {
    const h = fnv(text);
    if (want.has(h) && !found.has(h)) found.set(h, text);
    if (found.size === want.size) break;
  }
  return found;
}

export const decodable = () => Object.keys(CANDIDATES);

async function main() {
  const expected = JSON.parse(readFileSync(new URL("./machine-expected.json", import.meta.url), "utf8")).programs;
  for (const program of decodable()) {
    for (const [config, want] of Object.entries(expected[program] ?? {})) {
      const texts = decode(program, want.failures.map((f) => f[2]));
      for (const [test, line, hash] of want.failures) console.log(`${program} ${config} ${test}:${line} ${hash} ${texts.get(hash) ?? "(not decoded)"}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
