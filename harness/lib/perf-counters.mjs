// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Hardware counters of the emulated CPU thread (Linux perf), for race-perf
// and race-multi --counters: user-mode instructions and cycles of a
// session's busiest renderer thread during the measured window, and host
// instructions per guest cycle. Needs kernel.perf_event_paranoid <= 2.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { round } from "./stats.mjs";

// The GameCube's Gekko clock: guest cycles per emulated second at 100 %.
export const GUEST_HZ = 486_000_000;
// User-mode counts on every core type's PMU (one per cluster type on the
// Spark: armv8_pmuv3_0 the A725s, armv8_pmuv3_1 the X925s); summed, so the
// pinned lane's type needs no knowing. Read from sysfs, so another arm64
// machine (the CI bench's Neoverse N2 runner) counts on its own PMUs.
const SPARK_PMUS = ["armv8_pmuv3_0", "armv8_pmuv3_1"];
export function armPmus(dir = "/sys/bus/event_source/devices") {
  try {
    const found = readdirSync(dir).filter((d) => /^armv8_pmuv3/.test(d)).sort();
    return found.length ? found : SPARK_PMUS;
  } catch {
    return SPARK_PMUS;
  }
}

// Front-end and back-end events of the X925/A725 PMUs (--counter-events
// frontend): where the cycles of a low-IPC thread go. Five, so that with
// instructions they fit the six programmable counters (cycles has its own)
// and nothing is multiplexed.
export const FRONTEND_EVENTS = ["stall_frontend", "stall_backend", "l1i_cache_refill", "itlb_walk", "br_mis_pred_retired"];

// perf stat -x, output: counts summed per event name across PMUs, and the
// smallest share of the window an event was counted in (multiplexing: under
// 100 %, perf scaled its count).
export function parsePerfCsv(text) {
  const out = { instructions: 0, cycles: 0 };
  let counted = 100;
  for (const line of text.split("\n")) {
    const [count, , event, , pct] = line.split(",");
    const n = Number(count);
    const name = /^[^/]+\/([^/]+)\//.exec(event ?? "")?.[1];
    if (!Number.isFinite(n) || !name) continue; // "<not counted>", comments
    out[name] = (out[name] ?? 0) + n;
    if (Number.isFinite(Number(pct)) && Number(pct) > 0) counted = Math.min(counted, Number(pct));
  }
  if (Object.keys(out).length > 2) out.countedPct = counted;
  return out;
}

// The events of --counter-events: "frontend" or a comma-separated list of
// PMU event names (as in /sys/bus/event_source/devices/armv8_pmuv3_1/events).
export function counterEvents(spec) {
  if (!spec) return [];
  const list = spec === "frontend" ? FRONTEND_EVENTS : spec.split(",").map((e) => e.trim()).filter(Boolean);
  for (const e of list) if (!/^[a-z0-9_]+$/.test(e) || e === "instructions" || e === "cycles") throw new Error(`--counter-events: bad event ${e}`);
  return list;
}

// The busiest thread of the renderer(s) of `profileDir`, from /proc ticks
// over `ms`: the emulated CPU thread in a race (saturated).
export async function busiestThread(profileDir, ms = 500, { withShare = false } = {}) {
  const ps = execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8", maxBuffer: 32 << 20 });
  const pids = ps.split("\n").filter((l) => l.includes(profileDir) && l.includes("--type=renderer")).map((l) => l.trim().split(/\s+/)[0]);
  const ticks = () => {
    const m = new Map();
    for (const pid of pids) for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try { const f = readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8"); const x = f.slice(f.lastIndexOf(")") + 2).split(" "); m.set(tid, Number(x[11]) + Number(x[12])); } catch {}
    }
    return m;
  };
  const a = ticks();
  // Asynchronous: the arms sample at once, so their windows start together.
  await new Promise((r) => setTimeout(r, ms));
  const b = ticks();
  let best = null;
  for (const [tid, t] of b) if (a.has(tid) && (!best || t - a.get(tid) > best.delta)) best = { tid, delta: t - a.get(tid) };
  // /proc ticks are USER_HZ (100 a second): the share of the interval it ran.
  return withShare ? (best ? { tid: best.tid, busyPct: Math.round((best.delta * 1000) / ms) } : null) : best?.tid ?? null;
}

// Every thread of the renderer(s) of `profileDir`.
export function rendererThreads(profileDir) {
  const ps = execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8", maxBuffer: 32 << 20 });
  const pids = ps.split("\n").filter((l) => l.includes(profileDir) && l.includes("--type=renderer")).map((l) => l.trim().split(/\s+/)[0]);
  const tids = [];
  for (const pid of pids) { try { tids.push(...readdirSync(`/proc/${pid}/task`)); } catch {} }
  return tids;
}

// perf stat -x, --per-thread output: the counts of each thread ("comm-tid").
export function parsePerfCsvPerThread(text) {
  const byThread = new Map();
  for (const line of text.split("\n")) {
    const m = /^(.+)-(\d+),/.exec(line);
    if (!m) continue;
    const key = m[2];
    if (!byThread.has(key)) byThread.set(key, { tid: Number(m[2]), comm: m[1], lines: [] });
    byThread.get(key).lines.push(line.slice(m[1].length + m[2].length + 2));
  }
  return [...byThread.values()].map((t) => ({ tid: t.tid, comm: t.comm, ...parsePerfCsv(t.lines.join("\n")) }));
}

// The thread that ran most over the window (most cycles): the emulated CPU
// thread. Chosen after the window, from every renderer thread's counts, not
// from 500 ms before it: on a scene at the speed cap the CPU thread naps, and
// a compiler worker could look busier at the start (p0143 heavy, 2026-10-24).
export function busiestOf(threads) {
  return threads.reduce((best, t) => (!best || (t.cycles ?? 0) > (best.cycles ?? 0) ? t : best), null);
}

// Why a window's counters cannot be the emulated CPU thread's, or null: no
// guest cycle costs under one host cycle.
export function counterSanity(w) {
  const cpg = cyclesPerGuestCycle(w);
  return cpg != null && cpg < 1 ? `cycles per guest cycle ${round(cpg, 3)} < 1: not the emulated CPU thread` : null;
}

// o.onWindow for race-perf's measure(): perf stat on every renderer thread
// over the window of each session, the busiest kept afterwards.
// `extra`: more PMU events (counterEvents), counted on the same thread and window.
export function perfCounters(outDir = mkdtempSync(path.join(os.tmpdir(), "perf-counters-")), { extra = [] } = {}) {
  const live = new Map();
  const onWindow = async (phase, session) => {
    if (phase === "start") {
      const tids = rendererThreads(session.profileDir);
      if (!tids.length) return live.set(session, { error: "no renderer thread" });
      const file = path.join(outDir, `perf-${tids[0]}-${randomBytes(3).toString("hex")}.csv`);
      const events = armPmus().flatMap((p) => ["instructions", "cycles", ...extra].map((e) => `${p}/${e}/u`)).join(",");
      const proc = spawn("perf", ["stat", "-x,", "--per-thread", "-e", events, "-t", tids.join(","), "-o", file], { stdio: "ignore" });
      live.set(session, { proc, file, threads: tids.length });
      return;
    }
    const c = live.get(session);
    live.delete(session);
    if (!c || c.error) return { error: c?.error ?? "not started" };
    const exited = new Promise((r) => c.proc.once("exit", r));
    c.proc.kill("SIGINT");
    await exited;
    let best;
    try { best = busiestOf(parsePerfCsvPerThread(readFileSync(c.file, "utf8"))); } catch (e) { return { error: String(e.message) }; }
    rmSync(c.file, { force: true });
    if (!best) return { error: "no thread counted" };
    const { tid, comm, ...counts } = best;
    return { tid, thread: comm, threadsCounted: c.threads, ...counts, ipc: counts.cycles ? round(counts.instructions / counts.cycles, 3) : null };
  };
  // A window that will never end (race-perf --run-timeout): perf stops.
  onWindow.abort = async (session) => {
    const c = live.get(session);
    live.delete(session);
    if (!c || c.error) return;
    c.proc.kill("SIGINT");
    rmSync(c.file, { force: true });
  };
  return onWindow;
}

// Host instructions per guest cycle of one window (race-perf's record): over
// the guest ticks it covered when known (--emulated-window), else from its
// speed and host length.
export function instructionsPerGuestCycle(cold) {
  const c = cold?.counters;
  if (!c || c.error || !c.instructions) return null;
  if (cold.guestTicks > 0) return c.instructions / cold.guestTicks;
  if (!cold.speed || !cold.windowMs) return null;
  return c.instructions / ((cold.speed / 100) * GUEST_HZ * (cold.windowMs / 1000));
}


// Host cycles per guest cycle of one window, as instructionsPerGuestCycle:
// the metric that decides when a change moves the IPC (instructions alone
// read region code 29 % cheaper where its cycles were equal, aot on/off
// 2026-10-23).
export function cyclesPerGuestCycle(cold) {
  const c = cold?.counters;
  if (!c || c.error || !c.cycles) return null;
  if (cold.guestTicks > 0) return c.cycles / cold.guestTicks;
  if (!cold.speed || !cold.windowMs) return null;
  return c.cycles / ((cold.speed / 100) * GUEST_HZ * (cold.windowMs / 1000));
}

// Refuses when the kernel would refuse perf (not persistent: back to 4 on reboot).
export function checkPerfAccess() {
  const paranoid = Number(readFileSync("/proc/sys/kernel/perf_event_paranoid", "utf8"));
  if (paranoid > 2) throw new Error(`--counters: kernel.perf_event_paranoid is ${paranoid} (needs <= 2; not persistent, back to 4 on reboot)`);
}
