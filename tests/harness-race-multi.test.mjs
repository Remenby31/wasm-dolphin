// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claim, OWNER_FILE } from "../harness/lib/ownership.mjs";
import { copySeedProfile } from "../harness/lib/session.mjs";

import { armEffects, barrier, bootOrder, chromeLogLines, parseJitStats, GUEST_HZ, instructionsPerGuestCycle, laneOf, parsePerfCsv, waitRegionsQuiescent } from "../harness/probes/race-multi.mjs";

test("race-multi: a cyclic Latin square, every arm on every lane equally", () => {
  const seen = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let run = 1; run <= 6; run += 1) {
    const lanes = [0, 1, 2].map((arm) => laneOf(arm, run, 3));
    assert.deepEqual([...lanes].sort(), [0, 1, 2]); // one arm per lane in each run
    lanes.forEach((l, arm) => { seen[arm][l] += 1; });
  }
  assert.deepEqual(seen, [[2, 2, 2], [2, 2, 2], [2, 2, 2]]);
});

test("race-multi: arm effects survive lane differences and run-wide noise", () => {
  // Arm 1 is 3 % faster, arm 2 equal; lane 1 is 2 % slower, lane 2 1 % faster;
  // each run drifts as a whole (load, heat): all of it multiplicative.
  const armF = [1, 1.03, 1], laneF = [1, 0.98, 1.01], runF = [1, 0.97, 1.02, 0.99, 1.04, 0.96];
  const laneIdx = runF.map((_, r) => [0, 1, 2].map((a) => laneOf(a, r + 1, 3)));
  const speeds = runF.map((rf, r) => armF.map((af, a) => 60 * rf * af * laneF[laneIdx[r][a]]));
  const e = armEffects(speeds, laneIdx);
  assert.equal(e.arms[0].laneCorrected, 3);
  assert.equal(e.arms[1].laneCorrected, 0);
  assert.deepEqual(e.lanes, [0, -2, 1]);
  assert.equal(e.residualSd, 0);
  // The raw per-run ratios carry the lanes' differences; their median does not cancel them in general.
  assert.ok(e.arms[0].sd > 1);
});

test("race-multi: perf counts summed over both PMUs, per guest cycle", () => {
  const csv = "# started on Thu Oct 22 10:07:59 2026\n\n<not counted>,,armv8_pmuv3_0/instructions/u,0,0.00,,\n<not counted>,,armv8_pmuv3_0/cycles/u,0,0.00,,\n22921628025,,armv8_pmuv3_1/instructions/u,1468754848,100.00,4.01,insn per cycle\n5714995397,,armv8_pmuv3_1/cycles/u,1468752096,100.00,,\n";
  assert.deepEqual(parsePerfCsv(csv), { instructions: 22921628025, cycles: 5714995397 });
  // 20 s at 50 % speed = 10 emulated seconds = 4.86e9 guest cycles.
  const cold = { speed: 50, windowMs: 20000, counters: { instructions: 2 * 10 * GUEST_HZ } };
  assert.equal(instructionsPerGuestCycle(cold), 2);
  assert.equal(instructionsPerGuestCycle({ speed: 50, windowMs: 20000, counters: { error: "x" } }), null);
});

test("race-multi: boot order rotated too, independently of the lanes", () => {
  const firsts = [0, 0, 0], laneOfFirst = new Set();
  for (let run = 1; run <= 6; run += 1) {
    const order = bootOrder(run, 3);
    assert.deepEqual([...order].sort(), [0, 1, 2]);
    firsts[order[0]] += 1;
    laneOfFirst.add(laneOf(order[0], run, 3));
  }
  assert.deepEqual(firsts, [2, 2, 2]); // each arm boots first twice
  assert.equal(laneOfFirst.size, 3); // the first booted visits every lane
  // Orthogonal for 3 arms: each (lane, boot rank) pair once per 3 runs.
  const pairs = new Set();
  for (let run = 1; run <= 3; run += 1) bootOrder(run, 3).forEach((a, rank) => pairs.add(`${laneOf(a, run, 3)}/${rank}`));
  assert.equal(pairs.size, 9);
});

test("race-multi --aot-seed: the window waits for a quiescent region pipeline", async () => {
  const seq = (states) => { let i = 0; return async () => states[Math.min(i++, states.length - 1)]; };
  const p = (queued, installed, refused = 0, dropped = 0) => ({ queued, installed, refused, dropped, pending: queued - installed - refused - dropped });
  const fast = { everyMs: 0, sleep: async () => {} };
  // Installs still arriving, then stable for 3 reads.
  const g = await waitRegionsQuiescent(seq([p(140, 90), p(140, 130), p(143, 140, 3), p(143, 140, 3), p(143, 140, 3)]), fast);
  assert.equal(g.quiescent, true);
  assert.equal(g.installed, 140);
  assert.equal(g.pending, 0);
  // Pending forever: refused after the timeout, with what was left.
  const stuck = await waitRegionsQuiescent(seq([p(143, 100)]), { ...fast, timeoutMs: -1 });
  assert.equal(stuck.quiescent, false);
  assert.match(stuck.why, /43 pending/);
  // A core without the region pipeline says so.
  assert.equal((await waitRegionsQuiescent(async () => null, fast)).why, "no region pipeline in this core");
});

test("race-multi --aot-seed: the arms open their windows together", async () => {
  const arrive = barrier(3, 1000);
  const order = [];
  const arm = (i, delay) => new Promise((r) => setTimeout(r, delay)).then(arrive).then((all) => order.push([i, all]));
  await Promise.all([arm(0, 30), arm(1, 0), arm(2, 60)]);
  assert.deepEqual(order.map(([, all]) => all), [true, true, true]);
  // An arm that never comes: the others go after the timeout, told so.
  const lone = barrier(2, 20);
  assert.equal(await lone(), false);
});

test("seed profile: copied with its caches, never its locks nor its owner", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "seed-profile-"));
  try {
    const seed = path.join(root, "seed"), dest = path.join(root, "dest");
    mkdirSync(path.join(seed, "Default", "File System"), { recursive: true });
    writeFileSync(path.join(seed, "Default", "File System", "regions.bin"), "cache");
    writeFileSync(path.join(seed, OWNER_FILE), JSON.stringify({ pid: 1 }));
    symlinkSync("spark-5512-123", path.join(seed, "SingletonLock"));
    mkdirSync(dest);
    copySeedProfile(seed, dest);
    assert.equal(readFileSync(path.join(dest, "Default", "File System", "regions.bin"), "utf8"), "cache");
    assert.equal(existsSync(path.join(dest, OWNER_FILE)), false);
    assert.equal(existsSync(path.join(dest, "SingletonLock")), false);
    // The copy can be claimed (2026-10-22: the copied marker made it "already claimed").
    assert.doesNotThrow(() => claim(dest, root, "chrome-profile"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("race-multi --aot-seed: a stable count below the seed's is not done", async () => {
  const seq = (states) => { let i = 0; return async () => states[Math.min(i++, states.length - 1)]; };
  const p = (installed) => ({ queued: 0, installed, refused: 0, dropped: 0, pending: 0 });
  const fast = { everyMs: 0, sleep: async () => {} };
  // 0 installed and stable: done without a target, not with the seed's 143.
  assert.equal((await waitRegionsQuiescent(seq([p(0)]), fast)).quiescent, true);
  const ko = await waitRegionsQuiescent(seq([p(0)]), { ...fast, target: 143, timeoutMs: -1 });
  assert.equal(ko.quiescent, false);
  assert.match(ko.why, /0 installed, 143 expected/);
  assert.equal((await waitRegionsQuiescent(seq([p(100), p(143), p(143), p(143)]), { ...fast, target: 143 })).installed, 143);
});

test("race-multi: the boot's console lines about regions, from chrome.log", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chrome-log-"));
  try {
    writeFileSync(path.join(dir, "chrome.log"), [
      "[1:1:1022/1:INFO:CONSOLE(1)] \"aot: 143 region modules installed before boot\", source: x",
      "[1:1:1022/1:INFO:CONSOLE(2)] \"jit-cache: discio recorded 100 new compiles (cache size=2917)\", source: x",
      "[1:1:1022/1:INFO:CONSOLE(3)] \"unrelated\", source: x",
      "[1:1:1022/1:WARNING:x.cc] aot outside the console"
    ].join("\n"));
    const lines = chromeLogLines(dir);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /143 region modules/);
    assert.deepEqual(chromeLogLines(path.join(dir, "missing")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("race-multi: the JIT's counters from the page's frame info", () => {
  const text = "tier:guarded hotcounts:off jit attempts:4175 compiled:1472 full:1463 partial:9 mixed:0/32768 short:1212/1196 merge:0 regalloc:49 emitfail:0 compilefail:0 enginereject:0 blacklisthit:0 transientreject:3 offthreaddefer:1491 tablefull:0 fmad:0 | imports system:551 | rej19/50:7 reject:33 0 calls";
  const j = parseJitStats(text);
  assert.equal(j.attempts, 4175);
  assert.equal(j.compiled, 1472);
  assert.equal(j.transientreject, 3);
  assert.equal(j.blacklisthit, 0);
  assert.equal(j.offthreaddefer, 1491);
  assert.equal(j.reject, 33);
  assert.equal(j.system, undefined); // past the JIT's own segment
  assert.deepEqual(parseJitStats(null), {});
});

test("race-multi: a run where an arm lacks some of its seeded regions is discarded", async () => {
  const { discardReason } = await import("../harness/probes/race-multi.mjs");
  const ok = { installed: 143, layoutRefused: 0, quiescent: true };
  assert.equal(discardReason([{ regionGate: ok }, { regionGate: ok }], [143, 143]), null);
  assert.equal(discardReason([{ regionGate: ok }, { regionGate: { installed: 0, layoutRefused: 143, quiescent: false, why: "0 installed, 143 expected" } }], [143, 143]),
    "layoutRefused on arm 1 (143)");
  assert.match(discardReason([{ regionGate: { ...ok, installed: 140 } }, { regionGate: ok }], [143, 143]), /arm 0 installed 140 of 143/);
  assert.match(discardReason([{ regionGate: null }, { regionGate: ok }], [143, 143]), /no region gate on arm 0/);
  assert.match(discardReason([{ regionGate: { ...ok, quiescent: false, why: "still compiling" } }], [null]), /arm 0: still compiling/);
});
