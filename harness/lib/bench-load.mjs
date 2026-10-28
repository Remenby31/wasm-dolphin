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
// - the whole machine, against fixed bounds (never raised by what it should
//   catch: a background counted into the limit let 40 unpinned foreign
//   threads through, review of #342): load1 at most REFERENCE_BACKGROUND
//   plus PER_LANE_LOAD per lane granted in the queue, never above the cores
//   nor an explicit --max-load; the runnable threads outside every granted
//   job's tree at most REFERENCE_BACKGROUND + BACKGROUND_MARGIN; all runnable
//   threads at most the cores. load1 is a minute's average, the thread
//   counts an instant (5 samples over a second): a spike shows in the latter
//   before the former.
// Off the bench (no SPARK_LANE_CPUS): null, the caller keeps its --max-load.
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { checkCores, parseCpuList, parseStat, treeOf } from "../remote/spark-cores.mjs";
import { readTickets } from "../remote/spark-queue.mjs";

export const LANE_FOREIGN_PCT = 50;
export const PER_LANE_LOAD = 5;
// The Spark's own background with no job on it (kubelet, apiserver, weed):
// load1 5-6, 2026-10-28.
export const REFERENCE_BACKGROUND = 6;
export const BACKGROUND_MARGIN = 6;

export function benchLane(env = process.env) {
  if (!env.SPARK_LANE_CPUS) return null;
  return { lane: env.SPARK_LANE ?? null, cpus: env.SPARK_LANE_CPUS, list: parseCpuList(env.SPARK_LANE_CPUS) };
}

// Granted on this host (the queue's tickets carry their host).
const granted = (tickets, host) => tickets.filter((t) => t.lane && t.lane !== "none" && t.host === host);

// Lanes granted in the queue (a build or a multi holds both).
export function grantedLanes(tickets, host = os.hostname()) {
  return new Set(granted(tickets, host).flatMap((t) => t.lane.split(" "))).size;
}

// The load1 limit: REFERENCE_BACKGROUND plus PER_LANE_LOAD per granted lane
// (at least this job's own), at most the cores and an explicit --max-load (cap).
export function benchLimit({ granted, cores = os.cpus().length, cap = null }) {
  const limit = Math.min(cores, REFERENCE_BACKGROUND + PER_LANE_LOAD * Math.max(1, granted), Number.isFinite(cap) && cap > 0 ? cap : Infinity);
  return Math.round(limit * 10) / 10;
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

// Runnable threads now, averaged over `samples`: all of them (total) and
// those of processes outside every granted job's tree (background; the jobs'
// shells are their tickets' pids).
export async function measureBackground(tickets, { samples = 5, everyMs = 200 } = {}) {
  let foreign = 0, all = 0;
  for (let i = 0; i < samples; i++) {
    const { pids, parents } = runnable();
    const ours = new Set();
    for (const t of granted(tickets, os.hostname())) for (const p of treeOf(t.pid, parents)) ours.add(p);
    foreign += pids.filter((p) => !ours.has(p)).length;
    all += pids.length;
    if (i < samples - 1) await new Promise((r) => setTimeout(r, everyMs));
  }
  const avg = (n) => Math.round((n / samples) * 10) / 10;
  return { background: avg(foreign), total: avg(all) };
}

// The machine-wide verdict from the readings (pure: tested).
export function benchJudge({ load, background, total, granted, cores = os.cpus().length, cap = null }) {
  const limit = benchLimit({ granted, cores, cap });
  const backgroundLimit = REFERENCE_BACKGROUND + BACKGROUND_MARGIN;
  const over = [];
  if (load > limit) over.push(`load ${load} > ${limit}`);
  if (background > backgroundLimit) over.push(`background ${background} > ${backgroundLimit} runnable threads`);
  if (total > cores) over.push(`${total} runnable threads > ${cores} cores`);
  return { limit, backgroundLimit, ok: over.length === 0, over };
}

// The gate's reading on the bench: { load, limit, ok, over, lane,
// background, total, granted, laneBusy }. `exclude`: this job's root pid
// (its tree is ours); `cap`: an explicit --max-load.
export async function benchRead({ lane = benchLane(), exclude = process.pid, load = () => os.loadavg()[0], tickets = readTickets(), ms = 1000, cap = null } = {}) {
  const granted = grantedLanes(tickets);
  const { background, total } = await measureBackground(tickets);
  const cores = await checkCores({ cpus: lane.cpus, exclude, threshold: LANE_FOREIGN_PCT, ms });
  const now = Math.round(load() * 100) / 100;
  const j = benchJudge({ load: now, background, total, granted, cap });
  return {
    load: now, limit: j.limit, ok: j.ok && cores.ok, over: j.over,
    lane: lane.lane, background, backgroundLimit: j.backgroundLimit, total, granted, laneBusy: cores.busy
  };
}
