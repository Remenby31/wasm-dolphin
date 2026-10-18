// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquirePerfLock, readLockOwner } from "../harness/lib/perf-lock.mjs";
import { num, pairedSpeedChange, sideOrder } from "../harness/probes/race-perf.mjs";
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
  const run = (n, b, c) => ({ run: n, baseline: { cold: { speed: b } }, candidate: { cold: { speed: c } } });
  const ch = pairedSpeedChange([run(1, 80, 88), run(2, 70, 77), run(3, 90, 99), run(4, 100, 110)]);
  assert.equal(ch.pairs, 4);
  assert.equal(ch.median, 10);
  assert.equal(ch.withheld, null);
});

// Review of #22: with 3 runs trunk went first twice; a failed pair could
// leave the order unbalanced; one pair was enough to conclude.
test("review #22: the change is withheld when pairs are too few or unbalanced in order", () => {
  const run = (n, b, c) => ({ run: n, baseline: { cold: { speed: b } }, candidate: { cold: { speed: c } } });
  const three = pairedSpeedChange([run(1, 80, 88), run(2, 70, 77), run(3, 90, 99)], { minPairs: 2 });
  assert.match(three.withheld, /unbalanced: trunk first in 2/);
  assert.equal(three.median, null);
  assert.match(pairedSpeedChange([run(1, 80, 88), run(2, 70, 77)]).withheld, /2 valid pair\(s\), at least 4/);
  const lost = pairedSpeedChange([run(1, 80, 88), run(2, 70, 77), run(3, 90, 99), { run: 4, baseline: { cold: { speed: 100 } }, candidate: { error: "core-mismatch" } }], { minPairs: 2 });
  assert.match(lost.withheld, /unbalanced/);
});

test("review #22: numeric options reject NaN and out-of-range values", () => {
  assert.equal(num({ "max-load": "3.5" }, "max-load", { min: 0.1 }), 3.5);
  assert.throws(() => num({ "max-load": "abc" }, "max-load", { min: 0.1 }), /--max-load abc: expected a number/);
  assert.throws(() => num({ runs: "2.5" }, "runs", { int: true }), /integer/);
  assert.throws(() => num({ secs: "0" }, "secs", { min: 2 }), /≥ 2/);
});

test("review #22: odd runs and a pinned coreid are refused with --baseline", () => {
  const probe = path.resolve(import.meta.dirname, "../harness/probes/race-perf.mjs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-test-probe-"));
  try {
    for (const f of ["d.iso", "s.sav"]) writeFileSync(path.join(dir, f), "");
    const args = (extra) => [probe, "--iso", path.join(dir, "d.iso"), "--state", path.join(dir, "s.sav"), "--port", "1", "--baseline", "origin/main", ...extra];
    const run = (extra) => spawnSync(process.execPath, args(extra), { encoding: "utf8", env: { ...process.env, CI: "" } }).stderr;
    assert.match(run(["--runs", "3"]), /runs must be even/);
    assert.match(run(["--query", "core=upstream&coreid=sha256:" + "a".repeat(64)]), /no coreid in --query/);
    assert.match(run(["--max-load", "abc"]), /--max-load abc/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review of #22: taking a stale lock over was not atomic; two harnesses
// could both end up holding it, or one delete the other's fresh lock.
test("review #22: contenders on a stale lock: one holder at a time, every one gets it", async (t) => {
  const dir = lockDir(t);
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => dead.on("exit", r));
  mkdirSync(dir);
  writeFileSync(path.join(dir, "owner"), JSON.stringify({ name: "crashed run", pid: dead.pid, host: os.hostname(), harness: true }));
  const holding = path.join(path.dirname(dir), "holding");
  const lockLib = path.resolve(import.meta.dirname, "../harness/lib/perf-lock.mjs");
  const script = `import { acquirePerfLock } from ${JSON.stringify(lockLib)};
    import { writeFileSync, rmSync } from "node:fs";
    const release = await acquirePerfLock({ dir: ${JSON.stringify(dir)}, name: "c" + process.pid, waitSec: 60, pollSec: 0.02 });
    try { writeFileSync(${JSON.stringify(holding)}, String(process.pid), { flag: "wx" }); } catch { console.log("OVERLAP"); process.exit(2); }
    await new Promise((r) => setTimeout(r, 30));
    rmSync(${JSON.stringify(holding)});
    release();
    console.log("ok");`;
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] }));
  const outs = await Promise.all(children.map((c) => new Promise((resolve) => { let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("exit", (code) => resolve(`${code}:${out.trim()}`)); })));
  assert.deepEqual(outs, Array(6).fill("0:ok"));
  assert.equal(existsSync(dir), false);
  assert.deepEqual(readdirSync(path.dirname(dir)).filter((n) => n.includes("stale")), []);
});

test("review #22: an ownerless lock is taken over only once it is old", async (t) => {
  const dir = lockDir(t);
  mkdirSync(dir); // a holder that died between mkdir and writing its owner
  await assert.rejects(acquirePerfLock({ dir, name: "test", waitSec: 0, sleep: async () => {} }), /unknown owner/);
  const old = new Date(Date.now() - 60_000);
  utimesSync(dir, old, old);
  const release = await acquirePerfLock({ dir, name: "test", waitSec: 0, sleep: async () => {} });
  assert.equal(readLockOwner(dir).name, "test");
  release();
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
