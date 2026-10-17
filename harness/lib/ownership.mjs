// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Who owns a harness directory (result campaign, temp Chrome profile,
// baseline export). Cleanup and rotation go by this marker, never by mtime:
// they skip anything whose owner process is alive, and anything another
// checkout (another agent) created.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const OWNER_FILE = ".harness-owner.json";

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

const active = new Set();
let exitHookInstalled = false;

// Mark `dir` as owned by this process and checkout until release() (or exit).
export function claim(dir, root, kind) {
  writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({ pid: process.pid, root, kind, startedAt: Date.now() }));
  active.add(dir);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => { for (const d of active) release(d); });
  }
  return () => release(dir);
}

// The owner is done: keep who made it, drop the live pid.
export function release(dir) {
  active.delete(dir);
  const file = path.join(dir, OWNER_FILE);
  if (!existsSync(file)) return;
  try {
    const m = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...m, pid: null, finishedAt: Date.now() }));
  } catch {}
}

export function readOwner(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, OWNER_FILE), "utf8"));
  } catch {
    return null;
  }
}

// May this checkout delete `dir`? Only if it made it and nobody runs in it.
export function deletable(dir, root, { alive = pidAlive } = {}) {
  const owner = readOwner(dir);
  if (!owner) return { ok: false, why: "no owner marker" };
  if (owner.root !== root) return { ok: false, why: `owned by ${owner.root}` };
  if (owner.pid && alive(owner.pid)) return { ok: false, why: `in use by pid ${owner.pid}` };
  return { ok: true, startedAt: owner.startedAt ?? 0 };
}

export function removeIfDeletable(dir, root) {
  const d = deletable(dir, root);
  if (d.ok) rmSync(dir, { recursive: true, force: true });
  return d;
}
