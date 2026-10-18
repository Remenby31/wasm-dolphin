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

export function readViRing({ buffer, ptr, capacity, head, read }) {
  const f64 = new Float64Array(buffer);
  const u32 = new Uint32Array(buffer);
  const i32 = new Int32Array(buffer);
  const shared = typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer;
  const seqAt = (base) => (shared ? Atomics.load(i32, base >> 2) >>> 0 : u32[base >> 2]);
  const out = { t: [], ticks: [], sinceBoot: [], sinceLoad: [], lost: 0 };
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
      const sinceBoot = u32[(base + 4) >> 2];
      const t = f64[(base + 8) >> 3];
      const ticks = u32[(base + 16) >> 2] + u32[(base + 20) >> 2] * 2 ** 32;
      const sinceLoad = u32[(base + 24) >> 2];
      if (seqAt(base) === before) entry = { sinceBoot, t, ticks, sinceLoad };
    }
    if (!entry) {
      out.lost += 1;
      continue;
    }
    out.t.push(entry.t);
    out.ticks.push(entry.ticks);
    out.sinceBoot.push(entry.sinceBoot);
    out.sinceLoad.push(entry.sinceLoad);
  }
  return out;
}
