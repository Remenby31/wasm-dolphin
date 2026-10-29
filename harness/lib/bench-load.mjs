// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The load gate on the DGX Spark bench (spark-race.sh exports SPARK_LANE and
// SPARK_LANE_CPUS), in place of a fixed --max-load on the whole machine.
// Since 2026-10-29 the Spark is shared (the user's decision): cpus 0-9 are
// Excalibur's evals, busy all the time, and 10-19 Salon's (lane a: Chromium
// 15-19, node 10-14). load1 counts the whole machine: with the evals it sat
// at 9-17 and refused or failed 3 runs in 4 of an A/A (seq-aa-lane-a-3)
// whose own cores were free. So the gate looks at Salon's cpus only:
// - the lane's own cores: no thread of a process outside this job's tree
//   above LANE_FOREIGN_PCT % of one of them (spark-cores busyOn, per thread);
// - Salon's cpus (10-19): at most SALON_FOREIGN_MAX runnable threads, last
//   run on one of them, outside every granted job's tree (5 samples over a
//   second; another user's unpinned process, apt, a stray eval);
// - the whole machine only against a collapse (memory bandwidth is shared):
//   load1 at most MACHINE_LOAD_MAX, or an explicit --max-load if lower.
// A window is judged on the median of the same count during it
// (salonForeignNow, race-perf). Off the bench (no SPARK_LANE_CPUS): null,
// the caller keeps its --max-load.
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { checkCores, parseCpuList, parseStat, treeOf } from "../remote/spark-cores.mjs";
import { readTickets } from "../remote/spark-queue.mjs";

export const LANE_FOREIGN_PCT = 50;
export const SALON_CPUS = parseCpuList("10-19");
export const SALON_FOREIGN_MAX = 2;
export const MACHINE_LOAD_MAX = 40;

export function benchLane(env = process.env) {
  if (!env.SPARK_LANE_CPUS) return null;
  return { lane: env.SPARK_LANE ?? null, cpus: env.SPARK_LANE_CPUS, list: parseCpuList(env.SPARK_LANE_CPUS) };
}

// Granted on this host (the queue's tickets carry their host).
const granted = (tickets, host) => tickets.filter((t) => t.lane && t.lane !== "none" && t.host === host);

// Lanes granted in the queue (a build holds every lane).
export function grantedLanes(tickets, host = os.hostname()) {
  return new Set(granted(tickets, host).flatMap((t) => t.lane.split(" "))).size;
}

// The load1 limit: MACHINE_LOAD_MAX, or an explicit --max-load (cap) below it.
export function benchLimit({ cap = null } = {}) {
  return Math.min(MACHINE_LOAD_MAX, Number.isFinite(cap) && cap > 0 ? cap : Infinity);
}

// Runnable (R) or uninterruptible (D) threads with their process and the cpu
// each last ran on: what load1 counts, sampled.
function runnable() {
  const out = [], parents = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const ppid = parseStat(readFileSync(`/proc/${name}/stat`, "utf8")).ppid;
      parents.set(Number(name), ppid);
      // a kernel thread (kthreadd, pid 2, and its children: kworker,
      // ksoftirqd, migration) is the machine's, not another user's work
      const kernel = Number(name) === 2 || ppid === 2;
      for (const tid of readdirSync(`/proc/${name}/task`)) {
        try {
          const line = readFileSync(`/proc/${name}/task/${tid}/stat`, "utf8");
          const state = line.slice(line.lastIndexOf(")") + 2, line.lastIndexOf(")") + 3);
          if (state === "R" || state === "D") out.push({ pid: Number(name), cpu: parseStat(line).cpu, kernel });
        } catch {} // gone meanwhile
      }
    } catch {} // gone meanwhile
  }
  return { threads: out, parents };
}

// Runnable threads on Salon's cpus outside every granted job's tree (the
// jobs' shells are their tickets' pids), kernel threads left out (per-cpu
// kworker, ksoftirqd and migration are runnable on 10-19 now and then: with
// a bound of 2 they would leave no margin, review of #355): one sample
// (pure, tested).
export function salonForeign(threads, ours, cpus = SALON_CPUS) {
  return threads.filter((t) => cpus.includes(t.cpu) && !ours.has(t.pid) && !t.kernel).length;
}

function oursOf(tickets, parents) {
  const ours = new Set();
  for (const t of granted(tickets, os.hostname())) for (const p of treeOf(t.pid, parents)) ours.add(p);
  return ours;
}

// One sample now, for a window's samples (race-perf, once a second).
export function salonForeignNow(tickets = readTickets()) {
  const { threads, parents } = runnable();
  return salonForeign(threads, oursOf(tickets, parents));
}

// The foreign count on Salon's cpus, averaged over `samples`.
export async function measureBackground(tickets, { samples = 5, everyMs = 200 } = {}) {
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const { threads, parents } = runnable();
    sum += salonForeign(threads, oursOf(tickets, parents));
    if (i < samples - 1) await new Promise((r) => setTimeout(r, everyMs));
  }
  return Math.round((sum / samples) * 10) / 10;
}

// The verdict from the readings (pure: tested).
export function benchJudge({ load, background, cap = null }) {
  const limit = benchLimit({ cap });
  const over = [];
  if (load > limit) over.push(`load ${load} > ${limit}`);
  if (background > SALON_FOREIGN_MAX) over.push(`${background} foreign runnable threads on cpus 10-19 > ${SALON_FOREIGN_MAX}`);
  return { limit, ok: over.length === 0, over };
}

// A window on the bench is overloaded when the median of its foreign counts
// on Salon's cpus is over SALON_FOREIGN_MAX (pure: tested).
export function salonOverloaded(samples) {
  const v = samples.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length > 0 && v[v.length >> 1] > SALON_FOREIGN_MAX;
}

// The gate's reading on the bench: { load, limit, ok, over, lane,
// background, granted, laneBusy }. `exclude`: this job's root pid (its tree
// is ours); `cap`: an explicit --max-load.
export async function benchRead({ lane = benchLane(), exclude = process.pid, load = () => os.loadavg()[0], tickets = readTickets(), ms = 1000, cap = null } = {}) {
  const background = await measureBackground(tickets);
  const cores = await checkCores({ cpus: lane.cpus, exclude, threshold: LANE_FOREIGN_PCT, ms });
  const now = Math.round(load() * 100) / 100;
  const j = benchJudge({ load: now, background, cap });
  return {
    load: now, limit: j.limit, ok: j.ok && cores.ok, over: j.over,
    lane: lane.lane, background, salonForeignMax: SALON_FOREIGN_MAX, granted: grantedLanes(tickets), laneBusy: cores.busy
  };
}
