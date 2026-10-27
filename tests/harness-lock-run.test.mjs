// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";

import { descendantsOf, reap, runLocked } from "../harness/lib/lock-run.mjs";

test("descendantsOf: the whole tree under a pid, not the pid itself nor its siblings", () => {
  const rows = [[10, 1], [11, 10], [12, 11], [13, 11], [20, 1], [21, 20]];
  assert.deepEqual(descendantsOf(rows, 10).sort(), [11, 12, 13]);
  assert.deepEqual(descendantsOf(rows, 99), []);
});

test("reap: waits, then SIGTERM, then SIGKILL, and says what is left", async () => {
  const live = new Map([[1, "t1"], [2, "t2"], [3, "t3"]]);
  const sent = [];
  const left = await reap(new Map(live), {
    graceMs: 0, killWaitMs: 0, stepMs: 0, sleep: async () => {},
    started: () => new Map(live),
    kill: (p, sig) => { sent.push(`${sig} ${p}`); if (sig === "SIGTERM" && p !== 3) live.delete(p); if (sig === "SIGKILL") live.delete(p); }
  });
  assert.deepEqual(left, []);
  assert.deepEqual(sent, ["SIGTERM 1", "SIGTERM 2", "SIGTERM 3", "SIGKILL 3"]);
});

// Review of #307: a pid seen during the run, gone, then given to another
// process (another start time) is never signalled nor waited for.
test("reap: a pid reused by another process is left alone", async () => {
  const now = new Map([[1, "later"], [2, "t2"]]); // pid 1 now belongs to someone else
  const sent = [];
  let waits = 0;
  const left = await reap(new Map([[1, "t1"], [2, "t2"]]), {
    graceMs: 0, killWaitMs: 0, stepMs: 0, sleep: async () => { waits += 1; },
    started: () => new Map(now),
    kill: (p, sig) => { sent.push(`${sig} ${p}`); now.delete(p); }
  });
  assert.deepEqual(sent, ["SIGTERM 2"], "only the run's own process");
  assert.deepEqual(left, []);
});

// 2026-10-27 16:11: a locked e2e gave the lock back while its Chromes still
// ran. A command that starts a detached grandchild (its own process group, as
// Playwright starts Chrome) and exits: the grandchild is gone before release.
test("runLocked: a detached grandchild left by the command is gone before the lock goes back", async () => {
  const script = `
    const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    g.unref();
    console.log("grandchild " + g.pid);
    setTimeout(() => process.exit(0), 1500);`;
  let grandchild = null, aliveAtRelease = null;
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const acquire = async () => () => { aliveAtRelease = grandchild != null && isAlive(grandchild); };
  const code = await runLocked({
    name: "test", cmd: process.execPath, args: ["-e", script], acquire, watchMs: 100, graceMs: 300, killWaitMs: 1000,
    log: (m) => { const p = /still alive \((\d+)/.exec(m); if (p) grandchild = Number(p[1]); }
  });
  assert.equal(code, 0);
  assert.ok(grandchild, "the grandchild was seen and had to be killed");
  assert.equal(aliveAtRelease, false, "gone when the lock went back");
});

// Re-review of #307.
test("descendantsOf: from several roots (the command and its processes still alive)", () => {
  // 30 was the command's child, its parent died: launchd (1) adopted it; 31 is its child
  const rows = [[10, 1], [11, 10], [30, 1], [31, 30], [40, 1]];
  assert.deepEqual(descendantsOf(rows, [10, 30]).sort(), [11, 31]);
});

test("reap: ps unavailable is never 'all gone': nothing signalled, everything reported left", async () => {
  const sent = [];
  const left = await reap(new Map([[5, "t5"], [6, "t6"]]), { graceMs: 0, killWaitMs: 0, stepMs: 0, sleep: async () => {}, started: () => null, kill: (p, s) => sent.push(`${s} ${p}`) });
  assert.deepEqual(sent, []);
  assert.deepEqual(left.sort(), [5, 6]);
});

test("runLocked: a command not found exits 127; one killed by a signal exits 128 + n", async () => {
  const acquire = async () => () => {};
  assert.equal(await runLocked({ name: "t", cmd: "/no/such/command-xyz", acquire, graceMs: 0 }), 127);
  assert.equal(await runLocked({ name: "t", cmd: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGKILL')"], acquire, graceMs: 0 }), 137);
});

// SIGTERM on the wrapper: the command's processes reaped, then the lock
// released, exit 143 (before, the lock went back and sh/sleep survived).
test("lock-run CLI: SIGTERM reaps the command's processes, then releases the lock, exit 143", async (t) => {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = mkdtempSync(path.join(os.tmpdir(), "lockrun-sig-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockDir = path.join(root, ".perf-lock");
  const cli = new URL("../harness/lib/lock-run.mjs", import.meta.url).pathname;
  const w = spawn(process.execPath, [cli, "--name", "sig-test", "--", "sh", "-c", "sleep 40 & sleep 40"], { env: { ...process.env, HARNESS_PERF_LOCK: lockDir }, stdio: "ignore" });
  const until = async (ok, ms) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); return ok(); };
  assert.ok(await until(() => existsSync(lockDir), 10000), "the lock is held");
  // its sh and the two sleeps, seen by the wrapper's watcher
  const { psRows, descendantsOf } = await import("../harness/lib/lock-run.mjs");
  let kids = [];
  assert.ok(await until(() => (kids = descendantsOf(psRows() ?? [], w.pid)).length >= 3, 10000), `processes: ${kids}`);
  await new Promise((r) => setTimeout(r, 1200)); // one watcher tick
  w.kill("SIGTERM");
  const code = await new Promise((r) => w.on("exit", (c) => r(c)));
  assert.equal(code, 143);
  assert.equal(existsSync(lockDir), false, "the lock went back");
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.deepEqual(kids.filter(alive), [], "sh and the sleeps were reaped before");
});
