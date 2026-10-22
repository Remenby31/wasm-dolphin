// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Guest memory accesses per instruction (patch 0104, written with the JIT
// owner), read through the harness-only worker message
// validationReadMemAccessStats, which copies the core's
// DolphinWeb_MemAccessStats struct. Nothing is emitted in the generated
// code: each block and region carries static counts (instructions, loads and
// stores by kind) from its compile, and with the stats on the core adds them
// up per execution of a block (RunWasmBlock, cached-interpreter EndBlock).
// Blocks inside a region chain in wasm with no return to C++: they are not
// counted, their cycles stay out of cyclesCovered, and the core estimates
// them apart (region cycles x the region's static accesses per cycle).
// Slow paths are counted in the C++ memory helpers.
// Layout v1 (192 bytes, little-endian), agreed on 2026-10-22:
//   +0 u32 version  +4 u32 sizeBytes  +8 u32 on  +12 u32 reserved
//   f64 from +16: guestInstructions; accesses int_load, int_store, fp_load,
//   fp_store, psq_load, psq_store; the same six on the slow path;
//   cyclesCovered, cyclesTotal; regionAccessesEstimated,
//   regionInstructionsEstimated; staticSaturations (u16 compile-time counts
//   that saturated, cumulative, never reset); four spares.
// DolphinWeb_MemAccessStats(n): n >= 0 zeroes and turns on at the next slice;
// n < 0 only reads. The core writes it at each slice boundary.
import { round } from "./stats.mjs";

export const MEM_STATS_VERSION = 1;
export const MEM_STATS_BYTES = 192;
export const KINDS = ["intLoad", "intStore", "fpLoad", "fpStore", "psqLoad", "psqStore"];
const F64 = [
  "guestInstructions", ...KINDS.map((k) => `access.${k}`), ...KINDS.map((k) => `slow.${k}`),
  "cyclesCovered", "cyclesTotal", "regionAccessesEstimated", "regionInstructionsEstimated", "staticSaturations"
];
// Counters that only grow while on (checked for tears); staticSaturations is
// cumulative too.
const MONOTONIC = F64;

export function decodeMemStats(bytes) {
  if (!bytes || bytes.length < 16) return { error: `memory access stats: ${bytes?.length ?? 0} bytes, no header` };
  const view = new DataView(Uint8Array.from(bytes).buffer);
  const version = view.getUint32(0, true), size = view.getUint32(4, true);
  if (version !== MEM_STATS_VERSION) return { error: `memory access stats: layout version ${version}, this harness reads ${MEM_STATS_VERSION}` };
  if (size < MEM_STATS_BYTES || bytes.length < MEM_STATS_BYTES) return { error: `memory access stats: struct of ${size} bytes (${bytes.length} copied), v1 needs ${MEM_STATS_BYTES}` };
  const out = { version, sizeBytes: size, on: view.getUint32(8, true) === 1 };
  F64.forEach((name, i) => { out[name] = view.getFloat64(16 + i * 8, true); });
  for (const name of F64) if (!Number.isFinite(out[name]) || out[name] < 0) return { error: `memory access stats: ${name} = ${out[name]}` };
  if (out.cyclesCovered > out.cyclesTotal) return { error: `memory access stats: cyclesCovered ${out.cyclesCovered} > cyclesTotal ${out.cyclesTotal}` };
  return out;
}

export function consistentMemRead(a, b) {
  if (a.error) return a;
  if (b.error) return b;
  const back = MONOTONIC.filter((f) => b[f] < a[f]);
  return back.length ? { error: `memory access stats: torn read (${back.join(", ")} went backwards)` } : a;
}

// Several windows added up (ratios of sums, not medians of ratios).
export function poolMemStats(list) {
  const got = list.filter((s) => s && !s.error);
  if (!got.length) return null;
  const sum = { version: got[0].version, sizeBytes: got[0].sizeBytes, on: got.every((s) => s.on) };
  for (const f of F64) sum[f] = f === "staticSaturations" ? Math.max(...got.map((s) => s[f])) : got.reduce((n, s) => n + s[f], 0);
  return sum;
}

const sumOf = (s, prefix) => KINDS.reduce((n, k) => n + s[`${prefix}.${k}`], 0);

// The ratio on the counted blocks, its coverage of the window's cycles, the
// region part estimated apart, and the slow path. Never merges the estimate
// into the counted figure: `withRegionsEstimated` is its own field.
export function memAccessShares(s) {
  if (!s || s.error) return null;
  if (!s.on) return { error: "memory access stats: counters not on" };
  if (!(s.guestInstructions > 0) || !(s.cyclesTotal > 0)) return { error: `memory access stats: ${s.guestInstructions} instructions over ${s.cyclesTotal} cycles` };
  const counted = sumOf(s, "access"), slow = sumOf(s, "slow");
  const share = (part, whole) => (whole > 0 ? round(part / whole, 4) : null);
  const regions = s.regionInstructionsEstimated > 0;
  return {
    accessesPerInstruction: share(counted, s.guestInstructions),
    coverage: share(s.cyclesCovered, s.cyclesTotal),
    scope: s.cyclesCovered < s.cyclesTotal ? "counted blocks only (see coverage)" : "every cycle counted",
    byKind: Object.fromEntries(KINDS.map((k) => [k, share(s[`access.${k}`], counted)])),
    loadsPerInstruction: share(s["access.intLoad"] + s["access.fpLoad"] + s["access.psqLoad"], s.guestInstructions),
    storesPerInstruction: share(s["access.intStore"] + s["access.fpStore"] + s["access.psqStore"], s.guestInstructions),
    // Slow-path calls come from every code path, regions included: over all
    // accesses, counted and estimated.
    slowShare: share(slow, counted + (regions ? s.regionAccessesEstimated : 0)),
    slowByKind: Object.fromEntries(KINDS.map((k) => [k, share(s[`slow.${k}`], slow)])),
    regionAccessesPerInstructionEstimated: regions ? share(s.regionAccessesEstimated, s.regionInstructionsEstimated) : null,
    withRegionsEstimated: regions ? share(counted + s.regionAccessesEstimated, s.guestInstructions + s.regionInstructionsEstimated) : null,
    guestInstructions: s.guestInstructions,
    staticSaturations: s.staticSaturations
  };
}
