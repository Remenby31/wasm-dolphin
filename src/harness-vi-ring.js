// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Reader for the core's QA-harness VI ring (dolphin_web_discio.cpp,
// DolphinWebHarnessViEntry, 24 bytes: f64 host ms, u64 ticks, u32 sinceBoot,
// u32 sinceLoad). sinceBoot is each entry's sequence number: entries must be
// consecutive, and the sequence is re-read after the fields, so an entry the
// core overwrote (lapped ring) or was writing during the read is counted as
// lost instead of being returned.
export const VI_ENTRY_BYTES = 24;

export function readViRing({ buffer, ptr, capacity, head, read }) {
  const f64 = new Float64Array(buffer);
  const u32 = new Uint32Array(buffer);
  const out = { t: [], ticks: [], sinceBoot: [], sinceLoad: [], lost: 0 };
  const from = read ?? head;
  const first = Math.max(from, head - capacity);
  out.lost += first - from;
  let expected = null;
  for (let n = first; n < head; n += 1) {
    const base = ptr + (n % capacity) * VI_ENTRY_BYTES;
    const seq = u32[(base + 16) >> 2];
    const t = f64[base >> 3];
    const ticks = u32[(base + 8) >> 2] + u32[(base + 12) >> 2] * 2 ** 32;
    const sinceLoad = u32[(base + 20) >> 2];
    if (u32[(base + 16) >> 2] !== seq || (expected !== null && seq !== expected)) {
      out.lost += 1;
      expected = null;
      continue;
    }
    expected = seq + 1;
    out.t.push(t);
    out.ticks.push(ticks);
    out.sinceBoot.push(seq);
    out.sinceLoad.push(sinceLoad);
  }
  return out;
}
