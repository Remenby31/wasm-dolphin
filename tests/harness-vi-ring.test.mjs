// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { readSwapRing, readViRing, SWAP_UNKNOWN, VI_ENTRY_BYTES } from "../src/harness-vi-ring.js";

// A ring of `capacity` slots after `written` entries, laid out like the core's.
function ring(capacity, written) {
  const buffer = new ArrayBuffer(64 + capacity * VI_ENTRY_BYTES);
  const f64 = new Float64Array(buffer), u32 = new Uint32Array(buffer);
  for (let n = 0; n < written; n += 1) {
    const base = 64 + (n % capacity) * VI_ENTRY_BYTES;
    u32[base >> 2] = 2 * (n + 1);
    u32[(base + 4) >> 2] = n + 1;
    f64[(base + 8) >> 3] = 1000 + n * 16.7;
    u32[(base + 16) >> 2] = n * 8100000;
    u32[(base + 24) >> 2] = n + 1;
  }
  return { buffer, u32, ptr: 64, capacity, head: written, slot: (n) => 64 + (n % capacity) * VI_ENTRY_BYTES };
}

test("every entry since the last read, in order", () => {
  const r = readViRing({ ...ring(16, 10), read: 4 });
  assert.deepEqual(r.sinceBoot, [5, 6, 7, 8, 9, 10]);
  assert.equal(r.lost, 0);
});

test("a lapped ring reports what it lost instead of misreading it", () => {
  const r = readViRing({ ...ring(8, 20), read: 0 });
  assert.equal(r.lost, 12);
  assert.deepEqual(r.sinceBoot, [13, 14, 15, 16, 17, 18, 19, 20]);
});

// Final review: an entry half written by the core (seq odd, fields partly
// new) was accepted with lost: 0. The per-entry seqlock rejects it.
test("final review: a partially written entry is lost, never returned", () => {
  const r = ring(8, 20);
  // Entry 15 (slot 7) is being overwritten by entry 23: seq odd, fields mixed.
  r.u32[r.slot(15) >> 2] = 2 * 23 + 1;
  r.u32[(r.slot(15) + 4) >> 2] = 23;
  const out = readViRing({ ...r, read: 12 });
  assert.equal(out.lost, 1);
  assert.deepEqual(out.sinceBoot, [13, 14, 15, 17, 18, 19, 20]); // entry 15 (sinceBoot 16) dropped
  // Completed by another entry (even seq, wrong value): lapped, lost too.
  const lapped = ring(8, 20);
  lapped.u32[lapped.slot(15) >> 2] = 2 * 24;
  assert.equal(readViRing({ ...lapped, read: 12 }).lost, 1);
});

// Patch 0214: the swap ring, laid out like the core's (DolphinWebHarnessSwapEntry).
function swapRing(entries, { capacity = 8, read = 0 } = {}) {
  const buffer = new ArrayBuffer(64 + capacity * VI_ENTRY_BYTES);
  const f64 = new Float64Array(buffer), u32 = new Uint32Array(buffer);
  entries.forEach((e, n) => {
    const base = 64 + (n % capacity) * VI_ENTRY_BYTES;
    u32[base >> 2] = 2 * (n + 1);
    u32[(base + 4) >> 2] = e.vi;
    f64[(base + 8) >> 3] = e.t;
    u32[(base + 16) >> 2] = e.behind;
    u32[(base + 20) >> 2] = e.fifoBytes;
    u32[(base + 24) >> 2] = e.flags;
  });
  return { buffer, ptr: 64, capacity, head: entries.length, read };
}

test("swap ring: fields and flags; an unknown FIFO value is null, never 0", () => {
  const r = readSwapRing(swapRing([
    { vi: 7, t: 1000.5, behind: 3, fifoBytes: 96, flags: 0 },
    { vi: 8, t: 1017.25, behind: 0, fifoBytes: 0, flags: 1 },
    { vi: 9, t: 1034, behind: SWAP_UNKNOWN, fifoBytes: SWAP_UNKNOWN, flags: 3 }
  ]));
  assert.deepEqual(r.vi, [7, 8, 9]);
  assert.deepEqual(r.t, [1000.5, 1017.25, 1034]);
  assert.deepEqual(r.behind, [3, 0, null]);
  assert.deepEqual(r.fifoBytes, [96, 0, null]);
  assert.deepEqual(r.fresh, [false, true, true]);
  assert.deepEqual(r.held, [false, false, true]);
  assert.equal(r.lost, 0);
});

test("swap ring: a half-written entry is lost, never returned", () => {
  const ring = swapRing([{ vi: 1, t: 1, behind: 0, fifoBytes: 0, flags: 1 }, { vi: 2, t: 2, behind: 0, fifoBytes: 0, flags: 1 }]);
  new Uint32Array(ring.buffer)[(64 + VI_ENTRY_BYTES) >> 2] = 3; // entry 1 being written
  const r = readSwapRing(ring);
  assert.deepEqual(r.vi, [1]);
  assert.equal(r.lost, 1);
});
