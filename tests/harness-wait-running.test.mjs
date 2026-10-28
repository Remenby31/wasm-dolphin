// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { waitRunning } from "../harness/lib/browser.mjs";

// A page whose core progress replies come from `replies` in turn (the last
// one repeated), on a clock that moves 100 ms per wait.
function fakeCore(replies) {
  let i = 0, t = 0;
  const page = { waitForTimeout: async (ms) => { t += ms; } };
  const read = async () => replies[Math.min(i++, replies.length - 1)];
  return { page, read, now: () => t, reads: () => i };
}

test("waitRunning: frames counted before the boot was accepted do not release the state load", async () => {
  // 2026-10-28: the page's runFrame loop counts frames while the boot still
  // waits for its AOT regions; a load then came back "no game booted"
  const core = fakeCore([
    { frame: 0, booted: false, coreState: "Uninitialized" },
    { frame: 12, booted: false, coreState: "Uninitialized" },
    { frame: 30, booted: false, coreState: "Uninitialized" },
    { frame: 31, booted: true, coreState: "Running" }
  ]);
  const p = await waitRunning(core.page, 60000, core);
  assert.equal(p.booted, true);
  assert.equal(core.reads(), 4, "released only once the boot was accepted");
});

test("waitRunning: a worker without the booted field keeps the frames rule; never booted is an error that says why", async () => {
  const old = fakeCore([{ frame: 0 }, { frame: 5 }]);
  assert.equal((await waitRunning(old.page, 60000, old)).frame, 5);
  const stuck = fakeCore([{ frame: 40, booted: false, coreState: "Uninitialized" }]);
  await assert.rejects(waitRunning(stuck.page, 1000, stuck), /core never reached Running \(frame 40, booted false, state Uninitialized\)/);
});

test("the worker's core progress says whether the disc's boot was accepted", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const reply = worker.slice(worker.indexOf('case "validationReadCoreProgress": {'), worker.indexOf("observedAtMs: performance.now(),"));
  assert.match(reply, /\n {8}booted: coreBoot\.accepted === true,\n {8}coreState: api\?\.getCoreStateName\?\.\(\) \?\? null,\n/);
});
