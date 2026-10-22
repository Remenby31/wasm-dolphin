// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { consistentMemRead, decodeMemStats, KINDS, memAccessShares, poolMemStats } from "../harness/lib/mem-access-stats.mjs";
import { memRecord, summarizeMem } from "../harness/probes/race-perf.mjs";

// A v1 struct as the worker copies it (layout agreed with the JIT owner).
function memBytes(v = {}) {
  const view = new DataView(new ArrayBuffer(192));
  view.setUint32(0, v.version ?? 1, true);
  view.setUint32(4, v.size ?? 192, true);
  view.setUint32(8, v.on ?? 1, true);
  const f = [
    v.instructions ?? 0, ...KINDS.map((k) => v.access?.[k] ?? 0), ...KINDS.map((k) => v.slow?.[k] ?? 0),
    v.cyclesCovered ?? 0, v.cyclesTotal ?? 0, v.regionAccesses ?? 0, v.regionInstructions ?? 0, v.saturations ?? 0
  ];
  f.forEach((x, i) => view.setFloat64(16 + 8 * i, x, true));
  return Array.from(new Uint8Array(view.buffer));
}

const BLOCKS = {
  instructions: 1000, cyclesCovered: 2000, cyclesTotal: 2000,
  access: { intLoad: 150, intStore: 80, fpLoad: 30, fpStore: 20, psqLoad: 15, psqStore: 5 },
  slow: { intLoad: 3, intStore: 2, fpLoad: 0, fpStore: 0, psqLoad: 0, psqStore: 0 }
};

test("memory access stats: layout v1 at the agreed offsets; other layouts and bad values refused", () => {
  const s = decodeMemStats(memBytes(BLOCKS));
  assert.equal(s.guestInstructions, 1000);
  assert.equal(s["access.intLoad"], 150);
  assert.equal(s["access.psqStore"], 5);
  assert.equal(s["slow.intStore"], 2);
  assert.equal(s.cyclesTotal, 2000);
  // Offsets: slow.int_load at +72, cyclesCovered at +120, staticSaturations at +152.
  const view = new DataView(Uint8Array.from(memBytes({ ...BLOCKS, saturations: 7 })).buffer);
  assert.equal(view.getFloat64(72, true), 3);
  assert.equal(view.getFloat64(120, true), 2000);
  assert.equal(view.getFloat64(152, true), 7);
  assert.match(decodeMemStats(memBytes({ version: 2 })).error, /layout version 2/);
  assert.match(decodeMemStats(memBytes({ size: 128 })).error, /needs 192/);
  assert.match(decodeMemStats(memBytes({ ...BLOCKS, cyclesCovered: 3000 })).error, /cyclesCovered 3000 > cyclesTotal 2000/);
  assert.match(consistentMemRead(s, decodeMemStats(memBytes({ ...BLOCKS, instructions: 10 }))).error, /torn read \(guestInstructions/);
});

test("memory access ratio: counted blocks, coverage, the region part estimated apart, the slow path", () => {
  const all = memAccessShares(decodeMemStats(memBytes(BLOCKS)));
  assert.equal(all.accessesPerInstruction, 0.3);
  assert.equal(all.coverage, 1);
  assert.equal(all.scope, "every cycle counted");
  assert.equal(all.loadsPerInstruction, 0.195);
  assert.equal(all.storesPerInstruction, 0.105);
  assert.equal(all.byKind.intLoad, 0.5);
  assert.equal(all.slowShare, round(5 / 300));
  assert.equal(all.withRegionsEstimated, null);
  // aot=1: most cycles in regions, counted apart as an estimate, never merged.
  const aot = memAccessShares(decodeMemStats(memBytes({ ...BLOCKS, cyclesCovered: 140, cyclesTotal: 2000, regionAccesses: 4000, regionInstructions: 10000 })));
  assert.equal(aot.accessesPerInstruction, 0.3);
  assert.equal(aot.coverage, 0.07);
  assert.match(aot.scope, /counted blocks only/);
  assert.equal(aot.regionAccessesPerInstructionEstimated, 0.4);
  assert.equal(aot.withRegionsEstimated, round(4300 / 11000));
  assert.equal(aot.slowShare, round(5 / 4300));
  assert.match(memAccessShares(decodeMemStats(memBytes({ on: 0 }))).error, /not on/);
});

test("race-perf --mem-stats: a window's record, the pooled ratio, and why when absent", () => {
  assert.deepEqual(memRecord(null), { memAccess: null, memAccessWhy: "not asked (no --mem-stats)" });
  assert.equal(memRecord({ error: "core has no DolphinWeb_MemAccessStats" }).memAccessWhy, "core has no DolphinWeb_MemAccessStats");
  assert.equal(memRecord({ error: "Unknown upstream worker message: validationReadMemAccessStats" }).memAccessWhy, "engine without validationReadMemAccessStats");
  const w = memRecord({ bytes: memBytes(BLOCKS), again: memBytes(BLOCKS) });
  assert.equal(w.memAccess.accessesPerInstruction, 0.3);
  const pooled = summarizeMem([w, w, memRecord({ error: "core has no DolphinWeb_MemAccessStats" })]);
  assert.equal(pooled.memAccess.windows, 2);
  assert.equal(pooled.memAccess.missingWindows, 1);
  assert.equal(pooled.memAccess.accessesPerInstruction, 0.3);
  assert.equal(poolMemStats([w.memRaw, w.memRaw]).guestInstructions, 2000);
  assert.equal(summarizeMem([memRecord(null)]).memAccess, null);
});

function round(v) { return Math.round(v * 10000) / 10000; }
