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
// A pair may also ask that its lane's cores be free of other people's work
// (--cores, spark-cores.mjs) before its grant: while they are busy, its
// ticket steps aside for a minute (holdUntil: younger jobs may go) and asks
// again, 30 min at most, then gives up (exit 3). Checked after the grant,
// the wait held the bench for 30 min with every build behind it.
//
//   node harness/remote/spark-queue.mjs wait --pid <job pid> --kind pair|build|multi --lanes auto|a|b --name <label>
//       [--cores a=15-19,10-14 --cores b=5-9,0-4 --cores-out <file>]
//     prints the lane granted (a, b, or "a b" for a build or a multi) and
//     exits 0; 3: the lane's cores stayed busy; 2: an error
//   node harness/remote/spark-queue.mjs done --pid <job pid>
//   node harness/remote/spark-queue.mjs list [--eta]
//   node harness/remote/spark-queue.mjs move <name> --after <name|head> --as-judge
//
// A waiting job finds its ticket by its pid at every poll, so moving a
// ticket (a rename, `move`) changes its turn safely; the judge alone moves
// tickets (PROGRAM.md), and every move is logged in queue/moves.log.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const BENCH_DIR = path.join(os.homedir(), "salon-bench");
export const LANES = ["a", "b"];
// Lanes a pair may be given. Two pairs at once failed their A/A (2026-10-21
// 22:55: lane b σ 1.86 pt and one pair at +4.8 %, both pairs 1-7 % slower
// and over the load limit): the clusters share enough to disturb each
// other. So one pair at a time, in lane a; lane b stays defined for builds'
// locks and a later attempt.
export const PAIR_LANES = ["a"];
export const laneLock = (lane, bench = BENCH_DIR) => (lane === "a" ? path.join(bench, ".perf-lock") : path.join(bench, "lanes", lane, ".perf-lock"));
const queueDir = (bench) => path.join(bench, "queue");

// Jobs that take the whole bench: a build, and a multi (race-multi: one arm
// per lane of big cores on both clusters, spark-multi.sh).
export const WHOLE_BENCH = ["build", "multi"];
// The lanes a job could take.
export const wants = (t) => (WHOLE_BENCH.includes(t.kind) ? LANES : t.lanes === "auto" ? PAIR_LANES : [t.lanes]);

// A waiting ticket stepped aside while its lane's cores are busy.
export const held = (t, now = Date.now()) => Boolean(t.holdUntil) && Date.parse(t.holdUntil) > now;

// What `me` may do now: { go: lanes } or { wait: why }. `tickets` are the
// live ones, `busy(lane)` says whether a lane's lock is held.
export function nextStep(me, tickets, busy, now = Date.now()) {
  if (held(me, now)) return { wait: "the lane's cores are busy" };
  const older = tickets.filter((t) => t.id < me.id);
  const mine = wants(me);
  const ahead = older.find((t) => !t.lane && !held(t, now) && wants(t).some((l) => mine.includes(l)));
  if (ahead) return { wait: `${ahead.kind} ${ahead.name} arrived first` };
  const taken = (l) => busy(l) || tickets.some((t) => t.id !== me.id && t.lane?.split(" ").includes(l));
  if (WHOLE_BENCH.includes(me.kind)) return mine.some(taken) ? { wait: "a lane is in use" } : { go: mine };
  const free = mine.find((l) => !taken(l));
  return free ? { go: [free] } : { wait: `lane${mine.length > 1 ? "s" : ""} ${mine.join(" ")} in use` };
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

// Live tickets, oldest first; tickets of a process that is gone are removed.
// One ticket per job: a move racing with the job's own grant can leave two
// (the moved one, and the granted one under the old name); the granted, or
// else the newest name, is kept.
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
  const keep = new Map();
  for (const t of out) {
    const k = `${t.host} ${t.pid}`, prev = keep.get(k);
    if (!prev) { keep.set(k, t); continue; }
    const [win, lose] = Boolean(t.lane) !== Boolean(prev.lane) ? (t.lane ? [t, prev] : [prev, t]) : [t, prev];
    rmSync(path.join(dir, lose.id), { force: true });
    keep.set(k, win);
  }
  return out.filter((t) => keep.get(`${t.host} ${t.pid}`) === t);
}

// Minutes a job holds the bench: a pair, from race-perf's options (every
// run boots each side: warmup + window + ~20 s of boot and savestate); a
// build ~3 min: one build checkout and a shared ccache (#78) make a build
// after another 1-3.5 min (measured 2026-10-22); only a cold one takes ~7.
export const BUILD_MIN = 3;
export const MULTI_SEED_MIN = 4, MULTI_RUN_MIN = 1.5;
const optOf = (args, name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : def; };
export function estimateMin(kind, args = []) {
  if (kind === "build") return BUILD_MIN;
  // A multi: one first launch per arm (~4 min, together), then ~75 s a run
  // (multi-aba-emu-0087b, 2026-10-22), discarded runs played again.
  if (kind === "multi") return Math.round(MULTI_SEED_MIN + optOf(args, "runs", 6) * MULTI_RUN_MIN);
  const opt = (name, def) => optOf(args, name, def);
  const sides = args.includes("--baseline") ? 2 : 1;
  return Math.round((opt("runs", 4) * sides * (opt("warmup", 25) + opt("secs", 20) + 20)) / 60);
}

// When each job should start and end, in minutes from `now`. The bench runs
// one job at a time (a pair in lane a, a build on both lanes), so in queue
// order; a running job has its estimate minus the time since its grant.
export function eta(tickets, now = Date.now()) {
  let t0 = 0;
  const out = [];
  for (const t of tickets.filter((x) => x.lane !== "none")) {
    const est = t.estMin ?? (t.kind === "build" ? BUILD_MIN : t.kind === "multi" ? estimateMin("multi") : 13);
    if (t.lane) {
      const left = Math.max(1, est - (t.grantedAt ? (now - Date.parse(t.grantedAt)) / 60000 : 0));
      out.push({ ...t, startsIn: 0, endsIn: Math.round(left) });
      t0 = Math.max(t0, left);
    } else {
      out.push({ ...t, startsIn: Math.round(t0), endsIn: Math.round(t0 + est) });
      t0 += est;
    }
  }
  return out;
}

// The ticket name that puts `name` just after `after` ("head": before every
// waiting ticket): a time between its new neighbours.
export function movedId(tickets, name, after) {
  const me = tickets.find((t) => t.name === name);
  if (!me) throw new Error(`no ticket named ${name}`);
  if (me.lane) throw new Error(`${name} is already running`);
  // A waiter from a harness before moves (no estMin in its ticket) keeps its
  // ticket's name in memory: renamed, it would wait for itself (2026-10-22,
  // p87-native-ps-aot idled the bench). Its owner requeues it with main.
  if (!("estMin" in me)) throw new Error(`${name} waits with a harness from before \`move\`: it would wait for itself; its owner must requeue it after merging main`);
  const others = tickets.filter((t) => t !== me);
  const at = after === "head" ? others.filter((t) => t.lane).length : others.findIndex((t) => t.name === after) + 1;
  if (after !== "head" && at === 0) throw new Error(`no ticket named ${after}`);
  if (others.slice(at).some((t) => t.lane)) throw new Error(`cannot move ${name} before a running job`);
  const ms = (t) => Number(t.id.split("-")[0]);
  const lo = at > 0 ? ms(others[at - 1]) : ms(others[0] ?? me) - 2000, hi = at < others.length ? ms(others[at]) : ms(others.at(-1)) + 2000;
  if (hi - lo < 2) throw new Error(`no room between ${others[at - 1]?.name} and ${others[at]?.name} (same millisecond)`);
  return `${String(Math.floor((lo + hi) / 2)).padStart(15, "0")}-${me.pid}.json`;
}

export function move(name, after, { bench = BENCH_DIR, by = "judge" } = {}) {
  const tickets = readTickets(bench);
  const me = tickets.find((t) => t.name === name);
  const id = movedId(tickets, name, after);
  renameSync(path.join(queueDir(bench), me.id), path.join(queueDir(bench), id));
  appendFileSync(path.join(queueDir(bench), "moves.log"), `${new Date().toISOString()} ${by}: ${name} after ${after} (${me.id} -> ${id})\n`);
  return id;
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

// ready(lanes) -> { ok }: asked before a grant (a pair's free cores); not
// ok, the ticket is held `holdSec` and asked again, `giveUpSec` at most,
// then waitTurn returns null with its ticket gone. Its errors are thrown.
export async function waitTurn({ pid, kind, lanes = "auto", name, estMin = null, owner = null, bench = BENCH_DIR, pollSec = 15, ready = null, holdSec = 60, giveUpSec = 1800, log = () => {} }) {
  if (!["pair", ...WHOLE_BENCH].includes(kind)) throw new Error(`--kind ${kind}: pair, build or multi`);
  if (!["auto", ...LANES].includes(lanes)) throw new Error(`--lanes ${lanes}: auto, ${LANES.join(", ")}`);
  mkdirSync(queueDir(bench), { recursive: true });
  const me = { id: `${String(Date.now()).padStart(15, "0")}-${pid}.json`, pid, host: os.hostname(), kind, lanes, name, estMin, owner, at: new Date().toISOString(), lane: null };
  writeTicket(bench, me);
  let said = null, busySince = null;
  for (;;) {
    const tickets = readTickets(bench);
    // Our ticket as it is now: its name changes when the judge moves it.
    const mine = tickets.find((t) => t.pid === pid && t.host === me.host);
    if (mine) me.id = mine.id;
    else writeTicket(bench, me); // removed by hand: back in at its old place
    const step = nextStep(me, mine ? tickets : readTickets(bench), (l) => laneBusy(l, { bench, tickets }));
    if (step.go && ready) {
      const r = await ready(step.go);
      if (!r.ok) {
        busySince ??= Date.now();
        if (Date.now() - busySince >= giveUpSec * 1000) {
          done(pid, bench);
          return null;
        }
        me.holdUntil = new Date(Date.now() + holdSec * 1000).toISOString();
        writeTicket(bench, me);
        if (said !== "cores") log(`queued: lane ${step.go.join(" ")}'s cores are busy, asking again every ${holdSec} s`);
        said = "cores";
        await new Promise((r) => setTimeout(r, pollSec * 1000));
        continue;
      }
      delete me.holdUntil;
    }
    if (step.go) {
      me.lane = step.go.join(" ");
      me.grantedAt = new Date().toISOString();
      writeTicket(bench, me);
      return me.lane;
    }
    if (step.wait !== said) log(`queued: ${(said = step.wait)}`);
    await new Promise((r) => setTimeout(r, pollSec * 1000));
  }
}

// Builds an agent may have queued or running at once (judge, 2026-10-22: a
// bisection once queued 14, ~2 h of bench for everyone else).
export const MAX_BUILDS_PER_OWNER = 3;
// `owner`'s builds in the queue, waiting or running (tickets of a harness
// before owners have none and are not counted).
export const ownerBuilds = (tickets, owner) => tickets.filter((t) => t.kind === "build" && t.lane !== "none" && t.owner === owner);

export function done(pid, bench = BENCH_DIR) {
  for (const t of readTickets(bench)) if (t.pid === pid && t.host === os.hostname()) rmSync(path.join(queueDir(bench), t.id), { force: true });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    pid: { type: "string" }, kind: { type: "string" }, lanes: { type: "string", default: "auto" }, name: { type: "string", default: "" },
    eta: { type: "boolean", default: false }, json: { type: "boolean", default: false }, after: { type: "string" }, "as-judge": { type: "boolean", default: false },
    cores: { type: "string", multiple: true, default: [] }, "cores-out": { type: "string" }
  } });
  if (cmd === "list") {
    // A running ticket of an older harness has no grantedAt: its lane lock's
    // owner says when it started.
    const lockStart = (lane) => { try { return JSON.parse(readFileSync(path.join(laneLock(lane), "owner"), "utf8")).startedAt; } catch { return null; } };
    const tickets = readTickets().map((t) => (t.lane && t.lane !== "none" && !t.grantedAt ? { ...t, grantedAt: lockStart(t.lane.split(" ")[0]) ?? undefined } : t));
    const rows = values.eta ? eta(tickets) : tickets;
    if (values.json) return console.log(JSON.stringify(rows));
    for (const t of rows) console.log(`${t.at} ${t.kind} ${t.name} lanes:${t.lanes} ${t.lane ? `running in ${t.lane}` : "waiting"} pid ${t.pid}${values.eta && t.lane !== "none" ? ` | starts in ~${t.startsIn} min, ends in ~${t.endsIn} min` : ""}`);
    return;
  }
  if (cmd === "move") {
    if (!values["as-judge"]) throw new Error("move reorders every agent's turn: the judge's call only (--as-judge)");
    if (positionals.length !== 1 || !values.after) throw new Error("usage: spark-queue.mjs move <name> --after <name|head> --as-judge");
    console.log(`moved: ${move(positionals[0], values.after)}`);
    return;
  }
  const pid = Number(values.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("--pid <job pid> is required");
  if (cmd === "done") return done(pid);
  if (cmd !== "wait") throw new Error("usage: spark-queue.mjs wait|done|list …");
  // Progress on stderr, the lane alone on stdout. After the options, a
  // pair's race-perf options (for its estimated duration).
  const estMin = estimateMin(values.kind, positionals);
  const ready = values.cores.length ? coresReady(lanesCpus(values.cores), { exclude: pid, out: values["cores-out"] }) : null;
  const lane = await waitTurn({ pid, kind: values.kind, lanes: values.lanes, name: values.name, estMin, ready, log: (m) => console.error(`[spark-queue] ${m}`) });
  if (lane === null) {
    console.error("[spark-queue] the lane's cores stayed busy for 30 min: no turn");
    process.exitCode = 3;
    return;
  }
  console.log(lane);
}

// --cores a=15-19,10-14 (repeated): lane -> its cores (Chromium's, node's).
export function lanesCpus(specs) {
  const out = {};
  for (const spec of specs) {
    const m = /^([a-z])=(.+)$/.exec(spec);
    if (!m || !LANES.includes(m[1])) throw new Error(`--cores ${spec}: expected <lane>=<cpus>, lanes ${LANES.join(", ")}`);
    out[m[1]] = m[2];
  }
  return out;
}

// A ready() for waitTurn: the granted lane's cores free (spark-cores.mjs,
// read only), the last check written to `out` (kept with the run).
function coresReady(cpus, { exclude, out }) {
  return async (lanes) => {
    const spec = lanes.map((l) => cpus[l]).filter(Boolean).join(",");
    if (!spec) return { ok: true };
    const { checkCores } = await import("./spark-cores.mjs");
    const r = await checkCores({ cpus: spec, exclude });
    if (out) writeFileSync(out, `${JSON.stringify(r)}\n`);
    if (!r.ok) console.error(`[spark-queue] lane ${lanes.join(" ")}'s cores are busy: ${JSON.stringify(r.busy)}`);
    return r;
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(`[spark-queue] ${e.message}`); process.exitCode = 2; });
}
