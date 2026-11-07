// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// A process killed while it waits in the perf lock's queue takes its ticket
// with it (SIGTERM, SIGINT, or a plain exit), never leaving it to the next
// contender's sweep.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const lib = new URL("../harness/lib/perf-lock.mjs", import.meta.url).href;
const tickets = (dir) => { try { return readdirSync(path.join(path.dirname(dir), ".perf-lock.queue")).filter((n) => !n.startsWith(".")); } catch { return []; } };

async function queuedChild(t, dir, script = "") {
  // two contenders, the second queued behind the first (held by this test's
  // own sleeping child, a live pid)
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `
    const { acquirePerfLock } = await import(${JSON.stringify(lib)});
    await acquirePerfLock({ dir: ${JSON.stringify(dir)}, name: "holder", waitSec: 30, pollSec: 1 });
    process.stdout.write("held\\n");
    setTimeout(() => process.exit(0), 60_000);`], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => holder.kill("SIGKILL"));
  await new Promise((r) => holder.stdout.once("data", r));
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { acquirePerfLock } = await import(${JSON.stringify(lib)});
    ${script}
    await acquirePerfLock({ dir: ${JSON.stringify(dir)}, name: "queued", waitSec: 60, pollSec: 1, log: (m) => process.stdout.write(m + "\\n") });`], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  // queued: its ticket is in
  for (let i = 0; i < 100 && tickets(dir).length < 1; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => child.stdout.once("data", r));
  return child;
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  test(`${sig} while queued: the ticket goes, exit 128 + n`, async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "harness-queued-signal-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, ".perf-lock");
    const child = await queuedChild(t, dir);
    assert.equal(tickets(dir).length, 1, "queued with a ticket");
    const exited = new Promise((r) => child.once("exit", (code) => r(code)));
    child.kill(sig);
    assert.equal(await exited, sig === "SIGTERM" ? 143 : 130);
    assert.deepEqual(tickets(dir), [], "no ticket left");
  });
}

test("a plain exit while queued takes the ticket too", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "harness-queued-signal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, ".perf-lock");
  const child = await queuedChild(t, dir, "setTimeout(() => process.exit(3), 1500);");
  const code = await new Promise((r) => child.once("exit", (c) => r(c)));
  assert.equal(code, 3);
  assert.deepEqual(tickets(dir), []);
});

test("lock-run (handleSignals: false) queued: SIGTERM takes the ticket too, nothing launched", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "harness-queued-signal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, ".perf-lock");
  const marker = path.join(root, "launched");
  const lockRun = new URL("../harness/lib/lock-run.mjs", import.meta.url).href;
  const child = await queuedChild(t, dir, `
    const { runLocked } = await import(${JSON.stringify(lockRun)});
    await runLocked({ name: "lock-run queued", cmd: "touch", args: [${JSON.stringify(marker)}], lock: { dir: ${JSON.stringify(dir)}, waitSec: 60, pollSec: 1 }, log: (m) => process.stdout.write(m + "\\n") });
    process.exit(0);`);
  assert.equal(tickets(dir).length, 1, "queued with a ticket");
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  child.kill("SIGTERM");
  assert.equal(await exited, 143);
  assert.deepEqual(tickets(dir), [], "no ticket left");
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(marker), false, "the command never ran");
});
