#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Spark side, read only: are the lane's cores free of other people's work?
// The bench is shared (another user's evals run there, never touched), and
// their processes are not pinned: on 2026-10-27 two of them sat at 100 % on
// cpus 15 and 16, two of lane a's five Chromium cores, and the worker's rAF
// got two BeginFrames in three. Before a pair, spark-race.sh asks here and
// waits while any process outside the pair's own tree uses more than
// --threshold % of a core it last ran on among the lane's.
//
//   node spark-cores.mjs check --cpus 15-19,10-14 --exclude-tree <pid> [--threshold 50] [--ms 1000]
//
// Prints one JSON line ({ ok, cpus, busy: [{ pid, user, comm, cpu, pct }] })
// and exits 0 when free, 3 when busy. CPU shares come from two reads of
// /proc/<pid>/stat --ms apart (utime + stime), not from ps's lifetime average.
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

// One line of /proc/<pid>/stat: comm, ppid, ticks (utime + stime), last cpu.
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

// Two snapshots (pid -> { comm, ppid, ticks, cpu, user }) `ms` apart: the
// processes outside `exclude` above `threshold` % of a core, on one of `cpus`.
export function busyOn({ before, after, ms, ticksPerSecond, cpus, exclude = new Set(), threshold = 50 }) {
  const busy = [];
  for (const [pid, b] of after) {
    const a = before.get(pid);
    if (!a || exclude.has(pid) || !cpus.includes(b.cpu)) continue;
    const pct = ((b.ticks - a.ticks) / ticksPerSecond / (ms / 1000)) * 100;
    if (pct > threshold) busy.push({ pid, user: b.user, comm: b.comm, cpu: b.cpu, pct: Math.round(pct) });
  }
  return busy.sort((x, y) => y.pct - x.pct);
}

function snapshot() {
  const out = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const s = parseStat(readFileSync(`/proc/${name}/stat`, "utf8"));
      out.set(Number(name), { ...s, user: statSync(`/proc/${name}`).uid });
    } catch {} // the process ended meanwhile
  }
  return out;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { cpus: { type: "string" }, "exclude-tree": { type: "string" }, threshold: { type: "string", default: "50" }, ms: { type: "string", default: "1000" } },
    allowPositionals: true
  });
  if (positionals[0] !== "check" || !values.cpus) throw new Error("usage: spark-cores.mjs check --cpus 15-19,10-14 --exclude-tree <pid> [--threshold 50] [--ms 1000]");
  const cpus = parseCpuList(values.cpus);
  const ms = Number(values.ms);
  const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100;
  const before = snapshot();
  await new Promise((r) => setTimeout(r, ms));
  const after = snapshot();
  const exclude = values["exclude-tree"] ? treeOf(Number(values["exclude-tree"]), new Map([...after].map(([pid, s]) => [pid, s.ppid]))) : new Set();
  exclude.add(process.pid);
  const busy = busyOn({ before, after, ms, ticksPerSecond, cpus, exclude, threshold: Number(values.threshold) });
  console.log(JSON.stringify({ ok: busy.length === 0, at: new Date().toISOString(), cpus: values.cpus, threshold: Number(values.threshold), busy }));
  process.exitCode = busy.length ? 3 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exitCode = 2; });
