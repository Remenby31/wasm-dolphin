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

// Review of #273: with the heap moved, each region needs a compile of its
// patched bytes (a round trip to the compiler worker). The queue must not
// wait for it; the submits still go in the order the regions came.
test("the installer prepares in order without awaiting compiles, and submits in order", async () => {
  const { createRegionInstaller } = await import("../src/aot-orchestrator.js");
  const log = [];
  const resolvers = {};
  let gen = 1;
  const inst = createRegionInstaller({
    current: () => gen,
    prepare: async (r) => {
      log.push(`prepare ${r}`);
      const pending = new Promise((res) => { resolvers[r] = res; });
      return { prepared: r, pending };
    },
    submit: (r) => log.push(`submit ${r}`)
  });
  for (const r of ["a", "b", "c"]) inst.push(r);
  // let the queue run its tasks: all three prepared before any compile is done
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(log, ["prepare a", "prepare b", "prepare c"]);
  // compiles finish out of order: c, then a, then b
  resolvers.c(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(log.filter((x) => x.startsWith("submit")), [], "c waits for a and b");
  resolvers.a(true);
  resolvers.b(false); // b's compile failed: not submitted
  await inst.idle;
  assert.deepEqual(log.filter((x) => x.startsWith("submit")), ["submit a", "submit c"]);
});

test("the installer drops what another disc's queue still held", async () => {
  const { createRegionInstaller } = await import("../src/aot-orchestrator.js");
  let gen = 1;
  const prepared = [], submitted = [];
  const inst = createRegionInstaller({
    current: () => gen,
    prepare: async (r) => { prepared.push(r); if (r === "b") gen = 2; return { prepared: r }; },
    submit: (r) => submitted.push(r)
  });
  for (const r of ["a", "b", "c"]) inst.push(r);
  await inst.idle;
  assert.deepEqual(prepared, ["a", "b"], "c, queued for disc 1, is not prepared once disc 2 is in");
  assert.deepEqual(submitted, ["a"], "b was prepared for disc 1 but the disc changed before its submit");
});

test("sharedYield: concurrent callers share one wait", async () => {
  const { sharedYield } = await import("../src/aot-orchestrator.js");
  let calls = 0;
  const y = sharedYield(async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); });
  await Promise.all(Array.from({ length: 8 }, () => y()));
  assert.equal(calls, 1);
  await y();
  assert.equal(calls, 2);
});
