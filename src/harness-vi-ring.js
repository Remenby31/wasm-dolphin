// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Reader for the core's QA-harness VI ring (dolphin_web_discio.cpp,
// DolphinWebHarnessViEntry, 32 bytes: u32 seq, u32 sinceBoot, f64 host ms,
// u64 ticks, u32 sinceLoad, u32 pad). Each entry is a seqlock: seq is odd
// while the core writes it and 2 * (n + 1) once entry n is complete. An entry
// is accepted only if seq has that value before and after reading the
// fields; it is retried a few times, then counted as lost. A lapped or
// half-written entry is never returned.
export const VI_ENTRY_BYTES = 32;
const RETRIES = 4;

// One seqlock ring of 32-byte entries (seq first), from `read` to `head`:
// `fields(base, u32, f64)` reads one entry's fields, each pushed to its
// array in `out`.
function readSeqlockRing({ buffer, ptr, capacity, head, read }, out, fields) {
  const f64 = new Float64Array(buffer);
  const u32 = new Uint32Array(buffer);
  const i32 = new Int32Array(buffer);
  const shared = typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer;
  const seqAt = (base) => (shared ? Atomics.load(i32, base >> 2) >>> 0 : u32[base >> 2]);
  out.lost = 0;
  const from = read ?? head;
  const first = Math.max(from, head - capacity);
  out.lost += first - from;
  for (let n = first; n < head; n += 1) {
    const base = ptr + (n % capacity) * VI_ENTRY_BYTES;
    const expected = (2 * (n + 1)) >>> 0;
    let entry = null;
    for (let attempt = 0; attempt < RETRIES && !entry; attempt += 1) {
      const before = seqAt(base);
      if (before !== expected) {
        if (before & 1) continue; // being written: retry
        break; // another entry (lapped): lost
      }
      const e = fields(base, u32, f64);
      if (seqAt(base) === before) entry = e;
    }
    if (!entry) {
      out.lost += 1;
      continue;
    }
    for (const [k, v] of Object.entries(entry)) out[k].push(v);
  }
  return out;
}

export function readViRing(ring) {
  return readSeqlockRing(ring, { t: [], ticks: [], sinceBoot: [], sinceLoad: [], lost: 0 }, (base, u32, f64) => ({
    sinceBoot: u32[(base + 4) >> 2],
    t: f64[(base + 8) >> 3],
    ticks: u32[(base + 16) >> 2] + u32[(base + 20) >> 2] * 2 ** 32,
    sinceLoad: u32[(base + 24) >> 2]
  }));
}

// Patch 0214 (harness pipeline diag): the core's swap ring
// (dolphin_web_discio.cpp, DolphinWebHarnessSwapEntry, 32 bytes: u32 seq,
// u32 VI output since boot, f64 host ms when the video thread pulled the swap,
// u32 FIFO chunks it still had to replay, u32 FIFO distance at the VI in
// bytes, u32 flags (bit 0 a new picture, bit 1 patch 0211 held the last one),
// u32 pad), same seqlock. UINT32_MAX (the core does not know: single core, a
// deterministic GPU thread) reads as null, never as 0.
export const SWAP_UNKNOWN = 0xFFFFFFFF;
export function readSwapRing(ring) {
  const known = (x) => (x === SWAP_UNKNOWN ? null : x);
  return readSeqlockRing(ring, { vi: [], t: [], behind: [], fifoBytes: [], fresh: [], held: [], lost: 0 }, (base, u32, f64) => {
    const flags = u32[(base + 24) >> 2];
    return {
      vi: u32[(base + 4) >> 2],
      t: f64[(base + 8) >> 3],
      behind: known(u32[(base + 16) >> 2]),
      fifoBytes: known(u32[(base + 20) >> 2]),
      fresh: (flags & 1) !== 0,
      held: (flags & 2) !== 0
    };
  });
}
