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
// - a takeover that moved a live lock after all (an older harness, whose
//   takeover is unguarded, removed the stale one and made a fresh one in
//   between) puts it back only onto nothing, else leaves it aside as stale,
//   and never aborts; a contender whose own owner is in .perf-lock holds it,
//   it never waits on itself;
// - leftovers of a process killed mid-step (.stale-, .released-, moved
//   guards) carry their time in their name and are swept once 60 s old.
// First come, first served (2026-10-21): the lock is polled, so a burst of
// short runs or builds could retake it again and again while a long wait
// timed out. Every contender first drops a ticket in .perf-lock.queue, named
// by its arrival time, and tries the lock only when no older ticket of a
// live process is still waiting; the ticket goes once the lock is held, or
// when the contender gives up. Tickets of a process that is gone are removed
// by whoever reads them. Older harnesses take no ticket and can still pass
// ahead, until every checkout has this code.
// Left: a takeover guard holder suspended past the abandon delay may lose its
// guard between its last check and its rename (narrowed, not closed); and
// older harnesses' own unguarded takeovers race among themselves until every
// checkout has this code.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIN_BATTERY_PERCENT, powerSnapshot } from "./system.mjs";

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

// Names of moved locks and guards carry the time they were moved: a rename
// keeps the directory's mtime, so a lock held for minutes would look old the
// instant it is moved aside (the sweep would remove it mid-release).
const unique = (base, tag) => `${base}.${tag}-${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}`;

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
  // Our owner in .perf-lock is ours, whatever happened meanwhile (an older
  // harness may have moved the directory and put it back).
  return readLockOwner(dir)?.nonce === owner.nonce ? "held" : "lost";
}

// Move `dir` aside under a unique name, and remove it if `isMeant(moved)`
// says it is the one meant. True when removed. A removal never empties `dir`
// in place. What was moved by mistake (a live lock or guard that replaced
// the one judged, possible while older harnesses take over without the
// guard) is put back only if nothing took its place; otherwise it stays
// aside, as a stale lock would, for the sweep. Never throws: the caller
// looks again.
function removeIf(dir, tag, isMeant, { log = () => {} } = {}) {
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
  // Put back only onto nothing: a rename onto an empty directory would
  // replace a lock being taken by an older harness.
  if (!existsSync(dir)) {
    try {
      renameSync(aside, dir);
      log(`moved a live ${path.basename(dir)} by mistake; put it back`);
      return false;
    } catch {}
  }
  log(`moved a live ${path.basename(dir)} by mistake and something took its place; left aside as ${path.basename(aside)}`);
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
    removeIf(guard, "takeover-abandoned", (moved) => ageSec(moved) >= TAKEOVER_ABANDONED_SEC, { log });
    return true;
  }
  try {
    if (!existsSync(dir)) return true;
    const now = readLockOwner(dir);
    const still = judged ? JSON.stringify(now) === JSON.stringify(judged) : now == null && ageSec(dir) >= orphanSec;
    if (!still) return true; // replaced or claimed meanwhile: judged again by the caller
    // A guard taken from us while we were suspended (past the abandon delay):
    // stop before moving anything.
    if (readLockOwner(guard)?.nonce !== me.nonce) return true;
    removeIf(dir, "stale", (aside) => {
      const owner = readLockOwner(aside);
      return judged ? JSON.stringify(owner) === JSON.stringify(judged) : owner == null;
    }, { log });
    return true;
  } finally {
    // Our guard only: one that is not ours any more (we hung past the
    // abandon delay and another contender cleared it) is put back.
    removeIf(guard, "takeover-done", (moved) => readLockOwner(moved)?.nonce === me.nonce, { log });
  }
}

export const queueDir = (dir) => `${dir}.queue`;
const TICKET = /^\d{13}-\d+-[0-9a-f]+$/;

// Drops this contender's ticket; returns its name. Written aside and renamed,
// so a reader never sees half a ticket.
function enqueue(dir, name) {
  const q = queueDir(dir);
  const id = `${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}`;
  const tmp = path.join(q, `.tmp-${id}`);
  for (let i = 0; ; i++) {
    try {
      mkdirSync(q, { recursive: true });
      writeFileSync(tmp, JSON.stringify({ name, pid: process.pid, host: os.hostname(), at: new Date().toISOString() }));
      renameSync(tmp, path.join(q, id));
      return id;
    } catch (e) {
      // The queue emptied and was removed between our mkdir and our write.
      if (e.code !== "ENOENT" || i >= 10) throw e;
    }
  }
}

// The ticket goes, and the queue with it once empty (rmdir refuses a
// directory that still has tickets).
const dequeue = (dir, id) => {
  try { unlinkSync(path.join(queueDir(dir), id)); } catch {} // never throw from an exit path
  try { rmdirSync(queueDir(dir)); } catch {}
};

// Tickets older than `id` whose process is still there, oldest first; those
// of a process gone from this host are removed.
export function ticketsAhead(dir, id) {
  const q = queueDir(dir);
  let names = [];
  try { names = readdirSync(q); } catch { return []; }
  const out = [];
  for (const n of names.filter((n) => TICKET.test(n) && n < id).sort()) {
    let t = null;
    try { t = JSON.parse(readFileSync(path.join(q, n), "utf8")); } catch {}
    if (!t || (t.host === os.hostname() && Number.isInteger(t.pid) && !alive(t.pid))) {
      try { unlinkSync(path.join(q, n)); } catch {}
      continue;
    }
    out.push(t);
  }
  return out;
}

// Leftovers of a process killed between two steps: moved locks and guards.
function sweepLeftovers(dir) {
  const parent = path.dirname(dir);
  const prefixes = [".stale-", ".released-", ".takeover.takeover-abandoned-", ".takeover.takeover-done-"].map((p) => `${path.basename(dir)}${p}`);
  let names = [];
  try { names = readdirSync(parent); } catch { return; }
  for (const n of names) {
    const prefix = prefixes.find((p) => n.startsWith(p));
    if (!prefix) continue;
    // Age from the time in the name; an older harness's name (pid first, no
    // time) falls back to the mtime.
    const at = Number(n.slice(prefix.length).split("-")[0]);
    const age = at > 1e12 ? (Date.now() - at) / 1000 : ageSec(path.join(parent, n));
    if (age >= LEFTOVER_SEC) rmSync(path.join(parent, n), { recursive: true, force: true });
  }
}

// Resolves to release() once the lock is held. Waits (polling every
// `pollSec`) up to `waitSec` while someone else holds it, then throws.
// requireMains (a measure, not an e2e or a build): on a laptop, waits for
// mains power before taking a ticket (a measure on battery is another
// machine; 2026-10-26/27 several ran unnoticed on battery), and gives its
// turn back if the power went to battery meanwhile. The release() it
// returns then says whether the power changed since (powerChanged()).
export const ON_BATTERY = Symbol("on battery");
export async function acquirePerfLock({
  dir = process.env.HARNESS_PERF_LOCK || DEFAULT_PERF_LOCK, name, waitSec = 1800, pollSec = 60, orphanSec = ORPHAN_SEC,
  requireMains = false, power = powerSnapshot,
  // false: the caller handles SIGINT/SIGTERM/SIGHUP itself (lock-run.mjs
  // reaps its command's processes first); the lock still goes on exit
  handleSignals = true,
  log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
} = {}) {
  if (path.basename(dir) !== ".perf-lock") throw new Error(`perf lock must be a directory named .perf-lock, not ${dir}`);
  for (const [k, v] of Object.entries({ waitSec, pollSec, orphanSec })) if (!Number.isFinite(v) || v < 0) throw new Error(`perf lock: ${k} must be a number ≥ 0, not ${v}`);
  const end = Date.now() + waitSec * 1000;
  // battery, or on mains with the charge under MIN_BATTERY_PERCENT (the
  // charger not keeping up): not a machine to measure on yet
  const onBattery = () => {
    if (!requireMains) return false;
    const p = power();
    return p?.source === "battery" || (Number.isFinite(p?.percent) && p.percent < MIN_BATTERY_PERCENT);
  };
  for (;;) {
    // Outside the queue: a measure waiting for mains blocks nobody behind it.
    while (onBattery()) {
      if (Date.now() >= end) throw new Error(`perf lock ${dir}: still on battery after ${waitSec} s; a measure needs mains power, nothing measured`);
      log(`perf lock: on battery or under ${MIN_BATTERY_PERCENT} % charge, waiting for mains power and charge before taking a ticket; retrying in ${pollSec} s`);
      await sleep(pollSec * 1000);
    }
    sweepLeftovers(dir);
    const ticket = enqueue(dir, name);
    let held;
    try {
      held = await contend({ dir, name, waitSec, pollSec, orphanSec, log, sleep, end, ticket, onBattery, handleSignals });
    } finally {
      dequeue(dir, ticket);
    }
    if (held === ON_BATTERY) continue;
    held.requireMains = requireMains;
    held.powerSource = requireMains ? power()?.source ?? null : null;
    // Taken off battery: whether it is on battery now. A reading that fails
    // (null, pmset busy) or AC <-> UPS is no change.
    held.powerChanged = () => requireMains && power()?.source === "battery";
    return held;
  }
}

async function contend({ dir, name, waitSec, pollSec, orphanSec, log, sleep, end, ticket, onBattery = () => false, handleSignals = true }) {
  const ours = new Map(); // nonce → owner, of every attempt
  for (;;) {
    const ahead = ticketsAhead(dir, ticket);
    if (ahead.length) {
      if (Date.now() >= end) throw new Error(`perf lock ${dir}: ${ahead.length} contender(s) arrived first, still waiting after ${waitSec} s (first: ${ahead[0].name}, pid ${ahead[0].pid})`);
      log(`perf lock: ${ahead.length} contender(s) arrived first (${ahead[0].name}); retrying in ${pollSec} s`);
      await sleep(pollSec * 1000);
      continue;
    }
    // Our turn, but unplugged meanwhile: the ticket goes, the next one plays.
    if (onBattery()) {
      log("perf lock: on battery at our turn; ticket given back until mains power");
      return ON_BATTERY;
    }
    const owner = newOwner(name);
    ours.set(owner.nonce, owner);
    const got = claim(dir, owner);
    if (got === "held") return release(dir, owner, { handleSignals });
    if (got === "lost") continue; // our directory was moved away before it was ours: try again
    const holder = readLockOwner(dir);
    // An earlier attempt of ours that an older harness put back after we
    // gave it up: it is ours, never wait on ourselves.
    if (holder && ours.has(holder.nonce)) return release(dir, ours.get(holder.nonce), { handleSignals });
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

// Whether `owner` still holds the lock alone: its nonce in .perf-lock, and
// no other living harness holder, in .perf-lock or in a lock moved aside
// (a takeover that moved a live lock): two holders at once would measure
// on a shared machine. Cheap: one directory listing and a few small reads.
export function lockIntegrity(dir, owner) {
  const now = readLockOwner(dir);
  if (now?.nonce !== owner.nonce) return { ok: false, why: `the lock is held by ${now ? `${now.name} (pid ${now.pid})` : "nobody"}, not by this process` };
  const parent = path.dirname(dir), base = path.basename(dir);
  let names = [];
  try { names = readdirSync(parent).filter((n) => n.startsWith(`${base}.`) && !n.startsWith(`${base}.takeover`)); } catch {}
  for (const n of names) {
    const o = readLockOwner(path.join(parent, n));
    if (o && o.nonce !== owner.nonce && o.harness && o.host === os.hostname() && Number.isInteger(o.pid) && o.pid !== process.pid && alive(o.pid)) {
      return { ok: false, why: `another living holder: ${o.name} (pid ${o.pid}) in ${n}` };
    }
  }
  return { ok: true };
}

function release(dir, owner, { handleSignals = true } = {}) {
  let done = false;
  const free = () => {
    if (done) return;
    done = true;
    // Only our own lock: never remove one somebody else took meanwhile.
    const now = readLockOwner(dir);
    if (now?.pid !== owner.pid || now?.nonce !== owner.nonce) return;
    try {
      removeIf(dir, "released", (moved) => readLockOwner(moved)?.nonce === owner.nonce);
    } catch {} // released anyway: never throw from an exit path
  };
  // SIGHUP: the SSH session that started the run closed.
  const onSignal = (sig) => { free(); process.exit({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[sig] ?? 1); };
  process.once("exit", free);
  if (handleSignals) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.once("SIGHUP", onSignal);
  }
  const releaseFn = () => {
    free();
    process.off("exit", free);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
  };
  // releaseFn.check(): lockIntegrity for this holder (race-perf checks it
  // when it takes the lock, before each run and at the end).
  releaseFn.check = () => lockIntegrity(dir, owner);
  return releaseFn;
}
