#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// First come, first served on the Spark bench. The lanes' perf locks keep
// two jobs out of one lane, but they are polled: a burst of core builds
// retook lane a's lock for half an hour while a pair waiting before them
// timed out (2026-10-21). Every job (a pair: one lane; a build: both) first
// drops a ticket in ~/salon-bench/queue/, named by its arrival time, and
// starts only when no older ticket still waiting could use a lane it wants,
// and that lane is free (no lock, no ticket running in it). It then writes
// its lane into its ticket and takes the lock as before; the ticket goes
// when the job ends, or when its process is gone.
//
//   node harness/remote/spark-queue.mjs wait --pid <job pid> --kind pair|build --lanes auto|a|b --name <label>
//     prints the lane granted (a, b, or "a b" for a build)
//   node harness/remote/spark-queue.mjs done --pid <job pid>
//   node harness/remote/spark-queue.mjs list
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const BENCH_DIR = path.join(os.homedir(), "salon-bench");
export const LANES = ["a", "b"];
export const laneLock = (lane, bench = BENCH_DIR) => (lane === "a" ? path.join(bench, ".perf-lock") : path.join(bench, "lanes", lane, ".perf-lock"));
const queueDir = (bench) => path.join(bench, "queue");

// The lanes a job could take.
export const wants = (t) => (t.kind === "build" ? LANES : t.lanes === "auto" ? LANES : [t.lanes]);

// What `me` may do now: { go: lanes } or { wait: why }. `tickets` are the
// live ones, `busy(lane)` says whether a lane's lock is held.
export function nextStep(me, tickets, busy) {
  const older = tickets.filter((t) => t.id < me.id);
  const mine = wants(me);
  const ahead = older.find((t) => !t.lane && wants(t).some((l) => mine.includes(l)));
  if (ahead) return { wait: `${ahead.kind} ${ahead.name} arrived first` };
  const taken = (l) => busy(l) || tickets.some((t) => t.id !== me.id && t.lane?.split(" ").includes(l));
  if (me.kind === "build") return mine.some(taken) ? { wait: "a lane is in use" } : { go: mine };
  const free = mine.find((l) => !taken(l));
  return free ? { go: [free] } : { wait: `lane${mine.length > 1 ? "s" : ""} ${mine.join(" ")} in use` };
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

// Live tickets, oldest first; tickets of a process that is gone are removed.
export function readTickets(bench = BENCH_DIR) {
  const dir = queueDir(bench);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const id of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    let t;
    try { t = JSON.parse(readFileSync(path.join(dir, id), "utf8")); } catch { continue; } // being written
    if (t.host === os.hostname() && !alive(t.pid)) { rmSync(path.join(dir, id), { force: true }); continue; }
    out.push({ ...t, id });
  }
  return out;
}

const writeTicket = (bench, t) => {
  const file = path.join(queueDir(bench), t.id);
  const { id, ...body } = t;
  writeFileSync(`${file}.tmp`, JSON.stringify(body));
  renameSync(`${file}.tmp`, file);
};

// A core build is a node process running spark-build.mjs, never the shell
// that started it (`sh -c 'node …spark-build.mjs …; echo $? > …'`): that
// shell has no ticket, and counting it as a build without one kept lane b
// busy for the queue's own builds, which then waited forever (2026-10-21).
export function isBuildProcess(argv) {
  return path.basename(argv[0] ?? "") === "node" && /(?:^|\/)harness\/remote\/spark-build\.mjs$/.test(argv[1] ?? "");
}

// Core builds of a harness before this queue: build processes with no
// ticket. They take lane a's lock alone (or wait for it) and compile on
// every core.
function untrackedBuilds(tickets) {
  if (process.platform !== "linux") return [];
  const ticketed = new Set(tickets.map((t) => t.pid));
  const out = [];
  for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (isBuildProcess(argv) && !ticketed.has(Number(pid))) out.push(Number(pid));
    } catch {} // gone meanwhile
  }
  return out;
}

// A lane is in use while its lock is held; lane b also while an untracked
// build exists, running or waiting.
export function laneBusy(lane, { bench = BENCH_DIR, tickets = [] } = {}) {
  if (existsSync(laneLock(lane, bench))) return true;
  return lane !== "a" && untrackedBuilds(tickets).length > 0;
}

export async function waitTurn({ pid, kind, lanes = "auto", name, bench = BENCH_DIR, pollSec = 15, log = () => {} }) {
  if (!["pair", "build"].includes(kind)) throw new Error(`--kind ${kind}: pair or build`);
  if (!["auto", ...LANES].includes(lanes)) throw new Error(`--lanes ${lanes}: auto, ${LANES.join(", ")}`);
  mkdirSync(queueDir(bench), { recursive: true });
  const me = { id: `${String(Date.now()).padStart(15, "0")}-${pid}.json`, pid, host: os.hostname(), kind, lanes, name, at: new Date().toISOString(), lane: null };
  writeTicket(bench, me);
  let said = null;
  for (;;) {
    const tickets = readTickets(bench);
    const step = nextStep(me, tickets, (l) => laneBusy(l, { bench, tickets }));
    if (step.go) {
      me.lane = step.go.join(" ");
      writeTicket(bench, me);
      return me.lane;
    }
    if (step.wait !== said) log(`queued: ${(said = step.wait)}`);
    await new Promise((r) => setTimeout(r, pollSec * 1000));
  }
}

export function done(pid, bench = BENCH_DIR) {
  for (const t of readTickets(bench)) if (t.pid === pid && t.host === os.hostname()) rmSync(path.join(queueDir(bench), t.id), { force: true });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: { pid: { type: "string" }, kind: { type: "string" }, lanes: { type: "string", default: "auto" }, name: { type: "string", default: "" } } });
  if (cmd === "list") {
    for (const t of readTickets()) console.log(`${t.at} ${t.kind} ${t.name} lanes:${t.lanes} ${t.lane ? `running in ${t.lane}` : "waiting"} pid ${t.pid}`);
    return;
  }
  const pid = Number(values.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("--pid <job pid> is required");
  if (cmd === "done") return done(pid);
  if (cmd !== "wait") throw new Error("usage: spark-queue.mjs wait|done|list …");
  // Progress on stderr, the lane alone on stdout.
  console.log(await waitTurn({ pid, kind: values.kind, lanes: values.lanes, name: values.name, log: (m) => console.error(`[spark-queue] ${m}`) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(`[spark-queue] ${e.message}`); process.exitCode = 2; });
}
