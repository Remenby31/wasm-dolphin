#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Spark side, read only: are the lane's cores free of other people's work?
// The bench is shared (another user's evals run there, never touched), and
// their processes are not pinned: on 2026-10-27 two of them sat at 100 % on
// cpus 15 and 16, two of lane a's five Chromium cores, and the worker's rAF
// got two BeginFrames in three. Before a pair, spark-race.sh asks here and
// waits while any thread of a process outside the pair's own tree uses more
// than --threshold % of a core it last ran on among the lane's.
//
//   node spark-cores.mjs check --cpus 15-19,10-14 --exclude-tree <pid> [--threshold 50] [--ms 1000]
//
// Prints one JSON line ({ ok, cpus, busy: [{ pid, tid, user, comm, cpu, pct }] })
// and exits 0 when free, 3 when busy, 2 on an error. CPU shares come from two
// reads of /proc/<pid>/task/<tid>/stat --ms apart (utime + stime), thread by
// thread, not from ps's lifetime average. /proc/<pid>/stat will not do: its
// utime and stime sum every thread while its cpu is the main thread's, so an
// eval at 400 % on cpus 0-9 whose main thread slept on 12 made lane a busy,
// and a busy thread on the lane under a main thread elsewhere went unseen.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// "15-19,10-14" -> [15, 16, 17, 18, 19, 10, 11, 12, 13, 14]
export function parseCpuList(list) {
  const out = [];
  for (const part of String(list).split(",").filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`cpu list ${list}: expected n or n-m, comma-separated`);
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    for (let c = Math.min(a, b); c <= Math.max(a, b); c++) if (!out.includes(c)) out.push(c);
  }
  return out;
}

// One line of /proc/<pid>/[task/<tid>/]stat: comm, ppid, ticks (utime +
// stime), last cpu.
export function parseStat(line) {
  const close = line.lastIndexOf(")");
  const comm = line.slice(line.indexOf("(") + 1, close);
  const f = line.slice(close + 2).split(" "); // fields from 3 (state) on
  return { comm, ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), cpu: Number(f[36]) };
}

// The pids under `root` (itself included), from a pid -> ppid map.
export function treeOf(root, parents) {
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parents) if (!tree.has(pid) && tree.has(ppid)) { tree.add(pid); grew = true; }
  }
  return tree;
}

// Two snapshots (tid -> { pid, comm, ticks, cpu, user }) `ms` apart: the
// threads of processes outside `exclude` (pids) above `threshold` % of a
// core, on one of `cpus`.
export function busyOn({ before, after, ms, ticksPerSecond, cpus, exclude = new Set(), threshold = 50 }) {
  const busy = [];
  for (const [tid, b] of after) {
    const a = before.get(tid);
    if (!a || exclude.has(b.pid) || !cpus.includes(b.cpu)) continue;
    const pct = ((b.ticks - a.ticks) / ticksPerSecond / (ms / 1000)) * 100;
    if (pct > threshold) busy.push({ pid: b.pid, tid, user: b.user, comm: b.comm, cpu: b.cpu, pct: Math.round(pct) });
  }
  return busy.sort((x, y) => y.pct - x.pct);
}

// Every thread: tid -> { pid, comm, ticks, cpu, user }, and pid -> ppid.
function snapshot() {
  const threads = new Map(), parents = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const user = statSync(`/proc/${name}`).uid;
      parents.set(pid, parseStat(readFileSync(`/proc/${name}/stat`, "utf8")).ppid);
      for (const tid of readdirSync(`/proc/${name}/task`)) {
        try {
          const { comm, ticks, cpu } = parseStat(readFileSync(`/proc/${name}/task/${tid}/stat`, "utf8"));
          threads.set(Number(tid), { pid, comm, ticks, cpu, user });
        } catch {} // the thread ended meanwhile
      }
    } catch {} // the process ended meanwhile
  }
  return { threads, parents };
}

// The lane's cores, `cpus` ("15-19,10-14"), checked once: { ok, busy }.
// `exclude` is a pid whose tree is ours (the pair's shell).
export async function checkCores({ cpus, exclude = null, threshold = 50, ms = 1000 }) {
  const list = parseCpuList(cpus);
  const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100;
  const before = snapshot().threads;
  await new Promise((r) => setTimeout(r, ms));
  const { threads: after, parents } = snapshot();
  const excluded = exclude ? treeOf(Number(exclude), parents) : new Set();
  excluded.add(process.pid);
  const busy = busyOn({ before, after, ms, ticksPerSecond, cpus: list, exclude: excluded, threshold });
  return { ok: busy.length === 0, at: new Date().toISOString(), cpus, threshold, busy };
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { cpus: { type: "string" }, "exclude-tree": { type: "string" }, threshold: { type: "string", default: "50" }, ms: { type: "string", default: "1000" } },
    allowPositionals: true
  });
  if (positionals[0] !== "check" || !values.cpus) throw new Error("usage: spark-cores.mjs check --cpus 15-19,10-14 --exclude-tree <pid> [--threshold 50] [--ms 1000]");
  const result = await checkCores({ cpus: values.cpus, exclude: values["exclude-tree"], threshold: Number(values.threshold), ms: Number(values.ms) });
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 3;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 2; });
