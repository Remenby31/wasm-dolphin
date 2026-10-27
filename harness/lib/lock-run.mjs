// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// A command under the shared perf lock, and none of its processes left when
// the lock goes back. 2026-10-27 16:11: a locked e2e returned the lock while
// its Playwright Chromes still ran (load ~25), and the next holder measured
// under that load. Playwright starts Chrome in a process group of its own and
// an exiting parent leaves its children to launchd, so the tree is followed
// while the command runs (every `watchMs`), and once it exits every process
// seen is awaited (`graceMs`), then sent SIGTERM, then SIGKILL, before the
// lock is released.
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { acquirePerfLock } from "./perf-lock.mjs";

// `ps -A -o pid=,ppid=` rows -> the pids under `root` (root excluded).
export function descendantsOf(rows, root) {
  const children = new Map();
  for (const [pid, ppid] of rows) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop();
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

// [pid, ppid, started] rows: `started` (ps lstart, to the second) tells a
// process from a later one that got its pid back (one reused within the same
// second as the first started would pass: not seen in practice).
export function psRows() {
  try {
    return execFileSync("ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8" }).split("\n").map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(l);
      return m ? [Number(m[1]), Number(m[2]), m[3]] : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}
const startedOf = () => new Map(psRows().map(([pid, , started]) => [pid, started]));


// Waits for `seen` (pid -> start time when seen) to be gone, up to graceMs;
// then SIGTERM, then SIGKILL (killWaitMs after each). A pid is ours only
// while it has the start time it had when seen: a pid given back to another
// process meanwhile is never signalled (nor waited for). Returns the pids
// still alive at the end.
export async function reap(seen, { graceMs = 10000, killWaitMs = 5000, log = () => {}, started = startedOf, kill = (pid, sig) => process.kill(pid, sig), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), stepMs = 200 } = {}) {
  const left = () => { const now = started(); return [...seen].filter(([pid, at]) => now.get(pid) === at).map(([pid]) => pid); };
  const waitGone = async (ms) => { for (const end = Date.now() + ms; left().length && Date.now() < end;) await sleep(stepMs); return left(); };
  let rest = await waitGone(graceMs);
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    if (!rest.length) return [];
    log(`${rest.length} process(es) of the run still alive (${rest.slice(0, 8).join(", ")}): ${sig}`);
    // checked again right before the signal: still the same process
    const now = started();
    for (const pid of rest) { if (now.get(pid) !== seen.get(pid)) continue; try { kill(pid, sig); } catch {} }
    rest = await waitGone(killWaitMs);
  }
  return rest;
}

// Runs `cmd args` under the perf lock; resolves to its exit code once every
// process it started is gone and the lock is back.
export async function runLocked({ name, cmd, args = [], cwd, env = process.env, lock = {}, watchMs = 1000, graceMs = 10000, killWaitMs = 5000, log = () => {}, acquire = acquirePerfLock }) {
  const release = await acquire({ name, log, ...lock });
  log("perf lock held");
  const child = spawn(cmd, args, { cwd, env, stdio: "inherit" });
  const seen = new Map(); // pid -> its start time when first seen
  const look = () => {
    const rows = psRows();
    const at = new Map(rows.map(([pid, , started]) => [pid, started]));
    for (const pid of descendantsOf(rows, child.pid)) if (!seen.has(pid) && at.has(pid)) seen.set(pid, at.get(pid));
  };
  look();
  const watcher = setInterval(look, watchMs);
  let code;
  try {
    code = await new Promise((resolve) => child.on("exit", (c, s) => resolve(c ?? (s ? 1 : 0))));
  } finally {
    clearInterval(watcher);
    look(); // what the command left behind just before it went (already reparented ones were seen earlier)
    const rest = await reap(seen, { graceMs, killWaitMs, log });
    if (rest.length) log(`still alive after SIGKILL: ${rest.join(", ")} (the lock goes back anyway)`);
    release();
    log(`perf lock released (exit ${code})`);
  }
  return code;
}

// node harness/lib/lock-run.mjs --name "Salon · UX e2e" [--measure] [--wait 14400] -- npx playwright test …
// --measure: a measure (waits for mains power, requireMains); without it
// (e2e, builds) only the lock. Exits with the command's code.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const sep = process.argv.indexOf("--");
  const opts = process.argv.slice(2, sep < 0 ? undefined : sep);
  const at = (k) => { const i = opts.indexOf(k); return i >= 0 ? opts[i + 1] : null; };
  const [cmd, ...args] = sep < 0 ? [] : process.argv.slice(sep + 1);
  if (!cmd || !at("--name")) { console.error('usage: lock-run.mjs --name "<who>" [--measure] [--wait s] -- <command…>'); process.exit(2); }
  const log = (m) => console.log(`[lock-run] ${new Date().toISOString().slice(11, 19)} ${m}`);
  const code = await runLocked({ name: at("--name"), cmd, args, log, lock: { waitSec: Number(at("--wait") ?? 14400), requireMains: opts.includes("--measure") } });
  process.exit(code);
}
