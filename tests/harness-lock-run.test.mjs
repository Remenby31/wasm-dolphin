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
  const live = new Set([1, 2, 3]);
  const sent = [];
  const left = await reap([1, 2, 3], {
    graceMs: 0, killWaitMs: 0, stepMs: 0, sleep: async () => {},
    isAlive: (p) => live.has(p),
    kill: (p, sig) => { sent.push(`${sig} ${p}`); if (sig === "SIGTERM" && p !== 3) live.delete(p); if (sig === "SIGKILL") live.delete(p); }
  });
  assert.deepEqual(left, []);
  assert.deepEqual(sent, ["SIGTERM 1", "SIGTERM 2", "SIGTERM 3", "SIGKILL 3"]);
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
