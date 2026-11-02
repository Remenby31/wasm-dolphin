// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Where the emulated CPU thread's host time goes over a window (a second, a
// few VIs), from two snapshots of the core's cumulative counters taken at
// the window's ends (harness/probes/cpu-window.mjs). Pure functions.
//
// A snapshot: { t, headroom, region, ax, mem, progress }
//   t         host ms of the read (node clock), used only without headroom
//   headroom  decodeHeadroomStats (patch 0113, lib/headroom.mjs)
//   region    decodeRegionStats (patch 0075, lib/jit-region-stats.mjs)
//   ax        decodeAxStats (patch 0099, lib/ax-hle-stats.mjs)
//   mem       decodeMemStats (patch 0104, lib/mem-access-stats.mjs)
//   diag      decodeCpuThreadDiag (patch 0213, lib/cpu-thread-diag.mjs)
//   progress  validationReadCoreProgress: { coreTicks, coreTicksPerSecond }
// Any of them may be null or { error } (a core without the export, a torn
// read): the fields that need it are then null, with the reason in `why`.
//
// The window's host time (hostMs) is the CPU thread's own: headroom
// windowUs, written at each Throttle together with guestTicks (so speed is
// guest over host on one clock, as lib/headroom.mjs and
// src/occupancy-stats.js read it). The parts that add up to hostMs:
//   sleep         throttle sleep (cpuSleepUs; SleepUntil, after its region
//                 installs, patch 0107)
//   flushGpuWait  the CPU thread waiting for the GPU thread in FlushGpu
//                 (SyncOnSkipIdle on; 0 with it off)
//   regions       host time inside region calls (regionTimeMs)
//   blocksDispatch  the rest of the CPU slice loop: blockTimeMs +
//                 dispatchTimeMs. The JIT'd wasm blocks, the
//                 cached-interpreter callbacks between them and everything
//                 they call (MMIO, memory slow paths, the gather pipe, AX
//                 HLE, the block compiles after a lookup miss), the block
//                 lookups and the loop. The sum is exact (dispatch is the
//                 slice's residual); the split between the two is NOT
//                 (below): kept apart in `split`, for information only
//   interpreter   interpTimeMs: the core never separates it (0075 leaves it
//                 at 0, interpreted instructions are inside blocks): null
//                 when it did not move
//   idle          CoreTiming::Idle (idleTimeMs), less flushGpuWait: Idle is
//                 where FlushGpu waits with SyncOnSkipIdle, and the core
//                 times Idle whole
//   installs      region module installs (installMs, slice boundaries and
//                 throttle-sleep windows, outside both the slice and sleep)
//   other         busy - the above, clamped >= 0 (overAttributedMs keeps a
//                 negative rest): CoreTiming::Advance and its events (VI,
//                 SI, DSP/audio events, the throttle's own bookkeeping),
//                 RetryDeferredWasmBlocks, the slice set-up, and the edge
//                 mismatch of the clocks (below)
// axHle is NESTED, never added: the AX command list runs inside the DSP
// mailbox MMIO write from guest code, so its time is already in blocks or
// regions (which of the two is not known).
// The CPU-thread diag (0213) cuts `other` (all NESTED, never added; null on a
// core without it): advance (CoreTiming::Advance from the slice loop, its
// event callbacks inside), throttle (Throttle's bookkeeping, inside advance:
// the VI event), sliceSetup (the slice set-up, ServiceRegionInstalls less
// its installs, the slice close-out), retryDeferred
// (RetryDeferredWasmBlocks), and otherDirect, the core's own count of the
// time outside the slice loops less sleep, installs and FlushGpu waits (the
// four parts add up to it by construction). staleCheck (regions re-verified,
// invalidated, their state cleared) is nested where it ran: blocks or
// events. Per row, cpuThread.coverageOfOther = (advance + sliceSetup +
// retryDeferred) / other, controlOfOther = otherDirect / other: what other
// holds beyond them is CPU-thread time outside the slice loop's iterations
// (or the edges of the reads).
//
// Sampling: with DolphinWeb_JitRegionStats(sampleEvery > 0) the core times
// EVERY region call, EVERY ExecuteOneBlock and every Idle; only the block
// lookups are timed 1 in sampleEvery (N), and the core multiplies them by N
// itself (0075 timed_lookup). The struct's times are therefore totals:
// never scaled again here (race-perf's regionShares does not either).
// sampleEvery 0 = counters only: every region time is null.
// Why the blocks/dispatch split is unreliable (0075, CachedInterpreter::Run):
// per ExecuteOneBlock call, block_time += max(call - clock pair - its region
// time - its lookup time - its Idle time, 0), where its lookup time is 0 on
// the N-1 calls whose lookups are not timed and N x one lookup on the
// sampled one; then dispatch = slice - (region + block + idle), the lookups
// never subtracted. So the unsampled calls' lookups stay in blocks, and on a
// sampled call N x a lookup usually exceeds the call: the clamp drops the
// block's own time, which lands in dispatch. blocks + dispatch = the slice
// less regions and Idle, exactly; how it splits is biased both ways.
//
// Edges: windowUs and guestTicks move at each Throttle (once per VI-ish
// event), the region times at each slice, the reads are a few ms apart: a
// 1 s window carries ~1-2 % of edge noise, which lands in `other`.
import { cpuThreadDiagDelta } from "./cpu-thread-diag.mjs";
import { KINDS } from "./mem-access-stats.mjs";
import { round } from "./stats.mjs";

// The parts of hostMs, in table order; they add up to hostMs.
export const PARTS = ["regions", "blocksDispatch", "interpreter", "idle", "installs", "other", "sleep", "flushGpuWait"];
// Nested in other parts (shown, never added).
export const NESTED = {
  axHle: "blocksDispatch+regions (the DSP mailbox MMIO write)",
  advance: "other (CoreTiming::Advance and its events, 0213)",
  throttle: "other, inside advance (the VI event, 0213)",
  sliceSetup: "other (slice set-up, region service, close-out, 0213)",
  retryDeferred: "other (RetryDeferredWasmBlocks, 0213)",
  staleCheck: "blocksDispatch or other, where the check ran (0213)",
  otherDirect: "other (the core's own count, 0213)"
};
// The 0213 parts whose sum is compared with other (coverageOfOther).
export const OTHER_PARTS = ["advance", "sliceSetup", "retryDeferred"];
export const SPLIT_NOTE = "blocks/dispatch as the core splits them (0075): unreliable (the unsampled lookups stay in blocks, a sampled call's block time is clamped into dispatch); their sum blocksDispatch is exact";
export const CATEGORIES = [...PARTS, ...Object.keys(NESTED)];

const ok = (s) => s != null && typeof s === "object" && !s.error;
const backwards = (a, b, fields) => fields.filter((f) => !(Number(b[f]) >= Number(a[f])));
const d = (a, b, f) => b[f] - a[f];
const ms2 = (v) => (v == null ? null : round(v, 2));
const share = (part, whole) => (part == null || !(whole > 0) ? null : round(part / whole, 4));
const reasonOf = (s, name) => (s == null ? `no ${name} read` : s.error ? s.error : null);

// Headroom deltas, or { why }.
function headroomDelta(a, b, nodeMs) {
  const why = reasonOf(a, "headroom") ?? reasonOf(b, "headroom");
  if (why) return { why };
  if (!a.on || !b.on) return { why: "headroom stats: counters not on" };
  const back = backwards(a, b, ["windowUs", "cpuSleepUs", "flushGpuWaitUs", "guestTicks"]);
  if (back.length) return { why: `headroom stats: reset in the window (${back.join(", ")} went back)` };
  const windowMs = d(a, b, "windowUs") / 1000;
  if (!(windowMs > 0)) return { why: "headroom stats: no Throttle in the window" };
  // The CPU thread updates windowUs at each Throttle: far less than the node
  // window means it did not throttle for most of it (stalled, or a reset in
  // between with every counter past the previous read again).
  if (nodeMs > 0 && windowMs < nodeMs * 0.5) return { why: `headroom stats: ${round(windowMs, 0)} ms of CPU-thread window over ${round(nodeMs, 0)} ms (no Throttle for half the window)` };
  return { windowMs, sleepMs: d(a, b, "cpuSleepUs") / 1000, flushMs: d(a, b, "flushGpuWaitUs") / 1000, guestTicks: d(a, b, "guestTicks") };
}

const REGION_MONOTONIC = ["regionCycles", "totalCycles", "regionTimeMs", "blockTimeMs", "interpTimeMs", "regionCalls"];
const REGION_DIAG_MONOTONIC = ["idleCycles", "idleTimeMs", "installMs"];

// Region deltas, or { why }. Times null (timesWhy) when not sampled.
function regionDelta(a, b) {
  const why = reasonOf(a, "region") ?? reasonOf(b, "region");
  if (why) return { why };
  if (a.version !== b.version) return { why: `region stats: layout v${a.version} then v${b.version}` };
  const back = backwards(a, b, REGION_MONOTONIC);
  const diag = Boolean(a.diagnostics && b.diagnostics);
  // v1 diagnostics have no installMs: only the fields both reads carry
  const diagFields = diag ? REGION_DIAG_MONOTONIC.filter((f) => f in a.diagnostics && f in b.diagnostics) : [];
  if (diag) back.push(...backwards(a.diagnostics, b.diagnostics, diagFields));
  if (back.length) return { why: `region stats: reset in the window (${back.join(", ")} went back)` };
  const out = {
    sampleEvery: b.sampleEvery,
    regionCycles: d(a, b, "regionCycles"), totalCycles: d(a, b, "totalCycles"), regionCalls: d(a, b, "regionCalls"),
    idleCycles: diag ? d(a.diagnostics, b.diagnostics, "idleCycles") : null,
    // install_ms is added whether the stats are on or not (TryInstallRegion)
    installsMs: diagFields.includes("installMs") ? d(a.diagnostics, b.diagnostics, "installMs") : null,
    diagWhy: !diag ? "region stats: no diagnostics (88-byte struct): idle and installs unknown"
      : diagFields.includes("installMs") ? null : "region stats: layout v1 (no installMs): installs unknown"
  };
  if (a.sampleEvery !== b.sampleEvery) return { ...out, timesWhy: `region stats: sampleEvery ${a.sampleEvery} then ${b.sampleEvery} (reset in the window)` };
  if (!(b.sampleEvery > 0)) return { ...out, timesWhy: "region stats: sampleEvery 0 (counters only, no host times)" };
  return {
    ...out,
    regionsMs: d(a, b, "regionTimeMs"),
    // may dip below 0 for one slice (the core adds slice time less the timed
    // parts): kept as it is
    dispatchMs: d(a, b, "dispatchTimeMs"),
    blocksMs: d(a, b, "blockTimeMs"),
    interpMs: d(a, b, "interpTimeMs"),
    idleRawMs: diag ? d(a.diagnostics, b.diagnostics, "idleTimeMs") : null
  };
}

// AX deltas, or { why }. A start read before the first mail since the reset
// (on false, everything 0) is a zero baseline; an end read still off is not
// a measurement.
function axDelta(a, b) {
  const why = reasonOf(a, "AX") ?? reasonOf(b, "AX");
  if (why) return { why };
  if (!b.on) return { why: "AX stats: counters not on (no mailbox write since the reset)" };
  if (!a.on && (a.mailMs !== 0 || a.mails !== 0)) return { why: "AX stats: start read off with counts" };
  const back = backwards(a, b, ["mailMs", "mails"]);
  if (back.length) return { why: `AX stats: reset in the window (${back.join(", ")} went back)` };
  return { mailMs: d(a, b, "mailMs"), mails: d(a, b, "mails") };
}

const MEM_FIELDS = ["guestInstructions", ...KINDS.map((k) => `access.${k}`), ...KINDS.map((k) => `slow.${k}`), "cyclesCovered", "cyclesTotal", "regionAccessesEstimated", "regionInstructionsEstimated"];

// Memory slow paths over the window, or { why }.
function memDelta(a, b) {
  const why = reasonOf(a, "memory access") ?? reasonOf(b, "memory access");
  if (why) return { why };
  if (!a.on || !b.on) return { why: "memory access stats: counters not on" };
  const back = backwards(a, b, MEM_FIELDS);
  if (back.length) return { why: `memory access stats: reset in the window (${back.join(", ")} went back)` };
  const x = Object.fromEntries(MEM_FIELDS.map((f) => [f, d(a, b, f)]));
  const slowBy = Object.fromEntries(KINDS.map((k) => [k, x[`slow.${k}`]]));
  const slow = KINDS.reduce((n, k) => n + slowBy[k], 0);
  const counted = KINDS.reduce((n, k) => n + x[`access.${k}`], 0);
  // Slow-path calls come from every code path, regions included: over the
  // counted blocks' instructions plus the regions' estimate (0104).
  const instructions = x.guestInstructions + x.regionInstructionsEstimated;
  const accesses = counted + x.regionAccessesEstimated;
  if (!(instructions > 0)) return { why: "memory access stats: no instruction counted in the window" };
  return {
    slowAccesses: slow,
    slowPerKiloInstr: round((1000 * slow) / instructions, 4),
    slowShare: accesses > 0 ? round(slow / accesses, 6) : null,
    // which kinds the slow paths were (null without a slow path)
    slowByKind: slow > 0 ? Object.fromEntries(KINDS.map((k) => [k, round(slowBy[k] / slow, 4)])) : null,
    slowCounts: slowBy,
    instructions,
    // share of the window's guest cycles in counted blocks (regions estimated)
    coverage: x.cyclesTotal > 0 ? round(x.cyclesCovered / x.cyclesTotal, 4) : null
  };
}

// The window between two snapshots (see the header). Never invents a zero:
// what cannot be computed is null, with the reason in why[struct].
export function cpuWindowBreakdown(start, end) {
  const why = {};
  const nodeMs = Number.isFinite(start?.t) && Number.isFinite(end?.t) ? end.t - start.t : null;
  const hr = headroomDelta(start?.headroom, end?.headroom, nodeMs);
  if (hr.why) why.headroom = hr.why;
  const tps = Number(end?.progress?.coreTicksPerSecond ?? start?.progress?.coreTicksPerSecond);
  let hostMs = null, hostSource = null, guestSeconds = null;
  if (!hr.why) {
    hostMs = hr.windowMs;
    hostSource = "headroom";
    if (tps > 0) guestSeconds = hr.guestTicks / tps;
  } else if (nodeMs > 0) {
    hostMs = nodeMs;
    hostSource = "node";
    const t0 = Number(start?.progress?.coreTicks), t1 = Number(end?.progress?.coreTicks);
    if (tps > 0 && Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) guestSeconds = (t1 - t0) / tps;
  }
  if (guestSeconds == null) why.guest = tps > 0 ? "no core ticks over the window" : "no coreTicksPerSecond";
  const sleep = hr.why ? null : hr.sleepMs;
  const flushGpuWait = hr.why ? null : hr.flushMs;
  const busyMs = hr.why ? null : hostMs - sleep - flushGpuWait;

  const rg = regionDelta(start?.region, end?.region);
  if (rg.why) why.region = rg.why;
  else if (rg.timesWhy || rg.diagWhy) why.region = [rg.timesWhy, rg.diagWhy].filter(Boolean).join("; ");
  const timed = !rg.why && !rg.timesWhy;
  const ms = {
    regions: timed ? rg.regionsMs : null,
    blocksDispatch: timed ? rg.blocksMs + rg.dispatchMs : null,
    // 0 that never moved is "not separated" (0075), not a measured 0
    interpreter: timed && rg.interpMs > 0 ? rg.interpMs : null,
    idle: timed && rg.idleRawMs != null ? Math.max(0, rg.idleRawMs - (flushGpuWait ?? 0)) : null,
    installs: rg.why ? null : rg.installsMs,
    other: null,
    sleep,
    flushGpuWait,
    axHle: null,
    advance: null, throttle: null, sliceSetup: null, retryDeferred: null, staleCheck: null, otherDirect: null
  };
  if (timed && ms.interpreter == null) why.interpreter = "the core does not separate the interpreter (interpTimeMs did not move): interpreted instructions are in blocks";
  // other: busy less every attributed part; the interpreter counts as 0
  // there (its time is in blocks when the core does not separate it).
  let overAttributedMs = null;
  const attributed = ["regions", "blocksDispatch", "idle", "installs"];
  if (busyMs != null && attributed.every((k) => ms[k] != null)) {
    const rest = busyMs - attributed.reduce((n, k) => n + ms[k], 0) - (ms.interpreter ?? 0);
    ms.other = Math.max(0, rest);
    if (rest < 0) overAttributedMs = ms2(-rest);
  }
  const ax = axDelta(start?.ax, end?.ax);
  if (ax.why) why.ax = ax.why;
  else ms.axHle = ax.mailMs;
  const mem = memDelta(start?.mem, end?.mem);
  if (mem.why) why.mem = mem.why;
  const ct = cpuThreadDiagDelta(start?.diag, end?.diag, { otherMs: ms.other });
  if (ct.why) why.cpuThread = ct.why;
  else {
    ms.advance = ct.advanceMs;
    ms.throttle = ct.throttleMs;
    ms.sliceSetup = ct.setupMs + ct.regionServiceMs + ct.tailMs;
    ms.retryDeferred = ct.retryMs;
    ms.staleCheck = ct.staleCheck.ms;
    ms.otherDirect = ct.controlMs;
  }

  const round2 = Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, ms2(v)]));
  return {
    hostMs: ms2(hostMs), hostSource, nodeMs: ms2(nodeMs),
    guestSeconds: guestSeconds == null ? null : round(guestSeconds, 5),
    speed: guestSeconds != null && hostMs > 0 ? round(guestSeconds / (hostMs / 1000), 4) : null,
    speedPct: guestSeconds != null && hostMs > 0 ? round((100 * guestSeconds) / (hostMs / 1000), 2) : null,
    busyMs: ms2(busyMs),
    cpuBusyShare: busyMs == null ? null : round(Math.min(1, Math.max(0, busyMs / hostMs)), 4),
    ms: round2,
    shares: Object.fromEntries(CATEGORIES.map((k) => [k, share(ms[k], hostMs)])),
    perGuestSecond: Object.fromEntries(CATEGORIES.map((k) => [k, ms[k] == null || !(guestSeconds > 0) ? null : round(ms[k] / guestSeconds, 2)])),
    // for information only (SPLIT_NOTE): never in the table nor the contrast
    split: timed ? { blocks: ms2(rg.blocksMs), dispatch: ms2(rg.dispatchMs), reliable: false, note: SPLIT_NOTE } : null,
    idleRawMs: timed ? ms2(rg.idleRawMs) : null,
    overAttributedMs,
    sampleEvery: rg.why ? null : rg.sampleEvery,
    regionCoverage: rg.why ? null : {
      raw: share(rg.regionCycles, rg.totalCycles),
      outsideIdle: rg.idleCycles == null ? null : share(rg.regionCycles, rg.totalCycles - rg.idleCycles)
    },
    regionCalls: rg.why ? null : rg.regionCalls,
    ax: ax.why ? null : { mails: ax.mails, mailMs: ms2(ax.mailMs), meanMailUs: ax.mails > 0 ? round((1000 * ax.mailMs) / ax.mails, 1) : null },
    mem: mem.why ? null : mem,
    // 0213: the parts in ms, per event type (largest first), the retry
    // lists, the stale checks; coverageOfOther, controlOfOther
    cpuThread: ct.why ? null : ct,
    why
  };
}

// Each row marked dip (speed under speedBelow %, or the CPU thread busy
// over busyAbove of its host time), normal, or null when neither is known.
export function classifyDips(rows, { speedBelow = 99, busyAbove = 0.95 } = {}) {
  if (!(busyAbove >= 0 && busyAbove <= 1)) throw new Error(`--dip-busy ${busyAbove}: a share of host time, 0 to 1`);
  if (!(speedBelow >= 0)) throw new Error(`--dip-speed ${speedBelow}: a speed in %`);
  return rows.map((r) => {
    const slow = r.speedPct == null ? null : r.speedPct < speedBelow;
    const busy = r.cpuBusyShare == null ? null : r.cpuBusyShare > busyAbove;
    const dip = slow === true || busy === true ? true : slow === false || busy === false ? false : null;
    const dipWhy = [slow ? `speed ${r.speedPct} % < ${speedBelow} %` : null, busy ? `CPU thread busy ${r.cpuBusyShare} > ${busyAbove}` : null].filter(Boolean);
    return { ...r, dip, dipWhy };
  });
}

// Pooled over a group of rows: per category, the ratio of sums (host ms per
// host s and per guest s), over the rows where it is known.
function pool(rows) {
  const out = { rows: rows.length, shares: {}, msPerGuestSecond: {}, n: {} };
  for (const k of CATEGORIES) {
    const got = rows.filter((r) => r.ms?.[k] != null && r.hostMs > 0);
    const host = got.reduce((n, r) => n + r.hostMs, 0);
    const withGuest = got.filter((r) => r.guestSeconds > 0);
    const guest = withGuest.reduce((n, r) => n + r.guestSeconds, 0);
    out.n[k] = got.length;
    out.shares[k] = host > 0 ? round(got.reduce((n, r) => n + r.ms[k], 0) / host, 4) : null;
    out.msPerGuestSecond[k] = guest > 0 ? round(withGuest.reduce((n, r) => n + r.ms[k], 0) / guest, 2) : null;
  }
  const mean = (f) => {
    const v = rows.map(f).filter(Number.isFinite);
    return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 4) : null;
  };
  out.speedPct = mean((r) => r.speedPct);
  out.cpuBusyShare = mean((r) => r.cpuBusyShare);
  out.regionCoverage = mean((r) => r.regionCoverage?.outsideIdle ?? r.regionCoverage?.raw);
  out.slowPerKiloInstr = mean((r) => r.mem?.slowPerKiloInstr);
  out.coverageOfOther = mean((r) => r.cpuThread?.coverageOfOther);
  // 0213: each CoreTiming event type's callback ms per guest second
  const withEvents = rows.filter((r) => r.cpuThread && r.guestSeconds > 0);
  const guest = withEvents.reduce((n, r) => n + r.guestSeconds, 0);
  const sums = new Map();
  for (const r of withEvents) for (const e of r.cpuThread.events ?? []) sums.set(e.name, (sums.get(e.name) ?? 0) + e.ms);
  out.eventsMsPerGuestSecond = guest > 0 ? Object.fromEntries([...sums].map(([k, v]) => [k, round(v / guest, 3)]).sort((a, b) => b[1] - a[1])) : null;
  return out;
}

// The n event types with the most ms per guest second ([name, ms] pairs).
const topOf = (byName, n = 3) => (byName ? Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, n) : []);

// Dip rows against normal rows (classifyDips first). The comparison that
// says what grew is host ms per GUEST second: a dip has no throttle sleep,
// so every work part's share of host time grows with it; per guest second,
// only the parts that cost more for the same emulated time grow. `grew`:
// the parts (sleep left out) whose cost per guest second rose, largest first.
export function contrast(rows) {
  const dips = rows.filter((r) => r.dip === true), normal = rows.filter((r) => r.dip === false);
  const a = pool(dips), b = pool(normal);
  const diff = { msPerGuestSecond: {}, shares: {} };
  for (const k of CATEGORIES) {
    const x = a.msPerGuestSecond[k], y = b.msPerGuestSecond[k];
    diff.msPerGuestSecond[k] = x != null && y != null ? round(x - y, 2) : null;
    const s = a.shares[k], t = b.shares[k];
    diff.shares[k] = s != null && t != null ? round(s - t, 4) : null;
  }
  const grew = CATEGORIES.filter((k) => k !== "sleep" && diff.msPerGuestSecond[k] > 0)
    .sort((p, q) => diff.msPerGuestSecond[q] - diff.msPerGuestSecond[p])
    .map((k) => ({ part: k, msPerGuestSecond: diff.msPerGuestSecond[k], ...(NESTED[k] ? { nestedIn: NESTED[k] } : {}) }));
  const verdict = !dips.length ? "no dip row" : !normal.length ? "no normal row to compare with"
    : grew.length ? `in the dips, per guest second: ${grew.slice(0, 3).map((g) => `${g.part} +${g.msPerGuestSecond} ms`).join(", ")}`
      : "no part costs more per guest second in the dips";
  // parts past the busy time somewhere: said in the verdict (the parts of
  // those rows overlap, their contrast is less sure)
  const over = overAttributed(rows);
  const overNote = over ? `; ${over.rows} row(s) over-attributed (max ${over.maxMs} ms past the busy time)` : "";
  // 0213: the event types, per guest second: the top 3 of each group and
  // the 3 that grew most in the dips
  const ea = a.eventsMsPerGuestSecond, eb = b.eventsMsPerGuestSecond;
  const eventDiff = ea && eb ? Object.fromEntries([...new Set([...Object.keys(ea), ...Object.keys(eb)])].map((k) => [k, round((ea[k] ?? 0) - (eb[k] ?? 0), 3)])) : null;
  const events = { dips: topOf(ea), normal: topOf(eb), grew: topOf(eventDiff).filter(([, v]) => v > 0) };
  return { dips: a, normal: b, diff, grew, events, overAttributed: over, verdict: verdict + overNote };
}

// --vi FROM-TO: [from, to] (VI outputs since the savestate load).
export function parseViRange(spec) {
  if (spec == null || spec === "") return null;
  const m = /^(\d+)-(\d+)$/.exec(String(spec).trim());
  if (!m || Number(m[1]) > Number(m[2])) throw new Error(`--vi ${spec}: expected FROM-TO (VI outputs since the load, FROM <= TO)`);
  return [Number(m[1]), Number(m[2])];
}

// The rows whose VI range overlaps [from, to]. Rows without a VI range are
// left out and counted (droppedNoVi). error (the probe fails on it): a range
// no row covers, or one past the last VI the run reached (the run ended
// before the dip: a longer --secs), or before the first one it saw.
export function rowsInViRange(rows, range) {
  if (!range) return { rows, droppedNoVi: 0, error: null };
  const [from, to] = range;
  const withVi = rows.filter((r) => r.vi && Number.isFinite(r.vi.from) && Number.isFinite(r.vi.to));
  const droppedNoVi = rows.length - withVi.length;
  const kept = withVi.filter((r) => r.vi.to >= from && r.vi.from <= to);
  const first = withVi.length ? Math.min(...withVi.map((r) => r.vi.from)) : null;
  const last = withVi.length ? Math.max(...withVi.map((r) => r.vi.to)) : null;
  const noVi = droppedNoVi ? ` (${droppedNoVi} row(s) without a VI range left out)` : "";
  let error = null;
  if (!withVi.length) error = `--vi ${from}-${to}: no row has a VI range (no VI timeline)${noVi}`;
  else if (to > last) error = `--vi ${from}-${to}: past the last VI the run reached (${last}): a longer --secs or --warmup${noVi}`;
  else if (from < first) error = `--vi ${from}-${to}: before the first VI of the rows (${first}): a shorter --warmup${noVi}`;
  else if (!kept.length) error = `--vi ${from}-${to}: no row covers it${noVi}`;
  return { rows: kept, droppedNoVi, error };
}

// The VIs of a drained timeline chunk (validationReadTimeline): first and
// last index since the load, and how many; null without a VI timeline.
export function viRangeOf(viEntries) {
  const idx = (viEntries ?? []).map((v) => v.sinceLoad).filter(Number.isFinite);
  if (!idx.length) return null;
  return { from: Math.min(...idx), to: Math.max(...idx), count: idx.length };
}

// A short human table: one line per row, shares of host time in %.
const COLS = [["regions", "reg"], ["blocksDispatch", "b+d"], ["idle", "idle"], ["installs", "inst"], ["other", "oth"], ["sleep", "slp"], ["flushGpuWait", "flush"], ["axHle", "ax*"],
  ["advance", "adv*"], ["throttle", "thr*"], ["sliceSetup", "set*"], ["retryDeferred", "rdw*"], ["staleCheck", "stl*"]];
export function formatTable(rows) {
  // 5 wide: "100.0" fits (a busy CPU thread is 99.99 %, never cut)
  const pct = (v) => (v == null ? "-" : (v * 100).toFixed(1)).padStart(5);
  const ratio = (v) => (v == null ? "-" : (v * 100).toFixed(0)).padStart(4);
  const list = (l) => (l?.mean == null ? "-" : `${Math.round(l.mean)}/${l.max}`).padStart(9);
  const head = ["  #", "VI from-to  ", "speed%", " busy", ...COLS.map(([, h]) => h.padStart(5)), "cov%", "ctl%", "wait m/M ", "over ms", "slow/ki", "dip"].join(" ");
  const lines = rows.map((r) => [
    String(r.i ?? "").padStart(3),
    (r.vi ? `${r.vi.from}-${r.vi.to}` : "-").padEnd(12),
    (r.speedPct == null ? "-" : r.speedPct.toFixed(1)).padStart(6),
    pct(r.cpuBusyShare),
    ...COLS.map(([k]) => pct(r.shares?.[k])),
    ratio(r.cpuThread?.coverageOfOther),
    ratio(r.cpuThread?.controlOfOther),
    list(r.cpuThread?.retryLists?.offThreadWaiting),
    (r.overAttributedMs == null ? "" : r.overAttributedMs.toFixed(1)).padStart(7),
    (r.mem?.slowPerKiloInstr == null ? "-" : r.mem.slowPerKiloInstr.toFixed(2)).padStart(7),
    r.dip == null ? "?" : r.dip ? "DIP" : ""
  ].join(" "));
  return [head, ...lines, "shares of the CPU thread's host time in %; b+d: JIT blocks + dispatch (their split is unreliable, summary.json split); ax* is inside b+d/reg (not added); adv* thr* set* rdw* (0213) are inside oth, stl* inside b+d or oth (thr* inside adv*); cov%: (adv + set + rdw) / oth; ctl%: the core's own count of oth / oth; wait m/M: off-thread waiting list mean/max; over ms: parts past the busy time (other clamped at 0); slow/ki: memory slow paths per 1000 guest instructions"].join("\n");
}

// The cost of the per-call timing, from the same run: a window with the
// region counters on but untimed (sampleEvery 0) before the timed rows.
// Busy host ms per guest second is the comparison that holds whether the
// thread sleeps or not (a capped scene keeps its speed at 100 % and pays in
// sleep); ratio > 1: the timed rows cost that much more CPU-thread time per
// emulated second. The scene moves between the two windows: an estimate.
export function timingCost(untimed, rows) {
  const busyPerGuest = (r) => (r?.busyMs != null && r.guestSeconds > 0 ? r.busyMs / r.guestSeconds : null);
  const u = busyPerGuest(untimed);
  const got = rows.filter((r) => busyPerGuest(r) != null);
  const busy = got.reduce((n, r) => n + r.busyMs, 0), guest = got.reduce((n, r) => n + r.guestSeconds, 0);
  const t = guest > 0 ? busy / guest : null;
  const mean = (f) => {
    const v = rows.map(f).filter(Number.isFinite);
    return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 2) : null;
  };
  return {
    untimedSpeedPct: untimed?.speedPct ?? null,
    timedSpeedPct: mean((r) => r.speedPct),
    untimedBusyMsPerGuestSecond: u == null ? null : round(u, 1),
    timedBusyMsPerGuestSecond: t == null ? null : round(t, 1),
    ratio: u > 0 && t != null ? round(t / u, 3) : null,
    why: u == null ? (untimed?.why?.headroom ?? "no untimed window") : t == null ? "no timed row with busy time" : null
  };
}

// Whether regions ran: the query asks for them (aot=1), the core installed
// some, and they covered cycles. A warning string, or null.
export function regionWarning({ query, rows, region }) {
  const aot = new URLSearchParams(String(query ?? "")).get("aot") === "1";
  const cov = rows.map((r) => r.regionCoverage?.raw).filter(Number.isFinite);
  const mean = cov.length ? cov.reduce((a, b) => a + b, 0) / cov.length : null;
  const installed = region && !region.error ? region.diagnostics?.regionsInstalled ?? null : null;
  if (!aot) return `no aot=1 in the query: no region runs (the product runs with aot=1&aotcompiler=1&jitoffthread=1, --config product)`;
  if (installed === 0) return "aot=1 but the core installed no region (regionsInstalled 0): regions column is 0, b+d holds everything";
  if (mean != null && mean < 0.01) return `region coverage ${round(mean * 100, 2)} % of guest cycles: regions barely ran (cache cold? a longer --warmup)`;
  return null;
}

// Rows whose parts went past the busy time (other clamped at 0): how many,
// and the worst; null when none.
export function overAttributed(rows) {
  const over = rows.map((r) => r.overAttributedMs).filter((v) => v > 0);
  return over.length ? { rows: over.length, maxMs: Math.max(...over), totalMs: round(over.reduce((a, b) => a + b, 0), 2) } : null;
}

// The console sentence on the timing's price (timingCost).
export function inflationNote(cost) {
  return cost?.ratio != null
    ? `absolute numbers inflated x${cost.ratio} by the per-call timing, compare within a run only`
    : `absolute numbers inflated by the per-call timing (cost unknown: ${cost?.why ?? "no estimate"}), compare within a run only`;
}
