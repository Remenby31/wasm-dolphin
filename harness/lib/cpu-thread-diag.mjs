// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The CPU-thread diag (patch 0213, DolphinWeb_CpuThreadDiagStats, read by
// the worker's validationReadCpuThreadDiag): where the emulated CPU thread's
// host time goes outside the timed slice parts (cpu-window's "other").
// Cumulative since the last reset; the CPU thread alone writes it.
//
// Layout v3 (1984 bytes, little-endian): u32 version, sizeBytes, on (1 once
// a reset was applied), eventSlots (32); 32 f64 fields (FIELDS, host µs or
// counts); then eventSlots + 1 entries of 48 bytes: char name[32]
// (NUL-terminated), f64 us, f64 calls. Event types take a slot at their
// first registration; past 32 they share the last entry, "(others)". Then
// 16 f64 (DEFERRED_FIELDS): the deferred blocks' runs by reason, throttle
// then offThread (blocks, runs, instructions, cycles, sampledRuns,
// sampledUs), clockPairUs, sampleEvery, statsPublishUs and
// statsPublishCalls. v3 splits setupUs: setupPolicyUs (to
// RetryDeferredWasmBlocks), setupRequestsUs (from ServiceRegionInstalls to
// Advance: the stats requests, mode checks; statsPublishUs, the region
// stats' publication every 64 slices, is inside it), the rest being the
// region stats' own set-up before the slice loop.
//
// Deferred blocks: blocks the core wrote as interpreter callbacks for lack
// of their WebAssembly module, "throttle" (the slice's compile budget was
// spent) or "offThread" (waiting for the compiler worker). Counted at each
// run; one run in sampleEvery timed (clock reads included: clockPairUs each).
// Inside the slice loop (blocks): never added to the parts.
//
// The parts (each net of the "nested" time inside it: throttle sleep,
// region installs, FlushGpu waits, all counted elsewhere):
//   setupUs, retryUs (RetryDeferredWasmBlocks), regionServiceUs
//   (ServiceRegionInstalls less its installs), advanceUs
//   (CoreTiming::Advance from Run), tailUs (slice close-out).
// They add up to controlUs (each Run iteration's time outside its slice
// loop, less nested) by construction: consecutive clock points of one
// iteration. eventsUs (all event callbacks) and throttleUs (Throttle's
// bookkeeping, inside the VI event) are inside advanceUs. The stale-region
// checks (reverifyUs: a region marked stale checked again before it runs;
// invalidateUs: DolphinWeb_InvalidateRegions; clearRegionStateUs:
// ClearOffThreadAndRegionState) are nested in the other parts (blocks or
// events), never added.
import { round } from "./stats.mjs";

export const CPU_THREAD_DIAG_VERSION = 3;
export const CPU_THREAD_DIAG_BYTES = 1984;
export const FIELDS = [
  "windowUs", "iterations", "controlUs", "sliceLoopUs", "nestedUs",
  "setupUs", "retryUs", "regionServiceUs", "advanceUs", "tailUs",
  "eventsUs", "eventCalls", "throttleUs", "throttleCalls",
  "offThreadWaitingNow", "offThreadWaitingMax", "offThreadWaitingSum",
  "deferredNow", "deferredMax", "deferredSum",
  "regionWaitingNow", "regionWaitingMax", "regionWaitingSum",
  "reverifyUs", "reverifyCalls", "invalidateUs", "invalidateCalls", "invalidateScans",
  "clearRegionStateUs", "clearRegionStateCalls", "setupPolicyUs", "setupRequestsUs"
];
export const DEFERRED_REASONS = ["throttle", "offThread"];
const DEFERRED_RUN_FIELDS = ["blocks", "runs", "instructions", "cycles", "sampledRuns", "sampledUs"];
export const DEFERRED_FIELDS = [
  ...DEFERRED_REASONS.flatMap((r) => DEFERRED_RUN_FIELDS.map((f) => `${r}${f[0].toUpperCase()}${f.slice(1)}`)),
  "clockPairUs", "sampleEvery", "statsPublishUs", "statsPublishCalls"
];
// The parts that add up to controlUs.
export const PARTS = ["setupUs", "retryUs", "regionServiceUs", "advanceUs", "tailUs"];
const EVENTS_AT = 16 + FIELDS.length * 8, EVENT_BYTES = 48, NAME_BYTES = 32;
// Fields that only grow between resets (a torn read or a reset shows as one
// going back). Times net of nested time could dip by a rounding: compared
// with a tolerance.
const COUNTS = ["windowUs", "iterations", "eventCalls", "throttleCalls", "offThreadWaitingSum", "deferredSum", "regionWaitingSum", "reverifyCalls", "invalidateCalls", "invalidateScans", "clearRegionStateCalls", "nestedUs", "sliceLoopUs",
  ...DEFERRED_REASONS.flatMap((r) => ["Blocks", "Runs", "Instructions", "Cycles", "SampledRuns"].map((f) => `${r}${f}`)), "statsPublishCalls"];
const DEFERRED_AT = EVENTS_AT + 33 * EVENT_BYTES;
const TIMES = ["controlUs", ...PARTS, "eventsUs", "throttleUs", "reverifyUs", "invalidateUs", "clearRegionStateUs"];

export function decodeCpuThreadDiag(bytes) {
  if (!bytes || bytes.length < 16) return { error: `CPU-thread diag: ${bytes?.length ?? 0} bytes, no header` };
  const buf = Uint8Array.from(bytes);
  const view = new DataView(buf.buffer);
  const version = view.getUint32(0, true), size = view.getUint32(4, true);
  if (version !== CPU_THREAD_DIAG_VERSION) return { error: `CPU-thread diag: layout version ${version}, this harness reads ${CPU_THREAD_DIAG_VERSION}` };
  if (size < CPU_THREAD_DIAG_BYTES || bytes.length < CPU_THREAD_DIAG_BYTES) return { error: `CPU-thread diag: struct of ${size} bytes (${bytes.length} copied), v3 needs ${CPU_THREAD_DIAG_BYTES}` };
  const slots = view.getUint32(12, true);
  if (slots !== 32) return { error: `CPU-thread diag: ${slots} event slots, v3 has 32` };
  const out = { on: view.getUint32(8, true) === 1, eventSlots: slots };
  FIELDS.forEach((name, i) => { out[name] = view.getFloat64(16 + i * 8, true); });
  DEFERRED_FIELDS.forEach((name, i) => { out[name] = view.getFloat64(DEFERRED_AT + i * 8, true); });
  for (const name of [...FIELDS, ...DEFERRED_FIELDS]) if (!Number.isFinite(out[name])) return { error: `CPU-thread diag: ${name} = ${out[name]}` };
  const events = [];
  for (let i = 0; i <= slots; i += 1) {
    const at = EVENTS_AT + i * EVENT_BYTES;
    const raw = buf.subarray(at, at + NAME_BYTES);
    const end = raw.indexOf(0);
    const name = new TextDecoder().decode(raw.subarray(0, end < 0 ? NAME_BYTES : end));
    const us = view.getFloat64(at + NAME_BYTES, true), calls = view.getFloat64(at + NAME_BYTES + 8, true);
    if (!Number.isFinite(us) || !Number.isFinite(calls)) return { error: `CPU-thread diag: event ${i} (${name}) = ${us} µs, ${calls} calls` };
    if (i === slots) events.push({ slot: i, name: "(others)", us, calls });
    else if (name) events.push({ slot: i, name, us, calls });
  }
  out.events = events;
  return out;
}

// Two copies of the same struct (the worker's bytes and again): the first,
// unless a counter went back (a torn read) or the event names differ.
export function consistentCpuThreadDiagRead(a, b) {
  if (a.error) return a;
  if (b.error) return b;
  const back = COUNTS.filter((f) => b[f] < a[f]);
  if (back.length) return { error: `CPU-thread diag: torn read (${back.join(", ")} went backwards)` };
  const names = (s) => s.events.map((e) => `${e.slot}:${e.name}`).join(",");
  if (names(a) !== names(b)) return { error: "CPU-thread diag: torn read (event names changed between the copies)" };
  return a;
}

// The window between two reads (cumulative, same reset), in ms, or { why }.
// otherMs: cpu-window's "other" for the same window, when known: coverage
// is the parts' sum over it (and the control's).
export function cpuThreadDiagDelta(a, b, { otherMs = null, topEvents = 3 } = {}) {
  if (a == null || b == null) return { why: "no CPU-thread diag read" };
  if (a.error || b.error) return { why: a.error ?? b.error };
  if (!a.on || !b.on) return { why: "CPU-thread diag: not on" };
  const back = COUNTS.filter((f) => b[f] < a[f]);
  if (back.length) return { why: `CPU-thread diag: reset in the window (${back.join(", ")} went back)` };
  const d = (f) => b[f] - a[f];
  const ms = (f) => round(d(f) / 1000, 3);
  const iterations = d("iterations");
  const byName = new Map(a.events.map((e) => [e.name, e]));
  const events = b.events.map((e) => {
    const p = byName.get(e.name) ?? { us: 0, calls: 0 };
    return { name: e.name, ms: round((e.us - p.us) / 1000, 3), calls: e.calls - p.calls };
  }).filter((e) => e.calls > 0 || e.ms !== 0).sort((x, y) => y.ms - x.ms);
  const partsMs = PARTS.reduce((n, f) => n + d(f), 0) / 1000;
  const controlMs = d("controlUs") / 1000;
  const coverage = otherMs > 0 ? round(partsMs / otherMs, 4) : null;
  const out = {
    windowMs: ms("windowUs"), iterations,
    controlMs: round(controlMs, 3), partsMs: round(partsMs, 3),
    // the parts add up to control by construction: a gap is a core bug
    partsGapMs: round(controlMs - partsMs, 3),
    sliceLoopMs: ms("sliceLoopUs"), nestedMs: ms("nestedUs"),
    setupMs: ms("setupUs"),
    // setup's three spans (v3); statsPublishMs is inside setupRequestsMs
    setupSplit: {
      policyMs: ms("setupPolicyUs"), requestsMs: ms("setupRequestsUs"),
      regionStatsSetupMs: round((d("setupUs") - d("setupPolicyUs") - d("setupRequestsUs")) / 1000, 3),
      statsPublishMs: ms("statsPublishUs"), statsPublishes: d("statsPublishCalls"),
      usPerIteration: iterations > 0 ? round(d("setupUs") / iterations, 3) : null
    },
    retryMs: ms("retryUs"), regionServiceMs: ms("regionServiceUs"),
    advanceMs: ms("advanceUs"), tailMs: ms("tailUs"),
    eventsMs: ms("eventsUs"), eventCalls: d("eventCalls"),
    throttleMs: ms("throttleUs"), throttleCalls: d("throttleCalls"),
    retryLists: {
      offThreadWaiting: { now: b.offThreadWaitingNow, max: b.offThreadWaitingMax, mean: iterations > 0 ? round(d("offThreadWaitingSum") / iterations, 2) : null },
      deferred: { now: b.deferredNow, max: b.deferredMax, mean: iterations > 0 ? round(d("deferredSum") / iterations, 2) : null },
      regionWaiting: { now: b.regionWaitingNow, max: b.regionWaitingMax, mean: iterations > 0 ? round(d("regionWaitingSum") / iterations, 2) : null }
    },
    // nested in blocks or events, never added to the parts
    staleCheck: {
      ms: round((d("reverifyUs") + d("invalidateUs") + d("clearRegionStateUs")) / 1000, 3),
      reverifyMs: ms("reverifyUs"), reverifies: d("reverifyCalls"),
      invalidateMs: ms("invalidateUs"), invalidations: d("invalidateCalls"), invalidateScans: d("invalidateScans"),
      clearRegionStateMs: ms("clearRegionStateUs"), clears: d("clearRegionStateCalls")
    },
    deferredRuns: deferredRunsDelta(a, b),
    topEvents: events.slice(0, topEvents),
    events,
    coverageOfOther: coverage,
    controlOfOther: otherMs > 0 ? round(controlMs / otherMs, 4) : null
  };
  return out;
}

// The deferred blocks' runs in the window, by reason, and their estimated
// host time: runs x the sampled runs' mean, less the two clock reads each
// sample carries (clockPairUs, from b's reset). estMs is null with no sample.
export function deferredRunsDelta(a, b) {
  const pair = b.clockPairUs ?? 0;
  const out = {};
  let total = 0, totalKnown = true;
  for (const r of DEFERRED_REASONS) {
    const d = (f) => b[`${r}${f}`] - a[`${r}${f}`];
    const runs = d("Runs"), sampled = d("SampledRuns");
    const usPerRun = sampled > 0 ? Math.max(0, d("SampledUs") / sampled - pair) : null;
    const estMs = runs === 0 ? 0 : usPerRun == null ? null : round(runs * usPerRun / 1000, 3);
    if (estMs == null) totalKnown = false; else total += estMs;
    out[r] = {
      blocks: d("Blocks"), runs, instructions: d("Instructions"), cycles: d("Cycles"), sampledRuns: sampled,
      usPerRun: usPerRun == null ? null : round(usPerRun, 3), estMs
    };
  }
  out.estMs = totalKnown ? round(total, 3) : null;
  out.clockPairUs = round(pair, 4);
  return out;
}
