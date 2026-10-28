// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The load gate on the DGX Spark bench (spark-race.sh exports SPARK_LANE and
// SPARK_LANE_CPUS), in place of a fixed --max-load on the whole machine. Two
// lanes now run at once (lane b screens next to lane a pairs, spark-queue
// backfill): a lane a pair at --max-load 5 saw load 6-9 from the other lane's
// Chromium and gave every run up (2026-10-28, seq-aa-lane-a). So:
// - the lane's own cores: no thread of a process outside this job's tree
//   above LANE_FOREIGN_PCT % of one of them (spark-cores busyOn, per thread);
// - the whole machine, against a real spike only: load1 at most the
//   background (runnable threads outside every granted job's tree) plus
//   PER_LANE_LOAD per lane granted in the queue.
// Off the bench (no SPARK_LANE_CPUS): null, the caller keeps its --max-load.
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { checkCores, parseCpuList, parseStat, treeOf } from "../remote/spark-cores.mjs";
import { readTickets } from "../remote/spark-queue.mjs";

export const LANE_FOREIGN_PCT = 50;
export const PER_LANE_LOAD = 5;

export function benchLane(env = process.env) {
  if (!env.SPARK_LANE_CPUS) return null;
  return { lane: env.SPARK_LANE ?? null, cpus: env.SPARK_LANE_CPUS, list: parseCpuList(env.SPARK_LANE_CPUS) };
}

// Lanes granted in the queue (a build or a multi holds both).
export function grantedLanes(tickets) {
  return new Set(tickets.filter((t) => t.lane && t.lane !== "none").flatMap((t) => t.lane.split(" "))).size;
}

// The global limit: the background plus PER_LANE_LOAD per granted lane (at
// least this job's own).
export function benchLimit({ background, granted }) {
  return Math.round((background + PER_LANE_LOAD * Math.max(1, granted)) * 10) / 10;
}

// Runnable (R) or uninterruptible (D) threads, each with its process: what
// load1 counts, sampled.
function runnable() {
  const out = [], parents = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      parents.set(Number(name), parseStat(readFileSync(`/proc/${name}/stat`, "utf8")).ppid);
      for (const tid of readdirSync(`/proc/${name}/task`)) {
        try {
          const line = readFileSync(`/proc/${name}/task/${tid}/stat`, "utf8");
          const state = line.slice(line.lastIndexOf(")") + 2, line.lastIndexOf(")") + 3);
          if (state === "R" || state === "D") out.push(Number(name));
        } catch {} // gone meanwhile
      }
    } catch {} // gone meanwhile
  }
  return { pids: out, parents };
}

// The background: runnable threads of processes outside every granted job's
// tree (the jobs' shells are their tickets' pids), averaged over `samples`.
export async function measureBackground(tickets, { samples = 5, everyMs = 200 } = {}) {
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const { pids, parents } = runnable();
    const ours = new Set();
    for (const t of tickets.filter((x) => x.lane && x.lane !== "none" && x.host === os.hostname())) for (const p of treeOf(t.pid, parents)) ours.add(p);
    sum += pids.filter((p) => !ours.has(p)).length;
    if (i < samples - 1) await new Promise((r) => setTimeout(r, everyMs));
  }
  return Math.round((sum / samples) * 10) / 10;
}

// The gate's reading on the bench: { load, limit, ok, lane, background,
// granted, laneBusy }. `exclude`: this job's root pid (its tree is ours).
export async function benchRead({ lane = benchLane(), exclude = process.pid, load = () => os.loadavg()[0], tickets = readTickets(), ms = 1000 } = {}) {
  const granted = grantedLanes(tickets);
  const background = await measureBackground(tickets);
  const limit = benchLimit({ background, granted });
  const cores = await checkCores({ cpus: lane.cpus, exclude, threshold: LANE_FOREIGN_PCT, ms });
  const now = load();
  return {
    load: Math.round(now * 100) / 100, limit, ok: now <= limit && cores.ok,
    lane: lane.lane, background, granted, laneBusy: cores.busy
  };
}
