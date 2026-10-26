// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";

import { discAwareYield } from "../src/aot-orchestrator.js";

// A fake clock: sleep and the translation slices advance it; reads land at
// the times `readAt(t)` says (the last read at or before t).
function clock(readAt) {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    sleep: async (ms) => { t += ms; },
    lastReadAt: () => readAt(t),
    yieldNow: async () => {}
  };
}

test("a translation slice waits while the disc is being read, and starts once reads are quiet", async () => {
  const reads = [0, 10, 20, 30, 40]; // a burst of reads every 10 ms up to 40 ms
  const c = clock((t) => Math.max(-Infinity, ...reads.filter((r) => r <= t)));
  await discAwareYield({ ...c, quietMs: 15 })();
  assert.ok(c.now() >= 55, `resumed at ${c.now()} ms, before the burst was quiet`);
});

test("no recent read: no wait", async () => {
  const c = clock(() => -100);
  await discAwareYield({ ...c, quietMs: 15 })();
  assert.equal(c.now(), 0);
});

// Review of #268: reads that never stop (a movie, streamed audio, a long
// load screen) must not starve the translation. 60 s of 8 ms slices under
// reads every 5, 10, 14, 16 and 30 ms: after the first maxWaitMs, the
// translation keeps about half the time at least.
test("endless reads at any cadence leave the translation at least ~45 % of the time", async () => {
  for (const every of [5, 10, 14, 16, 30]) {
    const c = clock((t) => Math.floor(t / every) * every);
    const y = discAwareYield({ ...c, quietMs: 15, maxWaitMs: 1000 });
    let translating = 0;
    while (c.now() < 60_000) {
      await y();
      c.advance(8); // one translation slice
      translating += 8;
    }
    const share = translating / c.now();
    assert.ok(share >= 0.45, `reads every ${every} ms: translation ${(100 * share).toFixed(1)} % of the time`);
  }
});

test("a boot's burst still gets the disc first: up to maxWaitMs of waiting before any slice", async () => {
  const c = clock((t) => (t < 600 ? Math.floor(t / 5) * 5 : 590)); // reads every 5 ms for 600 ms, then quiet
  const y = discAwareYield({ ...c, quietMs: 15, maxWaitMs: 1000 });
  await y();
  assert.ok(c.now() >= 600, `the first slice started at ${c.now()} ms, during the burst`);
  assert.ok(y.waitedMs >= 600);
});

// The worker's hook: every WORKERFS read stamps the time the translator's
// yield reads (behaviour, through the worker's own export).
test("the worker stamps every disc read for the translator's yield", async (t) => {
  const originalSelf = globalThis.self;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);
  const { noteDiscReads, lastDiscReadAtForTest } = await import(`${workerUrl.href}?disc-yield-test=${Date.now()}`);
  const calls = [];
  const fs = { stream_ops: { read: (stream, buffer, offset, length, position) => { calls.push(length); return length; } } };
  noteDiscReads(fs);
  noteDiscReads(fs); // once only
  const before = performance.now();
  assert.equal(fs.stream_ops.read(null, null, 0, 4096, 0), 4096);
  assert.deepEqual(calls, [4096]);
  assert.ok(lastDiscReadAtForTest() >= before);
});
