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
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { checkCores, parseCpuList, parseStat, treeOf } from "../remote/spark-cores.mjs";
import { readTickets } from "../remote/spark-queue.mjs";

export const LANE_FOREIGN_PCT = 50;
export const SALON_CPUS = parseCpuList("10-19");
export const SALON_FOREIGN_MAX = 2;
export const MACHINE_LOAD_MAX = 40;
// The GPU is shared and the GB10's memory with it (unified): another user's
// process above GPU_FOREIGN_MAX % of the GPU's SMs makes a window invalid.
// 2026-10-30 01:10-01:50, every lane a run of a JIT pair fell to ~20 % speed,
// headless with video=null (our Chromium off the GPU), load1 and the cpus
// normal: nothing read the GPU then.
export const GPU_FOREIGN_MAX = 20;
// Memory (the GB10's is the GPU's too): a window is invalid when the memory
// available falls under MEM_FLOOR_MB or by more than MEM_DROP_MB during it,
// or when tasks stalled on memory (PSI "some", 10 s average) more than
// MEM_PSI_MAX % of the time at its end. The runs that fell to ~20 % on
// 2026-10-30 had their busiest thread at 32-40 %: waiting, not computing,
// which a memory bandwidth limit would not give, and memory pressure would.
// The memory controller's bandwidth is not readable here (system-wide
// counters need perf_event_paranoid <= 0; the bench has 2).
export const MEM_FLOOR_MB = 8192;
export const MEM_DROP_MB = 4096;
export const MEM_PSI_MAX = 10;

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

// `nvidia-smi pmon -c 1 -s um` -> [{ pid, sm, mem, command }] (pure,
// tested; "-" for a process with nothing to show is 0).
export function parsePmon(text) {
  const num = (v) => (v === "-" || v === undefined ? 0 : Number(v));
  return String(text).split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("#")).map((l) => {
    const f = l.trim().split(/\s+/);
    return { pid: Number(f[1]), sm: num(f[3]), mem: num(f[4]), command: f.at(-1) };
  }).filter((p) => Number.isInteger(p.pid) && p.pid > 0);
}

// The GPU now: its use, the processes on it outside every granted job's
// tree with their share of the SMs, and the memory the machine has left
// (MemAvailable: the GPU's memory is the machine's). Null where nvidia-smi
// is missing or hangs (5 s).
export function gpuNow(tickets = readTickets(), { run = (args) => execFileSync("nvidia-smi", args, { encoding: "utf8", timeout: 5000 }), ours = null } = {}) {
  let util = null, procs = [];
  try {
    util = Number(run(["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"]).trim().split("\n")[0]);
    procs = parsePmon(run(["pmon", "-c", "1", "-s", "um"]));
  } catch {
    return null;
  }
  if (!ours) {
    try { ours = oursOf(tickets, runnable().parents); } catch { ours = new Set(); }
  }
  // the bench's own Xorg (salon-xorg.service, outside every job's tree)
  // draws a headed Chromium: ours
  const foreign = procs.filter((p) => !ours.has(p.pid) && p.command !== "Xorg").sort((a, b) => b.sm - a.sm);
  const memAvailMB = (() => { try { return Math.round(Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))[1]) / 1024); } catch { return null; } })();
  return { util: Number.isFinite(util) ? util : null, foreignSm: foreign[0]?.sm ?? 0, foreign: foreign.slice(0, 3), memAvailMB };
}

// Memory now (no root): MemAvailable, PSI "some"/"full" 10 s averages, and
// the cumulative major faults and swap-ins (/proc/vmstat). Null fields where
// a file is missing (an older kernel without PSI).
export function memNow(read = (f) => readFileSync(f, "utf8")) {
  const get = (f) => { try { return read(f); } catch { return ""; } };
  const meminfo = get("/proc/meminfo"), psi = get("/proc/pressure/memory"), vmstat = get("/proc/vmstat");
  const num = (re, text) => { const m = re.exec(text); return m ? Number(m[1]) : null; };
  return {
    memAvailMB: ((kb) => (kb === null ? null : Math.round(kb / 1024)))(num(/MemAvailable:\s+(\d+)/, meminfo)),
    psiSome10: num(/^some avg10=([\d.]+)/m, psi), psiFull10: num(/^full avg10=([\d.]+)/m, psi),
    majFaults: num(/^pgmajfault (\d+)/m, vmstat), swapIns: num(/^pswpin (\d+)/m, vmstat)
  };
}

// Why a window's memory makes it invalid, from its start and end readings
// (pure, tested): [] when it is fine or unread.
export function memOver(start, end) {
  const over = [];
  const avail = [start?.memAvailMB, end?.memAvailMB].filter(Number.isFinite);
  if (avail.length && Math.min(...avail) < MEM_FLOOR_MB) over.push(`memory available ${Math.min(...avail)} MB < ${MEM_FLOOR_MB}`);
  if (Number.isFinite(start?.memAvailMB) && Number.isFinite(end?.memAvailMB) && start.memAvailMB - end.memAvailMB > MEM_DROP_MB) over.push(`memory available fell ${start.memAvailMB - end.memAvailMB} MB > ${MEM_DROP_MB} in the window`);
  if (Number.isFinite(end?.psiSome10) && end.psiSome10 > MEM_PSI_MAX) over.push(`memory pressure ${end.psiSome10} % > ${MEM_PSI_MAX}`);
  return over;
}

// The verdict from the readings (pure: tested).
export function benchJudge({ load, background, cap = null, gpu = null, mem = null }) {
  const limit = benchLimit({ cap });
  const over = [];
  if (load > limit) over.push(`load ${load} > ${limit}`);
  if (mem) over.push(...memOver(mem, mem));
  if (gpu && gpu.foreignSm > GPU_FOREIGN_MAX) over.push(`GPU: ${gpu.foreign[0].command} (pid ${gpu.foreign[0].pid}) at ${gpu.foreignSm} % > ${GPU_FOREIGN_MAX}`);
  if (background > SALON_FOREIGN_MAX) over.push(`${background} foreign runnable threads on cpus 10-19 > ${SALON_FOREIGN_MAX}`);
  return { limit, ok: over.length === 0, over };
}

// A window on the bench is overloaded when the median of its foreign counts
// on Salon's cpus is over SALON_FOREIGN_MAX, or when at least two samples in
// a row are (a burst of seconds; a single one may be a scan's own instant).
// Pair #361 (2026-10-29) let windows through at a median of 0-1 with peaks
// of 6-8 and scattered -10 to +21 % (pure: tested).
export function salonOverloaded(samples) {
  const finite = samples.filter(Number.isFinite);
  const v = [...finite].sort((a, b) => a - b);
  if (v.length > 0 && v[v.length >> 1] > SALON_FOREIGN_MAX) return true;
  return finite.some((x, i) => i > 0 && x > SALON_FOREIGN_MAX && finite[i - 1] > SALON_FOREIGN_MAX);
}

// The gate's reading on the bench: { load, limit, ok, over, lane,
// background, granted, laneBusy }. `exclude`: this job's root pid (its tree
// is ours); `cap`: an explicit --max-load.
export async function benchRead({ lane = benchLane(), exclude = process.pid, load = () => os.loadavg()[0], tickets = readTickets(), ms = 1000, cap = null } = {}) {
  const background = await measureBackground(tickets);
  const cores = await checkCores({ cpus: lane.cpus, exclude, threshold: LANE_FOREIGN_PCT, ms });
  const now = Math.round(load() * 100) / 100;
  const gpu = gpuNow(tickets);
  const mem = memNow();
  const j = benchJudge({ load: now, background, cap, gpu, mem });
  return {
    load: now, limit: j.limit, ok: j.ok && cores.ok, over: j.over, gpu, mem,
    lane: lane.lane, background, salonForeignMax: SALON_FOREIGN_MAX, granted: grantedLanes(tickets), laneBusy: cores.busy
  };
}
