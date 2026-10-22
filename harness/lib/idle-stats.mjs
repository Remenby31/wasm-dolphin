// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Idle-skip counters (patch 0089), read through the harness-only worker
// message validationReadIdleStats, which copies the core's
// DolphinWeb_IdleStats struct (Core/WasmIdleStats.h). Layout v1
// (little-endian, counters cumulative since the last reset):
//   +0 u32 version  +4 u32 sizeBytes  +8 u32 on  +12 u32 reserved
//   then f64 from +16, in FIELDS order below.
// DolphinWeb_IdleStats(n): n >= 0 resets them at the CPU thread's next
// CoreTiming slice and counts from there; n < 0 only reads.
//
// What they answer (research/gamecube-speedhacks.md §1.2): how often a
// detected wait loop comes back out of CoreTiming::Idle() only to go straight
// back in (a reentry: same loop, at most 256 cycles run in between, so no
// interrupt handler), what woke it (a VI half-line that changed nothing but
// the beam position, or another event), and how much CPU-thread time those
// round trips cost outside the event callbacks themselves.
import { round } from "./stats.mjs";

export const IDLE_STATS_VERSION = 1;
export const FIELDS = [
  "cycles", "hostMs",
  "advances", "idleCalls", "idleCycles", "flushGpu",
  "reentries", "reentryCycles", "reentryHostMs", "reentryEventMs",
  "idleWakes", "wakeViOnly", "wakeWithVi", "wakeExceptions",
  "viUpdates", "viObservable", "beamReads",
  "wakeAudioDma", "wakeDsp", "wakeGpuSleeper", "wakeIpc", "wakeDec", "wakeSi", "wakeOther",
  // ?idleff=1: wakes where the fast-forward could start, loop iterations it
  // replaced.
  "ffArmed", "ffSkips"
];
export const IDLE_STATS_BYTES = 16 + 8 * FIELDS.length;
// GameCube CPU clock, and NTSC fields per second (VideoInterface).
const TICKS_PER_SECOND = 486000000;
const FIELDS_PER_SECOND = 59.94;

// bytes: the struct as an array of byte values (what the worker returns).
export function decodeIdleStats(bytes) {
  if (!bytes || bytes.length < 16) return { error: `idle stats: ${bytes?.length ?? 0} bytes, no header` };
  const view = new DataView(Uint8Array.from(bytes).buffer);
  const version = view.getUint32(0, true), size = view.getUint32(4, true), on = view.getUint32(8, true);
  if (version !== IDLE_STATS_VERSION) return { error: `idle stats: layout version ${version}, this harness reads ${IDLE_STATS_VERSION}` };
  if (!on) return { error: "idle stats: not counting yet (no CoreTiming slice since the reset)" };
  if (size < IDLE_STATS_BYTES || bytes.length < IDLE_STATS_BYTES) return { error: `idle stats: struct of ${size} bytes (${bytes.length} copied), v1 needs ${IDLE_STATS_BYTES}` };
  const out = { version };
  FIELDS.forEach((name, i) => { out[name] = view.getFloat64(16 + i * 8, true); });
  for (const name of FIELDS) if (!Number.isFinite(out[name]) || out[name] < 0) return { error: `idle stats: ${name} = ${out[name]}` };
  if (out.reentries > out.idleCalls) return { error: `idle stats: reentries ${out.reentries} > idleCalls ${out.idleCalls}` };
  return out;
}

// Two reads back to back: a counter that went backwards was a torn read.
export function consistentIdleRead(a, b) {
  if (a.error) return a;
  if (b.error) return b;
  const back = FIELDS.filter((f) => b[f] < a[f]);
  return back.length ? { error: `idle stats: torn read (${back.join(", ")} went backwards)` } : a;
}

// Several windows pooled: every field adds up.
export function poolIdleStats(list) {
  const sum = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  for (const s of list) for (const f of FIELDS) sum[f] += s[f];
  return sum;
}

const per = (n, d) => (d > 0 ? n / d : null);

// The rates and shares the report asks for, from one window or a pool.
export function idleRates(s) {
  if (!s || s.error) return null;
  const guestSec = s.cycles / TICKS_PER_SECOND;
  const fields = guestSec * FIELDS_PER_SECOND;
  const overheadMs = Math.max(s.reentryHostMs - s.reentryEventMs, 0);
  return {
    guestSeconds: round(guestSec, 3), hostSeconds: round(s.hostMs / 1000, 3),
    idleCycleShare: round(per(s.idleCycles, s.cycles), 4),
    advancesPerGuestSec: round(per(s.advances, guestSec), 0),
    idleCallsPerField: round(per(s.idleCalls, fields), 1),
    reentriesPerField: round(per(s.reentries, fields), 1),
    flushGpuPerField: round(per(s.flushGpu, fields), 1),
    reentryShareOfIdle: round(per(s.reentries, s.idleCalls), 4),
    // Guest cycles run between an Idle() and the next one in a reentry (the
    // loop body again), and the host time per round trip.
    reentryCyclesMean: round(per(s.reentryCycles, s.reentries), 1),
    reentryUsMean: round(per(s.reentryHostMs * 1000, s.reentries), 3),
    reentryOverheadUsMean: round(per(overheadMs * 1000, s.reentries), 3),
    // CPU-thread host time spent coming out of a wait and going back in,
    // event callbacks left out (they run anyway).
    reentryOverheadShare: round(per(overheadMs, s.hostMs), 4),
    reentryEventShare: round(per(s.reentryEventMs, s.hostMs), 4),
    // What woke the loop.
    wakeViOnlyShare: round(per(s.wakeViOnly, s.idleWakes), 4),
    wakeWithViShare: round(per(s.wakeWithVi, s.idleWakes), 4),
    wakeExceptionShare: round(per(s.wakeExceptions, s.idleWakes), 4),
    viObservableShare: round(per(s.viObservable, s.viUpdates), 4),
    viUpdatesPerField: round(per(s.viUpdates, fields), 1),
    beamReadsPerField: round(per(s.beamReads, fields), 2),
    ffSkipsPerField: round(per(s.ffSkips, fields), 1),
    wakeOtherPerField: Object.fromEntries(["wakeAudioDma", "wakeDsp", "wakeGpuSleeper", "wakeIpc", "wakeDec", "wakeSi", "wakeOther"].map((f) => [f, round(per(s[f], fields), 2)]))
  };
}

// One stats window as race-perf records it: { idle, idleRaw } or
// { idle: null, idleWhy }.
export function idleRecord(reply) {
  if (!reply) return { idle: null, idleWhy: "idle stats not asked (no --idle-secs)" };
  if (reply.error) return { idle: null, idleWhy: /Unknown upstream worker message/.test(reply.error) ? "engine without validationReadIdleStats" : reply.error };
  const stats = consistentIdleRead(decodeIdleStats(reply.bytes), decodeIdleStats(reply.again));
  if (stats.error) return { idle: null, idleWhy: stats.error };
  return { idle: idleRates(stats), idleRaw: stats };
}

// One side over its windows: rates of the pooled counters.
export function summarizeIdle(windows) {
  const recs = windows.filter(Boolean);
  const raw = recs.map((w) => w.idleRaw).filter(Boolean);
  if (!raw.length) return { idle: null, why: [...new Set(recs.map((w) => w.idleWhy).filter(Boolean))].join("; ") || "no window" };
  const pooled = poolIdleStats(raw);
  return { idle: { ...idleRates(pooled), windows: raw.length, missingWindows: recs.length - raw.length, raw: pooled }, why: null };
}
