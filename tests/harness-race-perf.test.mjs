// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquirePerfLock, readLockOwner } from "../harness/lib/perf-lock.mjs";
import { pairedSpeedChange, sideOrder } from "../harness/probes/race-perf.mjs";
import { summarizePcSamples } from "../src/harness-pc-sampler.js";

function lockDir(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "harness-test-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, ".perf-lock");
}

test("perf lock: taken with mkdir, owner written, released only by its holder", async (t) => {
  const dir = lockDir(t);
  const release = await acquirePerfLock({ dir, name: "test" });
  assert.equal(readLockOwner(dir).pid, process.pid);
  await assert.rejects(acquirePerfLock({ dir, name: "second", waitSec: 0, sleep: async () => {} }), /still held by/);
  release();
  assert.equal(existsSync(dir), false);
  // Someone else's lock is never removed by our release.
  const again = await acquirePerfLock({ dir, name: "test" });
  writeFileSync(path.join(dir, "owner"), "another agent\n");
  again();
  assert.equal(existsSync(dir), true);
});

test("perf lock: waits for another holder, then gets it", async (t) => {
  const dir = lockDir(t);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "owner"), "wgpu agent\n");
  let polls = 0;
  const release = await acquirePerfLock({ dir, name: "test", waitSec: 60, sleep: async () => { polls += 1; if (polls === 2) rmSync(dir, { recursive: true }); } });
  assert.equal(polls, 2);
  release();
});

test("perf lock: a lock left by a dead harness process of this host is taken over", async (t) => {
  const dir = lockDir(t);
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => child.on("exit", r));
  mkdirSync(dir);
  writeFileSync(path.join(dir, "owner"), JSON.stringify({ name: "old run", pid: child.pid, host: os.hostname(), harness: true }));
  const release = await acquirePerfLock({ dir, name: "test", waitSec: 0, sleep: async () => {} });
  assert.equal(readLockOwner(dir).pid, process.pid);
  release();
  // Not a harness lock (a person or another tool): never taken over.
  mkdirSync(dir);
  writeFileSync(path.join(dir, "owner"), JSON.stringify({ name: "manual", pid: child.pid, host: os.hostname() }));
  await assert.rejects(acquirePerfLock({ dir, name: "test", waitSec: 0, sleep: async () => {} }), /still held/);
});

test("trunk and head are interleaved, the order alternating, and compared per run", () => {
  assert.deepEqual([1, 2, 3, 4].map(sideOrder), [["baseline", "candidate"], ["candidate", "baseline"], ["baseline", "candidate"], ["candidate", "baseline"]]);
  const run = (b, c) => ({ baseline: { cold: { speed: b } }, candidate: { cold: { speed: c } } });
  const ch = pairedSpeedChange([run(80, 88), run(70, 77), run(90, 99), { baseline: { cold: { speed: null } }, candidate: { cold: { speed: 50 } } }]);
  assert.equal(ch.pairs, 3);
  assert.equal(ch.median, 10);
});

test("guest PC histogram: shares, top PCs and per-function attribution", () => {
  const counts = [[0x80003000, 50], [0x80003004, 25], [0x80010000, 20], [0x80200000, 5]];
  const s = summarizePcSamples({ n: 100, outside: 4, same: 30, ms: 1000, counts }, { functions: [[0x80003000, 0x80003100, "PSMTXConcat"], [0x80010000, 0x80010040, "memcpy"]] });
  assert.equal(s.samples, 100);
  assert.equal(s.hz, 104);
  assert.equal(s.topPcs[0].pc, "0x80003000");
  assert.deepEqual(s.topFunctions, [{ name: "PSMTXConcat", share: 75 }, { name: "memcpy", share: 20 }]);
  assert.equal(s.unattributedShare, 5);
});
