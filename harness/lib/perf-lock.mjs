// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The shared performance lock of this Mac (PROGRAM.md): one speed campaign
// at a time. Taken with mkdir (atomic: it fails if someone holds it), owner
// written in .perf-lock/owner, released by removing the directory. Every
// harness command that measures speed (race-perf, ab) takes it before its
// first launch and releases it on every exit path; it only ever removes a
// lock it holds itself.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PERF_LOCK = path.join(os.homedir(), "projects", "gc-web-emu", ".perf-lock");
// A lock directory with no owner file is one whose holder died between mkdir
// and writing the owner; it is taken over once it is this old.
export const ORPHAN_SEC = 30;

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

const ageSec = (dir) => {
  try { return (Date.now() - statSync(dir).mtimeMs) / 1000; } catch { return 0; }
};

// Why a held lock may be taken over, or null.
function staleReason(dir, holder, orphanSec) {
  if (!holder) return ageSec(dir) >= orphanSec ? `no owner file for ${Math.round(ageSec(dir))} s` : null;
  if (holder.harness && holder.host === os.hostname() && Number.isInteger(holder.pid) && !alive(holder.pid)) return `harness process ${holder.pid} (${holder.name}) is gone`;
  return null;
}


// Take a stale lock away atomically: rename it aside (only one contender's
// rename succeeds), check that what was moved is the stale lock that was
// judged, and only then delete it. If a fresh lock was moved by mistake (it
// replaced the stale one meanwhile), it is put back untouched.
function takeOver(dir, judged, { orphanSec, log }) {
  const aside = `${dir}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(dir, aside);
  } catch (e) {
    if (e.code === "ENOENT") return; // someone else moved it first
    throw e;
  }
  const moved = readLockOwner(aside);
  // The same owner file as judged; for an ownerless lock, still an old
  // directory (rename keeps its mtime), not one just being created.
  const same = judged ? JSON.stringify(moved) === JSON.stringify(judged) : moved == null && ageSec(aside) >= orphanSec;
  if (same) {
    rmSync(aside, { recursive: true, force: true });
    return;
  }
  try {
    renameSync(aside, dir);
    log("a fresh lock replaced the stale one meanwhile; put it back");
  } catch (e) {
    throw new Error(`perf lock: moved a live lock to ${aside} and could not put it back (${e.code}); fix by hand`);
  }
}

// Resolves to release() once the lock is held. Waits (polling every
// `pollSec`) up to `waitSec` while someone else holds it, then throws.
export async function acquirePerfLock({
  dir = process.env.HARNESS_PERF_LOCK || DEFAULT_PERF_LOCK, name, waitSec = 1800, pollSec = 60, orphanSec = ORPHAN_SEC,
  log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
} = {}) {
  if (path.basename(dir) !== ".perf-lock") throw new Error(`perf lock must be a directory named .perf-lock, not ${dir}`);
  for (const [k, v] of Object.entries({ waitSec, pollSec, orphanSec })) if (!Number.isFinite(v) || v < 0) throw new Error(`perf lock: ${k} must be a number ≥ 0, not ${v}`);
  const end = Date.now() + waitSec * 1000;
  for (;;) {
    try {
      mkdirSync(dir);
      const owner = { name, pid: process.pid, host: os.hostname(), harness: true, startedAt: new Date().toISOString(), nonce: randomBytes(6).toString("hex") };
      writeFileSync(path.join(dir, "owner"), `${JSON.stringify(owner)}\n`);
      return release(dir, owner);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const holder = readLockOwner(dir);
    const stale = staleReason(dir, holder, orphanSec);
    if (stale) {
      log(`perf lock is stale (${stale}): taking it over`);
      takeOver(dir, holder, { orphanSec, log });
      continue;
    }
    if (Date.now() >= end) throw new Error(`perf lock ${dir} still held by ${holder ? JSON.stringify(holder) : "unknown owner"} after ${waitSec} s`);
    log(`perf lock held by ${holder?.name ?? "unknown (no owner file yet)"}${holder?.pid ? ` (pid ${holder.pid})` : ""}; retrying in ${pollSec} s`);
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
    if (now?.pid === owner.pid && now?.nonce === owner.nonce) rmSync(dir, { recursive: true, force: true });
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
