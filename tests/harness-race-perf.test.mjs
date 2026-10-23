// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquirePerfLock, lockIntegrity, queueDir, readLockOwner, ticketsAhead } from "../harness/lib/perf-lock.mjs";
import { chromeArgsOf, guestCovered, lockOverlapAt, num, pairedSpeedChange, regionPipeline, sideOrder, withheldOnOverlap } from "../harness/probes/race-perf.mjs";
import { stockChrome } from "../harness/lib/kpi.mjs";
import { calmThenLock, loadGaveUp } from "../harness/lib/env.mjs";
import { summarizePcSamples } from "../src/harness-pc-sampler.js";
import { hitchList, HITCH_MS } from "../harness/lib/timeline.mjs";

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

test("perf lock: first come, first served, whoever polls faster", async (t) => {
  const dir = lockDir(t);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "owner"), "another agent\n");
  // A arrives first and polls slowly (it moves only when told); B arrives
  // second and polls every few milliseconds.
  let wakeA;
  const order = [];
  const a = acquirePerfLock({ dir, name: "A", waitSec: 60, sleep: () => new Promise((r) => (wakeA = r)) }).then((rel) => { order.push("A"); return rel; });
  await new Promise((r) => setTimeout(r, 5));
  const b = acquirePerfLock({ dir, name: "B", waitSec: 60, sleep: (ms) => new Promise((r) => setTimeout(r, 2)) }).then((rel) => { order.push("B"); return rel; });
  rmSync(dir, { recursive: true });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(order, [], "B waits behind A although the lock is free");
  assert.equal(existsSync(dir), false);
  wakeA();
  const releaseA = await a;
  assert.equal(readLockOwner(dir).name, "A");
  releaseA();
  const releaseB = await b;
  assert.deepEqual(order, ["A", "B"]);
  releaseB();
  assert.equal(existsSync(queueDir(dir)), false, "no ticket left, nor the queue");
});

test("perf lock: a ticket of a gone process never blocks; a contender that gives up leaves none", async (t) => {
  const dir = lockDir(t);
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => dead.on("exit", r));
  mkdirSync(queueDir(dir));
  writeFileSync(path.join(queueDir(dir), `${Date.now() - 1000}-${dead.pid}-abcd`), JSON.stringify({ name: "killed run", pid: dead.pid, host: os.hostname() }));
  const release = await acquirePerfLock({ dir, name: "test", waitSec: 0, sleep: async () => {} });
  assert.equal(readLockOwner(dir).pid, process.pid);
  assert.equal(existsSync(queueDir(dir)), false);
  mkdirSync(queueDir(dir));
  // A live contender ahead: refused at the deadline, with who is ahead, and no ticket left.
  writeFileSync(path.join(queueDir(dir), `${Date.now() - 1000}-${process.pid}-beef`), JSON.stringify({ name: "earlier run", pid: process.pid, host: os.hostname() }));
  release();
  await assert.rejects(acquirePerfLock({ dir, name: "late", waitSec: 0, sleep: async () => {} }), /1 contender\(s\) arrived first.*earlier run/);
  assert.deepEqual(readdirSync(queueDir(dir)).map((n) => n.endsWith("-beef")), [true], "only the earlier ticket stays");
  assert.equal(ticketsAhead(dir, `${Date.now()}-1-ffff`).length, 1);
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
    // A coreid on both sides (no --baseline-query) or on the baseline side is refused.
    assert.match(run(["--query", "core=upstream&coreid=sha256:" + "a".repeat(64)]), /a coreid in --query needs a --baseline-query without it/);
    assert.match(run(["--max-load", "abc"]), /--max-load abc/);
    assert.match(run(["--baseline-query", "core=upstream&coreid=sha256:" + "a".repeat(64)]), /no coreid in --baseline-query/);
    // Only on the candidate side: accepted (a lever's PR core against trunk's);
    // an invalid --max-load stops it right after, so no run starts.
    const ok = run(["--runs", "2", "--query", "core=upstream&coreid=sha256:" + "a".repeat(64), "--baseline-query", "core=upstream", "--max-load", "abc"]);
    assert.match(ok, /--max-load abc/);
    assert.doesNotMatch(ok, /coreid/);
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
  assert.deepEqual(readdirSync(path.dirname(dir)).filter((n) => n.includes("stale") || n.includes(".new-") || n.includes(".takeover") || n.includes(".released-")), []);
});

test("perf lock: a takeover guard left by a dead harness is abandoned once old", async (t) => {
  const dir = lockDir(t);
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => dead.on("exit", r));
  mkdirSync(dir);
  writeFileSync(path.join(dir, "owner"), JSON.stringify({ name: "crashed run", pid: dead.pid, host: os.hostname(), harness: true }));
  mkdirSync(`${dir}.takeover`); // its taker died mid-takeover
  // Fresh guard: somebody is taking over, so wait.
  await assert.rejects(acquirePerfLock({ dir, name: "test", waitSec: 0, sleep: async () => {} }), /still held by/);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${dir}.takeover`, old, old);
  const release = await acquirePerfLock({ dir, name: "test", waitSec: 5, pollSec: 0.01 });
  assert.equal(readLockOwner(dir).name, "test");
  release();
  assert.deepEqual(readdirSync(path.dirname(dir)), []);
});

test("perf lock: leftovers of a killed step are swept once old, young ones kept", async (t) => {
  const dir = lockDir(t);
  const parent = path.dirname(dir);
  const old = new Date(Date.now() - 120_000);
  for (const n of [".perf-lock.stale-1-aa", ".perf-lock.released-1-bb", ".perf-lock.takeover.takeover-done-1-cc"]) {
    mkdirSync(path.join(parent, n));
    utimesSync(path.join(parent, n), old, old);
  }
  mkdirSync(path.join(parent, ".perf-lock.stale-2-young")); // a takeover right now
  const release = await acquirePerfLock({ dir, name: "test", waitSec: 0 });
  assert.deepEqual(readdirSync(parent).sort(), [".perf-lock", ".perf-lock.stale-2-young"]);
  release();
});

// Older checkouts keep running during the transition: their protocol (mkdir,
// then the owner written in place; released by emptying the directory in
// place) and this one must exclude each other (review of #47: publishing by
// rename onto an empty directory gave two holders).
test("perf lock: older and current harnesses exclude each other", async (t) => {
  const dir = lockDir(t);
  const holding = path.join(path.dirname(dir), "holding");
  const lockLib = path.resolve(import.meta.dirname, "../harness/lib/perf-lock.mjs");
  const hold = `try { writeFileSync(${JSON.stringify(holding)}, "x", { flag: "wx" }); } catch { console.log("OVERLAP"); process.exit(2); }
      await new Promise((r) => setTimeout(r, 2)); rmSync(${JSON.stringify(holding)});`;
  const current = `import { acquirePerfLock } from ${JSON.stringify(lockLib)}; import { writeFileSync, rmSync } from "node:fs";
    for (let i = 0; i < 15; i++) {
      const release = await acquirePerfLock({ dir: ${JSON.stringify(dir)}, name: "new", waitSec: 120, pollSec: 0.005 });
      ${hold}
      release();
    }
    console.log("ok");`;
  const older = `import { mkdirSync, writeFileSync, rmSync } from "node:fs";
    for (let i = 0; i < 15; i++) {
      for (;;) { try { mkdirSync(${JSON.stringify(dir)}); break; } catch (e) { if (e.code !== "EEXIST") throw e; await new Promise((r) => setTimeout(r, 5)); } }
      writeFileSync(${JSON.stringify(path.join(dir, "owner"))}, JSON.stringify({ name: "old", pid: process.pid, harness: true }));
      ${hold}
      rmSync(${JSON.stringify(dir)}, { recursive: true, force: true });
    }
    console.log("ok");`;
  const run = (script) => new Promise((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code) => resolve(`${code}:${out.trim()}${code ? ` ${err.split("\n")[0]}` : ""}`));
  });
  const outs = await Promise.all([...Array(4).fill(current), ...Array(4).fill(older)].map(run));
  assert.deepEqual(outs, Array(8).fill("0:ok"));
  assert.equal(existsSync(dir), false);
});

// Review of #47 (round 2): with older harnesses AND holders killed (stale
// locks to take over), a takeover could move a live lock and abort, or a
// contender wait on its own lock.
// Holds of the perf lock in time order, from `ms pid kind take|release`
// lines, and the overlaps among them (a take while another holder had not
// released): what a failure of the test below needs to be read.
function lockTimeline(text) {
  const events = text.split("\n").filter(Boolean).map((l) => { const [ms, pid, kind, what] = l.split(" "); return { ms: Number(ms), pid, kind, what }; }).sort((a, b) => a.ms - b.ms);
  const overlaps = [];
  let holder = null;
  for (const e of events) {
    if (e.what === "take") { if (holder) overlaps.push({ ms: e.ms, holder: `${holder.kind} ${holder.pid}`, taker: `${e.kind} ${e.pid}` }); holder = e; }
    else if (holder?.pid === e.pid) holder = null;
  }
  return { events, overlaps };
}

test("perf lock: the timeline of holds finds an overlap", () => {
  const t = lockTimeline("10 1 current take\n12 1 current release\n13 2 older take\n14 3 current take\n15 2 older release\n");
  assert.deepEqual(t.overlaps, [{ ms: 14, holder: "older 2", taker: "current 3" }]);
  assert.equal(lockTimeline("1 1 a take\n2 1 a release\n3 2 b take\n4 2 b release\n").overlaps.length, 0);
});

test("perf lock: older and current harnesses with holders killed mid-hold", async (t) => {
  const dir = lockDir(t);
  const holding = path.join(path.dirname(dir), "holding");
  // Every take and release, with its time, for the diagnosis on failure.
  const timeline = path.join(path.dirname(dir), "timeline");
  const lockLib = path.resolve(import.meta.dirname, "../harness/lib/perf-lock.mjs");
  const mark = (what) => `appendFileSync(${JSON.stringify(timeline)}, \`\${Date.now()} \${process.pid} \${KIND} ${what}\\n\`);`;
  const hold = `${mark("take")} try { writeFileSync(${JSON.stringify(holding)}, "x", { flag: "wx" }); } catch { console.log("OVERLAP"); process.exit(2); }
      await new Promise((r) => setTimeout(r, 2)); rmSync(${JSON.stringify(holding)}); ${mark("release")}`;
  const take = { current: `const release = await acquirePerfLock({ dir: ${JSON.stringify(dir)}, name: "new", waitSec: 120, pollSec: 0.005, orphanSec: 1 });`,
    older: `for (;;) { try { mkdirSync(${JSON.stringify(dir)}); break; } catch (e) { if (e.code !== "EEXIST") throw e; await new Promise((r) => setTimeout(r, 5)); } }
      writeFileSync(${JSON.stringify(path.join(dir, "owner"))}, JSON.stringify({ name: "old", pid: process.pid, host: ${JSON.stringify(os.hostname())}, harness: true, nonce: String(Math.random()) }));
      const release = () => rmSync(${JSON.stringify(dir)}, { recursive: true, force: true });` };
  const head = (kind) => `import { acquirePerfLock } from ${JSON.stringify(lockLib)}; import { appendFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs"; const KIND = ${JSON.stringify(kind)};`;
  const worker = (kind) => `${head(kind)} for (let i = 0; i < 12; i++) { ${take[kind]} ${hold} release(); } console.log("ok");`;
  // A holder that never lets go: killed (SIGKILL) once it holds, its lock left stale.
  const dying = (kind) => `${head(`${kind}-dying`)} ${take[kind]} ${mark("take")} console.log("held"); setInterval(() => {}, 1000);`;
  const run = (script, { killOnHeld = false } = {}) => new Promise((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    // A holder killed mid-hold leaves a stale lock: its hold ends at the kill.
    c.stdout.on("data", (d) => { out += d; if (killOnHeld && out.includes("held") && !c.killed) { appendFileSync(timeline, `${Date.now()} ${c.pid} killed release\n`); c.kill("SIGKILL"); } });
    c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code, signal) => resolve(signal ? `killed:${out.trim()}` : `${code}:${out.trim()}${code ? ` ${err.split("\n")[0]}` : ""}`));
  });
  const workers = [...Array(4).fill("current"), ...Array(4).fill("older")].map((k) => run(worker(k)));
  // Older harnesses here never take a stale lock over (the real ones do,
  // unguarded, with races of their own, out of this test): a current harness
  // passing by does, as on the machine, until every other contender is done
  // (else the last stale lock is never taken over and the test hangs).
  const dyings = (async () => {
    const killed = [];
    for (const kind of ["current", "older", "current", "older"]) {
      await new Promise((r) => setTimeout(r, 40));
      killed.push(await run(dying(kind), { killOnHeld: true }));
    }
    return killed;
  })();
  let done = false;
  const all = Promise.all([Promise.all(workers), dyings]).finally(() => { done = true; });
  const janitor = (async () => { while (!done) { await run(`${head("janitor")} ${take.current} ${mark("take")} release(); ${mark("release")} console.log("ok");`); await new Promise((r) => setTimeout(r, 100)); } })();
  const [results, killed] = await all;
  await janitor;
  // Failed once in ~83 runs under heavy load (2026-10-22) without saying
  // why: on failure, everything needed to tell a tight limit from a real
  // overlap goes to stderr.
  try {
    assert.deepEqual(killed, Array(4).fill("killed:held"));
    assert.deepEqual(results, Array(8).fill("0:ok"));
  } catch (error) {
    const tl = lockTimeline(existsSync(timeline) ? readFileSync(timeline, "utf8") : "");
    console.error(`[perf lock test] workers (code:out): ${JSON.stringify(results)}`);
    console.error(`[perf lock test] killed holders: ${JSON.stringify(killed)}`);
    console.error(`[perf lock test] overlaps in the timeline: ${JSON.stringify(tl.overlaps)}`);
    console.error(`[perf lock test] timeline (ms pid kind take|release), last 60:\n${tl.events.slice(-60).map((e) => `${e.ms} ${e.pid} ${e.kind} ${e.what}`).join("\n")}`);
    throw error;
  }
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

test("race-perf hitch list: where each hitch is, in the window and in the scene", () => {
  // Presents every 16.7 ms, with hitches of 50 and 100 ms; VI outputs since
  // boot are 1000 + VI since the savestate load.
  const presents = [];
  let t = 10_000, vi = 1200;
  for (let i = 0; i < 30; i += 1) {
    t += i === 10 ? 50 : i === 20 ? 100 : 1000 / 60;
    vi += 1;
    presents.push({ t, vi });
  }
  const timeline = { presents, vi: [{ t: 10_000, ticks: 0, sinceBoot: 1200, sinceLoad: 200 }] };
  const h = hitchList(timeline, { origin: 10_000 });
  assert.equal(h.count, 2);
  assert.equal(h.truncated, false);
  assert.deepEqual(h.hitches.map(([, ms]) => ms), [50, 100]);
  assert.deepEqual(h.hitches.map(([, , place]) => place), [211, 221]); // the same place on a slower side
  assert.ok(h.hitches[0][0] > 0 && h.hitches[1][0] > h.hitches[0][0]);
  // Capped: the longest kept, in time order; the count says how many there were.
  const many = { presents: Array.from({ length: 401 }, (_, i) => ({ t: i * 40 + (i % 2 ? 5 : 0), vi: -1 })), vi: [] };
  const capped = hitchList(many, { origin: 0, cap: 200 });
  assert.equal(capped.count, 400);
  assert.equal(capped.truncated, true);
  assert.equal(capped.hitches.length, 200);
  assert.ok(capped.hitches.every(([, ms]) => ms === 45)); // the longer half (45 ms), not the 35 ms ones
  assert.ok(capped.hitches.every(([at], i, a) => i === 0 || at > a[i - 1][0]));
  assert.ok(capped.hitches.every(([, , place]) => place === null)); // no VI timeline: no place
  assert.ok(HITCH_MS > 1000 / 60 && HITCH_MS < 35);
});

test("race-perf Chromium flags per side: plain extra flags only, never stock Chrome for the KPIs", () => {
  assert.deepEqual(chromeArgsOf("--js-flags=--no-liftoff  --enable-features=X", "chrome-args"), ["--js-flags=--no-liftoff", "--enable-features=X"]);
  assert.deepEqual(chromeArgsOf(undefined, "chrome-args"), []);
  for (const bad of ["--headless=new", "--user-data-dir=/tmp/x", "--remote-debugging-port=9", "js-flags", "--a b"]) assert.throws(() => chromeArgsOf(bad, "chrome-args"), /not an extra Chromium flag/, bad);
  assert.equal(stockChrome({ chrome: { path: "chrome stable", args: "" } }), true);
  assert.equal(stockChrome({ chrome: { path: "chrome stable", args: "", sideArgs: { baseline: "--js-flags=--no-liftoff" } } }), false);
});

test("load: a calm machine before the lock, never the lock held while waiting on the load", async () => {
  let locked = 0;
  const acquire = async () => { locked += 1; return () => {}; };
  // Calm: the lock is taken after the wait.
  const order = [];
  await calmThenLock({ maxLoad: 6, calmWait: 60, acquire: async () => { order.push("lock"); return acquire(); }, wait: async ({ waitSec, pollSec }) => { order.push(`wait ${waitSec} s, poll ${pollSec} s`); return { load: 3, limit: 6, ok: true }; } });
  assert.deepEqual(order, ["wait 60 s, poll 30 s", "lock"]);
  // Never calm: refused, the lock never asked for.
  locked = 0;
  await assert.rejects(calmThenLock({ maxLoad: 6, calmWait: 600, acquire, wait: async () => ({ load: 25.3, limit: 6, ok: false }) }), /machine not calm: load 25.3 > 6 after 600 s; no lock taken/);
  assert.equal(locked, 0);
  // Under the lock: a gate that did not open gives the remaining runs up.
  assert.equal(loadGaveUp({ load: 3, limit: 6, ok: true }), null);
  assert.equal(loadGaveUp(undefined), null);
  assert.match(loadGaveUp({ load: 9.1, limit: 6, ok: false }), /load 9.1 > 6 after --load-wait: remaining runs given up, lock released/);
});

test("perf lock: a holder knows when it is not alone (overlap guard)", async (t) => {
  const dir = lockDir(t);
  const release = await acquirePerfLock({ dir, name: "test", waitSec: 0 });
  try {
    assert.deepEqual(release.check(), { ok: true });
    const me = readLockOwner(dir);
    // A live lock moved aside by a takeover: its holder (alive) still measures.
    const aside = `${dir}.stale-${Date.now()}-1-ab`;
    mkdirSync(aside);
    writeFileSync(path.join(aside, "owner"), JSON.stringify({ name: "other", pid: process.ppid, host: os.hostname(), harness: true, nonce: "x" }));
    assert.match(release.check().why, /another living holder: other/);
    // The same with a holder that is gone: no overlap.
    writeFileSync(path.join(aside, "owner"), JSON.stringify({ name: "gone", pid: 2 ** 22 + 99, host: os.hostname(), harness: true, nonce: "y" }));
    assert.deepEqual(release.check(), { ok: true });
    // Our lock replaced under us.
    writeFileSync(path.join(dir, "owner"), JSON.stringify({ ...me, nonce: "someone-else", name: "intruder" }));
    assert.match(lockIntegrity(dir, me).why, /held by intruder/);
  } finally {
    writeFileSync(path.join(dir, "owner"), JSON.stringify(readLockOwner(dir)));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("race-perf: a change measured during a lock overlap is withheld", () => {
  const change = { pairs: 4, median: 3.1, withheld: null, perRun: [3, 3.2, 3.1, 3] };
  assert.equal(withheldOnOverlap(change, []), change);
  const w = withheldOnOverlap(change, [{ at: "before run 3", why: "another living holder: x (pid 9)" }]);
  assert.equal(w.median, null);
  assert.match(w.withheld, /perf lock overlap: before run 3: another living holder/);
});

// A page whose core runs `rate` ticks per node ms from `start`; pause and
// resume are counted, everything else answered as the core would.
function fakeCorePage({ rate = 1000, start = 5000, perSecond = 486_000_000 } = {}) {
  const t0 = Date.now(), calls = [];
  return {
    calls,
    evaluate: async (_fn, [type]) => {
      calls.push(type);
      if (type === "validationReadCoreProgress") return { coreTicks: start + Math.floor((Date.now() - t0) * rate), coreTicksPerSecond: perSecond };
      return { ok: true };
    }
  };
}

test("emulated window: covers at least S guest seconds after W, from a paused key press", async () => {
  const { emulatedStart } = await import("../harness/lib/emulated-window.mjs");
  // 1000 ticks per ms and 10 000 ticks per guest second: 10 ms per guest second.
  const page = fakeCorePage({ rate: 1000, perSecond: 10_000 });
  const order = [];
  const run = await emulatedStart(page, { warmup: 2, pollMs: 5, press: async () => order.push(page.calls.at(-1)) });
  assert.deepEqual(order, ["pause"], "the key goes down while the core is paused");
  assert.ok(page.calls.includes("resume"));
  const fractions = [];
  const r = await run.window(3, { poll: (_t, f) => fractions.push(f) });
  assert.ok(r.guestTicksStart - run.t0.ticks >= 20_000, "warmup of 2 guest seconds");
  assert.equal(r.guestTicks, r.guestTicksEnd - r.guestTicksStart);
  assert.ok(r.guestTicks >= 30_000 && r.overshootTicks >= 0);
  assert.equal(r.guestSecondsCovered, r.guestTicks / 10_000);
  assert.ok(fractions.at(-1) >= 1 && fractions.length >= 2);
  assert.deepEqual(r.emulatedWindow, { secs: 3, warmup: 2, pollMs: 5, polls: fractions.length });
});

test("emulated window: speed is guest seconds over host seconds; a core without ticks is refused", async () => {
  const { emulatedRecord, emulatedStart } = await import("../harness/lib/emulated-window.mjs");
  const r = emulatedRecord({
    t0: { ticks: 0, perSecond: 486e6 }, begin: { ticks: 486e6, at: 1000 }, end: { ticks: 486e6 * 6 + 100, at: 11000, polls: 99 },
    target: 486e6 * 6, secs: 5, warmup: 1, pollMs: 100
  });
  assert.equal(r.overshootTicks, 100);
  assert.equal(r.hostMs, 10000);
  assert.equal(r.speed, 50);
  assert.equal(r.warmupTicks, 486e6);
  const dead = { evaluate: async (_fn, [type]) => (type === "validationReadCoreProgress" ? { error: "Unknown upstream worker message" } : { ok: true }) };
  await assert.rejects(emulatedStart(dead, { warmup: 1 }), /no guest ticks/);
});

test("emulated window: counters are divided by the ticks covered when known", async () => {
  const { instructionsPerGuestCycle } = await import("../harness/lib/perf-counters.mjs");
  assert.equal(instructionsPerGuestCycle({ counters: { instructions: 4e9 }, guestTicks: 1e8, speed: 50, windowMs: 1 }), 40);
  assert.equal(instructionsPerGuestCycle({ counters: { instructions: 486e6 }, speed: 100, windowMs: 1000 }), 1);
});

// 2026-10-22: a launch on a loaded machine ran without its region cache, every
// module set aside by the engine for another heap layout before the core saw
// it. The counters are read whatever the options, so the run says so.
test("race-perf: the region pipeline counters of a stats reply", () => {
  assert.deepEqual(regionPipeline({ layoutRefused: 143, heapPatched: 0, heapPatchedBytes: 0, heapPatchFailed: 0 }),
    { layoutRefused: 143, heapPatched: 0, heapPatchedBytes: 0, heapPatchFailed: 0 });
  assert.deepEqual(regionPipeline({ layoutRefused: 0 }), { layoutRefused: 0 }, "an engine before 0084: no heap counters");
  assert.deepEqual(regionPipeline({}), {}, "an engine before 0078");
});

test("race-perf: the guest time a host-time window covered", () => {
  assert.deepEqual(guestCovered(1000, 486001000, 486000000), { ticks: 486000000, seconds: 1 });
  assert.deepEqual(guestCovered("0", "972000000", 486000000), { ticks: 972000000, seconds: 2 });
  assert.equal(guestCovered(null, 5, 486000000), null);
  assert.equal(guestCovered(10, 5, 486000000), null);
  assert.equal(guestCovered(1, 5, 0), null);
});

test("load under the lock: a loaded machine gives the lock back while waiting, then takes it again in turn", async () => {
  const { calmUnderLock } = await import("../harness/lib/env.mjs");
  const events = [];
  const lock = () => events.push("release");
  const acquire = async () => { events.push("acquire"); return () => events.push("release2"); };
  const wait = async () => { events.push("wait"); return { load: 1, limit: 4, ok: true }; };
  // Calm: the lock is kept, nothing waited for.
  const calm = await calmUnderLock({ lock, maxLoad: 4, waitSec: 300, acquire, wait, load: () => 2 });
  assert.equal(calm.lock, lock);
  assert.equal(calm.relocked, false);
  assert.deepEqual(events, []);
  // Loaded: released BEFORE the wait, taken again after it.
  const loaded = await calmUnderLock({ lock, maxLoad: 4, waitSec: 300, acquire, wait, load: () => 9 });
  assert.deepEqual(events, ["release", "wait", "acquire"]);
  assert.equal(loaded.relocked, true);
  assert.notEqual(loaded.lock, lock);
  // Never calm: released, not taken again, given up with no lock held.
  events.length = 0;
  const never = await calmUnderLock({ lock, maxLoad: 4, waitSec: 300, acquire, wait: async () => ({ load: 9, limit: 4, ok: false }), load: () => 9 });
  assert.deepEqual(events, ["release"]);
  assert.equal(never.lock, null);
  assert.match(loadGaveUp(never.gate), /given up, lock released/);
});

test("calmLock: every probe's load gate gives the lock back while waiting; --no-lock only waits", async () => {
  const { calmLock } = await import("../harness/lib/env.mjs");
  const events = [];
  let n = 0;
  const acquire = async () => { const id = ++n; events.push(`acquire${id}`); const r = () => events.push(`release${id}`); return r; };
  const wait = async ({ waitSec }) => { events.push(`wait${waitSec}`); return { load: 1, limit: 4, ok: true }; };
  let load = 1;
  const lock = await calmLock({ maxLoad: 4, calmWait: 7, acquire, wait, load: () => load });
  assert.deepEqual(events, ["wait7", "acquire1"], "calm first, then the lock");
  assert.equal((await lock.waitCalmUnlocked({ waitSec: 300 })).relocked, false);
  load = 9;
  const g = await lock.waitCalmUnlocked({ waitSec: 300 });
  assert.equal(g.relocked, true);
  assert.deepEqual(events.slice(2), ["release1", "wait300", "acquire2"], "released before the wait, taken again after");
  lock.release();
  lock.release();
  assert.deepEqual(events.slice(5), ["release2"], "release lets go of the lock held now, once");
  const none = await calmLock({ maxLoad: 4, calmWait: 7, acquire: null, wait });
  events.length = 0;
  assert.equal((await none.waitCalmUnlocked({ waitSec: 5 })).ok, true);
  assert.deepEqual(events, ["wait5"]);
});

test("calmLock: no probe waits for the load on its own any more (the pattern does not come back)", () => {
  const dir = path.join(import.meta.dirname, "..", "harness");
  const files = ["probes/race-perf.mjs", "probes/ttff.mjs", "probes/ax-hle.mjs", "probes/first-launch.mjs", "cli.mjs"];
  for (const f of files) {
    const src = readFileSync(path.join(dir, f), "utf8");
    const direct = src.split("\n").filter((l) => /\bwaitForLoad\(/.test(l) && !/abLock \?/.test(l));
    assert.deepEqual(direct, [], `${f} calls waitForLoad outside calmLock / calmUnderLock`);
  }
});

test("load give-up after --load-wait: no lock held, the lock checks pass cleanly (no TypeError)", async () => {
  const { calmUnderLock } = await import("../harness/lib/env.mjs");
  let released = 0;
  const held = Object.assign(() => { released += 1; }, { check: () => ({ ok: true }) });
  // The loop's give-up: loaded for the whole --load-wait, the lock goes back and is not taken again.
  const g = await calmUnderLock({ lock: held, maxLoad: 4, waitSec: 1, acquire: async () => assert.fail("never taken again"), wait: async () => ({ load: 9, limit: 4, ok: false }), load: () => 9 });
  assert.equal(g.lock, null);
  assert.equal(released, 1);
  // What race-perf then does: checkLock("end") and the final release on the lock it holds (none).
  assert.equal(lockOverlapAt(g.lock, "end"), null);
  assert.doesNotThrow(() => g.lock?.());
  // A held lock still reports an overlap.
  assert.deepEqual(lockOverlapAt(Object.assign(() => {}, { check: () => ({ ok: false, why: "another holder" }) }), "before run 2"), { at: "before run 2", why: "another holder" });
  assert.equal(lockOverlapAt(Object.assign(() => {}, { check: () => ({ ok: true }) }), "x"), null);
});

test("ab: load > max-load at the start of a run → release, calm wait, retake, no exception (even after a give-up)", async () => {
  const { calmLock, calmUnderLock } = await import("../harness/lib/env.mjs");
  const events = [];
  let n = 0;
  const acquire = async () => { const id = ++n; events.push(`acquire${id}`); return Object.assign(() => events.push(`release${id}`), { check: () => ({ ok: true }) }); };
  let calmAfterWait = true;
  const wait = async () => { events.push("wait"); return calmAfterWait ? { load: 1, limit: 4, ok: true } : { load: 9, limit: 4, ok: false }; };
  let load = 1;
  const lock = await calmLock({ maxLoad: 4, calmWait: 60, acquire, wait, load: () => load, retakeOnGiveUp: true });
  events.length = 0;
  // Loaded at the start of a run, calm within the wait: released, waited, retaken.
  load = 9;
  assert.equal((await lock.waitCalmUnlocked({ waitSec: 60 })).ok, true);
  assert.deepEqual(events, ["release1", "wait", "acquire2"]);
  // Loaded and never calm (the 2026-10-22 crash): released, waited, and taken again anyway for the cell.
  events.length = 0;
  calmAfterWait = false;
  const gaveUp = await lock.waitCalmUnlocked({ waitSec: 60 });
  assert.equal(gaveUp.ok, false);
  assert.deepEqual(events, ["release2", "wait", "acquire3"]);
  // The next run, loaded again: no TypeError, the lock it holds goes back.
  events.length = 0;
  await assert.doesNotReject(lock.waitCalmUnlocked({ waitSec: 60 }));
  assert.deepEqual(events, ["release3", "wait", "acquire4"]);
  lock.release();
  assert.deepEqual(events.slice(-1), ["release4"]);
  // Without retake (ttff, ax-hle, first-launch stop on a give-up), a later gate with no lock held
  // never calls null: calm, it takes the lock; loaded, it waits first.
  events.length = 0;
  const calm = await calmUnderLock({ lock: null, maxLoad: 4, waitSec: 1, acquire, wait, load: () => 1 });
  assert.equal(calm.relocked, true);
  assert.deepEqual(events, ["acquire5"]);
  events.length = 0;
  calmAfterWait = true;
  await assert.doesNotReject(calmUnderLock({ lock: null, maxLoad: 4, waitSec: 1, acquire, wait, load: () => 9 }));
  assert.deepEqual(events, ["wait", "acquire6"]);
});

test("race-perf: pairs on the warm windows and on cycles per guest cycle", () => {
  const run = (n, b, c) => ({ run: n, baseline: { cold: { speed: 50, cyclesPerGuestCycle: b }, warm: { speed: b * 5 } }, candidate: { cold: { speed: 50, cyclesPerGuestCycle: c }, warm: { speed: c * 5 } } });
  const runs = [run(1, 10, 11), run(2, 10, 11), run(3, 10, 11), run(4, 10, 11)];
  assert.equal(pairedSpeedChange(runs, { metric: "cyclesPerGuestCycle" }).median, 10);
  assert.equal(pairedSpeedChange(runs, { phase: "warm" }).median, 10);
  assert.equal(pairedSpeedChange(runs).median, 0, "cold speed by default");
});
