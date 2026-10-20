// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The shared performance lock of this Mac (PROGRAM.md): one speed campaign
// at a time. The lock is the directory .perf-lock with its owner file; every
// harness command that measures speed (race-perf, ab) takes it before its
// first launch and releases it on every exit path, and only ever removes a
// lock it holds itself.
//
// Taking it is an exclusive mkdir, as in every earlier harness, so this code
// and older checkouts still running on the machine exclude each other. The
// owner is then written to a temporary file inside the directory just made
// and renamed to owner, never left half-written. Hardened on 2026-10-20
// after 24 contenders on a stale lock gave two holders at once (11 rounds of
// 320 on the earlier code):
// - the directory made can vanish before its owner is written (an older
//   harness's takeover moved it): the write fails or lands elsewhere, so the
//   directory's identity (inode) is checked and the owner read back; any
//   doubt means not held, and the contender tries again;
// - a stale lock is taken over by one contender at a time, under the
//   .perf-lock.takeover guard, judging again before moving it; while the
//   guard is held nobody else moves .perf-lock and a stale lock's holder is
//   gone, so what was judged is what is moved;
// - releasing moves the directory aside before removing it (never emptied in
//   place), and the guard is released the same way, each only when it still
//   carries this process's nonce;
// - leftovers of a process killed mid-step (.stale-, .released-, moved
//   guards) are swept once old.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PERF_LOCK = path.join(os.homedir(), "projects", "gc-web-emu", ".perf-lock");
// A lock directory with no owner file is one whose holder died between mkdir
// and writing the owner; it is taken over once it is this old.
export const ORPHAN_SEC = 30;
// A takeover guard this old was abandoned (its harness died or hung
// mid-takeover); a takeover takes milliseconds.
export const TAKEOVER_ABANDONED_SEC = 10;
// Leftovers of a killed step (moved locks and guards) are removed once this old.
export const LEFTOVER_SEC = 60;

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

const inode = (dir) => {
  try { return statSync(dir).ino; } catch { return null; }
};

const unique = (base, tag) => `${base}.${tag}-${process.pid}-${randomBytes(4).toString("hex")}`;

const newOwner = (name) => ({ name, pid: process.pid, host: os.hostname(), harness: true, startedAt: new Date().toISOString(), nonce: randomBytes(6).toString("hex") });

// Why a held lock may be taken over, or null.
function staleReason(dir, holder, orphanSec) {
  if (!holder) return ageSec(dir) >= orphanSec ? `no owner file for ${Math.round(ageSec(dir))} s` : null;
  if (holder.harness && holder.host === os.hostname() && Number.isInteger(holder.pid) && !alive(holder.pid)) return `harness process ${holder.pid} (${holder.name}) is gone`;
  return null;
}

// Make `dir` exclusively and give it `owner`. "taken": it exists already;
// "lost": made, but it vanished or changed before it was ours (nothing of
// ours is left behind); "held": ours.
function claim(dir, owner) {
  try {
    mkdirSync(dir);
  } catch (e) {
    if (e.code === "EEXIST") return "taken";
    throw e;
  }
  const ino = inode(dir);
  const tmp = path.join(dir, `owner.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, `${JSON.stringify(owner)}\n`, { flag: "wx" });
  } catch (e) {
    if (["ENOENT", "EINVAL", "ENOTDIR"].includes(e.code)) return "lost";
    throw e;
  }
  // The directory written into must still be the one made.
  if (inode(dir) !== ino) {
    try { unlinkSync(tmp); } catch {}
    return "lost";
  }
  try {
    renameSync(tmp, path.join(dir, "owner"));
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    if (["ENOENT", "EINVAL", "ENOTDIR"].includes(e.code)) return "lost";
    throw e;
  }
  return inode(dir) === ino && readLockOwner(dir)?.nonce === owner.nonce ? "held" : "lost";
}

// Move `dir` aside under a unique name, and remove it if `isMeant(moved)`
// says it is the one meant; otherwise put it back. True when removed. A
// removal never empties `dir` in place. A guard that cannot be put back (a
// newer one is there) is left aside for the sweep; a lock that cannot be
// put back is an error.
function removeIf(dir, tag, isMeant, { mustPutBack = true } = {}) {
  const aside = unique(dir, tag);
  try {
    renameSync(dir, aside);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  if (isMeant(aside)) {
    rmSync(aside, { recursive: true, force: true });
    return true;
  }
  try {
    renameSync(aside, dir);
  } catch (e) {
    if (!mustPutBack) return false;
    throw new Error(`perf lock: moved ${path.basename(dir)} to ${aside} by mistake and could not put it back (${e.code}); fix by hand`);
  }
  return false;
}

// Take a stale lock away, one contender at a time (see the header). True
// when the caller should look again at once, false when another contender
// is taking it over (wait a little).
function takeOver(dir, judged, { orphanSec, log }) {
  const guard = `${dir}.takeover`;
  const me = newOwner("takeover");
  const got = claim(guard, me);
  if (got === "lost") return true;
  if (got === "taken") {
    if (ageSec(guard) < TAKEOVER_ABANDONED_SEC) return false;
    // Abandoned: removed only if what was moved is still that old guard
    // (a fresh one made meanwhile is put back).
    removeIf(guard, "takeover-abandoned", (moved) => ageSec(moved) >= TAKEOVER_ABANDONED_SEC, { mustPutBack: false });
    return true;
  }
  try {
    if (!existsSync(dir)) return true;
    const now = readLockOwner(dir);
    const still = judged ? JSON.stringify(now) === JSON.stringify(judged) : now == null && ageSec(dir) >= orphanSec;
    if (!still) return true; // replaced or claimed meanwhile: judged again by the caller
    const moved = removeIf(dir, "stale", (aside) => {
      const owner = readLockOwner(aside);
      return judged ? JSON.stringify(owner) === JSON.stringify(judged) : owner == null;
    });
    if (!moved) log("a fresh lock replaced the stale one meanwhile; put it back");
    return true;
  } finally {
    // Our guard only: one that is not ours any more (we hung past the
    // abandon delay and another contender cleared it) is put back.
    removeIf(guard, "takeover-done", (moved) => readLockOwner(moved)?.nonce === me.nonce, { mustPutBack: false });
  }
}

// Leftovers of a process killed between two steps: moved locks and guards.
function sweepLeftovers(dir) {
  const parent = path.dirname(dir);
  const prefixes = [".stale-", ".released-", ".takeover.takeover-abandoned-", ".takeover.takeover-done-"].map((p) => `${path.basename(dir)}${p}`);
  let names = [];
  try { names = readdirSync(parent); } catch { return; }
  for (const n of names) {
    if (!prefixes.some((p) => n.startsWith(p))) continue;
    const p = path.join(parent, n);
    if (ageSec(p) >= LEFTOVER_SEC) rmSync(p, { recursive: true, force: true });
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
  sweepLeftovers(dir);
  for (;;) {
    const owner = newOwner(name);
    const got = claim(dir, owner);
    if (got === "held") return release(dir, owner);
    if (got === "lost") continue; // our directory was moved away before it was ours: try again
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
    // Only our own lock: never remove one somebody else took meanwhile.
    const now = readLockOwner(dir);
    if (now?.pid !== owner.pid || now?.nonce !== owner.nonce) return;
    removeIf(dir, "released", (moved) => readLockOwner(moved)?.nonce === owner.nonce);
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
