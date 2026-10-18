// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { createFreezeWatch, probeWorker } from "../harness/lib/freeze-probe.mjs";

// One timeline read: VI outputs and presentations at the given times.
const chunk = (now, vi = [], presents = []) => ({
  now, presents: { t: presents, vi: presents.map(() => 0) },
  vi: { supported: true, t: vi, ticks: vi.map(() => 0), sinceBoot: vi.map((_, i) => 100 + i), sinceLoad: vi.map(() => 0) }
});

test("a presentation freeze (VI goes on, nothing presented) starts one episode", () => {
  const w = createFreezeWatch();
  assert.equal(w.observe(chunk(1000, [990], [995])), null);
  assert.equal(w.observe(chunk(2000, [1990], [])), null);
  const e = w.observe(chunk(3100, [3090], []));
  assert.equal(e.kind, "present");
  assert.equal(e.lastPresentAgeMs, 2105);
  assert.equal(w.observe(chunk(4100, [4090], [])), null); // same episode
  assert.equal(w.observe(chunk(5100, [5090], [5095])), null); // over
  assert.equal(w.observe(chunk(8100, [8090], [])).kind, "present"); // a new one
});

test("a core freeze (no VI output) is its own kind, and episodes are capped", () => {
  const w = createFreezeWatch({ maxEpisodes: 1 });
  w.observe(chunk(1000, [990], [990]));
  assert.equal(w.observe(chunk(3500, [], [])).kind, "core");
  w.observe(chunk(4000, [3990], [3990]));
  assert.equal(w.observe(chunk(7000, [], [])), null); // cap reached
});

test("the worker state is read several times; an unknown message is reported once as unsupported", async () => {
  const calls = [];
  const ok = await probeWorker(async (t) => { calls.push(t); return { ring: calls.length }; }, { wait: async () => {} });
  assert.equal(ok.states.length, 4);
  assert.deepEqual(ok.states.map((s) => s.state.ring), [1, 2, 3, 4]);
  const no = await probeWorker(async () => ({ error: "Error: Unknown upstream worker message: validationReadWgpuReplayState" }), { wait: async () => {} });
  assert.equal(no.unsupported, true);
  const big = await probeWorker(async () => ({ blob: "x".repeat(70000) }), { reads: 1, wait: async () => {} });
  assert.equal(big.states[0].state.truncated, true);
});
