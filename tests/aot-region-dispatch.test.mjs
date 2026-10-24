// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Regions in the dispatcher (P4 step 5): modules queued from any thread are
// installed at a slice boundary, the dispatcher runs the region holding the
// pc before looking for a block, only with translation and FP on, and
// invalidating covered code drops them. Skipped with a core before 0075.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { imageFromDol } from "../src/aot-image.js";
import { planDol } from "../src/aot-plan.js";
import { coreStatus } from "../tools/core-artifacts.mjs";
import { assembleRegion, claimEntries, regionModuleKey, paddedSleb, paddedUleb, patchRegionHeap, regionHeapOfBytes } from "../src/aot-region-module.js";
import { coreAssembleOptions, coreRegionTranslator, translateWithContinuations } from "../src/aot-orchestrator.js";
import { PRODUCTION_DISABLE_MASK } from "./helpers/jit-oracle.mjs";
import { asm, assemble, buildDol } from "./aot-asm.mjs";
import { HELPER_SIGNATURES, STOP, functionFragments, loadAotCore, regionGroups, seedGprs } from "./helpers/aot-core-equivalence.mjs";
import { makeRng, randomProgram } from "./helpers/jit-oracle.mjs";

const core = await loadAotCore();
const skip = !core?.has("DolphinWeb_AotQueueRegion") && "core without the region dispatcher (patch 0075)";
const TEXT = 0x80003100;
const add = (d, a, b) => (31 << 26) | (d << 21) | (a << 16) | (b << 11) | (266 << 1);
const stw = (s, a, off) => (36 << 26) | (s << 21) | (a << 16) | (off & 0xffff);
const lwz = (d, a, off) => (32 << 26) | (d << 21) | (a << 16) | (off & 0xffff);
const mtlr = (s) => (31 << 26) | (s << 21) | (8 << 16) | (467 << 1);
const PROGRAM = assemble(TEXT, [
  "main", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), asm.li(3, 7), (pc, l) => asm.bl(pc, l.double),
  (pc, l) => asm.bl(pc, l.count), lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  "double", add(3, 3, 3), asm.blr(),
  "count", asm.li(8, 0),
  "count_loop", asm.addi(8, 8, 3), asm.cmplwi(8, 30), (pc, l) => asm.bgt(pc, l.count_done), (pc, l) => asm.b(pc, l.count_loop),
  "count_done", asm.blr()
]);

function setup() {
  const dol = buildDol({ textAddr: TEXT, text: PROGRAM.words, entry: PROGRAM.labels.main });
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  for (const s of image.segments) core.load(s.start, s.bytes);
  core.invalidate(TEXT, 4 * PROGRAM.words.length); // regions of an earlier test are dropped
  core.module._DolphinWeb_AotForgetRegionsForTest?.(); // (0085: an invalidation alone keeps unchanged code)
  return plan;
}

// Every region of the plan, queued as P7 would (members with the plan's hashes).
function queueAll(plan, maxFunctions = 100, chain = false) {
  let entries = 0;
  for (const group of regionGroups(plan, maxFunctions)) {
    const fragments = group.flatMap(functionFragments(core));
    const { bytes, entries: mapped } = assembleRegion(fragments, { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages, chain });
    core.queueRegion(bytes, mapped.map(([pc]) => pc), group.map((f) => ({ ranges: f.ranges, hash: f.hash })));
    entries += mapped.length;
  }
  return entries;
}

// The modules queueAll queues, in the same order.
function regionModules(plan) {
  return regionGroups(plan, 100).map((group) =>
    assembleRegion(group.flatMap(functionFragments(core)), { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages }).bytes);
}

// The program's regions installed, from a clean code image (each test alone).
function installed() {
  const plan = setup();
  core.setRegionsEnabled(true);
  const before = core.regionCount();
  const entries = queueAll(plan);
  core.serviceRegions();
  return { plan, before, entries };
}

// The CPU loop, one dispatch at a time: a region where there is one, else
// one interpreted instruction.
function runCall(entry, { regions }) {
  core.reset(seedGprs(entry), entry, STOP, 400000);
  let ran = 0, interpreted = 0;
  for (let n = 0; n < 100000 && core.pc() !== STOP; n++) {
    if (regions && core.dispatchRegion()) { ran += 1; continue; }
    assert.equal(core.interpretOne(), 0, "no exception");
    interpreted += 1;
  }
  assert.equal(core.pc(), STOP);
  return { state: core.state(), downcount: core.downcount(), ran, interpreted };
}

const ADDI_R3_1 = ((14 << 26) | (3 << 21) | (3 << 16) | 1) >>> 0; // addi r3,r3,1
const patchDouble = () => core.load(PROGRAM.labels.double, Uint8Array.of(ADDI_R3_1 >>> 24, (ADDI_R3_1 >>> 16) & 0xff, (ADDI_R3_1 >>> 8) & 0xff, ADDI_R3_1 & 0xff));

test("queued regions install at the slice boundary and the dispatcher runs them like the interpreter", { skip }, () => {
  const plan = setup();
  core.setRegionsEnabled(true);
  const before = core.regionCount();
  const entries = queueAll(plan);
  assert.equal(core.regionCount(), before, "nothing is mapped before the slice boundary");
  core.serviceRegions();
  assert.equal(core.regionCount(), before + entries);
  const stats0 = core.regionStats(0);
  assert.deepEqual([stats0.version, stats0.sizeBytes, stats0.sampleEvery], [2, 256, 0]); // v2: v1 + diagnostics with install counters
  const reference = runCall(PROGRAM.labels.main, { regions: false });
  const got = runCall(PROGRAM.labels.main, { regions: true });
  // Calls between functions of a region are return_calls: the whole call
  // runs in region code, the interpreter runs nothing.
  assert.ok(got.ran >= 1, `regions ran (${got.ran})`);
  assert.equal(got.interpreted, 0);
  assert.deepEqual(got.state, reference.state);
  assert.equal(got.downcount, reference.downcount);
  const stats = core.regionStats();
  assert.equal(stats.regionCalls, got.ran);
  assert.equal(stats.regionStops, 0);
  assert.ok(stats.regionCycles > 0);
});

test("regions run only with translation and FP on", { skip }, () => {
  installed();
  core.reset(seedGprs(1), PROGRAM.labels.double, STOP, 400000);
  assert.equal(core.dispatchRegion(), 1);
  core.reset(seedGprs(1), PROGRAM.labels.double, STOP, 400000);
  const msr = core.state()[37];
  core.loadState(Uint32Array.from(core.state(), (v, i) => (i === 37 ? msr & ~0x2000 : v)), PROGRAM.labels.double);
  assert.equal(core.dispatchRegion(), 0, "FP off: the block path");
});

// Patch 0085: an invalidation over a region's code checks it again against
// the plan's hashes before it next runs: the same bytes written again (the
// OS init on every second launch) keep it, changed code drops it.
const rechecks = () => {
  const p = core.module._malloc(12);
  try {
    core.module._DolphinWeb_AotRegionRechecks(p);
    return Array.from(new Uint32Array(core.module.HEAPU8.buffer, p, 3));
  } finally {
    core.module._free(p);
  }
};
test("invalidating covered code: unchanged code keeps its region, changed code drops it before it runs", { skip: skip || (!core?.has("DolphinWeb_AotRegionRechecks") && "core without region re-checks (0085)") }, () => {
  installed();
  const count = core.regionCount();
  core.invalidate(0x80100000, 0x1000);
  assert.equal(core.regionCount(), count, "unrelated code");
  const [kept, reverified] = rechecks();
  core.load(PROGRAM.labels.double, core.ram().slice(PROGRAM.labels.double & 0x01ffffff, (PROGRAM.labels.double & 0x01ffffff) + 4));
  core.invalidate(PROGRAM.labels.double, 4); // the same bytes again (a DMA of the same code)
  assert.equal(core.regionCount(), count, "kept, to be checked");
  assert.equal(rechecks()[0], kept + 1);
  core.reset(seedGprs(1), PROGRAM.labels.double, STOP, 400000);
  assert.equal(core.dispatchRegion(), 1, "unchanged: checked and run");
  assert.equal(rechecks()[1], reverified + 1);
  const reference = runCall(PROGRAM.labels.main, { regions: false });
  assert.deepEqual(runCall(PROGRAM.labels.main, { regions: true }).state, reference.state);
  patchDouble();
  core.invalidate(PROGRAM.labels.double, 4);
  core.reset(seedGprs(1), PROGRAM.labels.double, STOP, 400000);
  assert.equal(core.dispatchRegion(), 0, "changed: dropped before it runs");
  assert.ok(core.regionCount() < count, "the region with double is gone");
  const patched = runCall(PROGRAM.labels.main, { regions: false });
  assert.deepEqual(runCall(PROGRAM.labels.main, { regions: true }).state, patched.state, "the new code runs");
});

// Review of #85: a region already due for a check is not scanned again by
// every later invalidation (a game invalidating a megabyte line by line), and
// a forced invalidation (breakpoints) drops it at once, as before.
test("invalidations skip a region already due for a check; a forced one drops it", { skip: skip || (typeof core?.module._DolphinWeb_AotInvalidateForcedForTest !== "function" && "core without forced invalidations (0085)") }, () => {
  installed();
  const count = core.regionCount();
  const same = () => core.load(PROGRAM.labels.double, core.ram().slice(PROGRAM.labels.double & 0x01ffffff, (PROGRAM.labels.double & 0x01ffffff) + 4));
  same();
  const before = rechecks()[2];
  core.invalidate(PROGRAM.labels.double, 4); // every live region looked at; the one over double kept, to be checked
  const first = rechecks()[2] - before;
  assert.ok(first >= 1);
  const scans = rechecks()[2];
  for (let line = 0; line < 64; line++) core.invalidate(PROGRAM.labels.double, 4);
  assert.equal(rechecks()[2] - scans, 64 * (first - 1), "the region due for a check is never looked at again, the others once per invalidation");
  assert.equal(core.regionCount(), count, "kept");
  core.module._DolphinWeb_AotInvalidateForcedForTest(PROGRAM.labels.double, 4);
  assert.ok(core.regionCount() < count, "a forced invalidation drops it");
  core.reset(seedGprs(1), PROGRAM.labels.double, STOP, 400000);
  assert.equal(core.dispatchRegion(), 0);
});

test("invalidating covered code drops the regions holding it, other code keeps them (core before 0085)", { skip: skip || (core?.has("DolphinWeb_AotRegionRechecks") && "core with region re-checks (0085)") }, () => {
  installed();
  const count = core.regionCount();
  core.invalidate(0x80100000, 0x1000);
  assert.equal(core.regionCount(), count, "unrelated code");
  core.invalidate(PROGRAM.labels.double, 4);
  assert.ok(core.regionCount() < count, "the region with double is gone");
  core.reset(seedGprs(1), PROGRAM.labels.double, STOP, 400000);
  assert.equal(core.dispatchRegion(), 0);
});

test("code changed between translation and install: the region is never installed (plan hashes)", { skip }, () => {
  const plan = setup();
  core.setRegionsEnabled(true);
  const before = core.regionCount();
  queueAll(plan);
  patchDouble(); // the game rewrites double and invalidates it before the slice boundary
  core.invalidate(PROGRAM.labels.double, 4);
  core.serviceRegions();
  core.reset(seedGprs(1), PROGRAM.labels.double, STOP, 400000);
  assert.equal(core.dispatchRegion(), 0, "no stale region for double");
  assert.equal(core.regionCount(), before, "the region holding double was refused");
  const reference = runCall(PROGRAM.labels.main, { regions: false });
  const got = runCall(PROGRAM.labels.main, { regions: true });
  assert.deepEqual(got.state, reference.state, "the new code runs");
});

test("after a cache clear, regions are hashed again: changed code is dropped, unchanged code runs", { skip }, () => {
  installed();
  core.unverifyRegions();
  core.reset(seedGprs(1), PROGRAM.labels.count, STOP, 400000);
  assert.equal(core.dispatchRegion(), 1, "unchanged code: verified, runs");
  patchDouble(); // no icbi: a state load replaced memory
  core.unverifyRegions();
  core.reset(seedGprs(1), PROGRAM.labels.double, STOP, 400000);
  assert.equal(core.dispatchRegion(), 0, "changed code: dropped before it runs");
  const reference = runCall(PROGRAM.labels.main, { regions: false });
  const got = runCall(PROGRAM.labels.main, { regions: true });
  assert.deepEqual(got.state, reference.state);
});

// jitoffthread=1 (the production default): the CPU thread never compiles a
// region module cold. It posts a compile request under its bytes' key and
// installs the region once the worker set the ready byte, so its own compile
// is a hit in V8's native module cache; meanwhile the block JIT runs the code.
function withOffThreadCompile(fn) {
  const m = core.module;
  const saved = Object.getOwnPropertyDescriptor(globalThis, "self");
  const posted = [];
  Object.defineProperty(globalThis, "self", { value: { postMessage: (msg) => posted.push(msg) }, configurable: true, writable: true });
  const savedCache = m._dolphinJitCache;
  m._dolphinJitCache = new Map(); // the pthread's module map (pre-js), empty
  m._SetPpcWasmJitOffThread(1);
  // 0107: a ready module waits for a throttle sleep (2 s at most); these
  // tests install at slice boundaries, as after that wait.
  m._DolphinWeb_AotSetSleepWaitForTest?.(0);
  try {
    return fn(posted.filter.bind(posted, (msg) => msg.type === "dolphin-jit-compile-request"));
  } finally {
    m._DolphinWeb_AotSetSleepWaitForTest?.(2000);
    m._SetPpcWasmJitOffThread(0);
    m._dolphinJitCache = savedCache;
    globalThis._dolphinJitInflight?.clear();
    if (saved) Object.defineProperty(globalThis, "self", saved);
    else delete globalThis.self;
  }
}
// The path of the last sampled install (DolphinWeb_JitRegionInstallSamples:
// 0 first attempt, 1 after the ready byte, 2 cold), or null when full.
function lastInstallPath() {
  const m = core.module, at = m._DolphinWeb_JitRegionInstallSamples() >>> 0;
  const view = new DataView(m.HEAPU8.buffer, at);
  const count = view.getUint32(0, true);
  return count && count < view.getUint32(4, true) ? view.getUint32(8 + 12 * (count - 1) + 8, true) : null;
}
const offThreadSkip = skip || (!core?.has("SetPpcWasmJitOffThread") && "core without jitoffthread");

test("with jitoffthread=1 a region installs once the worker marked its module ready", { skip: offThreadSkip }, () => {
  withOffThreadCompile((requests) => {
    const plan = setup();
    core.setRegionsEnabled(true);
    const before = core.regionCount();
    const entries = queueAll(plan);
    core.serviceRegions();
    core.serviceRegions();
    assert.equal(core.regionCount(), before, "nothing installed before the worker answers");
    assert.ok(requests().length >= 1, "a compile request per region");
    for (const r of requests()) {
      assert.match(r.key, /^wasm-block-sha256-v1:[0-9a-f]{64}$/);
      assert.equal(r.kind, "region");
      assert.equal("bytes" in r, false, "no bytes copied: discio holds the Module under the key");
      Atomics.store(core.module.HEAPU8, r.readyPtr + r.readySlot, 1);
    }
    const fallbacks = core.regionStats().installFallbacks;
    core.serviceRegions();
    assert.equal(core.regionCount(), before + entries);
    assert.equal(core.regionStats().installFallbacks, fallbacks, "no cold compile");
    assert.equal(lastInstallPath(), 1, "sampled as installed after the ready byte");
    const reference = runCall(PROGRAM.labels.main, { regions: false });
    const got = runCall(PROGRAM.labels.main, { regions: true });
    assert.ok(got.ran >= 1);
    assert.deepEqual(got.state, reference.state);
  });
});

test("with jitoffthread=1 a request never answered falls back to a synchronous compile", { skip: offThreadSkip }, () => {
  withOffThreadCompile(() => {
    const plan = setup();
    core.setRegionsEnabled(true);
    const before = core.regionCount();
    const entries = queueAll(plan);
    const fallbacks = core.regionStats().installFallbacks;
    core.module._DolphinWeb_AotSetReadyWaitForTest(0); // 5 s in production
    try {
      for (let slice = 0; slice < 300 && core.regionCount() === before; slice++) core.serviceRegions();
    } finally {
      core.module._DolphinWeb_AotSetReadyWaitForTest(5000);
    }
    assert.equal(core.regionCount(), before + entries);
    assert.ok(core.regionStats().installFallbacks > fallbacks, "counted as a cold compile (installFallbacks)");
    assert.equal(lastInstallPath(), 2, "sampled as cold");
  });
});

// A state load: ClearOffThreadAndRegionState, the part of
// CachedInterpreter::ClearCache for off-thread requests and regions (the
// Node core has no CachedInterpreter instance to clear).
const clearCacheSkip = offThreadSkip || (!core?.has("DolphinWeb_AotClearCacheForTest") && "core without the cache-clear test export (#58)");
function clearCache() {
  core.module._DolphinWeb_AotClearCacheForTest();
}

test("with jitoffthread=1 a cache clear while regions wait asks again: no mark is lost", { skip: clearCacheSkip }, () => {
  withOffThreadCompile((requests) => {
    const plan = setup();
    core.setRegionsEnabled(true);
    const before = core.regionCount();
    const entries = queueAll(plan);
    core.serviceRegions();
    const first = requests().length;
    assert.ok(first >= 1);
    // The worker answers, then a state load clears the cache before the CPU
    // thread saw the marks: the ready table and the requests in flight are reset.
    for (const r of requests()) Atomics.store(core.module.HEAPU8, r.readyPtr + r.readySlot, 1);
    clearCache();
    const fallbacks = core.regionStats().installFallbacks;
    core.serviceRegions();
    assert.equal(core.regionCount(), before, "nothing ready after the reset");
    assert.ok(requests().length > first, "the waiting regions asked again");
    for (const r of requests().slice(first)) Atomics.store(core.module.HEAPU8, r.readyPtr + r.readySlot, 1);
    core.serviceRegions();
    assert.equal(core.regionCount(), before + entries, "installed on the new marks, not after the 5 s wait");
    assert.equal(core.regionStats().installFallbacks, fallbacks);
  });
});

test("with jitoffthread=1 a region asked again after a cache clear is checked against the plan", { skip: clearCacheSkip }, () => {
  withOffThreadCompile((requests) => {
    const plan = setup();
    core.setRegionsEnabled(true);
    const before = core.regionCount();
    queueAll(plan);
    const modules = regionModules(plan); // translated from the code as queued
    core.serviceRegions();
    const first = requests().length;
    // The state load also rewrote double (no icbi), and the pthread already
    // holds the modules: the re-post would install at once without the check.
    patchDouble();
    for (const bytes of modules) {
      core.module._dolphinJitCache.set(`wasm-block-sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`, new WebAssembly.Module(bytes));
    }
    clearCache();
    core.serviceRegions();
    assert.ok(requests().length >= first);
    core.reset(seedGprs(1), PROGRAM.labels.double, STOP, 400000);
    assert.equal(core.dispatchRegion(), 0, "no region over the rewritten double");
    const reference = runCall(PROGRAM.labels.main, { regions: false });
    const got = runCall(PROGRAM.labels.main, { regions: true });
    assert.deepEqual(got.state, reference.state, "the new code runs");
    assert.ok(core.regionCount() >= before);
  });
});

// A region's code embeds absolute addresses of the core's heap (RAM, L1): a
// module translated in another session, whose RAM sat elsewhere, would read
// and write the wrong host memory. The core installs it only under the
// layout it was translated for (2nd launch with aot=1, 2026-10-21).
test("a region translated for another heap layout is never installed", { skip: skip || (!core?.has("DolphinWeb_AotLayoutHash") && "core without the layout guard") }, () => {
  const plan = setup();
  core.setRegionsEnabled(true);
  const before = core.regionCount();
  const refused = core.module._DolphinWeb_AotLayoutRefused() >>> 0;
  const layout = core.module._DolphinWeb_AotLayoutHash() >>> 0;
  for (const group of regionGroups(plan, 100)) {
    const { bytes, entries } = assembleRegion(group.flatMap(functionFragments(core)), { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
    const members = group.map((f) => ({ ranges: f.ranges, hash: f.hash }));
    core.queueRegion(bytes, entries.map(([pc]) => pc), members, (layout ^ 0x10) >>> 0);
    core.queueRegion(bytes, entries.map(([pc]) => pc), members, 0);
  }
  core.serviceRegions();
  assert.equal(core.regionCount(), before, "nothing installed");
  assert.ok((core.module._DolphinWeb_AotLayoutRefused() >>> 0) - refused >= 2, "counted as layout refusals");
  core.reset(seedGprs(1), PROGRAM.labels.main, STOP, 400000);
  assert.equal(core.dispatchRegion(), 0);
});

// A region already installed when the layout moves: its code still embeds
// the old offsets or sizes. A cache clear makes it checked again, layout
// included; a shutdown forgets every region (review of #62, P1-1). The RAM
// address is no longer part of the layout (patch 0084): it sits in listed
// heap sites, checked apart (the next tests).
const LAYOUT_RAM_SIZE_FIELD = 16; // WasmStateLayout.ram_size_real
test("an installed region is dropped when the heap layout moved, before it runs again", { skip: skip || (!core?.has("DolphinWeb_AotLayoutShiftFieldForTest") && "core without position-independent regions (0084)") }, () => {
  installed();
  core.reset(seedGprs(1), PROGRAM.labels.count, STOP, 400000);
  assert.equal(core.dispatchRegion(), 1, "runs under its own layout");
  core.module._DolphinWeb_AotLayoutShiftFieldForTest(LAYOUT_RAM_SIZE_FIELD, 0x100000);
  try {
    core.unverifyRegions(); // what ClearCache does at the new boot
    core.reset(seedGprs(1), PROGRAM.labels.count, STOP, 400000);
    assert.equal(core.dispatchRegion(), 0, "dropped, not run with the old sizes");
  } finally {
    core.module._DolphinWeb_AotLayoutShiftFieldForTest(0, 0);
  }
});

const heapSkip = skip || (!core?.has("DolphinWeb_AotRegionHeapBases") && "core without heap sites (0084)");
const bases = () => {
  const p = core.module._malloc(8);
  try {
    core.module._DolphinWeb_AotRegionHeapBases(p);
    return Array.from(new Uint32Array(core.module.HEAPU8.buffer, p, 2));
  } finally {
    core.module._free(p);
  }
};

// Patch 0084: a module translated in a session whose RAM sat elsewhere holds
// that address in its heap sites. Queued as it is, the core refuses it (its
// bases are not this session's); patched to this session's bases, it
// installs and runs as the interpreter does.
test("a region translated while the RAM sat elsewhere is refused as it is, and runs once patched", { skip: heapSkip }, () => {
  const plan = setup();
  core.setRegionsEnabled(true);
  const before = core.regionCount();
  const here = bases();
  const there = { ramBase: (here[0] + 0x100000) >>> 0, l1Base: here[1] };
  const modules = regionGroups(plan, 100).map((group) => ({ group, ...assembleRegion(group.flatMap(functionFragments(core)), { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages }) }));
  assert.ok(modules.some((m) => regionHeapOfBytes(m.bytes)?.sites.length), "the program's loads and stores are heap sites");
  const refused = core.module._DolphinWeb_AotLayoutRefused() >>> 0;
  for (const m of modules) {
    const elsewhere = patchRegionHeap(m.bytes, there); // as the other session's cache holds it
    core.queueRegion(elsewhere, m.entries.map(([pc]) => pc), m.group.map((f) => ({ ranges: f.ranges, hash: f.hash })), undefined, [there.ramBase, there.l1Base]);
  }
  core.serviceRegions();
  assert.equal(core.regionCount(), before, "refused under another RAM address");
  assert.ok((core.module._DolphinWeb_AotLayoutRefused() >>> 0) > refused);
  for (const m of modules) {
    const elsewhere = patchRegionHeap(m.bytes, there);
    const back = patchRegionHeap(elsewhere, { ramBase: here[0], l1Base: here[1] }); // what discio does
    assert.deepEqual(back, m.bytes, "patching back gives the bytes translated here");
    core.queueRegion(back, m.entries.map(([pc]) => pc), m.group.map((f) => ({ ranges: f.ranges, hash: f.hash })));
  }
  core.serviceRegions();
  assert.ok(core.regionCount() > before, "installed once patched");
  const reference = runCall(PROGRAM.labels.main, { regions: false });
  const got = runCall(PROGRAM.labels.main, { regions: true });
  assert.ok(got.ran > 0);
  assert.deepEqual(got.state, reference.state);
});

// Review of #71: the core checks the module's own heap section and sites,
// whatever bases the caller passes. A module without the section, one whose
// section claims other bases, and one whose site was changed are refused.
test("the core refuses a region whose heap section or sites do not hold this session's bases", { skip: heapSkip }, () => {
  const plan = setup();
  core.setRegionsEnabled(true);
  const before = core.regionCount();
  const here = bases();
  const [group] = regionGroups(plan, 100);
  const { bytes, entries } = assembleRegion(group.flatMap(functionFragments(core)), { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
  const heap = regionHeapOfBytes(bytes);
  assert.ok(heap?.sites.length);
  const members = group.map((f) => ({ ranges: f.ranges, hash: f.hash }));
  const queue = (b) => core.queueRegion(b, entries.map(([pc]) => pc), members); // the session's bases, as a buggy caller would
  // 1. a site changed to another address (the section still says here)
  const site = Uint8Array.from(bytes);
  site.set(paddedSleb(here[0] + 0x100000), heap.sites[0].offset);
  // 2. the section removed (renamed: the module still compiles)
  const unnamed = Uint8Array.from(bytes);
  const name = new TextEncoder().encode("region-heap");
  const at = unnamed.findIndex((_, i) => name.every((c, k) => unnamed[i + k] === c));
  unnamed[at] = "R".charCodeAt(0);
  // 3. the section claims other bases than its sites hold
  const claims = patchRegionHeap(bytes, { ramBase: here[0] + 0x100000, l1Base: here[1] });
  claims.set(Array.from(bytes.subarray(heap.sites[0].offset, heap.sites[0].offset + 5)), heap.sites[0].offset);
  const refused = core.module._DolphinWeb_AotLayoutRefused() >>> 0;
  for (const b of [site, unnamed, claims]) queue(b);
  core.serviceRegions();
  assert.equal(core.regionCount(), before, "none installed");
  assert.equal((core.module._DolphinWeb_AotLayoutRefused() >>> 0) - refused, 3, "each counted as a heap refusal");
  queue(bytes); // the module as translated here
  core.serviceRegions();
  assert.ok(core.regionCount() > before, "the untouched module installs");
});

// The RAM moved under an installed region (a stop and a new boot in the same
// page reallocates it): its heap sites still hold the old address. A cache
// clear makes it checked again, and it is dropped before it runs (#62 P1-1).
test("an installed region is dropped when the RAM moved under it, before it runs again", { skip: heapSkip }, () => {
  installed();
  core.reset(seedGprs(1), PROGRAM.labels.count, STOP, 400000);
  assert.equal(core.dispatchRegion(), 1, "runs where it was patched for");
  core.module._DolphinWeb_AotLayoutShiftForTest(0x100000); // the RAM sits 1 MiB further
  try {
    core.unverifyRegions(); // what ClearCache does at the new boot
    core.reset(seedGprs(1), PROGRAM.labels.count, STOP, 400000);
    assert.equal(core.dispatchRegion(), 0, "dropped, not run at the old address");
  } finally {
    core.module._DolphinWeb_AotLayoutShiftForTest(0);
  }
});

// The only guard against an address left out of the heap sites (Node never
// moves the RAM): no immediate of a fragment holds the RAM or L1 address,
// or a byte offset past it, but at a listed heap site. Over the oracle's
// random programs; one planted outside the sites proves the scan finds it.
const immediates = (code) => {
  const out = [];
  for (let i = 0; i < code.length; i++) {
    let v = 0, shift = 0, j = i, b;
    do { b = code[j++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80 && shift < 35 && j < code.length);
    const signed = shift < 35 && b & 0x40 ? (v - 2 ** shift) >>> 0 : v >>> 0;
    out.push([i, v >>> 0, signed]);
  }
  return out;
};
const nearBase = (v, [ram, l1]) => ((v - ram) >>> 0) < 0x10000 || ((v - l1) >>> 0) < 0x10000;
function strayAddresses(fragment, base) {
  const sites = new Set(fragment.relocs.filter((r) => r.kind === "heap").map((r) => r.offset));
  return immediates(fragment.code).filter(([at, u, sgn]) => !sites.has(at) && (nearBase(u, base) || nearBase(sgn, base))).map(([at]) => at);
}
test("no region fragment holds the RAM or L1 address outside its heap sites", { skip: heapSkip }, () => {
  const base = bases();
  const r = makeRng(84);
  const CODE = 0x80004000;
  let fragments = 0, sites = 0;
  for (let n = 0; n < 300; n++) {
    const words = Array.from(randomProgram(r, 48));
    core.load(CODE, Uint8Array.from(words.flatMap((w) => [w >>> 24, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff])));
    const fragment = core.translate(CODE, { ranges: [[CODE, CODE + 4 * words.length]] });
    if (!fragment) continue;
    fragments += 1;
    for (const site of fragment.relocs.filter((x) => x.kind === "heap")) {
      sites += 1;
      // main's i32.const of the base, padded to 5 bytes
      assert.equal(site.form, "const");
      assert.equal(fragment.code[site.offset - 1], 0x41, "an i32.const");
      assert.deepEqual(Array.from(fragment.code.subarray(site.offset, site.offset + 5)), paddedSleb(base[site.name === "ram_base" ? 0 : 1]), "it holds the base");
    }
    assert.deepEqual(strayAddresses(fragment, base), [], `program ${n}: an address outside the heap sites`);
  }
  core.invalidate(CODE, 4 * 48);
  assert.ok(fragments > 100 && sites > 100, `${fragments} fragments, ${sites} heap sites`);
  const planted = { code: Uint8Array.of(0x00, 0x41, ...paddedUleb(base[0] + 8)), relocs: [] };
  assert.equal(strayAddresses(planted, base).length > 0, true, "the scan finds a planted address");
});

test("a core shutdown forgets every region: installed, waiting and queued", { skip: skip || (!core?.has("DolphinWeb_AotForgetRegionsForTest") && "core without ForgetAllRegions") }, () => {
  const { before } = installed();
  assert.ok(core.regionCount() > 0);
  queueAll(setup()); // queued, not installed yet
  core.module._DolphinWeb_AotForgetRegionsForTest();
  assert.equal(core.regionCount(), 0);
  core.serviceRegions();
  assert.equal(core.regionCount(), 0, "the queue went too");
  core.reset(seedGprs(1), PROGRAM.labels.count, STOP, 400000);
  assert.equal(core.dispatchRegion(), 0);
  assert.ok(before >= 0);
});

// Region chaining (patch 0102): a region leaving for another region's entry
// tail-calls it (env.region_chain picks it, env.table holds it) instead of
// returning to the dispatcher. One region per function here, so every call
// and every return crosses regions.
const chainSkip = skip || (!core?.has("DolphinWeb_JitRegionChainStats") && "core without region chaining (patch 0102)");
function installedOnePerFunction() {
  const plan = setup();
  core.setRegionsEnabled(true);
  queueAll(plan, 1, true);
  serviceAll();
  return plan;
}
// A slice installs what fits its time budget: on a loaded machine the rest
// waits for the next slices. Serve them until nothing more is installed.
function serviceAll() {
  let count = -1;
  for (let i = 0; i < 50 && core.regionCount() !== count; i++) {
    count = core.regionCount();
    core.serviceRegions();
  }
}

test("chained regions run a whole call in one dispatch, like the interpreter", { skip: chainSkip }, () => {
  installedOnePerFunction();
  const reference = runCall(PROGRAM.labels.main, { regions: false });
  try {
    core.setRegionChaining(false);
    core.regionStats(0);
    const unchained = runCall(PROGRAM.labels.main, { regions: true });
    assert.deepEqual(unchained.state, reference.state);
    assert.equal(unchained.downcount, reference.downcount);
    assert.equal(core.regionChainStats().chained, 0, "off: every exit goes back to the dispatcher");
    core.setRegionChaining(true);
    core.regionStats(0);
    const chained = runCall(PROGRAM.labels.main, { regions: true });
    assert.deepEqual(chained.state, reference.state);
    assert.equal(chained.downcount, reference.downcount);
    assert.equal(chained.interpreted, 0);
    assert.equal(chained.ran, 1, "main, double, main, count, main: one dispatch");
    assert.ok(unchained.ran >= 4, `unchained dispatches (${unchained.ran})`);
    const chain = core.regionChainStats();
    if (keyVersion() >= 31) {
      // 0142: calls go through the stub (chained), returns come back as wasm
      // returns: fewer chains than dispatcher round trips saved.
      assert.ok(chain.chained >= 1 && chain.chained <= unchained.ran - 1, `${chain.chained} chains for ${unchained.ran - 1} round trips saved`);
    } else {
      assert.equal(chain.chained, unchained.ran - 1, "one chain per dispatcher round trip saved");
    }
    assert.equal(core.regionStats().regionCalls, 1);
  } finally {
    core.setRegionChaining(true);
  }
});

test("chaining stops when downcount runs out, at the interpreter's state", { skip: chainSkip }, () => {
  installedOnePerFunction();
  // Budgets that end inside main, double, count's loop and between them.
  for (const budget of [1, 3, 5, 8, 13, 21, 34]) {
    core.reset(seedGprs(PROGRAM.labels.main), PROGRAM.labels.main, STOP, budget);
    core.regionStats(0);
    assert.equal(core.dispatchRegion(), 1);
    const got = { state: core.state(), downcount: core.downcount() };
    assert.ok(got.downcount <= 0 || core.pc() === STOP, `budget ${budget}: stopped on downcount`);
    // The interpreter from the same start until it spent the same cycles.
    core.reset(seedGprs(PROGRAM.labels.main), PROGRAM.labels.main, STOP, budget);
    for (let n = 0; n < 100000 && core.downcount() > got.downcount; n++) assert.equal(core.interpretOne(), 0);
    assert.equal(core.downcount(), got.downcount, `budget ${budget}`);
    assert.deepEqual(core.state(), got.state, `budget ${budget}`);
  }
});

test("a dropped region is never chained to, even after a chain into it", { skip: chainSkip }, () => {
  installedOnePerFunction();
  core.setRegionChaining(true);
  assert.equal(runCall(PROGRAM.labels.main, { regions: true }).ran, 1, "main chains into double");
  patchDouble();
  core.invalidate(PROGRAM.labels.double, 4); // drops double's region
  core.regionStats(0);
  const got = runCall(PROGRAM.labels.main, { regions: true });
  const reference = runCall(PROGRAM.labels.main, { regions: false });
  assert.deepEqual(got.state, reference.state, "the patched double ran, not its old region");
  assert.ok(got.interpreted > 0, "double interpreted");
  assert.ok(core.regionChainStats().noRegion >= 1);
});

// A loop that never leaves, across two regions: spin calls tick and branches
// back. Chaining tests downcount at every crossing, as the dispatcher loop
// does (an interrupt or a scheduled event ends the slice through downcount,
// CoreTiming::ForceExceptionCheck): one dispatch ends when downcount is
// spent, never later, at the interpreter's state.
// Its own text: since 0085 an invalidation keeps a region whose code is still
// checkable (to be verified before it runs), and an entry already mapped
// keeps its region, so code loaded over PROGRAM's would not get its own.
const SPIN_TEXT = 0x80008100;
const SPIN = assemble(SPIN_TEXT, [
  "spin", asm.addi(4, 4, 1), (pc, l) => asm.bl(pc, l.tick), (pc, l) => asm.b(pc, l.spin),
  "tick", asm.addi(5, 5, 1), asm.blr()
]);

test("a loop across chained regions that never exits stops on downcount, like the interpreter", { skip: chainSkip }, () => {
  const dol = buildDol({ textAddr: SPIN_TEXT, text: SPIN.words, entry: SPIN.labels.spin });
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  for (const seg of image.segments) core.load(seg.start, seg.bytes);
  core.setRegionsEnabled(true);
  core.setRegionChaining(true);
  queueAll(plan, 1, true);
  serviceAll();
  for (const budget of [7, 100, 5000, 200000]) {
    core.reset(seedGprs(SPIN.labels.spin), SPIN.labels.spin, STOP, budget);
    core.regionStats(0);
    assert.equal(core.dispatchRegion(), 1, `budget ${budget}`);
    const got = { state: core.state(), downcount: core.downcount() };
    assert.ok(got.downcount <= 0, `budget ${budget}: stopped on downcount (${got.downcount})`);
    const chain = core.regionChainStats();
    if (budget >= 100) assert.ok(chain.chained > 2, `budget ${budget}: chained ${chain.chained}`);
    core.reset(seedGprs(SPIN.labels.spin), SPIN.labels.spin, STOP, budget);
    for (let n = 0; n < 1e6 && core.downcount() > got.downcount; n++) assert.equal(core.interpretOne(), 0);
    assert.equal(core.downcount(), got.downcount, `budget ${budget}`);
    assert.deepEqual(core.state(), got.state, `budget ${budget}`);
  }
  core.invalidate(SPIN_TEXT, 4 * SPIN.words.length);
});

// 0091 (with dispatch's 0090): under the MMU no region is installed, not even
// one queued before (a cache translated in a session without it), since
// region code does not stop at a DSI. The block path runs the code.
test("under the MMU queued regions are not installed, and the skips are counted", { skip: skip || ((!core?.setMMUMode || typeof core.module._DolphinWeb_AotRegionsSkippedMmu !== "function") && "core without the MMU guard (0091)") }, () => {
  const plan = setup();
  core.setRegionsEnabled(true);
  const before = core.regionCount();
  const skipped = core.module._DolphinWeb_AotRegionsSkippedMmu() >>> 0;
  const queued = regionGroups(plan, 100).length;
  queueAll(plan);
  core.setMMUMode(true);
  try {
    core.serviceRegions();
    assert.equal(core.regionCount(), before, "nothing installed");
    assert.equal((core.module._DolphinWeb_AotRegionsSkippedMmu() >>> 0) - skipped, queued);
    core.reset(seedGprs(1), PROGRAM.labels.main, STOP, 400000);
    assert.equal(core.dispatchRegion(), 0, "the block path runs the code");
  } finally {
    core.setMMUMode(false);
  }
});

// 0088: an idle loop inside a region (a block looping to its own start,
// PPCAnalyzer::IsBusyWaitLoop) must come back to the dispatcher, where the
// block path's CheckIdle skips it (CoreTiming::Idle). Before, the region cut
// the block before its branch, went on at the branch's address (no idle loop
// seen from there) and spun inside the region until the slice ran out. The
// Node core has no CPU loop to run CheckIdle, so the test checks what the
// skip needs: the region stops at the loop's start, a few cycles in.
const idleSkip88 = skip || ((await coreStatus(fileURLToPath(new URL("..", import.meta.url)))).current
  ? false : "the core in cores/dolphin predates these sources (CI builds this branch's core)");
test("an idle loop inside a region returns to the dispatcher at its start instead of spinning to the end of the slice", { skip: idleSkip88 }, () => {
  const IDLE = assemble(TEXT, [
    "wait", asm.addi(5, 5, 1),
    "wait_loop", lwz(3, 4, 0), asm.cmplwi(3, 0), (pc, l) => asm.beq(pc, l.wait_loop),
    "after", asm.addi(6, 6, 1), asm.blr()
  ]);
  const dol = buildDol({ textAddr: TEXT, text: IDLE.words, entry: IDLE.labels.wait });
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  for (const s of image.segments) core.load(s.start, s.bytes);
  core.invalidate(TEXT, 4 * IDLE.words.length);
  core.setRegionsEnabled(true);
  for (const group of regionGroups(plan, 100)) {
    const fragments = group.flatMap(functionFragments(core));
    const { bytes, entries } = assembleRegion(fragments, { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
    core.queueRegion(bytes, entries.map(([pc]) => pc), group.map((f) => ({ ranges: f.ranges, hash: f.hash })));
  }
  core.serviceRegions();
  const gprs = seedGprs(1);
  gprs[4] = 0x80100000; // a zero word: the loop never ends by itself
  const budget = 400000;
  core.reset(gprs, IDLE.labels.wait, STOP, budget);
  assert.equal(core.dispatchRegion(), 1, "the region runs from its entry");
  assert.equal(core.pc() >>> 0, IDLE.labels.wait_loop, "back to the dispatcher at the idle loop's start");
  assert.ok(budget - core.downcount() < 100, `only the block before the loop ran (${budget - core.downcount()} cycles), not the slice`);
});

// FPU ops the direct tier does not emit (the Rc forms such as fadds., mffs)
// stay in the region as helper calls (patch 0105, compiler version 6;
// ps_merge00 is direct-tier code, here as a neighbour)
// instead of leaving it: the whole call runs in region code, nothing is
// interpreted outside, at the interpreter's state. Its own text (see SPIN).
const FPU_TEXT = 0x8000a100, DATA = 0x80004000;
const lfs = (d, a, off) => (48 << 26) | (d << 21) | (a << 16) | (off & 0xffff);
const stfd = (s, a, off) => (54 << 26) | (s << 21) | (a << 16) | (off & 0xffff);
const faddsRc = (d, a, b) => (59 << 26) | (d << 21) | (a << 16) | (b << 11) | (21 << 1) | 1;
const mffs = (d) => (63 << 26) | (d << 21) | (583 << 1);
const psMerge00 = (d, a, b) => (4 << 26) | (d << 21) | (a << 16) | (b << 11) | (528 << 1);
const FPU = assemble(FPU_TEXT, [
  "main", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), (pc, l) => asm.bl(pc, l.fpu),
  lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  "fpu", asm.lis(5, DATA >>> 16), asm.ori(5, 5, DATA & 0xffff), lfs(1, 5, 0), lfs(2, 5, 4),
  faddsRc(3, 1, 2), psMerge00(4, 1, 2), mffs(6),
  stfd(3, 5, 8), stfd(4, 5, 16), stfd(6, 5, 24), asm.addi(6, 6, 1), asm.blr()
]);
const keyVersion = () => {
  const p = core.module._malloc(8);
  try { core.module._DolphinWeb_AotKeyParts(p); return new Uint32Array(core.module.HEAPU8.buffer, p, 2)[0]; } finally { core.module._free(p); }
};

test("FPU ops outside the direct tier run inside the region, interpreted, like the interpreter (0105)", { skip: chainSkip || (core?.has("DolphinWeb_AotKeyParts") && keyVersion() < 6 && "core before 0105 (compiler version < 6)") }, () => {
  const dol = buildDol({ textAddr: FPU_TEXT, text: FPU.words, entry: FPU.labels.main });
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  for (const seg of image.segments) core.load(seg.start, seg.bytes);
  const floats = new DataView(new ArrayBuffer(32));
  floats.setFloat32(0, 1.5); floats.setFloat32(4, -3.25);
  const loadData = () => core.load(DATA, new Uint8Array(floats.buffer));
  loadData();
  core.reset(seedGprs(FPU.labels.main), FPU.labels.main, STOP, 400000); // MSR.FP on while translating
  core.setRegionsEnabled(true);
  core.setRegionChaining(true);
  queueAll(plan, 1, true);
  serviceAll();
  loadData();
  const reference = runCall(FPU.labels.main, { regions: false });
  loadData();
  const got = runCall(FPU.labels.main, { regions: true });
  assert.deepEqual(got.state, reference.state);
  assert.equal(got.downcount, reference.downcount);
  assert.equal(got.interpreted, 0, "no op left the region");
  assert.equal(got.ran, 1);
  core.invalidate(FPU_TEXT, 4 * FPU.words.length);
});

// 0111: region compares store their CR field as one i64 (SO clear) and a bc
// on it decides on the compare's operands while they are intact. Unsigned
// and signed compares of a high-bit value, a bc on a false condition, an
// Rc=1 result overwritten before its bc, andi., a bc in another block of
// the fragment and one in another region (after a call) that read the
// stored field, then mfcr reads every field.
const CR_TEXT = 0x8000e100;
const cmpw = (crf, a, b) => (31 << 26) | (crf << 23) | (a << 16) | (b << 11);
const cmplw = (crf, a, b) => cmpw(crf, a, b) | (32 << 1);
const cmpwi = (crf, a, imm) => (11 << 26) | (crf << 23) | (a << 16) | (imm & 0xffff);
const andiRc = (a, s, imm) => (28 << 26) | (s << 21) | (a << 16) | (imm & 0xffff);
const mfcr = (d) => (31 << 26) | (d << 21) | (19 << 1);
const mtxer = (s) => (31 << 26) | (s << 21) | (1 << 16) | (467 << 1);
const bne = (from, to, crf = 0) => asm.bc(4, crf * 4 + 2, from, to);
const blt = (from, to, crf = 0) => asm.bc(12, crf * 4 + 0, from, to);
const crProgram = (setSo) => assemble(CR_TEXT, [
  "main", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), ...(setSo ? [asm.li(9, -1), mtxer(9)] : []),
  (pc, l) => asm.bl(pc, l.cr), lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  "cr", asm.lis(5, 0x8000), asm.li(6, 1), asm.li(3, 0),
  cmplw(0, 5, 6), (pc, l) => asm.bgt(pc, l.l1), asm.addi(3, 3, 100),
  "l1", cmpw(7, 5, 6), (pc, l) => asm.bge(pc, l.l2, 7), asm.addi(3, 3, 1),
  "l2", add(7, 5, 5) | 1, asm.li(7, 5), (pc, l) => bne(pc, l.l3), asm.addi(3, 3, 10),
  "l3", cmpwi(1, 6, 1), (pc, l) => asm.beq(pc, l.l4, 1), asm.addi(3, 3, 1000),
  "l4", andiRc(9, 5, 1), (pc, l) => asm.beq(pc, l.l5), asm.addi(3, 3, 10000),
  "l5", cmpw(6, 5, 6), (pc, l) => asm.b(pc, l.l6),
  "l6", (pc, l) => blt(pc, l.l7, 6), asm.addi(3, 3, 100000),
  "l7", asm.mflr(10), (pc, l) => asm.bl(pc, l.setcr), mtlr(10), (pc, l) => blt(pc, l.l8, 5), asm.addi(3, 3, 1000000),
  "l8", mfcr(8), asm.blr(),
  "setcr", cmpwi(5, 6, 2), asm.blr()
]);
const crSkip = chainSkip || (core?.has("DolphinWeb_AotKeyParts") && keyVersion() < 10 && "core before 0111 (compiler version < 10)");
function runCrProgram(setSo) {
  const prog = crProgram(setSo);
  const dol = buildDol({ textAddr: CR_TEXT, text: prog.words, entry: prog.labels.main });
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  for (const seg of image.segments) core.load(seg.start, seg.bytes);
  core.reset(seedGprs(prog.labels.main), prog.labels.main, STOP, 400000);
  core.setRegionsEnabled(true);
  core.setRegionChaining(true);
  queueAll(plan, 1, true);
  serviceAll();
  const reference = runCall(prog.labels.main, { regions: false });
  const got = runCall(prog.labels.main, { regions: true });
  core.invalidate(CR_TEXT, 4 * prog.words.length);
  core.module._DolphinWeb_AotForgetRegionsForTest?.();
  return { reference, got };
}

test("region compares and the bc after them end like the interpreter (0111)", { skip: crSkip }, () => {
  const { reference, got } = runCrProgram(false);
  assert.deepEqual(got.state, reference.state);
  assert.equal(got.downcount, reference.downcount);
  assert.equal(got.interpreted, 0, "no op left the region");
  assert.equal(got.ran, 1);
});

test("with XER.SO set regions do not run, and the CR fields carry SO like the interpreter's (0111)", { skip: crSkip }, () => {
  const { reference, got } = runCrProgram(true);
  assert.deepEqual(got.state, reference.state);
  // main's region runs up to mtxer (which runs outside); past it SO is set
  // and the call runs interpreted.
  assert.ok(got.ran <= 1, "refused while SO is set");
  assert.ok(got.interpreted > 20, `${got.interpreted} instructions outside regions`);
});

// 0111: XER.SO going 0 -> 1 in the middle of a function. An OE form (addo
// overflowing), mtxer and mcrxr are not region code (RegionMaySetSo ends
// the block before them): they run outside, and the fragment entered after
// them refuses while SO is set. The compares after them, the bc on their
// field and mfcr must carry SO as the interpreter's do.
const SO_TEXT = 0x80011100;
const addo = (d, a, b) => add(d, a, b) | (1 << 10);
const mcrxr = (crf) => (31 << 26) | (crf << 23) | (512 << 1);
const soProgram = (setter) => assemble(SO_TEXT, [
  "main", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), (pc, l) => asm.bl(pc, l.f),
  lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  "f", asm.lis(5, 0x8000), asm.li(6, 1), asm.li(3, 0), cmpwi(0, 6, 1), (pc, l) => asm.beq(pc, l.a), asm.addi(3, 3, 1),
  "a", ...setter, cmpwi(0, 6, 1), (pc, l) => asm.beq(pc, l.b), asm.addi(3, 3, 10),
  "b", cmpw(7, 6, 5), (pc, l) => asm.bgt(pc, l.c, 7), asm.addi(3, 3, 100),
  "c", asm.addi(4, 3, 0), mfcr(8), asm.blr()
]);
for (const [name, setter] of [["addo", [addo(7, 5, 5)]], ["mtxer", [asm.lis(9, 0x8000), mtxer(9)]], ["mcrxr then mtxer", [asm.lis(9, 0xc000), mtxer(9), mcrxr(2), asm.lis(9, 0x8000), mtxer(9)]]]) {
  test(`XER.SO set mid-function by ${name}: later compares, a bc on them and mfcr carry SO like the interpreter (0111)`, { skip: crSkip }, () => {
    const prog = soProgram(setter);
    const dol = buildDol({ textAddr: SO_TEXT, text: prog.words, entry: prog.labels.main });
    const { image, entryPoint } = imageFromDol(dol);
    const plan = planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
    for (const seg of image.segments) core.load(seg.start, seg.bytes);
    core.reset(seedGprs(prog.labels.main), prog.labels.main, STOP, 400000);
    core.setRegionsEnabled(true);
    core.setRegionChaining(true);
    queueAll(plan, 1, true);
    serviceAll();
    const reference = runCall(prog.labels.main, { regions: false });
    const got = runCall(prog.labels.main, { regions: true });
    core.invalidate(SO_TEXT, 4 * prog.words.length);
    core.module._DolphinWeb_AotForgetRegionsForTest?.();
    assert.deepEqual(got.state, reference.state);
    assert.equal(got.downcount, reference.downcount);
    assert.ok(got.ran >= 1, "the function's first blocks ran as a region");
    assert.ok(got.interpreted >= 1, "the SO setter ran outside regions");
  });
}

// Patch 0107: the CPU thread's throttle sleep installs ready regions (no
// frame pays for them), counted apart and kept out of installMaxSliceMs.
// [installs, ms x 100, worst lateness past the deadline x 100, slice installs
// after the sleep wait ran out] (the last two with the review's fixes).
function sleepCounters() {
  const p = core.module._malloc(16);
  try {
    new Uint32Array(core.module.HEAPU8.buffer, p, 4).fill(0);
    core.module._DolphinWeb_AotRegionSleepInstalls(p);
    return Array.from(new Uint32Array(core.module.HEAPU8.buffer, p, 4));
  } finally {
    core.module._free(p);
  }
}
test("a throttle sleep window installs queued regions", { skip: skip || (typeof core?.module._DolphinWeb_AotRegionSleepWindowForTest !== "function" && "core without installs in throttle sleeps (0107)") }, () => {
  const plan = setup();
  core.setRegionsEnabled(true);
  const before = core.regionCount();
  const [installs] = sleepCounters();
  queueAll(plan);
  core.module._DolphinWeb_AotRegionSleepWindowForTest(50); // a 50 ms sleep, as the throttle gives it
  assert.ok(core.regionCount() > before, "installed in the sleep window");
  assert.ok(sleepCounters()[0] > installs, "counted as sleep installs");
  const reference = runCall(PROGRAM.labels.main, { regions: false });
  assert.deepEqual(runCall(PROGRAM.labels.main, { regions: true }).state, reference.state);
  // A window with no time left installs nothing more.
  queueAll(setup());
  const after = core.regionCount();
  core.module._DolphinWeb_AotRegionSleepWindowForTest(0);
  assert.equal(core.regionCount(), after);
});

// A module too large for a slice (its estimate over the 2.5 ms target) waits
// for a sleep window, the boot window included (setup() forgets the regions,
// so these slices are the session's first), and at most the sleep wait from
// when it became installable: with #86 every module is posted at once, and
// one whose ready byte comes late must not skip the wait.
const largeSkip = offThreadSkip || (typeof core?.module._DolphinWeb_AotSetInstallCostForTest !== "function" && "core without the 0107 review's test hooks");
function withLargeModules(plan, fn) {
  const sizes = regionModules(plan).map((bytes) => bytes.length);
  // Each module estimated at 3 ms or more: too large for a slice.
  const saved = core.module._DolphinWeb_AotSetInstallCostForTest(3 / Math.min(...sizes));
  core.module._DolphinWeb_AotSetSleepWaitForTest(2000); // the production wait
  try {
    return fn(3 * Math.max(...sizes) / Math.min(...sizes) * sizes.length);
  } finally {
    core.module._DolphinWeb_AotSetInstallCostForTest(saved);
    core.module._DolphinWeb_AotSetSleepWaitForTest(2000);
  }
}
const spin = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };

test("a large ready module waits for a sleep window instead of costing a slice, boot window included", { skip: largeSkip }, () => {
  withOffThreadCompile((requests) => {
    const plan = setup();
    assert.deepEqual(sleepCounters(), [0, 0, 0, 0], "reset with the session's regions");
    core.setRegionsEnabled(true);
    withLargeModules(plan, (windowMs) => {
      const before = core.regionCount();
      const entries = queueAll(plan);
      core.serviceRegions();
      for (const r of requests()) Atomics.store(core.module.HEAPU8, r.readyPtr + r.readySlot, 1);
      for (let slice = 0; slice < 20; slice++) core.serviceRegions();
      assert.equal(core.regionCount(), before, "ready, but no slice installs it");
      core.module._DolphinWeb_AotRegionSleepWindowForTest(windowMs + 50);
      assert.equal(core.regionCount(), before + entries, "installed in the sleep window");
      const [installs, , lateBy, expired] = sleepCounters();
      assert.ok(installs >= 1);
      assert.equal(lateBy, 0, "the window's deadline was kept");
      assert.equal(expired, 0);
    });
  });
});

test("any ready module waits for a sleep window: with #86 the boot window is play", { skip: largeSkip }, () => {
  withOffThreadCompile((requests) => {
    const plan = setup();
    core.setRegionsEnabled(true);
    core.module._DolphinWeb_AotSetSleepWaitForTest(2000);
    const before = core.regionCount();
    const entries = queueAll(plan);
    core.serviceRegions();
    for (const r of requests()) Atomics.store(core.module.HEAPU8, r.readyPtr + r.readySlot, 1);
    for (let slice = 0; slice < 20; slice++) core.serviceRegions();
    assert.equal(core.regionCount(), before, "small modules too: no slice installs them while a sleep may come");
    core.module._DolphinWeb_AotRegionSleepWindowForTest(200);
    assert.equal(core.regionCount(), before + entries);
  });
});

// Review of #124: a module whose ready byte never came compiles cold,
// synchronously, far over the cache-hit estimate a sleep window is sized
// with: never in a sleep, at a slice boundary only.
test("a cold install (no ready byte) never runs in a sleep window, only at a slice boundary", { skip: largeSkip }, () => {
  withOffThreadCompile(() => {
    const plan = setup();
    core.setRegionsEnabled(true);
    core.module._DolphinWeb_AotSetSleepWaitForTest(2000);
    const before = core.regionCount();
    const entries = queueAll(plan);
    core.serviceRegions(); // posted; the worker never answers
    core.module._DolphinWeb_AotSetReadyWaitForTest(0); // 5 s in production
    try {
      core.module._DolphinWeb_AotRegionSleepWindowForTest(1000);
      assert.equal(core.regionCount(), before, "no cold compile in the sleep");
      for (let slice = 0; slice < 300 && core.regionCount() < before + entries; slice++) core.serviceRegions();
      assert.equal(core.regionCount(), before + entries, "cold, at slice boundaries");
      assert.equal(lastInstallPath(), 2, "sampled as cold");
    } finally {
      core.module._DolphinWeb_AotSetReadyWaitForTest(5000);
    }
  });
});

test("a large module's sleep wait counts from when it became installable; past it a slice installs it", { skip: largeSkip }, () => {
  withOffThreadCompile((requests) => {
    const plan = setup();
    core.setRegionsEnabled(true);
    withLargeModules(plan, () => {
      core.module._DolphinWeb_AotSetSleepWaitForTest(40); // 2 s in production
      const before = core.regionCount();
      const entries = queueAll(plan);
      core.serviceRegions();
      spin(60); // the worker answers after the sleep wait, counted from the post
      for (const r of requests()) Atomics.store(core.module.HEAPU8, r.readyPtr + r.readySlot, 1);
      core.serviceRegions();
      assert.equal(core.regionCount(), before, "the wait starts now, not at the post");
      spin(60); // no sleep came: the wait runs out
      for (let slice = 0; slice < 50 && core.regionCount() < before + entries; slice++) core.serviceRegions();
      assert.equal(core.regionCount(), before + entries, "a scene that never sleeps still gets its regions");
      assert.ok(sleepCounters()[3] >= 1, "counted as installed after the wait ran out");
      assert.equal(sleepCounters()[0], 0, "no sleep install");
    });
  });
});

// Continuation fragments (2026-10-23): a function of more blocks than one
// fragment holds (the 64-block cap) left the rest to the dispatcher and the
// block JIT at every pass (2.2 M exits per 4 s in a CPU-bound intro scene).
// The production translator now forms continuation fragments from the
// frontier, in the same module: one region call runs the whole function.
const LONG = 0x80020000;
const longFunction = (blocks) => assemble(LONG, [
  ...Array.from({ length: blocks }, () => [asm.addi(3, 3, 1), asm.cmplwi(3, 0xffff), (pc, l) => asm.beq(pc, l.out)]).flat(),
  "out", asm.blr()
]);
const contSkip = skip || (typeof core?.module._DolphinWeb_AotTranslate !== "function" && "core without the production translator");
for (const maxContinuations of [0, 7]) {
  test(`a function past the 64-block cap ${maxContinuations ? "runs in one region call with continuation fragments" : "exits to the dispatcher at the cap without them"}`, { skip: contSkip }, async () => {
    const program = longFunction(100);
    const bytes = new Uint8Array(4 * program.words.length);
    new DataView(bytes.buffer).setUint32(0, 0);
    program.words.forEach((w, i) => new DataView(bytes.buffer).setUint32(4 * i, w >>> 0));
    core.load(LONG, bytes);
    core.invalidate(LONG, bytes.length);
    core.module._DolphinWeb_AotForgetRegionsForTest?.();
    const ranges = [[LONG, LONG + bytes.length]];
    const translator = coreRegionTranslator(core.module, { mask: PRODUCTION_DISABLE_MASK, helperNames: coreAssembleOptions(core.module)?.helperNames, maxContinuations, yieldNow: async () => {} });
    const [r] = await translator.translate([{ entry: LONG, ranges, hash: null }]);
    assert.ok(r.fragment, r.reason);
    assert.equal(r.fragment.entries.length, 64, "the first fragment is capped");
    const fragments = claimEntries([r.fragment, ...(r.continuations ?? [])]);
    assert.equal(fragments.length, maxContinuations ? 2 : 1);
    const owned = new Set(fragments.flatMap((f) => f.entries));
    assert.equal(owned.size, maxContinuations ? 101 : 64, "every block start is an entry of one fragment");
    const { bytes: mod, entries } = assembleRegion(fragments, { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
    core.setRegionsEnabled(true);
    core.queueRegion(mod, entries.map(([pc]) => pc), [{ ranges, hash: null }]);
    core.serviceRegions();
    const reference = runCall(LONG, { regions: false });
    const got = runCall(LONG, { regions: true });
    assert.deepEqual(got.state, reference.state);
    if (maxContinuations) {
      assert.equal(got.ran, 1, "one region call");
      assert.equal(got.interpreted, 0);
    } else {
      assert.ok(got.interpreted > 0, "past the cap: back to the dispatcher");
    }
  });
}

// Review of #138: the continuation limits, and what is never followed.
const loadWords = (at, words) => {
  const bytes = new Uint8Array(4 * words.length);
  words.forEach((w, i) => new DataView(bytes.buffer).setUint32(4 * i, w >>> 0));
  core.load(at, bytes);
  core.invalidate(at, bytes.length);
  return [[at, at + bytes.length]];
};
const RFI = 0x4c000064;
const continuationsOf = (program, options = {}) => translateWithContinuations(core.module, { entry: program.labels.start ?? LONG, ranges: loadWords(LONG, program.words), hash: null },
  { mask: PRODUCTION_DISABLE_MASK, maxBlocks: 64, names: coreAssembleOptions(core.module)?.helperNames, ...options });

test("continuations: each under the byte cap (halved until it fits), within the count and byte limits", { skip: contSkip }, async () => {
  const program = longFunction(100);
  const whole = await continuationsOf(program);
  const size = whole.continuations[0].code.length;
  const halved = await continuationsOf(program, { maxFragmentBytes: Math.floor(size / 3) });
  assert.ok(halved.continuations.length > 1);
  assert.ok(halved.continuations.every((c) => c.code.length <= Math.floor(size / 3)), "each under the cap");
  assert.equal(new Set(claimEntries([halved.fragment, ...halved.continuations]).flatMap((f) => f.entries)).size, 101, "the same blocks");
  const one = await continuationsOf(program, { maxFragmentBytes: Math.floor(size / 3), maxContinuations: 1 });
  assert.equal(one.continuations.length, 1, "maxContinuations");
  const bytes = await continuationsOf(program, { maxFragmentBytes: Math.floor(size / 3), maxBytes: 1 });
  // Never past the byte budget (review of #189): the first charged fragment
  // would overshoot 1 byte, so none is kept, and it is refused.
  assert.equal(bytes.continuations, undefined, "nothing kept past the byte budget");
  assert.ok(bytes.budgetRefused >= 1 && bytes.resume, "refused, and resumable with more");
  const tiny = await continuationsOf(program, { maxFragmentBytes: 16 });
  assert.equal(tiny.continuations, undefined, "a single block over the cap is refused");
  assert.ok(tiny.oversize >= 1);
});

test("continuations: a leader that does not translate stays an exit; a data word that looks like a branch is not followed", { skip: contSkip }, async () => {
  // 64 blocks, then a bc whose fall-through starts with rfi (refused as a
  // first op) and whose target goes on; after the blr, a literal that
  // decodes as `b` to a label no held block reaches.
  const program = assemble(LONG, [
    ...Array.from({ length: 64 }, () => [asm.addi(3, 3, 1), asm.cmplwi(3, 0xffff), (pc, l) => asm.beq(pc, l.out)]).flat(),
    asm.cmplwi(3, 0), (pc, l) => asm.beq(pc, l.after),
    RFI,
    "after", asm.addi(4, 4, 1), asm.cmplwi(4, 0xffff), (pc, l) => asm.beq(pc, l.out),
    "out", asm.blr(),
    (pc, l) => asm.b(pc, l.island),
    "island", asm.addi(5, 5, 1), asm.blr()
  ]);
  const r = await continuationsOf(program);
  const held = new Set(claimEntries([r.fragment, ...(r.continuations ?? [])]).flatMap((f) => f.entries));
  const rfiAt = program.words.indexOf(RFI) * 4 + LONG;
  assert.equal(held.has(rfiAt), false, "the rfi block is no entry");
  assert.ok(held.has(program.labels.after), "past it, the frontier goes on");
  assert.equal(held.has(program.labels.island), false, "the literal's target is never translated");
});

test("the region key changes with the formation", async () => {
  const f = [{ entry: 0x80003100, sha256: "a".repeat(64) }];
  const parts = { compilerVersion: 5, codegenMask: 0 };
  assert.notEqual(await regionModuleKey(f, { ...parts, formation: 1 }), await regionModuleKey(f, { ...parts, formation: 2 }));
  assert.notEqual(await regionModuleKey(f, { ...parts, formation: 2 }), await regionModuleKey(f, { ...parts, formation: 3 }), "3: frontier rule and shared budget");
  assert.notEqual(await regionModuleKey(f, { ...parts, formation: 3 }), await regionModuleKey(f, { ...parts, formation: 4 }), "4: continuations stop at held blocks");
  assert.equal(await regionModuleKey(f, parts), await regionModuleKey(f, { ...parts, formation: 4 }), "4 by default");
});


// 0111, review: a recorded compare must not survive an op that writes its
// field or its operands, even one kept in the region as a helper call (0105):
// fcmpu and ps_cmpu0 into the compared field, lmw over a compared register;
// a cmplwi with a high immediate; crxor and mcrf reading the stored field.
const CR2_TEXT = 0x80014100;
const fcmpu = (crf, a, b) => (63 << 26) | (crf << 23) | (a << 16) | (b << 11);
const psCmpu0 = (crf, a, b) => (4 << 26) | (crf << 23) | (a << 16) | (b << 11);
const lmw = (d, a, off) => (46 << 26) | (d << 21) | (a << 16) | (off & 0xffff);
const crxor = (bt, ba, bb) => (19 << 26) | (bt << 21) | (ba << 16) | (bb << 11) | (193 << 1);
const mcrf = (d, s) => (19 << 26) | (d << 23) | (s << 18);
const CR2 = assemble(CR2_TEXT, [
  "main", asm.mflr(0), asm.stwu(1, 1, -32), stw(0, 1, 36), stw(29, 1, 8), stw(30, 1, 12), stw(31, 1, 16), (pc, l) => asm.bl(pc, l.f),
  lwz(29, 1, 8), lwz(30, 1, 12), lwz(31, 1, 16), lwz(0, 1, 36), asm.addi(1, 1, 32), mtlr(0), asm.blr(),
  "f", asm.lis(5, DATA >>> 16), asm.ori(5, 5, DATA & 0xffff), lfs(1, 5, 0), lfs(2, 5, 4), asm.li(6, 1), asm.li(30, 5), asm.li(3, 0),
  cmpw(3, 6, 30), fcmpu(3, 1, 2), (pc, l) => blt(pc, l.l1, 3), asm.addi(3, 3, 1),
  "l1", cmpw(7, 6, 30), psCmpu0(7, 1, 2), (pc, l) => blt(pc, l.l2, 7), asm.addi(3, 3, 2),
  "l2", asm.cmplwi(6, 0xfff0), (pc, l) => blt(pc, l.l3), asm.addi(3, 3, 4),
  "l3", cmpw(0, 30, 6), lmw(29, 5, 0), (pc, l) => asm.bgt(pc, l.l4), asm.addi(3, 3, 8),
  "l4", cmpw(4, 6, 6), crxor(22, 18, 16), mcrf(6, 4), (pc, l) => asm.beq(pc, l.l5, 6), asm.addi(3, 3, 16),
  "l5", (pc, l) => asm.beq(pc, l.l6, 5), asm.addi(3, 3, 32),
  "l6", mfcr(8), asm.blr()
]);

test("a compare's field or operands rewritten in the region (fcmpu, ps_cmpu0, lmw), cmplwi high, crxor and mcrf: like the interpreter (0111)", { skip: crSkip }, () => {
  const dol = buildDol({ textAddr: CR2_TEXT, text: CR2.words, entry: CR2.labels.main });
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  for (const seg of image.segments) core.load(seg.start, seg.bytes);
  const data = new DataView(new ArrayBuffer(16));
  data.setFloat32(0, 1.5); data.setFloat32(4, -3.25); data.setUint32(8, 0x80000000); data.setUint32(12, 7);
  const loadData = () => core.load(DATA, new Uint8Array(data.buffer));
  loadData();
  core.reset(seedGprs(CR2.labels.main), CR2.labels.main, STOP, 400000);
  core.setRegionsEnabled(true);
  core.setRegionChaining(true);
  queueAll(plan, 1, true);
  serviceAll();
  loadData();
  const reference = runCall(CR2.labels.main, { regions: false });
  loadData();
  const got = runCall(CR2.labels.main, { regions: true });
  core.invalidate(CR2_TEXT, 4 * CR2.words.length);
  core.module._DolphinWeb_AotForgetRegionsForTest?.();
  assert.deepEqual(got.state, reference.state);
  assert.equal(got.downcount, reference.downcount);
  assert.equal(got.interpreted, 0, "no op left the region");
});

// 0135 (was 0128): a fragment keeps pc, npc and downcount in locals and writes them back
// at its exits. A loop over memory with an FPU op kept in the region (a
// helper call: downcount flushed and reloaded around it), run to the end and
// stopped on downcount at every budget, against the interpreter.
const FRAME_TEXT = 0x80015100;
const bltFrame = (from, to) => asm.bc(12, 0, from, to);
const FRAME = assemble(FRAME_TEXT, [
  "main", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), (pc, l) => asm.bl(pc, l.loop),
  lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  "loop", asm.lis(5, DATA >>> 16), asm.ori(5, 5, DATA & 0xffff), asm.li(8, 0), asm.li(10, 0),
  lfs(1, 5, 0), lfs(2, 5, 4),
  "body", lwz(9, 5, 8), add(10, 10, 9), stw(10, 5, 12), faddsRc(3, 1, 2), asm.addi(8, 8, 1),
  asm.addi(9, 9, 3), stw(9, 5, 8), asm.cmplwi(8, 5), (pc, l) => bltFrame(pc, l.body),
  stfd(3, 5, 16), asm.blr()
]);

test("pc, npc and downcount in locals end like the interpreter, at the end and on downcount at every budget (0135)", { skip: chainSkip || (core?.has("DolphinWeb_AotKeyParts") && keyVersion() < 27 && "core before 0135 (compiler version < 27)") }, () => {
  const dol = buildDol({ textAddr: FRAME_TEXT, text: FRAME.words, entry: FRAME.labels.main });
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  for (const seg of image.segments) core.load(seg.start, seg.bytes);
  const data = new DataView(new ArrayBuffer(24));
  data.setFloat32(0, 1.5); data.setFloat32(4, -3.25); data.setUint32(8, 7);
  const loadData = () => core.load(DATA, new Uint8Array(data.buffer));
  loadData();
  core.reset(seedGprs(FRAME.labels.main), FRAME.labels.main, STOP, 400000);
  core.setRegionsEnabled(true);
  core.setRegionChaining(true);
  queueAll(plan, 1, true);
  serviceAll();
  loadData();
  const reference = runCall(FRAME.labels.main, { regions: false });
  loadData();
  const got = runCall(FRAME.labels.main, { regions: true });
  assert.deepEqual(got.state, reference.state);
  assert.equal(got.downcount, reference.downcount);
  assert.equal(got.interpreted, 0, "no op left the region");
  for (const budget of [1, 2, 4, 9, 17, 30, 47, 64]) {
    loadData();
    core.reset(seedGprs(FRAME.labels.main), FRAME.labels.main, STOP, budget);
    core.dispatchRegion();
    const stopped = { state: core.state(), downcount: core.downcount(), pc: core.pc() };
    loadData();
    core.reset(seedGprs(FRAME.labels.main), FRAME.labels.main, STOP, budget);
    for (let n = 0; n < 100000 && core.downcount() > stopped.downcount; n++) assert.equal(core.interpretOne(), 0);
    assert.equal(core.downcount(), stopped.downcount, `budget ${budget}`);
    assert.equal(core.pc(), stopped.pc, `budget ${budget}: pc`);
    assert.deepEqual(core.state(), stopped.state, `budget ${budget}`);
  }
  core.invalidate(FRAME_TEXT, 4 * FRAME.words.length);
  core.module._DolphinWeb_AotForgetRegionsForTest?.();
});

// The local profile in a product build (harness hooks off): the sampler gets
// the guest PC's address and a record writes the profile file. A product
// build of #165 got 0 from the harness-only export and recorded nothing.
const pcSkip = skip || (typeof core?.module._DolphinWeb_GuestPcAddress !== "function" && "core without DolphinWeb_GuestPcAddress");
test("without harness hooks the profile sampler gets the guest PC and a record writes the profile", { skip: pcSkip }, async () => {
  const { guestPcAddress, startHotSampler, createProfileRecorder } = await import("../src/aot-hot-sampler.js");
  const { AotProfileStore, blocksFromPcSamples } = await import("../src/aot-profile.js");
  const m = core.module;
  if (typeof m._DolphinWeb_HarnessPcAddress === "function") assert.equal(m._DolphinWeb_HarnessPcAddress(), 0, "the harness export stays gated");
  const at = guestPcAddress(m);
  assert.ok(at > 0 && at % 4 === 0, "an address without the harness");
  core.reset(seedGprs(1), TEXT + 0x40, STOP, 1000);
  assert.equal(new Uint32Array(m.HEAPU8.buffer, at, 1)[0] >>> 0, (TEXT + 0x40) >>> 0, "it is the core's PC");
  // The sampler starts from it (a stand-in worker posts what it counted).
  let worker;
  const sampler = startHotSampler({ buffer: new SharedArrayBuffer(16), pcAddress: at, createWorker: () => (worker = { postMessage() {}, terminate() {} }) });
  assert.ok(sampler);
  worker.onmessage({ data: [[TEXT + 0x40, 7]] });
  // A record writes the file, with the weight.
  const files = new Map();
  const dir = { getFileHandle: async (name, { create } = {}) => {
    if (!files.has(name) && !create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
    return { getFile: async () => ({ arrayBuffer: async () => (files.get(name) ?? new Uint8Array()).slice().buffer }), createWritable: async () => { let b; return { write: async (x) => { b = new Uint8Array(x); }, close: async () => { files.set(name, b); }, abort: async () => {} }; } };
  } };
  const store = new AotProfileStore({ getDirectoryHandle: async () => dir }, { locks: null });
  const record = createProfileRecorder({ store, discKey: "disc", blocksFromPcSamples });
  await record(sampler.drain());
  sampler.stop();
  const saved = await store.load("disc");
  assert.deepEqual(saved.blocks.map((b) => [b[0], b[4]]), [[(TEXT + 0x40) >>> 0, 7]], "the profile file holds the weight");
});

// Review of 0130: continuations that only hold what one uncut fragment held
// before (the first fragment and them, up to maxBlocks blocks) spend no
// budget; past that they do, and what the budget leaves out is counted.
test("continuation budget: the old single fragment's blocks are free; refusals for lack of budget are counted", { skip: contSkip }, async () => {
  const program = longFunction(100);
  const run = (options) => translateWithContinuations(core.module, { entry: LONG, ranges: loadWords(LONG, program.words), hash: null },
    { mask: PRODUCTION_DISABLE_MASK, maxBlocks: 64, names: coreAssembleOptions(core.module)?.helperNames, ...options });
  // A first fragment cut at 16 blocks: its continuations up to 64 blocks in all are free.
  const cut = await run({ maxBlocks: 16 });
  const blocksOf = (r) => [r.fragment, ...(r.continuations ?? [])].reduce((n, x) => n + x.entries.length, 0);
  assert.ok(blocksOf(cut) > 64);
  assert.ok(cut.budgetCharged > 0, "past 64 blocks: charged");
  const within = await run({ maxBlocks: 16, maxContinuations: 3 }); // 16 + 3 × 16 = 64 blocks
  assert.equal(within.budgetCharged, 0, "within the old fragment's 64 blocks: free");
  // With no budget past the free blocks, the rest is refused and counted.
  const starved = await run({ maxBlocks: 16, maxBytes: 1 });
  assert.ok(starved.budgetRefused >= 1, `refused ${starved.budgetRefused}`);
});

// The production path: a first fragment of maxBlocks (64) blocks, so nothing
// is free, and continuations halved under the byte cap. Every continuation
// byte is charged, and a budget below them refuses the rest, counted.
test("continuation budget: past a full first fragment every continuation byte is charged, byte-capped ones too", { skip: contSkip }, async () => {
  const program = longFunction(100);
  const run = (options) => translateWithContinuations(core.module, { entry: LONG, ranges: loadWords(LONG, program.words), hash: null },
    { mask: PRODUCTION_DISABLE_MASK, maxBlocks: 64, names: coreAssembleOptions(core.module)?.helperNames, ...options });
  const bytesOf = (r) => (r.continuations ?? []).reduce((n, c) => n + c.code.length, 0);
  const full = await run({});
  assert.equal(full.fragment.entries.length, 64);
  assert.ok(full.continuations?.length >= 1);
  assert.equal(full.budgetCharged, bytesOf(full), "64 blocks first: no block is free");
  const cap = Math.floor(full.fragment.code.length / 8);
  const capped = await run({ maxFragmentBytes: cap });
  assert.ok(capped.continuations.length > full.continuations.length, "halved under the byte cap");
  assert.ok(capped.continuations.every((c) => c.code.length <= cap));
  assert.equal(capped.budgetCharged, bytesOf(capped));
  const short = await run({ maxFragmentBytes: cap, maxBytes: cap });
  assert.ok(short.budgetCharged <= cap + Math.max(...capped.continuations.map((c) => c.code.length)), "stops once the budget is spent");
  assert.ok(short.budgetRefused >= 1, `refused ${short.budgetRefused}`);
});

// A branch is in held code when the nearest held entry before it reaches it
// with no block end between (the core's block can run through a leader it
// did not split at); after a block end it is not.
test("frontier: a branch belongs to the nearest held entry unless a block end lies between", async () => {
  const { frontier } = await import("../src/aot-orchestrator.js");
  const branches = [[0x80000008, [0x80000100]], [0x80000020, [0x80000200]]];
  branches.ends = [0x80000010];
  assert.deepEqual(frontier(branches, new Set([0x80000000])), [0x80000100], "the branch at 8 is in the entry's block; the one at 0x20 is past the blr");
  assert.deepEqual(frontier(branches, new Set([0x80000000, 0x80000014])), [0x80000100, 0x80000200]);
  // A leader the core did not split at (0x80000004, the head of a loop a
  // later branch targets): the branch at 8 is still in the held entry's
  // block. The old rule gave it to that leader, which no fragment holds,
  // and left its target out (an exit to code with no region: 0x800f5fc4,
  // the heavy scene's first one).
  const loop = [[0x80000008, [0x80000100]], [0x80000030, [0x80000004]]];
  loop.ends = [0x80000010, 0x80000030];
  // Formation 4: 0x80000004 is also seeded, a leader the held block falls
  // into (the bdnz at 0x30 enters there once its code is held).
  assert.deepEqual(frontier(loop, new Set([0x80000000])), [0x80000004, 0x80000100]);
});

// A function refused continuations for lack of budget resumes its frontier
// where it stopped: in two steps it holds what one step with the whole
// budget holds, and nothing is translated twice.
test("continuation budget: resume goes on from where the budget stopped", { skip: contSkip }, async () => {
  const program = longFunction(100);
  const f = { entry: LONG, ranges: loadWords(LONG, program.words), hash: null };
  const options = { mask: PRODUCTION_DISABLE_MASK, maxBlocks: 16, names: coreAssembleOptions(core.module)?.helperNames };
  const whole = await translateWithContinuations(core.module, f, options);
  assert.ok(!whole.budgetRefused && !whole.resume);
  const short = await translateWithContinuations(core.module, f, { ...options, maxBytes: 1 });
  assert.ok(short.budgetRefused >= 1 && typeof short.resume === "function");
  const more = await short.resume(1 << 20);
  assert.equal(more.budgetRefused, 0);
  const held = (fs) => new Set(fs.flatMap((x) => x.entries)).size;
  assert.equal(held([short.fragment, ...(short.continuations ?? []), ...more.continuations]), held([whole.fragment, ...whole.continuations]));
  assert.equal((short.budgetCharged ?? 0) + more.budgetCharged, whole.budgetCharged, "the same bytes charged");
  const entries = [...(short.continuations ?? []), ...more.continuations].map((x) => x.entry);
  assert.equal(new Set(entries).size, entries.length, "no continuation translated twice");
});

// A large member's share: what is left of the module's budget over the
// large members left (largeLeft), so the first ones no longer take it all.
test("continuation budget: a large member gets an even share of what the module has left", { skip: contSkip }, async () => {
  const program = longFunction(100);
  const t = coreRegionTranslator(core.module, { maxBlocks: 16, yieldNow: async () => {} });
  const f = { entry: LONG, ranges: loadWords(LONG, program.words), hash: null, flags: 0, extraEntries: [] };
  const [alone] = await t.translate([{ ...f, continuationBytesUsed: 0, largeLeft: 1 }]);
  const [shared] = await t.translate([{ ...f, continuationBytesUsed: t.unitContinuationBytes - 8000, largeLeft: 4 }]);
  assert.ok(!alone.budgetRefused, "alone: the whole budget");
  assert.ok(shared.budgetRefused >= 1, `a quarter of 8000 bytes is short of the ${alone.budgetCharged} it needs alone`);
  const biggest = Math.max(...(shared.continuations ?? [{ code: [] }]).map((c) => c.code.length));
  assert.ok(alone.budgetCharged > 2000);
  assert.ok(shared.budgetCharged <= 2000 + biggest, `charged ${shared.budgetCharged}`);
});

// Review of #189: no continuation is kept past the budget it was given (a
// fragment that would overshoot goes back to the frontier), in the first
// pass and in a resume, so a module never ends past its budget.
test("continuation budget: never charged past the limit, first pass or resume", { skip: contSkip }, async () => {
  const program = longFunction(100);
  const f = { entry: LONG, ranges: loadWords(LONG, program.words), hash: null };
  const options = { mask: PRODUCTION_DISABLE_MASK, maxBlocks: 16, names: coreAssembleOptions(core.module)?.helperNames };
  const whole = await translateWithContinuations(core.module, f, options);
  const sizes = (whole.continuations ?? []).map((c) => c.code.length);
  for (const limit of [1, Math.floor(whole.budgetCharged / 3), Math.floor(whole.budgetCharged / 2) + 1]) {
    const r = await translateWithContinuations(core.module, f, { ...options, maxBytes: limit });
    assert.ok((r.budgetCharged ?? 0) <= limit, `first pass: ${r.budgetCharged} <= ${limit}`);
    assert.ok(r.budgetRefused >= 1 && r.resume);
    const more = await r.resume(limit);
    assert.ok(more.budgetCharged <= limit, `resume: ${more.budgetCharged} <= ${limit}`);
  }
  assert.ok(sizes.length > 1);
  // A member whose own cap is reached is not offered more (no resume).
  const capped = await translateWithContinuations(core.module, f, { ...options, maxContinuations: 1 });
  assert.ok(capped.budgetRefused >= 1 && !capped.resume, "at its own cap: no resume");
});

// Formation 4: a continuation is translated over the function's ranges
// without the first word of each held block, so it stops there instead of
// translating it again; the frontier then also seeds what a held block
// falls into and the return points of calls made from held code (before,
// a continuation translated through them).
test("withoutStarts: the ranges without the word at each start", async () => {
  const { withoutStarts } = await import("../src/aot-orchestrator.js");
  assert.deepEqual(withoutStarts([[0x100, 0x140]], [0x100, 0x110, 0x13c, 0x200]), [[0x104, 0x110], [0x114, 0x13c]]);
  assert.deepEqual(withoutStarts([[0x100, 0x110], [0x200, 0x210]], []), [[0x100, 0x110], [0x200, 0x210]]);
});

test("frontier: a leader a held block falls into, and the return point of a call from held code", async () => {
  const { frontier } = await import("../src/aot-orchestrator.js");
  // 0x00 held; 0x08 a bctrl from held code (0x0c its return point); 0x10
  // a loop head only a bdnz at 0x30 targets, past a blr at 0x20 (so that
  // bdnz is in no held block).
  const branches = [[0x80000030, [0x80000010, 0x80000034]]];
  branches.ends = [0x80000008, 0x80000020, 0x80000040];
  branches.calls = [0x80000008];
  assert.deepEqual(frontier(branches, new Set([0x80000000])), [0x8000000c], "the call's return point; 0x10 is past the bctrl's end");
  // Held through 0x0c: 0x10 is fallen into (no end between 0x0c and it).
  assert.deepEqual(frontier(branches, new Set([0x80000000, 0x8000000c])), [0x80000010]);
});

test("continuations: no block in two fragments, and the module runs like the interpreter", { skip: contSkip }, async () => {
  const program = longFunction(100);
  const ranges = loadWords(LONG, program.words);
  const r = await translateWithContinuations(core.module, { entry: LONG, ranges, hash: null },
    { mask: PRODUCTION_DISABLE_MASK, maxBlocks: 16, names: coreAssembleOptions(core.module)?.helperNames });
  const fragments = [r.fragment, ...r.continuations];
  const listed = fragments.flatMap((x) => x.entries);
  assert.equal(new Set(listed).size, listed.length, "every block in one fragment");
  assert.equal(listed.length, 101);
  core.module._DolphinWeb_AotForgetRegionsForTest?.();
  const { bytes: mod, entries } = assembleRegion(claimEntries(fragments), { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
  core.setRegionsEnabled(true);
  core.queueRegion(mod, entries.map(([pc]) => pc), [{ ranges, hash: null }]);
  core.serviceRegions();
  const reference = runCall(LONG, { regions: false });
  const got = runCall(LONG, { regions: true });
  assert.deepEqual(got.state, reference.state);
  assert.equal(got.interpreted, 0);
});

// Review of #205: carving with the plan's hash on. A first fragment capped
// at 2 blocks holds `entry` and the loop head `L`; the continuation at `F`
// is cut where it falls into L (a held start) and jumps there. The module
// runs like the interpreter.
test("continuations: a block cut where it falls into a held block, hash on, runs like the interpreter", { skip: contSkip }, async () => {
  const { regionHash } = await import("../src/aot-plan.js");
  const t = assemble(LONG, [
    "entry", asm.li(3, 0), (pc, l) => asm.b(pc, l.L),
    "F", asm.addi(4, 4, 1),
    "L", asm.addi(3, 3, 1), asm.cmplwi(3, 10), (pc, l) => asm.bc(12, 0, pc, l.F), // blt F
    "out", asm.blr()
  ]);
  const ranges = loadWords(LONG, t.words);
  const read32 = (a) => new DataView(core.ram().buffer, core.ram().byteOffset).getUint32(a & 0x01ffffff, false);
  const hash = regionHash(read32, ranges);
  const r = await translateWithContinuations(core.module, { entry: LONG, ranges, hash },
    { mask: PRODUCTION_DISABLE_MASK, maxBlocks: 2, names: coreAssembleOptions(core.module)?.helperNames });
  assert.ok(r.fragment, r.reason);
  assert.ok(!r.codeChanged);
  const fragments = [r.fragment, ...(r.continuations ?? [])];
  const listed = fragments.flatMap((x) => x.entries);
  assert.equal(new Set(listed).size, listed.length, "no block in two fragments");
  for (const pc of [t.labels.entry, t.labels.F, t.labels.L, t.labels.out]) assert.ok(listed.includes(pc), `${pc.toString(16)} held`);
  const fFragment = fragments.find((x) => x.entry === t.labels.F);
  assert.ok(fFragment && !fFragment.entries.includes(t.labels.L), "F's fragment stops at the held L");
  core.module._DolphinWeb_AotForgetRegionsForTest?.();
  const { bytes: mod, entries } = assembleRegion(claimEntries(fragments), { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
  core.setRegionsEnabled(true);
  core.queueRegion(mod, entries.map(([pc]) => pc), [{ ranges, hash: null }]);
  core.serviceRegions();
  const reference = runCall(LONG, { regions: false });
  const got = runCall(LONG, { regions: true });
  assert.deepEqual(got.state, reference.state);
  assert.equal(got.interpreted, 0);
});

// Review of #205: code rewritten between two translations (an overlay
// during a slice) refuses the continuation and stops the function's growth:
// nothing translated from foreign bytes is kept.
test("continuations: code rewritten during a slice refuses the fragment (plan hash checked after each)", { skip: contSkip }, async () => {
  const { regionHash } = await import("../src/aot-plan.js");
  const program = longFunction(100);
  const ranges = loadWords(LONG, program.words);
  const read32 = (a) => new DataView(core.ram().buffer, core.ram().byteOffset).getUint32(a & 0x01ffffff, false);
  const hash = regionHash(read32, ranges);
  const options = { mask: PRODUCTION_DISABLE_MASK, maxBlocks: 16, names: coreAssembleOptions(core.module)?.helperNames };
  const clean = await translateWithContinuations(core.module, { entry: LONG, ranges, hash }, options);
  assert.ok(clean.continuations?.length >= 2 && !clean.codeChanged, "unchanged code: continuations kept");
  // The second slice rewrites a word of the function (an addi constant).
  const at = LONG + 4 * 40;
  const before = read32(at);
  let slices = 0;
  const slice = async () => {
    if (++slices === 2) core.load(at, Uint8Array.of(before >>> 24, (before >>> 16) & 0xff, (before >>> 8) & 0xff, ((before & 0xff) ^ 1)));
  };
  try {
    const r = await translateWithContinuations(core.module, { entry: LONG, ranges, hash }, { ...options, slice });
    assert.equal(r.codeChanged, true);
    assert.equal(r.continuations?.length ?? 0, 1, "only the continuation translated before the rewrite");
    assert.ok(!r.resume, "no resume: the function grows no more");
  } finally {
    core.load(at, Uint8Array.of(before >>> 24, (before >>> 16) & 0xff, (before >>> 8) & 0xff, before & 0xff));
  }
});

// 0142: a guest call made by a region is a wasm `call` (to the callee's
// fragment in the module, else the exit stub, which chains on), its return a
// wasm return (3) that the caller takes only at its continuation. Calls
// within one module and across modules (one region per function), a
// recursion past the 64-call cap, a return elsewhere than the continuation
// (LR rewritten: passed up to the dispatcher), each against the interpreter,
// to the end and at budgets that stop it mid-call.
const callSkip = chainSkip || (core?.has("DolphinWeb_AotKeyParts") && keyVersion() < 31 && "core before 0142 (compiler version < 31)");
const CALL_TEXT = 0x80016100;
const BEQLR = 0x4d820020; // beqlr cr0
const CALLS = assemble(CALL_TEXT, [
  "main", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), asm.li(3, 100), asm.li(4, 0), (pc, l) => asm.bl(pc, l.recA),
  asm.li(3, 10), (pc, l) => asm.bl(pc, l.self),
  asm.li(3, 0), (pc, l) => asm.bl(pc, l.cond), asm.li(3, 1), (pc, l) => asm.bl(pc, l.cond),
  (pc, l) => asm.bl(pc, l.jumper), asm.li(6, 1),
  "elsewhere", asm.li(7, 2), lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  // recA / recB (r3): a mutual recursion 100 deep, every call to the other
  // function's fragment (past the 64 cap); r4 += 1 per level on the way back.
  "recA", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), asm.cmplwi(3, 0), (pc, l) => asm.beq(pc, l.recA_done),
  asm.addi(3, 3, -1), (pc, l) => asm.bl(pc, l.recB), asm.addi(4, 4, 1),
  "recA_done", lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  "recB", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), asm.cmplwi(3, 0), (pc, l) => asm.beq(pc, l.recB_done),
  asm.addi(3, 3, -1), (pc, l) => asm.bl(pc, l.recA), asm.addi(4, 4, 1),
  "recB_done", lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  // self (r3): a self-recursion, its calls local jumps in its fragment: its
  // inner returns stay in the fragment (the head), only the last one is 3.
  "self", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), asm.cmplwi(3, 0), (pc, l) => asm.beq(pc, l.self_done),
  asm.addi(3, 3, -1), (pc, l) => asm.bl(pc, l.self), asm.addi(4, 4, 2),
  "self_done", lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  // cond (r3): beqlr taken with r3 == 0, not taken (r5 += 1, then blr) else.
  "cond", asm.cmplwi(3, 0), BEQLR, asm.addi(5, 5, 1), asm.blr(),
  // jumper: returns to `elsewhere`, not to its call's continuation.
  "jumper", (pc, l) => asm.lis(5, l.elsewhere >>> 16), (pc, l) => asm.ori(5, 5, l.elsewhere & 0xffff), mtlr(5), asm.blr()
]);
// The same without the deep recursion (no call past the cap), its own
// program so its entry is a function of the plan.
const SMALL_TEXT = 0x80019100;
const SMALL = assemble(SMALL_TEXT, [
  "main", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), asm.li(3, 10), (pc, l) => asm.bl(pc, l.self),
  asm.li(3, 0), (pc, l) => asm.bl(pc, l.cond), asm.li(3, 1), (pc, l) => asm.bl(pc, l.cond),
  (pc, l) => asm.bl(pc, l.jumper), asm.li(6, 1),
  "elsewhere", asm.li(7, 2), lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  "self", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), asm.cmplwi(3, 0), (pc, l) => asm.beq(pc, l.self_done),
  asm.addi(3, 3, -1), (pc, l) => asm.bl(pc, l.self), asm.addi(4, 4, 2),
  "self_done", lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  "cond", asm.cmplwi(3, 0), BEQLR, asm.addi(5, 5, 1), asm.blr(),
  "jumper", (pc, l) => asm.lis(5, l.elsewhere >>> 16), (pc, l) => asm.ori(5, 5, l.elsewhere & 0xffff), mtlr(5), asm.blr()
]);
function installCalls(maxFunctions, program = CALLS, text = CALL_TEXT) {
  const dol = buildDol({ textAddr: text, text: program.words, entry: program.labels.main });
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  for (const s of image.segments) core.load(s.start, s.bytes);
  core.invalidate(text, 4 * program.words.length);
  core.module._DolphinWeb_AotForgetRegionsForTest?.();
  core.setRegionsEnabled(true);
  core.setRegionChaining(true);
  queueAll(plan, maxFunctions, true);
  serviceAll();
  return plan;
}
test("guest calls as wasm calls, in one module and across modules, past the depth cap and returning elsewhere: like the interpreter (0142)", { skip: callSkip }, () => {
  for (const maxFunctions of [100, 1]) {
    installCalls(maxFunctions);
    const reference = runCall(CALLS.labels.main, { regions: false });
    const got = runCall(CALLS.labels.main, { regions: true });
    const what = maxFunctions === 1 ? "across modules" : "in one module";
    assert.deepEqual(got.state, reference.state, what);
    assert.equal(got.downcount, reference.downcount, what);
    // jumper's return to `elsewhere` (not an entry) unwinds to the CPU loop,
    // which interprets up to the next entry: some ops, never the calls.
    assert.ok(got.ran >= 1, `${what}: the regions ran`);
    // Counters (harness): the cap (the recursion 100 deep: past it, calls
    // are return_calls and the returns below unwind as "elsewhere")...
    const stats = () => Array.from(new Uint32Array(core.module.HEAPU8.buffer, core.module._DolphinWeb_RegionCallStats(-1), 6));
    core.module._DolphinWeb_RegionCallStats(1);
    runCall(CALLS.labels.main, { regions: true });
    const [calls, , , , capped, depthMax] = stats();
    assert.ok(calls >= 64, `${what}: ${calls} calls made as wasm calls`);
    assert.equal(depthMax, 64, `${what}: the cap is the deepest`);
    assert.ok(capped >= 30, `${what}: ${capped} calls past the cap (recursion 100)`);
    // ...and without it: self's inner returns stay in its fragment, cond's
    // beqlr returns taken and not, only jumper's return is elsewhere.
    installCalls(maxFunctions, SMALL, SMALL_TEXT);
    core.module._DolphinWeb_RegionCallStats(1);
    const small = runCall(SMALL.labels.main, { regions: true });
    const smallReference = runCall(SMALL.labels.main, { regions: false });
    const [smallCalls, , elsewhere, , smallCapped] = stats();
    core.module._DolphinWeb_RegionCallStats(0);
    assert.deepEqual(small.state, smallReference.state, `${what}: main_small`);
    assert.equal(smallCapped, 0);
    assert.ok(smallCalls >= 4, `${what}: ${smallCalls} calls`);
    assert.equal(elsewhere, 1, `${what}: only jumper's return is elsewhere`);
    installCalls(maxFunctions); // back to CALLS for the budgets
    for (const budget of [1, 7, 40, 151, 400, 777, 1501]) {
      core.reset(seedGprs(CALLS.labels.main), CALLS.labels.main, STOP, budget);
      while (core.downcount() > 0 && core.pc() !== STOP) if (!core.dispatchRegion()) assert.equal(core.interpretOne(), 0);
      assert.equal(core.module._DolphinWeb_RegionCallDepthForTest(-1), 0, `${what}, budget ${budget}: no call left counted`);
      const stopped = { state: core.state(), downcount: core.downcount() };
      core.reset(seedGprs(CALLS.labels.main), CALLS.labels.main, STOP, budget);
      for (let n = 0; n < 1000000 && core.downcount() > stopped.downcount; n++) assert.equal(core.interpretOne(), 0);
      assert.equal(core.downcount(), stopped.downcount, `${what}, budget ${budget}`);
      assert.deepEqual(core.state(), stopped.state, `${what}, budget ${budget}`);
    }
  }
});

// 0142: the depth starts at 0 at every region run, whatever was left (here
// set to the cap by hand): no call of the next run is made past the cap.
test("a region run starts at call depth 0 (0142)", { skip: callSkip }, () => {
  installCalls(100);
  const stats = () => Array.from(new Uint32Array(core.module.HEAPU8.buffer, core.module._DolphinWeb_RegionCallStats(-1), 6));
  core.module._DolphinWeb_RegionCallStats(1);
  core.reset(seedGprs(PROGRAM.labels.main), PROGRAM.labels.main, STOP, 400000);
  installedOnePerFunction();
  core.module._DolphinWeb_RegionCallDepthForTest(64);
  const got = runCall(PROGRAM.labels.main, { regions: true });
  const [calls, , , , capped] = stats();
  core.module._DolphinWeb_RegionCallStats(0);
  assert.equal(got.interpreted, 0);
  assert.ok(calls >= 2, `${calls} calls`);
  assert.equal(capped, 0, "none past the cap: the run started at 0");
});

// 0142: a callee that rewrites its caller's continuation (stw, icbi,
// isync) then returns. The translator does not take icbi: the callee's
// region leaves before it (0), every call passes that up, and the caller
// never goes on in code that is gone. As the interpreter.
const PATCH_TEXT = 0x80017100;
const icbi = (a, b) => (31 << 26) | (a << 16) | (b << 11) | (982 << 1);
const ISYNC = 0x4c00012c;
const LI_R9_2 = (14 << 26) | (9 << 21) | 2;
const PATCHER = assemble(PATCH_TEXT, [
  "main", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), (pc, l) => asm.bl(pc, l.patcher),
  "cont", asm.li(9, 1), lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  "patcher", asm.lis(5, LI_R9_2 >>> 16), asm.ori(5, 5, LI_R9_2 & 0xffff),
  (pc, l) => asm.lis(6, l.cont >>> 16), (pc, l) => asm.ori(6, 6, l.cont & 0xffff),
  stw(5, 6, 0), icbi(0, 6), ISYNC, asm.blr()
]);
test("a callee that rewrites its caller's continuation: the caller runs the new code, like the interpreter (0142)", { skip: callSkip }, () => {
  const load = () => {
    const dol = buildDol({ textAddr: PATCH_TEXT, text: PATCHER.words, entry: PATCHER.labels.main });
    const { image, entryPoint } = imageFromDol(dol);
    for (const seg of image.segments) core.load(seg.start, seg.bytes);
    core.invalidate(PATCH_TEXT, 4 * PATCHER.words.length);
    return planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  };
  load();
  const reference = runCall(PATCHER.labels.main, { regions: false });
  assert.equal(reference.state[9], 2, "the interpreter runs the new li r9, 2");
  for (const maxFunctions of [100, 1]) {
    const plan = load();
    core.module._DolphinWeb_AotForgetRegionsForTest?.();
    core.setRegionsEnabled(true);
    core.setRegionChaining(true);
    queueAll(plan, maxFunctions, true);
    serviceAll();
    const got = runCall(PATCHER.labels.main, { regions: true });
    // The translator does not take icbi: the region leaves before it (its
    // prefix ends, 0), every call passes that up, and the icbi, isync, blr
    // and the rewritten continuation run outside: 8 ops at most, the stw
    // and the calls in the region.
    assert.ok(got.interpreted <= 8, `maxFunctions ${maxFunctions}: ${got.interpreted} ops interpreted`);
    assert.deepEqual(got.state, reference.state, `maxFunctions ${maxFunctions}`);
    assert.equal(got.downcount, reference.downcount, `maxFunctions ${maxFunctions}`);
  }
});

// 0142: a callee that traps (tw: a program exception taken by its helper,
// the fragment halts with 2) under two levels of wasm calls: 2 is passed up
// through every call, and the state at the handler is the interpreter's.
const TRAP_TEXT = 0x80018100;
const TW = 0x7fe00008; // tw 31, r0, r0: always traps
const TRAPPER = assemble(TRAP_TEXT, [
  "main", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), (pc, l) => asm.bl(pc, l.middle), lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  "middle", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), (pc, l) => asm.bl(pc, l.trap), lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  "trap", asm.li(3, 5), TW, asm.blr()
]);
test("a trap in a callee two wasm calls deep: the handler sees the interpreter's state (0142)", { skip: callSkip }, () => {
  const VECTOR = 0x700;
  const load = () => {
    const dol = buildDol({ textAddr: TRAP_TEXT, text: TRAPPER.words, entry: TRAPPER.labels.main });
    const { image, entryPoint } = imageFromDol(dol);
    for (const seg of image.segments) core.load(seg.start, seg.bytes);
    core.invalidate(TRAP_TEXT, 4 * TRAPPER.words.length);
    return planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  };
  const toVector = (regions) => {
    core.reset(seedGprs(TRAPPER.labels.main), TRAPPER.labels.main, STOP, 400000);
    for (let n = 0; n < 100000 && (core.pc() >>> 0) !== VECTOR; n++) if (!(regions && core.dispatchRegion())) core.interpretOne();
    assert.equal(core.pc() >>> 0, VECTOR, "the program exception was taken");
    return { state: core.state(), downcount: core.downcount() };
  };
  load();
  core.setRegionsEnabled(false);
  const reference = toVector(false);
  for (const maxFunctions of [100, 1]) {
    const plan = load();
    core.module._DolphinWeb_AotForgetRegionsForTest?.();
    core.setRegionsEnabled(true);
    core.setRegionChaining(true);
    queueAll(plan, maxFunctions, true);
    serviceAll();
    const got = toVector(true);
    assert.deepEqual(got.state, reference.state, `maxFunctions ${maxFunctions}`);
    assert.equal(core.module._DolphinWeb_RegionCallDepthForTest(-1), 0, "no call left counted");
  }
});

// 0145: HID0.ICFI flash-invalidates the instruction cache (Dolphin clears
// its whole block cache, JitInterface::ClearSafe): every region is checked
// against its plan before it runs again. Here a callee rewrites a function
// main already ran (stw, no icbi or dcbf), then sets ICFI, and main calls the
// function again: it must run the new code, like the interpreter, and not
// main's or its own stale region. The mtspr is not a region op: the region
// leaves before it.
const unverifySkip = callSkip || (!core?.has("DolphinWeb_UnverifyRegions") && "core without region re-checks on an icache flush (0145)");
const ICFI_TEXT = 0x8001c100;
const HID0_SPR = ((1008 & 0x1f) << 5) | (1008 >>> 5);
const mfspr = (d, spr) => (31 << 26) | (d << 21) | (spr << 11) | (339 << 1);
const mtspr = (s, spr) => (31 << 26) | (s << 21) | (spr << 11) | (467 << 1);
const mr = (a, s) => (31 << 26) | (s << 21) | (a << 16) | (s << 11) | (444 << 1);
const FLASHER = assemble(ICFI_TEXT, [
  "main", asm.mflr(0), asm.stwu(1, 1, -16), stw(0, 1, 20), (pc, l) => asm.bl(pc, l.target), mr(11, 9),
  (pc, l) => asm.bl(pc, l.flasher), (pc, l) => asm.bl(pc, l.target),
  lwz(0, 1, 20), asm.addi(1, 1, 16), mtlr(0), asm.blr(),
  "target", asm.li(9, 1), asm.blr(),
  "flasher", asm.lis(5, LI_R9_2 >>> 16), asm.ori(5, 5, LI_R9_2 & 0xffff),
  (pc, l) => asm.lis(6, l.target >>> 16), (pc, l) => asm.ori(6, 6, l.target & 0xffff), stw(5, 6, 0),
  mfspr(7, HID0_SPR), asm.ori(7, 7, 0x800), mtspr(7, HID0_SPR), asm.blr()
]);
test("a function rewritten then an icache flash invalidate (HID0.ICFI): its next call runs the new code, like the interpreter (0145)", { skip: unverifySkip }, () => {
  const load = () => {
    const dol = buildDol({ textAddr: ICFI_TEXT, text: FLASHER.words, entry: FLASHER.labels.main });
    const { image, entryPoint } = imageFromDol(dol);
    for (const seg of image.segments) core.load(seg.start, seg.bytes);
    core.invalidate(ICFI_TEXT, 4 * FLASHER.words.length);
    return planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  };
  load();
  const reference = runCall(FLASHER.labels.main, { regions: false });
  assert.equal(reference.state[11], 1, "the interpreter ran the old li r9, 1 first");
  assert.equal(reference.state[9], 2, "then the new li r9, 2");
  for (const maxFunctions of [100, 1]) {
    const plan = load();
    core.module._DolphinWeb_AotForgetRegionsForTest?.();
    core.setRegionsEnabled(true);
    core.setRegionChaining(true);
    queueAll(plan, maxFunctions, true);
    serviceAll();
    const got = runCall(FLASHER.labels.main, { regions: true });
    assert.ok(got.ran >= 1, `maxFunctions ${maxFunctions}: the regions ran`);
    assert.deepEqual(got.state, reference.state, `maxFunctions ${maxFunctions}`);
    assert.equal(got.downcount, reference.downcount, `maxFunctions ${maxFunctions}`);
  }
});
