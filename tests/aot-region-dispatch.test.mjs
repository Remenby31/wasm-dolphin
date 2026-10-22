// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Regions in the dispatcher (P4 step 5): modules queued from any thread are
// installed at a slice boundary, the dispatcher runs the region holding the
// pc before looking for a block, only with translation and FP on, and
// invalidating covered code drops them. Skipped with a core before 0075.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { imageFromDol } from "../src/aot-image.js";
import { planDol } from "../src/aot-plan.js";
import { assembleRegion } from "../src/aot-region-module.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";
import { HELPER_SIGNATURES, STOP, functionFragments, loadAotCore, regionGroups, seedGprs } from "./helpers/aot-core-equivalence.mjs";

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
  return plan;
}

// Every region of the plan, queued as P7 would (members with the plan's hashes).
function queueAll(plan) {
  let entries = 0;
  for (const group of regionGroups(plan, 100)) {
    const fragments = group.flatMap(functionFragments(core));
    const { bytes, entries: mapped } = assembleRegion(fragments, { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
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

test("invalidating covered code drops the regions holding it, other code keeps them", { skip }, () => {
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

// A region already installed when the RAM moves (a stop and a new boot in
// the same page reallocates it): its code still writes the old address. A
// cache clear makes it checked again, layout included; a shutdown forgets
// every region (review of #62, P1-1).
test("an installed region is dropped when the heap layout moved, before it runs again", { skip: skip || (!core?.has("DolphinWeb_AotLayoutShiftForTest") && "core without the layout re-check") }, () => {
  installed();
  core.reset(seedGprs(1), PROGRAM.labels.count, STOP, 400000);
  assert.equal(core.dispatchRegion(), 1, "runs under its own layout");
  core.module._DolphinWeb_AotLayoutShiftForTest(0x100000); // the RAM sits 1 MiB further
  try {
    core.unverifyRegions(); // what ClearCache does at the new boot
    core.reset(seedGprs(1), PROGRAM.labels.count, STOP, 400000);
    assert.equal(core.dispatchRegion(), 0, "dropped, not run at the old address");
  } finally {
    core.module._DolphinWeb_AotLayoutShiftForTest(0);
  }
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
