// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The shared performance lock of this Mac (PROGRAM.md): one speed campaign
// at a time. The lock is the directory .perf-lock with its owner file. It is
// published whole: a private directory .perf-lock.new-<pid>-<rand> gets the
// owner file, then is renamed to .perf-lock (atomic; it fails if a lock with
// an owner is there), so this code never leaves a .perf-lock without an
// owner. Taken with mkdir then the owner write (older harnesses), a takeover
// could move the fresh directory between the two and the write failed
// (ENOENT, seen in CI with six contenders). Released by removing the
// directory. Every
// harness command that measures speed (race-perf, ab) takes it before its
// first launch and releases it on every exit path; it only ever removes a
// lock it holds itself.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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


// A takeover in progress: one contender at a time judges again and moves a
// stale lock (see takeOver). Abandoned (its harness died mid-takeover) once
// this old; a takeover takes milliseconds.
export const TAKEOVER_ABANDONED_SEC = 10;

// Take a stale lock away. Judging it stale and moving it are not atomic: the
// stale lock could be replaced by a fresh one in between and the fresh one
// moved (seen with 24 contenders). So contenders serialise on a guard
// directory, .perf-lock.takeover, and the one holding it judges again before
// moving: while it holds the guard, nobody else moves .perf-lock, a fresh
// lock cannot be published over an existing one, and a stale lock's holder
// is gone, so what was judged is what is moved. The moved lock is then
// checked once more and deleted; were it a fresh one after all (an older
// harness's takeover), it is put back.
function takeOver(dir, judged, { orphanSec, log }) {
  const guard = `${dir}.takeover`;
  try {
    mkdirSync(guard);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (ageSec(guard) < TAKEOVER_ABANDONED_SEC) return false; // someone else is taking it over: wait
    rmSync(guard, { recursive: true, force: true });
    return true; // an abandoned guard cleared: look again now
  }
  try {
    if (!existsSync(dir)) return true;
    const now = readLockOwner(dir);
    const still = judged ? JSON.stringify(now) === JSON.stringify(judged) : now == null && ageSec(dir) >= orphanSec;
    if (!still) return true; // replaced or claimed meanwhile: judged again by the caller
    const aside = `${dir}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
    renameSync(dir, aside);
    const moved = readLockOwner(aside);
    const same = judged ? JSON.stringify(moved) === JSON.stringify(judged) : moved == null;
    if (same) {
      rmSync(aside, { recursive: true, force: true });
      return true;
    }
    try {
      renameSync(aside, dir);
      log("a fresh lock replaced the stale one meanwhile; put it back");
      return true;
    } catch (e) {
      throw new Error(`perf lock: moved a live lock to ${aside} and could not put it back (${e.code}); fix by hand`);
    }
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

// Publish the lock whole (see the header); true when it is ours. A rename
// onto an existing directory fails when it holds an owner (ENOTEMPTY or
// EEXIST; EPERM on Windows), but succeeds onto an empty one: an ownerless
// lock (an older harness between its mkdir and its owner write, or one that
// died there) is never published over, it goes through the orphan rule. If
// such a directory appears between the check and the rename, its harness
// then writes its owner over ours: the lock is ours only when the owner read
// back is.
function publish(dir, owner) {
  if (existsSync(dir)) return false;
  const tmp = `${dir}.new-${process.pid}-${randomBytes(4).toString("hex")}`;
  mkdirSync(tmp);
  try {
    writeFileSync(path.join(tmp, "owner"), `${JSON.stringify(owner)}\n`);
    renameSync(tmp, dir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(e.code)) return false;
    throw e;
  }
  return readLockOwner(dir)?.nonce === owner.nonce;
}

// Unpublished directories of harness processes that died between their
// mkdir and their rename (this host only).
function sweepUnpublished(dir) {
  const base = `${path.basename(dir)}.new-`;
  let names = [];
  try { names = readdirSync(path.dirname(dir)); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(base)) continue;
    const pid = Number(n.slice(base.length).split("-")[0]);
    if (Number.isInteger(pid) && pid !== process.pid && !alive(pid)) rmSync(path.join(path.dirname(dir), n), { recursive: true, force: true });
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
  sweepUnpublished(dir);
  for (;;) {
    const owner = { name, pid: process.pid, host: os.hostname(), harness: true, startedAt: new Date().toISOString(), nonce: randomBytes(6).toString("hex") };
    if (publish(dir, owner)) return release(dir, owner);
    const holder = readLockOwner(dir);
    const stale = staleReason(dir, holder, orphanSec);
    if (stale) {
      log(`perf lock is stale (${stale}): taking it over`);
      if (takeOver(dir, holder, { orphanSec, log })) continue;
      // Another contender holds the takeover guard (milliseconds): look again
      // shortly, within the same deadline.
      if (Date.now() >= end) throw new Error(`perf lock ${dir} still held by ${JSON.stringify(holder)} (takeover in progress) after ${waitSec} s`);
      await sleep(Math.min(pollSec, 0.2) * 1000);
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
    if (now?.pid !== owner.pid || now?.nonce !== owner.nonce) return;
    // Moved aside first, then removed: emptied in place, .perf-lock would be
    // an empty directory for an instant, and a contender's publish (a rename)
    // would land in it (ENOTEMPTY here, seen under load 49).
    const aside = `${dir}.released-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      renameSync(dir, aside);
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    rmSync(aside, { recursive: true, force: true });
  };
  // SIGHUP: the SSH session that started the run closed.
  const onSignal = (sig) => { free(); process.exit({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[sig] ?? 1); };
  process.once("exit", free);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  return () => {
    free();
    process.off("exit", free);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
  };
}
