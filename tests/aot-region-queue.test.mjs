// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";

import { serialQueue, yieldToEventLoop } from "../src/aot-orchestrator.js";

// A warm launch queues ~140 cached regions: each one's synchronous work
// (heap patch, copy into the core's heap, queueing) must run in its own
// task, in order, so the worker gets back to its event loop (the core's
// disc reads) between two.
test("one task per region, in order, the event loop served between two", async () => {
  const q = serialQueue();
  const log = [];
  let between = 0;
  // A macrotask posted now runs only if the queue gives the event loop back.
  const ticker = setInterval(() => { between += 1; log.push("tick"); }, 0);
  try {
    for (let i = 0; i < 5; i += 1) {
      q.push(() => {
        const end = performance.now() + 15; // 15 ms of synchronous work
        while (performance.now() < end) { /* the region's heap patch */ }
        log.push(i);
      });
    }
    await q.idle;
  } finally {
    clearInterval(ticker);
  }
  assert.deepEqual(log.filter((x) => x !== "tick"), [0, 1, 2, 3, 4]);
  assert.ok(between >= 3, `the event loop ran ${between} times during 75 ms of queued work`);
  // between two regions, at least one other task ran
  const idx = log.map((x, i) => (typeof x === "number" ? i : -1)).filter((i) => i >= 0);
  assert.ok(idx.slice(1).filter((i, k) => log.slice(idx[k] + 1, i).includes("tick")).length >= 3);
});

test("a task that throws does not stop the ones after it", async () => {
  const q = serialQueue({ yieldNow: yieldToEventLoop });
  const done = [];
  q.push(() => { throw new Error("refused region"); });
  q.push(async () => { done.push("next"); });
  await q.idle;
  assert.deepEqual(done, ["next"]);
});
