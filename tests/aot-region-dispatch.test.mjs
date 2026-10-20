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
      assert.equal(r.key, `wasm-block-sha256-v1:${createHash("sha256").update(r.bytes).digest("hex")}`, "the key names the bytes");
      Atomics.store(core.module.HEAPU8, r.readyPtr + r.readySlot, 1);
    }
    core.serviceRegions();
    assert.equal(core.regionCount(), before + entries);
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
    for (let slice = 0; slice < 300 && core.regionCount() === before; slice++) core.serviceRegions();
    assert.equal(core.regionCount(), before + entries);
  });
});
