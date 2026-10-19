// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Region JIT counters (plan piste 3, P4), read through the harness-only
// worker message validationReadJitRegionStats, which copies the core's
// DolphinWeb_JitRegionStats struct. Layout v1, agreed with the JIT owner on
// 2026-10-19 (little-endian, 8-byte aligned, counters cumulative since the
// last reset):
//   +0 u32 version  +4 u32 sizeBytes  +8 u32 sampleEvery  +12 u32 reserved
//   then f64 from +16: regionCycles, totalCycles, regionTimeMs, dispatchTimeMs,
//   blockTimeMs, interpTimeMs, regionCalls, regionNotEntry, regionStops
// DolphinWeb_JitRegionStats(n): n >= 0 sets the host-time sampling (1 call
// out of n timed, 0 = counters only) and resets; n < 0 only reads. Before the
// first n >= 0 call the stats are fully off (nothing is counted).
import { round } from "./stats.mjs";

export const REGION_STATS_VERSION = 1;
export const REGION_STATS_BYTES = 88;
export const REGION_STATS_MAX_BYTES = 256;
const F64 = ["regionCycles", "totalCycles", "regionTimeMs", "dispatchTimeMs", "blockTimeMs", "interpTimeMs", "regionCalls", "regionNotEntry", "regionStops"];
const TIME = ["regionTimeMs", "dispatchTimeMs", "blockTimeMs", "interpTimeMs"];

// bytes: the struct as an array of byte values (what the worker returns).
export function decodeRegionStats(bytes) {
  if (!bytes || bytes.length < 8) return { error: `region stats: ${bytes?.length ?? 0} bytes, no header` };
  const view = new DataView(Uint8Array.from(bytes).buffer);
  const version = view.getUint32(0, true), size = view.getUint32(4, true);
  if (version !== REGION_STATS_VERSION) return { error: `region stats: layout version ${version}, this harness reads ${REGION_STATS_VERSION}` };
  if (size < REGION_STATS_BYTES || bytes.length < REGION_STATS_BYTES) return { error: `region stats: struct of ${size} bytes (${bytes.length} copied), v1 needs ${REGION_STATS_BYTES}` };
  const out = { version, sizeBytes: size, sampleEvery: view.getUint32(8, true) };
  F64.forEach((name, i) => { out[name] = view.getFloat64(16 + i * 8, true); });
  for (const name of F64) if (!Number.isFinite(out[name]) || out[name] < 0) return { error: `region stats: ${name} = ${out[name]}` };
  return out;
}

// Two reads taken back to back while the CPU thread keeps counting: every
// counter must have stayed or grown. A read that went backwards was torn (a
// reset in between, or fields read mid-update): refused. dispatchTimeMs is
// not checked: the core adds slice time minus the sampled parts, which may be
// negative for one slice (0075); only a negative total is refused (decode).
const MONOTONIC = F64.filter((f) => f !== "dispatchTimeMs");
export function consistentRead(a, b) {
  if (a.error) return a;
  if (b.error) return b;
  const back = MONOTONIC.filter((f) => b[f] < a[f]);
  return back.length ? { error: `region stats: torn read (${back.join(", ")} went backwards)` } : a;
}

// Shares of one set of counters (one window, or several pooled); null when
// the part cannot be computed. A part outside [0, 1] means counters that do
// not add up: refused rather than clamped into a plausible number.
export function regionShares(s) {
  if (!s || s.error) return null;
  const time = TIME.reduce((n, f) => n + s[f], 0);
  const share = (part, whole) => (whole > 0 ? part / whole : null);
  const shares = {
    regionCycleShare: share(s.regionCycles, s.totalCycles),
    regionTimeShare: share(s.regionTimeMs, time),
    dispatchTimeShare: share(s.dispatchTimeMs, time),
    blockTimeShare: share(s.blockTimeMs, time),
    interpTimeShare: share(s.interpTimeMs, time)
  };
  const bad = Object.entries(shares).filter(([, v]) => v != null && (v < 0 || v > 1));
  if (bad.length) return { error: `region stats: ${bad.map(([k, v]) => `${k} ${round(v, 4)}`).join(", ")} outside [0, 1]` };
  return {
    ...Object.fromEntries(Object.entries(shares).map(([k, v]) => [k, round(v, 4)])),
    regionCalls: s.regionCalls,
    regionNotEntry: s.regionNotEntry,
    regionStops: s.regionStops,
    sampleEvery: s.sampleEvery
  };
}

// Counters of several windows added up: their shares are ratios of sums, so
// the four time shares add up to 1 (medians of per-window shares would not).
export function poolStats(list) {
  const got = list.filter((s) => s && !s.error);
  if (!got.length) return null;
  const sum = { version: got[0].version, sizeBytes: got[0].sizeBytes, sampleEvery: got[0].sampleEvery };
  for (const f of F64) sum[f] = got.reduce((n, s) => n + s[f], 0);
  if (got.some((s) => s.sampleEvery !== sum.sampleEvery)) sum.sampleEvery = null;
  return sum;
}

export const P4_FIELDS = ["regionCycleShare", "regionTimeShare", "dispatchTimeShare", "blockTimeShare", "interpTimeShare", "regionCalls", "regionNotEntry", "regionStops", "sampleEvery"];
