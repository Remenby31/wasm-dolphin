// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";

// A save state loaded early in a first launch: the worker samples the guest
// PC from the shared heap for a moment and hands the counts to the flow,
// which moves the modules covering them first (aot-optimizer prioritize()).
test("without the profile sampler, the worker samples the guest PC itself and prioritizes the flow's modules", async (t) => {
  const originalSelf = globalThis.self;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);
  const { prioritizeAotAfterStateLoad } = await import(`${workerUrl.href}?state-priority-test=${Date.now()}`);
  const heap = new Uint32Array(16);
  const pcAddress = 8 * 4;
  // shaped like the real core: HEAPU8 only, no HEAPU32
  const instance = { HEAPU8: new Uint8Array(heap.buffer), _DolphinWeb_GuestPcAddress: () => pcAddress };
  // the guest runs 0x80100000 three times, 0x80200000 once, then real mode (not counted)
  const pcs = [0x80100000, 0x80100000, 0x80200000, 0x80100000, 0x00003100];
  let clock = 0, i = 0;
  heap[8] = pcs[0];
  const calls = [];
  const flow = { supported: true, prioritize: (hits) => { calls.push(hits); return hits.length; } };
  const moved = await prioritizeAotAfterStateLoad({
    flow, instance, sampler: null, rounds: [5], everyMs: 1, now: () => clock,
    wait: async () => { clock += 1; i += 1; heap[8] = pcs[i] ?? 0; }
  });
  assert.equal(moved, 2);
  assert.deepEqual(new Map(calls[0]), new Map([[0x80100000, 3], [0x80200000, 1]]));
});

test("no flow, no PC address or no heap: nothing sampled", async (t) => {
  const originalSelf = globalThis.self;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);
  const { prioritizeAotAfterStateLoad } = await import(`${workerUrl.href}?state-priority-test-none=${Date.now()}`);
  const flow = { supported: true, prioritize: () => { throw new Error("not called"); } };
  assert.equal(await prioritizeAotAfterStateLoad({ flow: null, sampler: null, instance: { HEAPU8: new Uint8Array(16), _DolphinWeb_GuestPcAddress: () => 4 } }), 0);
  assert.equal(await prioritizeAotAfterStateLoad({ flow, sampler: null, instance: { HEAPU8: new Uint8Array(16) } }), 0);
  assert.equal(await prioritizeAotAfterStateLoad({ flow, sampler: null, instance: null }), 0);
  assert.equal(await prioritizeAotAfterStateLoad({ flow, sampler: null, instance: { HEAPU32: new Uint32Array(4), _DolphinWeb_GuestPcAddress: () => 4 } }), 0, "no HEAPU8: nothing read");
});

// With the profile sampler (its own thread, 10 ms): rounds over what it saw
// since the load, cumulative, and the watch is stopped at the end.
test("with the profile sampler: one prioritize per round over the samples since the load", async (t) => {
  const originalSelf = globalThis.self;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);
  const { prioritizeAotAfterStateLoad } = await import(`${workerUrl.href}?state-priority-test-sampler=${Date.now()}`);
  let clock = 0, stopped = false;
  const seen = new Map();
  const sampler = { watch: () => ({ read: () => [...seen.entries()], stop: () => { stopped = true; } }) };
  const feeds = [[[0x80100000, 5]], [], [[0x80200000, 9]]];
  let round = 0;
  const calls = [];
  const flow = { supported: true, prioritize: (hits) => { calls.push(hits.map(([pc, n]) => [pc, n])); return hits.length; } };
  const moved = await prioritizeAotAfterStateLoad({
    flow, sampler, rounds: [600, 1500, 3000], now: () => clock,
    wait: async (ms) => { clock += ms; for (const [pc, n] of feeds[round++] ?? []) seen.set(pc, (seen.get(pc) ?? 0) + n); }
  });
  assert.equal(moved, 2);
  assert.deepEqual(calls, [[[0x80100000, 5]], [[0x80100000, 5]], [[0x80100000, 5], [0x80200000, 9]]]);
  assert.ok(stopped, "the watch ends with the rounds");
});

// Review of #278 (P2): a second load ends the first one's rounds; nothing
// left to translate, no round at all (the fallback polled discio 3 s).
test("a later load ends the earlier load's rounds; no rounds once the flow has no work", async (t) => {
  const originalSelf = globalThis.self;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);
  const { prioritizeAotAfterStateLoad } = await import(`${workerUrl.href}?state-priority-test-p2=${Date.now()}`);
  const seen = new Map([[0x80100000, 3]]);
  const sampler = { watch: () => ({ read: () => [...seen.entries()], stop() {} }) };
  const calls = [];
  const flow = { supported: true, hasWork: () => true, prioritize: (hits) => { calls.push(hits.length); return 1; } };
  // the first load's rounds wait on this gate; the second load runs meanwhile
  let open;
  const gate = new Promise((r) => { open = r; });
  const first = prioritizeAotAfterStateLoad({ flow, sampler, rounds: [600, 1500], wait: () => gate, now: () => 0 });
  const second = prioritizeAotAfterStateLoad({ flow, sampler, rounds: [10], wait: async () => {}, now: () => 0 });
  assert.equal(await second, 1);
  open();
  assert.equal(await first, 0, "the first load's rounds stopped: a later load took over");
  assert.deepEqual(calls, [1], "only the second load prioritized");
  // nothing left to translate: no sampling, no round
  let watched = 0;
  const idle = { supported: true, hasWork: () => false, prioritize: () => { throw new Error("not called"); } };
  assert.equal(await prioritizeAotAfterStateLoad({ flow: idle, sampler: { watch: () => { watched++; return { read: () => [], stop() {} }; } }, rounds: [600] }), 0);
  assert.equal(watched, 0);
});
