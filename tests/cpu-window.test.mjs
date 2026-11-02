// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { heldWatchdog } from "../harness/probes/cpu-window.mjs";
import { classifyDips, contrast, cpuWindowBreakdown, formatTable, inflationNote, overAttributed, PARTS, parseViRange, regionWarning, rowsInViRange, timingCost, viRangeOf } from "../harness/lib/cpu-window.mjs";
import { decodeHeadroomStats } from "../harness/lib/headroom.mjs";
import { DIAGNOSTICS, decodeRegionStats } from "../harness/lib/jit-region-stats.mjs";
import { KINDS } from "../harness/lib/mem-access-stats.mjs";

const TPS = 486000000; // core ticks per guest second

// Decoded structs, field names as the decoders give them.
const headroom = ({ windowUs = 0, cpuSleepUs = 0, flushGpuWaitUs = 0, guestTicks = 0, on = true } = {}) =>
  ({ on, windowUs, cpuSleepUs, gpuWorkUs: 0, xfbCopies: 0, rushSkips: 0, flushGpuWaitUs, flushGpuWaits: 0, gpuConsumerWaitUs: 0, guestTicks, presentSleepUs: 0 });
const region = ({ sampleEvery = 64, regionCycles = 0, totalCycles = 0, regionTimeMs = 0, dispatchTimeMs = 0, blockTimeMs = 0, interpTimeMs = 0, regionCalls = 0, idleCycles = 0, idleTimeMs = 0, installMs = 0 } = {}) => ({
  version: 2, sizeBytes: 256, sampleEvery, regionCycles, totalCycles, regionTimeMs, dispatchTimeMs, blockTimeMs, interpTimeMs, regionCalls, regionNotEntry: 0, regionStops: 0,
  diagnostics: { ...Object.fromEntries(DIAGNOSTICS.map((k) => [k, 0])), idleCycles, idleTimeMs, installMs }
});
const ax = ({ on = true, mailMs = 0, mails = 0 } = {}) => ({ version: 1, sizeBytes: 64, on, mailMs, mails, mailMaxMs: 0, windowMs: 0 });
const mem = ({ on = true, instructions = 0, access = {}, slow = {}, cyclesCovered = 0, cyclesTotal = 0, regionAccesses = 0, regionInstructions = 0 } = {}) => ({
  version: 1, sizeBytes: 192, on, guestInstructions: instructions,
  ...Object.fromEntries(KINDS.map((k) => [`access.${k}`, access[k] ?? 0])), ...Object.fromEntries(KINDS.map((k) => [`slow.${k}`, slow[k] ?? 0])),
  cyclesCovered, cyclesTotal, regionAccessesEstimated: regionAccesses, regionInstructionsEstimated: regionInstructions, staticSaturations: 0
});
const snap = (t, parts) => ({ t, progress: { coreTicks: parts.headroom?.guestTicks ?? 0, coreTicksPerSecond: TPS }, ...parts });

// A 1000 ms window at full speed: 400 ms sleep, 600 busy.
function pair({ sleep = 400e3, flush = 0, guestS = 1, regionMs = 200, dispatchMs = 50, blockMs = 250, idleMs = 30, installMs = 20, axMs = 10, slowIntLoad = 4 } = {}) {
  const start = snap(1000, {
    headroom: headroom({ windowUs: 5e6, cpuSleepUs: 1e6, flushGpuWaitUs: 1e4, guestTicks: 5 * TPS }),
    region: region({ regionCycles: 1e8, totalCycles: 4e8, regionTimeMs: 1000, dispatchTimeMs: 300, blockTimeMs: 2000, idleCycles: 1e8, idleTimeMs: 100, installMs: 500 }),
    ax: ax({ mailMs: 50, mails: 1000 }),
    mem: mem({ instructions: 1e6, access: { intLoad: 1e5 }, slow: { intLoad: 10 }, cyclesCovered: 1e6, cyclesTotal: 2e6 })
  });
  const end = snap(2000, {
    headroom: headroom({ windowUs: 6e6, cpuSleepUs: 1e6 + sleep, flushGpuWaitUs: 1e4 + flush, guestTicks: (5 + guestS) * TPS }),
    region: region({ regionCycles: 2e8, totalCycles: 6e8, regionTimeMs: 1000 + regionMs, dispatchTimeMs: 300 + dispatchMs, blockTimeMs: 2000 + blockMs, idleCycles: 1.5e8, idleTimeMs: 100 + idleMs, installMs: 500 + installMs }),
    ax: ax({ mailMs: 50 + axMs, mails: 1200 }),
    mem: mem({ instructions: 2e6, access: { intLoad: 2e5, fpStore: 1e4 }, slow: { intLoad: 10 + slowIntLoad, fpStore: 1 }, cyclesCovered: 1.8e6, cyclesTotal: 3e6, regionAccesses: 5e4, regionInstructions: 1e6 })
  });
  return [start, end];
}

test("cpu window: busy / sleep / FlushGpu split and the region parts add up to the host time", () => {
  const r = cpuWindowBreakdown(...pair());
  assert.equal(r.hostMs, 1000);
  assert.equal(r.hostSource, "headroom");
  assert.equal(r.guestSeconds, 1);
  assert.equal(r.speedPct, 100);
  assert.equal(r.busyMs, 600);
  assert.equal(r.cpuBusyShare, 0.6);
  // blocks + dispatch as one part: the core's split of the two is unreliable (0075)
  assert.deepEqual(r.ms, { regions: 200, blocksDispatch: 300, interpreter: null, idle: 30, installs: 20, other: 50, sleep: 400, flushGpuWait: 0, axHle: 10, advance: null, throttle: null, sliceSetup: null, retryDeferred: null, staleCheck: null, otherDirect: null });
  // no CPU-thread diag read (an engine before 0213): its parts null, said why
  assert.equal(r.cpuThread, null);
  assert.match(r.why.cpuThread, /no CPU-thread diag read/);
  assert.equal(r.split.blocks, 250);
  assert.equal(r.split.dispatch, 50);
  assert.equal(r.split.reliable, false);
  assert.match(r.split.note, /unreliable/);
  assert.ok(!("blocks" in r.shares) && !("dispatch" in r.perGuestSecond), "the split is never a part");
  // the parts (interpreter null: not separated by the core) add up to hostMs
  assert.equal(PARTS.reduce((n, k) => n + (r.ms[k] ?? 0), 0), r.hostMs);
  assert.equal(r.shares.blocksDispatch, 0.3);
  assert.equal(r.shares.axHle, 0.01);
  assert.equal(r.perGuestSecond.regions, 200);
  assert.match(r.why.interpreter, /does not separate the interpreter/);
  // region coverage: 1e8 of 2e8 cycles, 1.5e8 outside idle skip (0.5e8 idle)
  assert.deepEqual(r.regionCoverage, { raw: 0.5, outsideIdle: 0.6667 });
  assert.deepEqual(r.ax, { mails: 200, mailMs: 10, meanMailUs: 50 });
});

test("cpu window: FlushGpu waits are taken out of the idle time (Idle waits there with SyncOnSkipIdle)", () => {
  const r = cpuWindowBreakdown(...pair({ sleep: 300e3, flush: 20e3, idleMs: 50 }));
  assert.equal(r.ms.flushGpuWait, 20);
  assert.equal(r.idleRawMs, 50);
  assert.equal(r.ms.idle, 30);
  assert.equal(r.busyMs, 680);
  assert.equal(r.ms.other, 680 - 200 - 50 - 250 - 30 - 20);
});

test("cpu window: sampled times are the core's totals, never rescaled by sampleEvery; sampleEvery 0 gives null times", () => {
  // the same deltas with sampleEvery 1, 64 or 512: the same milliseconds
  for (const n of [1, 64, 512]) {
    const [a, b] = pair();
    a.region.sampleEvery = n;
    b.region.sampleEvery = n;
    const r = cpuWindowBreakdown(a, b);
    assert.equal(r.ms.regions, 200, `sampleEvery ${n}`);
    assert.equal(r.ms.blocksDispatch, 300);
    assert.equal(r.sampleEvery, n);
  }
  const [a, b] = pair();
  a.region.sampleEvery = 0;
  b.region.sampleEvery = 0;
  const r = cpuWindowBreakdown(a, b);
  for (const k of ["regions", "blocksDispatch", "idle", "other"]) assert.equal(r.ms[k], null, k);
  assert.equal(r.split, null);
  assert.equal(r.ms.installs, 20); // install time is counted with or without timing
  assert.equal(r.regionCoverage.raw, 0.5);
  assert.match(r.why.region, /sampleEvery 0/);
  // a decoded v2 struct carries the fields this module reads
  const view = new DataView(new ArrayBuffer(256));
  view.setUint32(0, 2, true);
  view.setUint32(4, 256, true);
  view.setUint32(8, 64, true);
  const s = decodeRegionStats(Array.from(new Uint8Array(view.buffer)));
  for (const k of ["regionTimeMs", "dispatchTimeMs", "blockTimeMs", "interpTimeMs", "regionCycles", "totalCycles"]) assert.ok(k in s, k);
  for (const k of ["idleTimeMs", "idleCycles", "installMs"]) assert.ok(k in s.diagnostics, k);
  const hv = new DataView(new ArrayBuffer(96));
  [1, 96, 1].forEach((v, i) => hv.setUint32(4 * i, v, true));
  const h = decodeHeadroomStats(Array.from(new Uint8Array(hv.buffer)));
  for (const k of ["windowUs", "cpuSleepUs", "flushGpuWaitUs", "guestTicks"]) assert.ok(k in h, k);
});

test("cpu window: AX HLE is nested in blocks/regions, never added; a start before the first mail is a zero baseline", () => {
  const [a, b] = pair({ axMs: 120 });
  const r = cpuWindowBreakdown(a, b);
  assert.equal(r.ms.axHle, 120);
  assert.equal(r.ms.other, 50); // unchanged by the AX time
  a.ax = ax({ on: false });
  assert.equal(cpuWindowBreakdown(a, b).ms.axHle, 170);
  b.ax = ax({ on: false });
  const off = cpuWindowBreakdown(a, b);
  assert.equal(off.ms.axHle, null);
  assert.equal(off.ax, null);
  assert.match(off.why.ax, /not on/);
});

test("cpu window: memory slow paths per guest kilo-instruction and by kind", () => {
  const r = cpuWindowBreakdown(...pair());
  // 5 slow paths over 1e6 counted + 1e6 region-estimated instructions
  assert.equal(r.mem.slowAccesses, 5);
  assert.equal(r.mem.slowPerKiloInstr, 0.0025);
  assert.equal(r.mem.instructions, 2e6);
  assert.deepEqual(r.mem.slowByKind, { intLoad: 0.8, intStore: 0, fpLoad: 0, fpStore: 0.2, psqLoad: 0, psqStore: 0 });
  // over 1e5 + 1e4 counted accesses and 5e4 estimated in regions
  assert.equal(r.mem.slowShare, round6(5 / 160000));
  assert.equal(r.mem.coverage, 0.8);
  const none = cpuWindowBreakdown(...pair({ slowIntLoad: 0 }));
  assert.equal(none.mem.slowAccesses, 1);
});
const round6 = (v) => Math.round(v * 1e6) / 1e6;

test("cpu window: a reset in the window gives nulls with the reason, never zeros", () => {
  const [a, b] = pair();
  b.headroom = headroom({ windowUs: 2e5, cpuSleepUs: 1e5, guestTicks: TPS / 10 }); // reset: went back
  b.region = region({ regionCycles: 1, totalCycles: 2, regionTimeMs: 1 });
  b.ax = ax({ mailMs: 1, mails: 2 });
  b.mem = mem({ instructions: 10 });
  const r = cpuWindowBreakdown(a, b);
  assert.equal(r.hostSource, "node");
  assert.equal(r.hostMs, 1000);
  assert.equal(r.cpuBusyShare, null);
  for (const k of [...PARTS, "axHle"]) assert.equal(r.ms[k], null, k);
  assert.equal(r.mem, null);
  assert.equal(r.regionCoverage, null);
  assert.match(r.why.headroom, /reset in the window/);
  assert.match(r.why.region, /reset in the window/);
  assert.match(r.why.ax, /reset in the window/);
  assert.match(r.why.mem, /reset in the window/);
  // the node clock and the core progress ticks still give the speed
  assert.equal(r.speedPct, 100);
  assert.equal(cpuWindowBreakdown(a, { ...b, progress: { coreTicks: 0, coreTicksPerSecond: TPS } }).speedPct, null);
  // a missing struct or an export the core lacks: null with its error
  const [c, d] = pair();
  d.region = { error: "engine without this worker message" };
  d.headroom = null;
  const m = cpuWindowBreakdown(c, d);
  assert.equal(m.ms.regions, null);
  assert.equal(m.why.region, "engine without this worker message");
  assert.match(m.why.headroom, /no headroom read/);
  // a CPU thread that did not throttle for most of the window
  const [e, f] = pair();
  f.headroom = { ...f.headroom, windowUs: e.headroom.windowUs + 3e5 };
  assert.match(cpuWindowBreakdown(e, f).why.headroom, /no Throttle for half the window/);
});

test("dips: speed under the threshold or a saturated CPU thread; contrast per guest second", () => {
  const normal = (i) => ({ i, ...cpuWindowBreakdown(...pair()) });
  // a dip: 0.8 guest s in 1 host s, no sleep, blocks +250 ms and more AX
  const dip = (i) => ({ i, ...cpuWindowBreakdown(...pair({ sleep: 0, guestS: 0.8, blockMs: 600, regionMs: 200, axMs: 40, idleMs: 0, installMs: 0 })) });
  const rows = classifyDips([normal(1), dip(2), normal(3), dip(4), { i: 5, speedPct: null, cpuBusyShare: null }]);
  assert.deepEqual(rows.map((r) => r.dip), [false, true, false, true, null]);
  assert.match(rows[1].dipWhy.join(), /speed 80 % < 99 %/);
  assert.match(rows[1].dipWhy.join(), /busy 1 > 0.95/);
  // saturated but at full speed is a dip too; thresholds are options
  assert.equal(classifyDips([{ speedPct: 100, cpuBusyShare: 0.97 }])[0].dip, true);
  assert.equal(classifyDips([{ speedPct: 97, cpuBusyShare: 0.5 }], { speedBelow: 95 })[0].dip, false);
  const c = contrast(rows);
  assert.equal(c.dips.rows, 2);
  assert.equal(c.normal.rows, 2);
  assert.equal(c.normal.msPerGuestSecond.blocksDispatch, 300);
  assert.equal(c.dips.msPerGuestSecond.blocksDispatch, 812.5); // (600 + 50) ms / 0.8 guest s
  assert.equal(c.diff.msPerGuestSecond.blocksDispatch, 512.5);
  assert.ok(!("blocks" in c.diff.msPerGuestSecond), "grew rests on the combined figure");
  assert.equal(c.diff.msPerGuestSecond.sleep, -400);
  assert.equal(c.grew[0].part, "blocksDispatch");
  assert.ok(c.grew.some((g) => g.part === "axHle" && g.nestedIn), "AX listed as nested");
  assert.ok(!c.grew.some((g) => g.part === "sleep"));
  assert.match(c.verdict, /blocksDispatch \+512.5 ms/);
  assert.equal(c.overAttributed, null);
  assert.equal(c.dips.speedPct, 80);
  assert.equal(contrast(rows.filter((r) => !r.dip)).verdict, "no dip row");
  assert.match(formatTable(rows), /DIP/);
});

test("VI range: parsed, rows kept when they overlap, ranges from the drained timeline", () => {
  assert.deepEqual(parseViRange("1200-1260"), [1200, 1260]);
  assert.equal(parseViRange(undefined), null);
  assert.throws(() => parseViRange("20-10"), /FROM-TO/);
  assert.throws(() => parseViRange("abc"), /FROM-TO/);
  assert.deepEqual(viRangeOf([{ sinceLoad: 61 }, { sinceLoad: 62 }, { sinceLoad: 120 }]), { from: 61, to: 120, count: 3 });
  assert.equal(viRangeOf([]), null);
  const rows = [{ i: 1, vi: { from: 0, to: 59 } }, { i: 2, vi: { from: 60, to: 119 } }, { i: 3, vi: { from: 120, to: 179 } }, { i: 4, vi: null }];
  const sel = rowsInViRange(rows, [100, 130]);
  assert.deepEqual(sel.rows.map((r) => r.i), [2, 3]);
  assert.equal(sel.droppedNoVi, 1);
  assert.equal(sel.error, null);
  assert.deepEqual(rowsInViRange(rows, null), { rows, droppedNoVi: 0, error: null });
});

test("probe contract: the three stats and headroom turned on with the worker messages, perf lock, watchdog after it, exits", () => {
  const src = readFileSync(new URL("../harness/probes/cpu-window.mjs", import.meta.url), "utf8");
  assert.match(src, /"validationReadJitRegionStats", \{ sampleEvery: o\.regionSample \}/);
  assert.match(src, /"validationReadMemAccessStats", \{ reset: 0 \}/);
  assert.match(src, /"validationReadAxHleStats", \{ reset: 0 \}/);
  assert.match(src, /"validationReadHeadroomStats", \{ reset: 0 \}/);
  assert.match(src, /"region-sample": \{ type: "string", default: "64" \}/);
  assert.match(src, /acquirePerfLock\(\{ requireMains: true/);
  // the watchdog is armed after the gate (the lock held, taken back if it
  // went for calm), around the measure only, and disarmed after it
  const main = src.slice(src.indexOf("async function main"));
  const gateAt = main.indexOf("await lock.waitCalmUnlocked("), armAt = main.indexOf("watchdog.arm()"), measureAt = main.indexOf("await measure(o, server)");
  assert.ok(gateAt > 0 && armAt > gateAt && measureAt > armAt, "armed after the gate, before the measure");
  assert.ok(main.indexOf("watchdog.disarm()", measureAt) > measureAt, "disarmed after the measure");
  assert.match(main, /heldWatchdog\(\{ seconds: budgetSec, release: \(\) => lock\.release\(\) \}\)/);
  assert.doesNotMatch(main, /setTimeout\(/, "no other watchdog in main");
  assert.match(src, /process\.exit\(code\)/);
  // the display comes from the environment (HARNESS_DISPLAY): headless by
  // default, the bench screen under spark-run --headed (video=wgpu)
  assert.doesNotMatch(src, /display: "headless"/);
  assert.match(src, /openSession\(\{ base: server\.base, server, query: o\.query, iso: o\.iso, routes, harness: o\.display \? \{ displayed: true \} : \{\} \}\)/);
  // --counters-before-load: the reset (which clears the JIT cache) before the state load
  const before = src.indexOf("if (o.countersBeforeLoad) {"), load = src.indexOf("await loadHarnessState(page, session.url)");
  assert.ok(before > 0 && load > before, "counters reset before the load");
  // snapshots read only: no reset between rows
  const snapFn = src.slice(src.indexOf("export async function snapshot"), src.indexOf("// Every counter on and reset"));
  assert.doesNotMatch(snapFn, /reset: 0|sampleEvery:/);
});

test("table: a saturated CPU thread prints 100.0, a null prints -, never a cut number", () => {
  const t = formatTable([{ i: 1, vi: { from: 911, to: 945 }, speedPct: 55.4, cpuBusyShare: 0.9999, shares: { blocksDispatch: 0.78, regions: 0 }, dip: true }, { i: 2, speedPct: null, cpuBusyShare: null, shares: {}, dip: null }]);
  const [head, one, two] = t.split("\n");
  assert.match(one, / 100\.0 /);
  assert.doesNotMatch(one, / 00\.0 /);
  assert.match(two, /^ +2 -/);
  // columns line up with the header
  assert.equal(head.indexOf("busy") + 4, one.indexOf("100.0") + 5);
});

test("timing cost: busy ms per guest second, timed rows against the untimed window", () => {
  const [a, b] = pair({ sleep: 500e3 }); // untimed: 500 busy ms for 1 guest s
  const untimed = cpuWindowBreakdown(a, b);
  const rows = [cpuWindowBreakdown(...pair({ sleep: 250e3 })), cpuWindowBreakdown(...pair({ sleep: 0, guestS: 0.8 }))];
  const c = timingCost(untimed, rows);
  assert.equal(c.untimedBusyMsPerGuestSecond, 500);
  assert.equal(c.timedBusyMsPerGuestSecond, round1((750 + 1000) / 1.8));
  assert.equal(c.ratio, Math.round(((1750 / 1.8) / 500) * 1000) / 1000);
  assert.equal(c.untimedSpeedPct, 100);
  assert.equal(c.timedSpeedPct, 90);
  assert.equal(c.why, null);
  const none = timingCost(null, rows);
  assert.equal(none.ratio, null);
  assert.match(none.why, /no untimed window/);
});
const round1 = (v) => Math.round(v * 10) / 10;

test("region warning: no aot=1, no region installed, or no coverage", () => {
  const rows = [{ regionCoverage: { raw: 0.4 } }];
  const region = { diagnostics: { regionsInstalled: 140 } };
  assert.match(regionWarning({ query: "core=upstream&video=wgpu&wasmjit=1", rows, region }), /no aot=1/);
  assert.match(regionWarning({ query: "aot=1&aotcompiler=1", rows: [{ regionCoverage: { raw: 0 } }], region: { diagnostics: { regionsInstalled: 0 } } }), /installed no region/);
  assert.match(regionWarning({ query: "aot=1", rows: [{ regionCoverage: { raw: 0.001 } }], region }), /barely ran/);
  assert.equal(regionWarning({ query: "aot=1", rows, region }), null);
});

test("probe contract: the product's query by default, the untimed window before the timed rows, query and regions in the header", () => {
  const src = readFileSync(new URL("../harness/probes/cpu-window.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ PRODUCT_QUERY \} from "\.\/drop-meter\.mjs"/);
  assert.match(src, /config: \{ type: "string", default: "product" \}/);
  assert.match(src, /values\.config === "product" \? PRODUCT_QUERY/);
  assert.match(src, /"validationReadJitRegionStats", \{ sampleEvery: 0 \}/);
  assert.ok(src.indexOf("untimed = cpuWindowBreakdown(") < src.indexOf("await timeRegions(page, o)"), "untimed window first");
  assert.match(src, /log\(`query \$\{o\.query\}`\)/);
  assert.match(src, /regionWarning\(/);
  assert.match(src, /timingCost\(/);
});

test("watchdog: counts only while armed (lock held and measuring), its exit releases the lock", () => {
  let now = 0, next = 1;
  const pending = new Map();
  const timers = {
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => pending.delete(id)
  };
  const advance = (ms) => {
    now += ms;
    for (const [id, t] of [...pending]) if (t.at <= now) { pending.delete(id); t.fn(); }
  };
  const events = [];
  const dog = heldWatchdog({ seconds: 900, release: () => events.push("release"), exit: (c) => events.push(`exit ${c}`), log: () => {}, timers });
  // not armed while waiting for calm or power: no time counts
  advance(5000e3);
  assert.deepEqual(events, []);
  // armed for the measure, disarmed when it ends
  dog.arm();
  assert.equal(dog.armed, true);
  advance(600e3);
  dog.disarm();
  assert.equal(dog.armed, false);
  advance(5000e3);
  assert.deepEqual(events, []);
  // armed again: the count starts over (not 600 s already spent)
  dog.arm();
  advance(899e3);
  assert.deepEqual(events, []);
  advance(1e3);
  assert.deepEqual(events, ["release", "exit 2"], "the lock goes back before the exit");
  // a release that throws still exits
  const out = [];
  const bad = heldWatchdog({ seconds: 1, release: () => { throw new Error("gone"); }, exit: (c) => out.push(c), log: () => {}, timers });
  bad.arm();
  assert.throws(() => advance(1e3), /gone/);
  assert.deepEqual(out, [2]);
});

test("--vi: a range no row covers, or past the run, is an error, never an empty result; rows without VI are counted", () => {
  const rows = [{ i: 1, vi: { from: 0, to: 59 } }, { i: 2, vi: { from: 60, to: 119 } }, { i: 3, vi: { from: 120, to: 179 } }, { i: 4, vi: null }];
  // past the last VI the run reached (the dip came after the run)
  const past = rowsInViRange(rows, [150, 400]);
  assert.match(past.error, /past the last VI the run reached \(179\)/);
  assert.match(past.error, /1 row\(s\) without a VI range/);
  assert.match(rowsInViRange(rows, [5000, 5100]).error, /past the last VI/);
  // before the first VI of the rows
  const gapRows = [{ i: 1, vi: { from: 900, to: 959 } }, { i: 2, vi: { from: 960, to: 1019 } }];
  assert.match(rowsInViRange(gapRows, [100, 200]).error, /before the first VI of the rows \(900\)/);
  // inside the run but in a hole between rows (VIs lost): no row covers it
  const holes = [{ i: 1, vi: { from: 0, to: 59 } }, { i: 2, vi: { from: 200, to: 259 } }];
  const hole = rowsInViRange(holes, [100, 150]);
  assert.deepEqual(hole.rows, []);
  assert.match(hole.error, /no row covers it/);
  // no VI timeline at all
  const none = rowsInViRange([{ i: 1, vi: null }, { i: 2 }], [0, 10]);
  assert.equal(none.droppedNoVi, 2);
  assert.match(none.error, /no row has a VI range/);
});

test("over-attribution in the table and the verdict; the inflation sentence; --dip-busy bounded to 1", () => {
  const rows = classifyDips([
    { i: 1, speedPct: 80, cpuBusyShare: 1, hostMs: 1000, guestSeconds: 0.8, overAttributedMs: 12.5, ms: { blocksDispatch: 900 }, shares: {} },
    { i: 2, speedPct: 100, cpuBusyShare: 0.5, hostMs: 1000, guestSeconds: 1, overAttributedMs: null, ms: { blocksDispatch: 400 }, shares: {} }
  ]);
  assert.deepEqual(overAttributed(rows), { rows: 1, maxMs: 12.5, totalMs: 12.5 });
  assert.equal(overAttributed([{ overAttributedMs: null }]), null);
  const table = formatTable(rows).split("\n");
  assert.match(table[0], /over ms/);
  assert.match(table[1], / 12\.5 /);
  assert.match(contrast(rows).verdict, /1 row\(s\) over-attributed \(max 12.5 ms past the busy time\)/);
  assert.equal(inflationNote({ ratio: 1.42 }), "absolute numbers inflated x1.42 by the per-call timing, compare within a run only");
  assert.match(inflationNote({ ratio: null, why: "no untimed window" }), /cost unknown: no untimed window\), compare within a run only/);
  assert.throws(() => classifyDips([], { busyAbove: 1.5 }), /--dip-busy 1.5: a share of host time, 0 to 1/);
  assert.throws(() => classifyDips([], { busyAbove: -0.1 }), /--dip-busy/);
  assert.equal(classifyDips([{ speedPct: 100, cpuBusyShare: 1 }], { busyAbove: 1 })[0].dip, false);
});

test("probe contract: --vi failure exits non-zero, --dip-busy refused over 1 before the lock, inflation and split notes", () => {
  const src = readFileSync(new URL("../harness/probes/cpu-window.mjs", import.meta.url), "utf8");
  const main = src.slice(src.indexOf("async function main"));
  assert.ok(main.indexOf("if (o.dipBusy > 1) throw") > 0 && main.indexOf("if (o.dipBusy > 1) throw") < main.indexOf("await calmLock("), "checked before the lock");
  const failAt = main.indexOf("if (sel.error) {");
  assert.ok(failAt > 0 && main.indexOf("code = 1;", failAt) < main.indexOf("} else {", failAt), "a --vi error sets a failing exit code");
  assert.match(main, /rowsDroppedNoVi: sel\.droppedNoVi/);
  assert.match(main, /log\(inflationNote\(cost\)\)/);
  assert.match(main, /splitNote: SPLIT_NOTE/);
  // no early return out of the try: process.exit(code) is always reached
  const tryBody = main.slice(main.indexOf("try {"), main.indexOf("} catch (error)"));
  assert.doesNotMatch(tryBody, /\breturn\b/);
});
