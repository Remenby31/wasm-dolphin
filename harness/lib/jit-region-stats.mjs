// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Region JIT counters (plan piste 3, P4), read through the harness-only
// worker message validationReadJitRegionStats, which copies the core's
// DolphinWeb_JitRegionStats struct. Layout v1, agreed with the JIT owner on
// 2026-10-19 (little-endian, 8-byte aligned, counters cumulative since the
// last reset):
//   +0 u32 version  +4 u32 sampleEvery
//   then f64: regionCycles, totalCycles, regionTimeMs, dispatchTimeMs,
//   blockTimeMs, interpTimeMs, regionCalls, regionNotEntry, regionStops
// DolphinWeb_JitRegionStats(n): n >= 0 sets the host-time sampling (1 call
// out of n timed, 0 = counters only) and resets; n < 0 only reads. Before the
// first n >= 0 call the stats are fully off (nothing is counted).
import { round } from "./stats.mjs";

export const REGION_STATS_VERSION = 1;
export const REGION_STATS_BYTES = 80;
const F64 = ["regionCycles", "totalCycles", "regionTimeMs", "dispatchTimeMs", "blockTimeMs", "interpTimeMs", "regionCalls", "regionNotEntry", "regionStops"];

// bytes: the struct as an array of byte values (what the worker returns).
export function decodeRegionStats(bytes) {
  if (!bytes || bytes.length < REGION_STATS_BYTES) return { error: `region stats: ${bytes?.length ?? 0} bytes, ${REGION_STATS_BYTES} expected` };
  const view = new DataView(Uint8Array.from(bytes).buffer);
  const version = view.getUint32(0, true);
  if (version !== REGION_STATS_VERSION) return { error: `region stats: layout version ${version}, this harness reads ${REGION_STATS_VERSION}` };
  const out = { version, sampleEvery: view.getUint32(4, true) };
  F64.forEach((name, i) => { out[name] = view.getFloat64(8 + i * 8, true); });
  return out;
}

const share = (part, whole) => (whole > 0 ? round(part / whole, 4) : null);

// The summary.json p4 block from the counters of one window (taken after a
// reset at the window's start). Time shares are over the four parts of the
// CPU thread's loop; they are null when the host time was not sampled.
export function regionShares(s) {
  if (!s || s.error) return null;
  const time = s.regionTimeMs + s.dispatchTimeMs + s.blockTimeMs + s.interpTimeMs;
  return {
    regionCycleShare: share(s.regionCycles, s.totalCycles),
    regionTimeShare: share(s.regionTimeMs, time),
    dispatchTimeShare: share(s.dispatchTimeMs, time),
    blockTimeShare: share(s.blockTimeMs, time),
    interpTimeShare: share(s.interpTimeMs, time),
    regionCalls: s.regionCalls,
    regionNotEntry: s.regionNotEntry,
    regionStops: s.regionStops,
    sampleEvery: s.sampleEvery
  };
}

export const P4_FIELDS = ["regionCycleShare", "regionTimeShare", "dispatchTimeShare", "blockTimeShare", "interpTimeShare", "regionCalls", "regionNotEntry", "regionStops", "sampleEvery"];
