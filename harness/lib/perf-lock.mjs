// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The shared performance lock of this Mac (PROGRAM.md): one speed campaign
// at a time. Taken with mkdir (atomic: it fails if someone holds it), owner
// written in .perf-lock/owner, released by removing the directory. The
// harness takes it before measuring and releases it on every exit path; it
// only ever removes a lock it holds itself.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PERF_LOCK = path.join(os.homedir(), "projects", "gc-web-emu", ".perf-lock");

export function readLockOwner(dir) {
  try {
    const text = readFileSync(path.join(dir, "owner"), "utf8");
    try { return JSON.parse(text); } catch { return { name: text.trim() }; }
  } catch {
    return null;
  }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

// Resolves to release() once the lock is held. Waits (polling every
// `pollSec`) up to `waitSec` while someone else holds it, then throws. A lock
// left by a harness process of this machine that no longer exists is taken
// over (its owner file says so); any other holder is waited for.
export async function acquirePerfLock({ dir = process.env.HARNESS_PERF_LOCK || DEFAULT_PERF_LOCK, name, waitSec = 1800, pollSec = 60, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (path.basename(dir) !== ".perf-lock") throw new Error(`perf lock must be a directory named .perf-lock, not ${dir}`);
  const end = Date.now() + waitSec * 1000;
  for (;;) {
    try {
      mkdirSync(dir);
      const owner = { name, pid: process.pid, host: os.hostname(), harness: true, startedAt: new Date().toISOString() };
      writeFileSync(path.join(dir, "owner"), `${JSON.stringify(owner)}\n`);
      return release(dir, owner);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const holder = readLockOwner(dir);
    if (holder?.harness && holder.host === os.hostname() && Number.isInteger(holder.pid) && !alive(holder.pid)) {
      log(`perf lock left by dead harness process ${holder.pid} (${holder.name}): taking it over`);
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= end) throw new Error(`perf lock ${dir} still held by ${holder ? JSON.stringify(holder) : "unknown owner"} after ${waitSec} s`);
    log(`perf lock held by ${holder?.name ?? "unknown"}${holder?.pid ? ` (pid ${holder.pid})` : ""}; retrying in ${pollSec} s`);
    await sleep(pollSec * 1000);
  }
}

function release(dir, owner) {
  let done = false;
  const free = () => {
    if (done) return;
    done = true;
    const now = readLockOwner(dir);
    // Only our own lock: never remove one somebody else took meanwhile.
    if (now?.pid === owner.pid && now?.startedAt === owner.startedAt) rmSync(dir, { recursive: true, force: true });
  };
  const onSignal = (sig) => { free(); process.exit(sig === "SIGINT" ? 130 : 143); };
  process.once("exit", free);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    free();
    process.off("exit", free);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}
