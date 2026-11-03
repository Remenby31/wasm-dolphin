// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Patch 0213 (CPU-thread diag): the decoder on synthetic bytes, cpu-window's
// columns, and the contracts: off by default with no clock read when off
// (every diag clock read sits behind the flag), the export, the worker
// message, the layout agreed between the header and the decoder.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CPU_THREAD_DIAG_BYTES, consistentCpuThreadDiagRead, cpuThreadDiagDelta, decodeCpuThreadDiag, DEFERRED_FIELDS, deferredRunsDelta, FIELDS, PARTS } from "../harness/lib/cpu-thread-diag.mjs";
import { classifyDips, contrast, cpuWindowBreakdown, formatTable, NESTED, OTHER_PARTS, phaseCheck, screenOf } from "../harness/lib/cpu-window.mjs";
import { cpuThreadLine } from "../harness/probes/cpu-window.mjs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const PATCH = "../patches/dolphin-wasm/snapshot/0213-cpu-thread-other-diag.patch";
const SLOTS = 32;

// Bytes as the core lays them out (v2): header, 32 f64, 33 event entries,
// 16 f64 of deferred runs.
function diagBytes({ version = 3, size = CPU_THREAD_DIAG_BYTES, on = 1, slots = SLOTS, fields = {}, events = [], others = null } = {}) {
  const buf = new ArrayBuffer(CPU_THREAD_DIAG_BYTES);
  const view = new DataView(buf), u8 = new Uint8Array(buf);
  [version, size, on, slots].forEach((v, i) => view.setUint32(4 * i, v, true));
  FIELDS.forEach((f, i) => view.setFloat64(16 + 8 * i, fields[f] ?? 0, true));
  const put = (slot, name, us, calls) => {
    const at = 16 + FIELDS.length * 8 + slot * 48;
    u8.set(new TextEncoder().encode(name).subarray(0, 31), at);
    view.setFloat64(at + 32, us, true);
    view.setFloat64(at + 40, calls, true);
  };
  events.forEach(([name, us, calls], slot) => put(slot, name, us, calls));
  if (others) put(slots, "", others[0], others[1]);
  DEFERRED_FIELDS.forEach((f, i) => view.setFloat64(16 + FIELDS.length * 8 + 33 * 48 + 8 * i, fields[f] ?? 0, true));
  return Array.from(u8);
}

const EVENTS = (k) => [["_lost_event", 0, 0], ["VICallback", 5000 * k, 60 * k], ["DSPCallback", 2000 * k, 500 * k], ["AICallback", 300 * k, 30 * k], ["SITransferPending", 900 * k, 120 * k]];
// Cumulative fields after k seconds of a steady scene, plus a growth g.
function fieldsAt(k, g = 0) {
  const setup = 4000 * k, retry = 1000 * k + g, service = 500 * k, advance = 9000 * k, tail = 1500 * k;
  return {
    windowUs: 1e6 * k, iterations: 20000 * k, controlUs: setup + retry + service + advance + tail, sliceLoopUs: 5e5 * k, nestedUs: 3e5 * k,
    setupUs: setup, retryUs: retry, regionServiceUs: service, advanceUs: advance, tailUs: tail,
    eventsUs: 8200 * k, eventCalls: 710 * k, throttleUs: 400 * k, throttleCalls: 60 * k,
    offThreadWaitingNow: 12, offThreadWaitingMax: 40, offThreadWaitingSum: 20000 * k * 10,
    deferredNow: 0, deferredMax: 3, deferredSum: 1000 * k, regionWaitingNow: 2, regionWaitingMax: 5, regionWaitingSum: 20000 * k * 2,
    reverifyUs: 50 * k, reverifyCalls: 3 * k, invalidateUs: 30 * k, invalidateCalls: 10 * k, invalidateScans: 100 * k, clearRegionStateUs: 0, clearRegionStateCalls: 0,
    // 0213 v2: throttle-deferred blocks run 8000 times a second, 1000 timed
    // at 2.1 µs each (0.1 µs of clock reads); off-thread ones not at all
    throttleBlocks: 40 * k, throttleRuns: 8000 * k, throttleInstructions: 96000 * k, throttleCycles: 120000 * k,
    throttleSampledRuns: 1000 * k, throttleSampledUs: 2100 * k, clockPairUs: 0.1, sampleEvery: 8,
    // v3: setup's spans (1000 + 2500 of setup's 4000 µs a second) and the region stats' publication
    setupPolicyUs: 1000 * k, setupRequestsUs: 2500 * k, statsPublishUs: 2000 * k, statsPublishCalls: 300 * k
  };
}
const decoded = (k, g = 0) => decodeCpuThreadDiag(diagBytes({ fields: fieldsAt(k, g), events: EVENTS(k), others: [10 * k, k] }));

test("decoder: v2 fields, named event slots, the (others) bucket; bad versions, sizes and torn reads refused", () => {
  const s = decoded(2);
  assert.equal(s.on, true);
  assert.equal(s.eventSlots, 32);
  assert.equal(s.advanceUs, 18000);
  assert.equal(s.offThreadWaitingMax, 40);
  assert.deepEqual(s.events.map((e) => e.name), ["_lost_event", "VICallback", "DSPCallback", "AICallback", "SITransferPending", "(others)"]);
  assert.deepEqual(s.events[1], { slot: 1, name: "VICallback", us: 10000, calls: 120 });
  assert.equal(s.events.at(-1).slot, 32);
  assert.equal(FIELDS.length, 32);
  assert.deepEqual(PARTS, ["setupUs", "retryUs", "regionServiceUs", "advanceUs", "tailUs"]);
  // a name of 31 bytes and more is cut at 31 (NUL at 32)
  const long = decodeCpuThreadDiag(diagBytes({ events: [["X".repeat(40), 1, 1]] }));
  assert.equal(long.events[0].name, "X".repeat(31));
  assert.equal(s.throttleRuns, 16000);
  assert.equal(s.clockPairUs, 0.1);
  assert.equal(DEFERRED_FIELDS.length, 16);
  assert.match(decodeCpuThreadDiag(diagBytes({ version: 2 })).error, /layout version 2/);
  assert.match(decodeCpuThreadDiag(diagBytes({ size: 96 })).error, /struct of 96 bytes/);
  assert.match(decodeCpuThreadDiag(diagBytes().slice(0, 100)).error, /v3 needs 1984/);
  assert.match(decodeCpuThreadDiag(diagBytes({ slots: 64 })).error, /64 event slots/);
  assert.match(decodeCpuThreadDiag([]).error, /no header/);
  assert.equal(decodeCpuThreadDiag(diagBytes({ on: 0 })).on, false);
  assert.equal(consistentCpuThreadDiagRead(decoded(1), decoded(2)).advanceUs, 9000);
  assert.match(consistentCpuThreadDiagRead(decoded(2), decoded(1)).error, /torn read/);
  const renamed = decodeCpuThreadDiag(diagBytes({ fields: fieldsAt(1), events: [["Other", 0, 0]] }));
  assert.match(consistentCpuThreadDiagRead(decoded(1), renamed).error, /event names changed/);
});

test("delta: parts add up to control, coverage of other, list means, stale checks nested, events by name", () => {
  const d = cpuThreadDiagDelta(decoded(1), decoded(3, 4000), { otherMs: 40 });
  assert.equal(d.windowMs, 2000);
  assert.equal(d.iterations, 40000);
  assert.equal(d.advanceMs, 18);
  assert.equal(d.retryMs, 6); // 2 ms steady + 4 ms grown
  assert.equal(d.partsGapMs, 0);
  assert.equal(d.partsMs, d.controlMs);
  assert.equal(d.coverageOfOther, round4(d.partsMs / 40));
  assert.equal(d.controlOfOther, d.coverageOfOther);
  assert.deepEqual(d.retryLists.offThreadWaiting, { now: 12, max: 40, mean: 10 });
  assert.equal(d.retryLists.regionWaiting.mean, 2);
  assert.deepEqual(d.staleCheck, { ms: 0.16, reverifyMs: 0.1, reverifies: 6, invalidateMs: 0.06, invalidations: 20, invalidateScans: 200, clearRegionStateMs: 0, clears: 0 });
  assert.deepEqual(d.topEvents.map((e) => e.name), ["VICallback", "DSPCallback", "SITransferPending"]);
  assert.deepEqual(d.topEvents[0], { name: "VICallback", ms: 10, calls: 120 });
  assert.ok(!d.events.some((e) => e.name === "_lost_event"), "an event that never ran is left out");
  assert.equal(cpuThreadDiagDelta(decoded(1), decoded(2)).coverageOfOther, null, "no other: no coverage");
  assert.match(cpuThreadDiagDelta(decoded(2), decoded(1)).why, /reset in the window/);
  assert.match(cpuThreadDiagDelta(null, decoded(1)).why, /no CPU-thread diag read/);
  assert.match(cpuThreadDiagDelta({ error: "core has no DolphinWeb_CpuThreadDiagStats" }, decoded(1)).why, /core has no/);
  const off = decodeCpuThreadDiag(diagBytes({ on: 0 }));
  assert.match(cpuThreadDiagDelta(off, off).why, /not on/);
});

test("deferred runs: by reason, est. time = runs x (sampled mean - clock pair), null without a sample", () => {
  const d = cpuThreadDiagDelta(decoded(1), decoded(3)).deferredRuns;
  assert.deepEqual(d.throttle, { blocks: 80, runs: 16000, instructions: 192000, cycles: 240000, sampledRuns: 2000, usPerRun: 2, estMs: 32 });
  assert.deepEqual(d.offThread, { blocks: 0, runs: 0, instructions: 0, cycles: 0, sampledRuns: 0, usPerRun: null, estMs: 0 });
  assert.equal(d.estMs, 32);
  const split = cpuThreadDiagDelta(decoded(1), decoded(3)).setupSplit;
  assert.deepEqual(split, { policyMs: 2, requestsMs: 5, regionStatsSetupMs: 1, statsPublishMs: 4, statsPublishes: 600, usPerIteration: 0.2 });
  // runs with no timed sample: unknown, not zero
  const a = { ...decoded(1), offThreadRuns: 0 }, b = { ...decoded(1), offThreadRuns: 5 };
  const u = deferredRunsDelta(a, b);
  assert.equal(u.offThread.estMs, null);
  assert.equal(u.estMs, null);
  // a run counter going back is a torn read
  assert.match(consistentCpuThreadDiagRead(decoded(2), { ...decoded(2), throttleRuns: 1 }).error, /throttleRuns/);
});

const round4 = (v) => Math.round(v * 1e4) / 1e4;

// cpu-window rows: a 1000 ms window, 600 busy, other 50 ms (as
// tests/cpu-window.test.mjs pair()), with the diag in the snapshots.
const TPS = 486000000;
function snaps({ guestS = 1, sleep = 400e3, blockMs = 250, k0 = 1, k1 = 2, grow = 0 } = {}) {
  const base = (t, k, h, r, g) => ({
    t, progress: { coreTicks: h.guestTicks, coreTicksPerSecond: TPS },
    headroom: { on: true, windowUs: h.windowUs, cpuSleepUs: h.cpuSleepUs, gpuWorkUs: 0, xfbCopies: 0, rushSkips: 0, flushGpuWaitUs: 0, flushGpuWaits: 0, gpuConsumerWaitUs: 0, guestTicks: h.guestTicks, presentSleepUs: 0 },
    region: { version: 2, sizeBytes: 256, sampleEvery: 64, regionCycles: 0, totalCycles: 1, regionTimeMs: r.region, dispatchTimeMs: r.dispatch, blockTimeMs: r.block, interpTimeMs: 0, regionCalls: 0, diagnostics: { idleCycles: 0, idleTimeMs: r.idle, installMs: r.install } },
    diag: decoded(k, g)
  });
  return [
    base(1000, k0, { windowUs: 5e6, cpuSleepUs: 1e6, guestTicks: 5 * TPS }, { region: 1000, dispatch: 300, block: 2000, idle: 100, install: 500 }, 0),
    base(2000, k1, { windowUs: 6e6, cpuSleepUs: 1e6 + sleep, guestTicks: (5 + guestS) * TPS }, { region: 1200, dispatch: 350, block: 2000 + blockMs, idle: 130, install: 520 }, grow)
  ];
}

test("cpu-window: the 0213 parts nested in other, coverage per row, columns, top 3 events in the contrast", () => {
  const r = cpuWindowBreakdown(...snaps());
  assert.equal(r.ms.other, 50);
  assert.equal(r.ms.advance, 9);
  assert.equal(r.ms.throttle, 0.4);
  assert.equal(r.ms.sliceSetup, 6); // set-up 4 + region service 0.5 + close-out 1.5
  assert.equal(r.ms.retryDeferred, 1);
  assert.equal(r.ms.staleCheck, 0.08);
  assert.equal(r.ms.otherDirect, 16);
  assert.equal(r.cpuThread.coverageOfOther, round4(16 / 50));
  assert.equal(r.cpuThread.controlOfOther, round4(16 / 50));
  assert.deepEqual(r.cpuThread.topEvents.map((e) => e.name), ["VICallback", "DSPCallback", "SITransferPending"]);
  // nested: never added (other unchanged), listed with where they sit
  for (const k of ["advance", "throttle", "sliceSetup", "retryDeferred", "staleCheck", "otherDirect"]) assert.ok(NESTED[k], k);
  assert.deepEqual(OTHER_PARTS, ["advance", "sliceSetup", "retryDeferred"]);
  assert.equal(OTHER_PARTS.reduce((n, k) => n + r.ms[k], 0), r.ms.otherDirect);
  assert.equal(r.shares.advance, 0.009);

  const normal = (i) => ({ i, ...cpuWindowBreakdown(...snaps()) });
  // a dip: 0.8 guest s, no sleep, the retry grew by 30 ms and VICallback by more
  const dip = (i) => {
    const [a, b] = snaps({ guestS: 0.8, sleep: 0, blockMs: 600, k1: 3, grow: 30000 });
    return { i, ...cpuWindowBreakdown(a, b) };
  };
  const rows = classifyDips([normal(1), dip(2), normal(3), dip(4)]);
  const c = contrast(rows);
  assert.equal(c.events.normal.length, 3);
  assert.deepEqual(c.events.normal[0], ["VICallback", 5]);
  assert.deepEqual(c.events.dips[0], ["VICallback", 12.5]); // 10 ms / 0.8 guest s
  assert.deepEqual(c.events.grew.map(([k]) => k), ["VICallback", "DSPCallback", "SITransferPending"]);
  assert.ok(c.grew.some((g) => g.part === "retryDeferred" && /other/.test(g.nestedIn)));
  assert.equal(c.normal.coverageOfOther, round4(16 / 50));
  const line = cpuThreadLine(c, rows);
  assert.match(line, /coverage of other \d+(\.\d)? % \(mean of 4 rows\)/);
  assert.match(line, /dips: VICallback 12\.5, /);
  assert.match(line, /grew: VICallback /);
  assert.match(cpuThreadLine(contrast([]), [{ why: { cpuThread: "core has no DolphinWeb_CpuThreadDiagStats" } }]), /none \(core has no/);

  const [head, one] = formatTable(rows).split("\n");
  for (const h of ["adv*", "thr*", "set*", "rdw*", "stl*", "cov%", "ctl%", "wait m/M"]) assert.ok(head.includes(h), h);
  assert.equal(head.indexOf("cov%") + 4, one.indexOf(" 32 ") + 3, "coverage under its header");
  assert.match(one, / 10\/40 /, "off-thread waiting list mean/max");
  // a row without the diag prints dashes, never a number
  const bare = formatTable([{ i: 1, speedPct: 100, cpuBusyShare: 0.5, shares: {}, dip: false }]).split("\n")[1];
  assert.match(bare, / {3}- {4}- {9}- /);
});

test("probe contract: the diag turned on with the others (also before the load), read in every snapshot", () => {
  const src = read("../harness/probes/cpu-window.mjs");
  const enable = src.slice(src.indexOf("async function enableStats"), src.indexOf("const timeRegions"));
  assert.match(enable, /cpuThread: status\(await req\("validationReadCpuThreadDiag", \{ reset: 0 \}\)\)/);
  // --counters-before-load and the default both go through enableStats
  assert.equal(src.match(/enabled = await enableStats\(page, \{ light: o\.light \}\)/g).length, 2);
  // --light: headroom and the diag only; no region, memory or AX read, no region timing
  const light = enable.slice(enable.indexOf("if (light) {"), enable.indexOf("  return {\n    mem: status"));
  assert.match(light, /validationReadHeadroomStats/);
  assert.match(light, /validationReadCpuThreadDiag/);
  assert.doesNotMatch(light, /validationReadJitRegionStats|validationReadMemAccessStats|validationReadAxHleStats/);
  assert.match(src, /const timed = o\.light \? null : await timeRegions\(page, o\);/);
  assert.equal(src.match(/await snapshot\(page, \{ light: o\.light \}\)/g).length, 4);
  const snapFn = src.slice(src.indexOf("export async function snapshot"), src.indexOf("// Every counter on and reset"));
  assert.match(snapFn, /const region = light \? off : decoded\(await req\("validationReadJitRegionStats"/);
  assert.match(snapFn, /"validationReadCpuThreadDiag", \{ reset: -1 \}\), decodeCpuThreadDiag, consistentCpuThreadDiagRead/);
  assert.match(snapFn, /return \{ t: [^}]*diag, progress, screen \}/);
  assert.match(src, /log\(cpuThreadLine\(c, run\.rows\)\)/);
});

test("worker contract: validationReadCpuThreadDiag, harness-only, on/reset/off payload, two whole-f64 copies", () => {
  const worker = read("../src/upstream-discio-worker.js");
  assert.match(worker, /case "validationReadCpuThreadDiag":\n {6}return harnessCpuThreadDiag\(payload\);/);
  const fn = worker.slice(worker.indexOf("function harnessCpuThreadDiag("), worker.indexOf("// Present cadence (patch 0162"));
  assert.match(fn, /if \(!harnessEnabled\) return \{ error: "harness hooks are off" \};/);
  assert.match(fn, /moduleInstance\?\._DolphinWeb_CpuThreadDiagStats;/);
  assert.match(fn, /reset >= 0 \|\| reset === -2\) \? reset : -1/);
  assert.match(fn, /getUint32\(4, true\), 1984\)/);
  assert.match(fn, /new Float64Array\(heap\.buffer, ptr, size \/ 8\)\.slice\(\)\.buffer/);
  assert.match(fn, /return \{ bytes: copy\(\), again: copy\(\) \};/);
  // the product never turns it on: only the harness message calls the export
  assert.equal(worker.match(/_DolphinWeb_CpuThreadDiagStats/g).length, 1);
});

// The patch's new-side text, hunk by hunk ({ file, lines }).
function hunks(patch) {
  const out = [];
  let file = null, cur = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (line.startsWith("@@")) out.push((cur = { file, lines: [] }));
    else if (cur && (line.startsWith("+") || line.startsWith(" "))) cur.lines.push({ text: line.slice(1), added: line.startsWith("+") });
  }
  return out;
}

// Whether line i sits in a block opened by `if (<flag>)` (any depth out),
// counting braces backwards in the hunk.
function insideGuard(lines, i, guard) {
  let depth = 0;
  for (let j = i - 1; j >= 0; j -= 1) {
    const t = lines[j].text.replace(/\/\/.*$/, "");
    for (let c = t.length - 1; c >= 0; c -= 1) {
      if (t[c] === "}") depth += 1;
      else if (t[c] === "{") {
        if (depth === 0) {
          const opener = `${lines[j - 1]?.text ?? ""}\n${t.slice(0, c)}`;
          if (guard.test(opener)) return true;
        } else depth -= 1;
      }
    }
  }
  return false;
}

test("0213 contract: off by default, every diag clock read behind the flag (zero cost off)", () => {
  const patch = read(PATCH);
  const flag = /^\s*(?:if \((?:cpu_thread_diag|on)\)|if \(cpu_thread_diag\)\s*$)/m;
  let reads = 0;
  for (const h of hunks(patch)) {
    h.lines.forEach((l, i) => {
      if (!l.added || !/\bNow\(\)/.test(l.text) || /inline TimePoint Now\(\)/.test(l.text)) return;
      // Mark()'s own read: every Mark call is checked below
      if (/^ +t\[i\] = DolphinWeb::CpuThreadDiag::Now\(\);$/.test(l.text)) return;
      // the reset's clock-pair calibration (ApplyReset runs with the flag on
      // only) and a deferred block's timed run (after its own On() return):
      // both checked below
      if (/^ +const TimePoint a = Now\(\);$|^ +pair = std::min\(pair, Micros\(Now\(\) - a\)\);$/.test(l.text)) return;
      if (/^ +const D::TimePoint start = D::Now\(\);$|^ +D::AddDeferredSample\(operands\.reason, D::Now\(\) - start, nested_before\);$/.test(l.text)) return;
      reads += 1;
      // a ternary on the flag, a one-line if on the line before, or a block
      // opened by if (flag)
      const ternary = /(cpu_thread_diag|on_) \?\s*(DolphinWeb::CpuThreadDiag::)?Now\(\)/.test(l.text) ||
        /(cpu_thread_diag|on_) \?\s*$/.test(h.lines[i - 1]?.text ?? "");
      const oneLine = /^\s*if \((cpu_thread_diag|DolphinWeb::CpuThreadDiag::On\(\))\)\s*$/.test(h.lines[i - 1]?.text ?? "");
      assert.ok(ternary || oneLine || insideGuard(h.lines, i, /if \((cpu_thread_diag|on)\)\s*$/), `${h.file}: unguarded clock read: ${l.text.trim()}`);
    });
  }
  assert.ok(reads >= 6, `clock reads found: ${reads}`);
  // Mark() reads the clock: every call behind the flag
  const marks = patch.match(/\+ +(if \(cpu_thread_diag\)\n\+ +)?diag\.Mark\(\d\);/g) ?? [];
  assert.equal(marks.length, 9);
  for (const m of marks.filter((x) => !/Mark\(0\)|Mark\(8\)/.test(x))) assert.match(m, /if \(cpu_thread_diag\)/);
  assert.match(patch, /\+ +if \(cpu_thread_diag\)\n\+ +\{\n\+ +diag\.Mark\(0\);/);
  assert.match(patch, /\+ +if \(cpu_thread_diag\)\n\+ +\{\n\+ +diag\.Mark\(8\);/);
  // off by default; the flag read once per Run iteration / Advance / Throttle
  assert.match(patch, /\+inline std::atomic<bool> g_on\{false\};/);
  assert.match(patch, /\+    const bool cpu_thread_diag = DolphinWeb::CpuThreadDiag::On\(\);\n\+    CpuThreadDiagIteration diag;/);
  assert.match(patch, /\+  const bool cpu_thread_diag = DolphinWeb::CpuThreadDiag::On\(\);\n\+#endif\n   CPUThreadConfigCallback::CheckForConfigChanges\(\);/);
  // the event callbacks: timed only with the flag; nested time taken out
  assert.match(patch, /\+    if \(cpu_thread_diag\)\n\+    \{\n\+      DolphinWeb::CpuThreadDiag::AddEvent\(evt\.type->diag_slot,/);
  // nested time is added with the flag only (sleep, installs, FlushGpu)
  assert.equal((patch.match(/\+ +if \(DolphinWeb::CpuThreadDiag::On\(\)\)\n\+ +DolphinWeb::CpuThreadDiag::AddNested\(/g) ?? []).length, 3);
  // ApplyReset: called behind the flag only; the deferred run: returns
  // before any clock read when off
  assert.match(patch, /\+    if \(cpu_thread_diag\)\n\+    \{\n\+      diag\.Mark\(0\);\n\+      DolphinWeb::CpuThreadDiag::ApplyReset\(diag\.t\[0\]\);/);
  assert.equal((patch.match(/ApplyReset\(/g) ?? []).length, 2, "ApplyReset: defined once, called once");
  assert.match(patch, /\+  if \(!D::On\(\) \|\| !D::NoteDeferredRun\(operands\.reason, operands\.instructions, operands\.cycles\)\)\n\+    return CPU_THREAD_DIAG_DEFERRED_SIZE;\n\+  const double nested_before = D::g_stats\.nested_us;\n\+  const D::TimePoint start = D::Now\(\);/);
  // the marker is written only with the flag on, and only for a block left
  // to the interpreter by the throttle or the compiler worker
  assert.match(patch, /\+  if \(cpu_thread_diag\)\n\+  \{\n\+    const bool throttled =[\s\S]*?\+    if \(throttled \|\| posted\)\n\+    \{[\s\S]*?\+      Write\(CpuThreadDiagDeferredRun, /);
  // RetryDeferredWasmBlocks itself is untouched (contract harnesses compile it alone)
  assert.doesNotMatch(patch, /^[+-].*void RetryDeferredWasmBlocks/m);
  assert.ok(patch.includes("\n     RetryDeferredWasmBlocks(*this);\n"), "the call is a context line");
});

test("0213 contract: the export (EMSCRIPTEN_KEEPALIVE, as the 0113/0075 stats), the layout agreed with the decoder", () => {
  const patch = read(PATCH);
  assert.match(patch, /\+extern "C" EMSCRIPTEN_KEEPALIVE u32 DolphinWeb_CpuThreadDiagStats\(int n\)/);
  // the other stats exports of the series are KEEPALIVE the same way (no
  // EXPORTED_FUNCTIONS entry: the series exports them with the attribute)
  assert.match(read("../patches/dolphin-wasm/snapshot/0113-headroom-counters.patch"), /EMSCRIPTEN_KEEPALIVE u32 DolphinWeb_HeadroomStats\(int reset\)/);
  assert.match(patch, /\+  u32 version = 3;\n\+  u32 size_bytes = 1984;/);
  assert.match(patch, /\+constexpr u32 EVENT_SLOTS = 32;/);
  assert.match(patch, /\+static_assert\(sizeof\(Stats\) == 16 \+ 32 \* 8 \+ \(EVENT_SLOTS \+ 1\) \* 48 \+ 16 \* 8\);/);
  // the f64 fields in the decoder's order
  const body = patch.slice(patch.indexOf("+struct Stats"), patch.indexOf("+  EventEntry events[EVENT_SLOTS + 1];"));
  const names = [...body.matchAll(/\+  double (\w+) = 0;/g)].map((m) => m[1]);
  const camel = (n) => n.replace(/_(\w)/g, (_, c) => c.toUpperCase()).replace(/Us$/, "Us");
  assert.deepEqual(names.map(camel), FIELDS);
  // v2: two DeferredRuns (6 f64 each), then 4 f64, after the events
  const runs = patch.slice(patch.indexOf("+struct DeferredRuns"), patch.indexOf("+constexpr u32 DEFERRED_THROTTLE"));
  const runNames = [...runs.matchAll(/\+  double (\w+) = 0;/g)].map((m) => camel(m[1]));
  const tail = patch.slice(patch.indexOf("+  DeferredRuns deferred[2];"), patch.indexOf("+static_assert(sizeof(EventEntry)"));
  const tailNames = [...tail.matchAll(/\+  double (\w+) = /g)].map((m) => camel(m[1]));
  const cap = (n) => n[0].toUpperCase() + n.slice(1);
  assert.deepEqual([...["throttle", "offThread"].flatMap((r) => runNames.map((n) => `${r}${cap(n)}`)), ...tailNames], DEFERRED_FIELDS);
  assert.match(patch, /\+constexpr u32 DEFERRED_THROTTLE = 0;\n\+constexpr u32 DEFERRED_OFF_THREAD = 1;/);
  assert.equal(16 + names.length * 8 + (SLOTS + 1) * 48 + DEFERRED_FIELDS.length * 8, CPU_THREAD_DIAG_BYTES);
  // event slots by registered name, generic: no game name, no guest address
  assert.match(patch, /\+  event_type->diag_slot = DolphinWeb::CpuThreadDiag::SlotFor\(name\);/);
  assert.doesNotMatch(patch.split("\n").filter((l) => l.startsWith("+")).join("\n"), /0x8[0-9a-f]{7}/i);
});

test("0213 contract: in the locked series after 0211, the core ABI lists the worker message", () => {
  const lock = JSON.parse(read("../provenance/dolphin-source.lock.json"));
  const paths = lock.patches.map((p) => p.path);
  const at = paths.indexOf("patches/dolphin-wasm/snapshot/0213-cpu-thread-other-diag.patch");
  assert.ok(at > paths.indexOf("patches/dolphin-wasm/snapshot/0211-stale-xfb-shows-last-picture.patch"));
  const abi = read("../provenance/dolphin-core-abi-v1.json");
  assert.ok(abi.includes('"validationReadCpuThreadDiag"'), "the ABI manifest lists validationReadCpuThreadDiag (npm run update:core-abi)");
});

test("phaseCheck: COMPLETE with the compile wave then game rows; INCOMPLETE without either, or without the v2 diag", () => {
  const dr = (blocks) => ({ throttle: { blocks: 0 }, offThread: { blocks } });
  // 0.25 s rows: 10 s of menu (40 draws/frame), a 1 s wave of 4 x 60 blocks, then game (400 draws/frame)
  const rows = [];
  for (let i = 1; i <= 80; i += 1) {
    const game = i > 44;
    rows.push({ i, atS: i * 0.25, cpuThread: { deferredRuns: dr(i > 40 && i <= 44 ? 60 : 2) }, screen: { dtS: 0.25, draws: (game ? 400 : 40) * 15, frames: 15, newFps: 60 } });
  }
  const ok = phaseCheck(rows);
  assert.equal(ok.verdict, "COMPLETE");
  assert.equal(ok.wave.blocks, 240);
  assert.equal(ok.wave.fromS, 10);
  assert.ok(ok.gameSecAfterWave >= 8.5, String(ok.gameSecAfterWave));
  // the route stopped in the menu: the wave never came
  const menu = rows.map((r) => ({ ...r, cpuThread: { deferredRuns: dr(2) }, screen: { ...r.screen, draws: 40 * 15 } }));
  assert.equal(phaseCheck(menu).verdict, "INCOMPLETE");
  assert.match(phaseCheck(menu).why[0], /no compile wave/);
  // the wave, but the game never showed (a load that never ended)
  const stuck = rows.map((r) => ({ ...r, screen: { ...r.screen, draws: 40 * 15 } }));
  assert.match(phaseCheck(stuck).why.join(), /no game phase after the wave: 0 s/);
  // a core without the diag: the transition from the screen alone (menu, then game)
  const noDiag = phaseCheck(rows.map((r) => ({ ...r, cpuThread: null })));
  assert.equal(noDiag.verdict, "COMPLETE");
  assert.equal(noDiag.waveSignal, "menu-to-game");
  assert.equal(noDiag.gameFromS, 11.25); // the pooled second reaches 200 draws a frame with the second game row
  assert.equal(noDiag.wave.fromS, 10.25);
  assert.match(phaseCheck(menu.map((r) => ({ ...r, cpuThread: null }))).why[0], /no game rows/);
  // screenOf: draws per produced frame between two snapshots
  assert.deepEqual(screenOf({ t: 0, screen: { draws: 100 } }, { t: 500, screen: { draws: 3100, producedFps: 60, newFps: 58 } }), { dtS: 0.5, draws: 3000, frames: 30, newFps: 58 });
  assert.equal(screenOf({ t: 0, screen: null }, { t: 500, screen: { draws: 1 } }), null);
});

test("probe contract: --steps-during runs alongside the rows and its phase check reaches the summary", () => {
  const src = read("../harness/probes/cpu-window.mjs");
  assert.match(src, /const duringRun = o\.during \? runSteps\(page, o\.during\)/);
  assert.match(src, /if \(duringDone\?\.unfinished\) throw new Error/);
  assert.match(src, /stepsDuring: values\["steps-during"\] \? \{ file: path\.basename\(values\["steps-during"\]\), doneAtS: run\.stepsDuringDoneS, \.\.\.phaseCheck\(run\.rows\) \} : null,/);
  assert.match(src, /screen: screenOf\(snaps\.at\(-1\), snap\)/);
  // --sampler-ms: the drop sampler started as drop-meter starts it, drained every row; --display: the harness's displayed trace
  assert.match(src, /workerRequest\(page, "validationDropSampler", \{ action: "start", everyMs: o\.samplerMs \}, 5000\)/);
  assert.match(src, /if \(o\.samplerMs\) snap\.sampler = lastSamplerRow\(await workerRequest\(page, "validationDropSampler", \{ action: "drain" \}, 10000\)/);
  assert.match(src, /light: o\.light, displayTrace: o\.display, samplerMs: o\.samplerMs,/);
});

test("--sampler-ms: the drain's last row as counters, deltas per row (u32 µs wrap)", async () => {
  const { lastSamplerRow, samplerDelta } = await import("../harness/probes/cpu-window.mjs");
  const a = lastSamplerRow({ columns: ["t", "jitCompiles", "jitUs", "jitModuleUs"], rows: [[1, 5, 100, 10], [2, 10, 400, 2 ** 32 - 10]] });
  assert.deepEqual(a, { t: 2, jitCompiles: 10, jitUs: 400, jitModuleUs: 2 ** 32 - 10 });
  const b = { t: 3, jitCompiles: 30, jitUs: 1400, jitModuleUs: 20 };
  const d = samplerDelta(a, b);
  assert.equal(d.jitCompiles, 20);
  assert.equal(d.jitUs, 1000);
  assert.equal(d.jitModuleUs, 30);
  assert.equal(d.offThreadDefers, null);
  assert.equal(lastSamplerRow({ columns: ["t"], rows: [] }), null);
  assert.equal(samplerDelta(null, b), null);
});

test("probe contract: --reload-after plays, counts the installed regions, loads the state again; rows from that load", () => {
  const src = read("../harness/probes/cpu-window.mjs");
  const at = src.indexOf("if (o.reloadAfter) {");
  const body = src.slice(at, src.indexOf("} else if (o.steps) {", at));
  assert.match(body, /await page\.waitForTimeout\(o\.reloadAfter \* 1000\);/);
  assert.match(body, /validationReadJitRegionStats/);
  assert.match(body, /const again = await loadHarnessState\(page, session\.url\);/);
  assert.match(body, /loadedAt = performance\.now\(\);/);
  assert.match(src, /warm: run\.warm,/);
});
