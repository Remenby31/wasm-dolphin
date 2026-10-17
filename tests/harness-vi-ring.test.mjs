// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { readViRing, VI_ENTRY_BYTES } from "../src/harness-vi-ring.js";

// A ring of `capacity` slots after `written` entries, laid out like the core's.
function ring(capacity, written, { tamper = null } = {}) {
  const buffer = new ArrayBuffer(64 + capacity * VI_ENTRY_BYTES);
  const f64 = new Float64Array(buffer), u32 = new Uint32Array(buffer);
  for (let n = 0; n < written; n += 1) {
    const base = 64 + (n % capacity) * VI_ENTRY_BYTES;
    f64[base >> 3] = 1000 + n * 16.7;
    u32[(base + 8) >> 2] = n * 8100000;
    u32[(base + 16) >> 2] = n + 1;
    u32[(base + 20) >> 2] = n + 1;
  }
  if (tamper) tamper(u32);
  return { buffer, ptr: 64, capacity, head: written };
}

test("every entry since the last read, in order", () => {
  const r = readViRing({ ...ring(16, 10), read: 4 });
  assert.deepEqual(r.sinceBoot, [5, 6, 7, 8, 9, 10]);
  assert.equal(r.lost, 0);
});

// Review round 4: 8192 entries behind, the reader returned 8193, 2, 3, … with
// lost: 0. The lapped entries are now counted as lost.
test("round 4: a lapped ring reports what it lost instead of misreading it", () => {
  const r = readViRing({ ...ring(8, 20), read: 0 });
  assert.equal(r.lost, 12);
  assert.deepEqual(r.sinceBoot, [13, 14, 15, 16, 17, 18, 19, 20]);
  // An entry overwritten during the read breaks the sequence: dropped, counted.
  const torn = ring(8, 20, { tamper: (u32) => { u32[(64 + (15 % 8) * VI_ENTRY_BYTES + 16) >> 2] = 23; } });
  const t = readViRing({ ...torn, read: 12 });
  assert.equal(t.lost, 1);
  assert.equal(t.sinceBoot.includes(23), false);
});
