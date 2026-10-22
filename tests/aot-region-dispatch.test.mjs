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
import { assembleRegion, paddedSleb, paddedUleb, patchRegionHeap, regionHeapOfBytes } from "../src/aot-region-module.js";
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
  try {
    return fn(posted.filter.bind(posted, (msg) => msg.type === "dolphin-jit-compile-request"));
  } finally {
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
    assert.equal(chain.chained, unchained.ran - 1, "one chain per dispatcher round trip saved");
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
