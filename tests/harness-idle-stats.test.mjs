// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";

import { consistentIdleRead, decodeIdleStats, FIELDS, IDLE_STATS_BYTES, idleRates, idleRecord, summarizeIdle } from "../harness/lib/idle-stats.mjs";

// The struct as the core lays it out (Core/WasmIdleStats.h, v1).
function struct(values, { version = 1, on = 1, size = IDLE_STATS_BYTES } = {}) {
  const view = new DataView(new ArrayBuffer(IDLE_STATS_BYTES));
  view.setUint32(0, version, true);
  view.setUint32(4, size, true);
  view.setUint32(8, on, true);
  FIELDS.forEach((f, i) => view.setFloat64(16 + 8 * i, values[f] ?? 0, true));
  return Array.from(new Uint8Array(view.buffer));
}

// One guest second at 486 MHz: 59.94 fields.
const second = { cycles: 486e6, hostMs: 1000, idleCalls: 30000, idleCycles: 243e6, reentries: 29000, reentryHostMs: 300, reentryEventMs: 100, idleWakes: 30000, wakeViOnly: 26000, viUpdates: 31470, viObservable: 600 };

test("idle stats: decodes the v1 struct and derives per-field rates", () => {
  const s = decodeIdleStats(struct(second));
  assert.equal(s.idleCalls, 30000);
  const r = idleRates(s);
  assert.equal(r.idleCycleShare, 0.5);
  assert.equal(r.reentriesPerField, Math.round((29000 / 59.94) * 10) / 10);
  // Host time per round trip, and its share once the event callbacks are out.
  assert.equal(r.reentryOverheadShare, 0.2);
  assert.equal(r.reentryOverheadUsMean, Math.round((200000 / 29000) * 1000) / 1000);
  assert.equal(r.wakeViOnlyShare, Math.round((26000 / 30000) * 1e4) / 1e4);
});

test("idle stats: refuses other layouts, a reset not yet applied, impossible or torn counters", () => {
  assert.match(decodeIdleStats(struct(second, { version: 2 })).error, /layout version 2/);
  assert.match(decodeIdleStats(struct(second, { on: 0 })).error, /not counting yet/);
  assert.match(decodeIdleStats(struct({ ...second, reentries: 40000 })).error, /reentries/);
  assert.match(decodeIdleStats(struct(second).slice(0, 40)).error, /bytes/);
  const a = decodeIdleStats(struct({ ...second, advances: 50 })), b = decodeIdleStats(struct({ ...second, advances: 10 }));
  assert.match(consistentIdleRead(a, b).error, /torn read \(advances/);
});

test("idle stats: a run records rates, a side pools its windows, an older core says why", () => {
  const rec = idleRecord({ bytes: struct(second), again: struct(second) });
  assert.equal(rec.idle.idleCycleShare, 0.5);
  assert.equal(idleRecord({ error: "Unknown upstream worker message: validationReadIdleStats" }).idleWhy, "engine without validationReadIdleStats");
  const side = summarizeIdle([rec, rec, { idle: null, idleWhy: "x" }]);
  assert.equal(side.idle.windows, 2);
  assert.equal(side.idle.missingWindows, 1);
  assert.equal(side.idle.raw.idleCalls, 60000);
  assert.equal(summarizeIdle([{ idle: null, idleWhy: "no export" }]).why, "no export");
});
