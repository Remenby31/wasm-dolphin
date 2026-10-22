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
// pinned lane's type needs no knowing.
const PMUS = ["armv8_pmuv3_0", "armv8_pmuv3_1"];

// perf stat -x, output: counts summed per event name across PMUs.
export function parsePerfCsv(text) {
  const out = { instructions: 0, cycles: 0 };
  for (const line of text.split("\n")) {
    const [count, , event] = line.split(",");
    const n = Number(count);
    if (!Number.isFinite(n) || !event) continue; // "<not counted>", comments
    if (/\/instructions\//.test(event)) out.instructions += n;
    else if (/\/cycles\//.test(event)) out.cycles += n;
  }
  return out;
}

// The busiest thread of the renderer(s) of `profileDir`, from /proc ticks
// over `ms`: the emulated CPU thread in a race (saturated).
export async function busiestThread(profileDir, ms = 500) {
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
  return best?.tid ?? null;
}

// o.onWindow for race-perf's measure(): perf stat on the busiest thread for
// the window of each session.
export function perfCounters(outDir = mkdtempSync(path.join(os.tmpdir(), "perf-counters-"))) {
  const live = new Map();
  return async (phase, session) => {
    if (phase === "start") {
      const tid = await busiestThread(session.profileDir);
      if (!tid) return live.set(session, { error: "no renderer thread" });
      const file = path.join(outDir, `perf-${tid}-${randomBytes(3).toString("hex")}.csv`);
      const events = PMUS.flatMap((p) => [`${p}/instructions/u`, `${p}/cycles/u`]).join(",");
      const proc = spawn("perf", ["stat", "-x,", "-e", events, "-t", tid, "-o", file], { stdio: "ignore" });
      live.set(session, { proc, file, tid, comm: (() => { try { return readFileSync(`/proc/${tid}/comm`, "utf8").trim(); } catch { return null; } })() });
      return;
    }
    const c = live.get(session);
    live.delete(session);
    if (!c || c.error) return { error: c?.error ?? "not started" };
    const exited = new Promise((r) => c.proc.once("exit", r));
    c.proc.kill("SIGINT");
    await exited;
    let counts;
    try { counts = parsePerfCsv(readFileSync(c.file, "utf8")); } catch (e) { return { tid: c.tid, error: String(e.message) }; }
    rmSync(c.file, { force: true });
    return { tid: Number(c.tid), thread: c.comm, ...counts, ipc: counts.cycles ? round(counts.instructions / counts.cycles, 3) : null };
  };
}

// Host instructions per guest cycle of one window (race-perf's record).
export function instructionsPerGuestCycle(cold) {
  const c = cold?.counters;
  if (!c || c.error || !c.instructions || !cold.speed || !cold.windowMs) return null;
  return c.instructions / ((cold.speed / 100) * GUEST_HZ * (cold.windowMs / 1000));
}


// Refuses when the kernel would refuse perf (not persistent: back to 4 on reboot).
export function checkPerfAccess() {
  const paranoid = Number(readFileSync("/proc/sys/kernel/perf_event_paranoid", "utf8"));
  if (paranoid > 2) throw new Error(`--counters: kernel.perf_event_paranoid is ${paranoid} (needs <= 2; not persistent, back to 4 on reboot)`);
}
