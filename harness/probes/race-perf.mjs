#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Steady-state speed of one scene, trunk against head. Each run loads a
// savestate, holds a key (the accelerator in a race), lets the scene settle,
// then measures a window with nothing attached: no CDP profiler and no page
// call at all until the window ends (a sampling profiler alone costs 15-20
// points). Approach and pitfalls from the WebGPU agent's probe.
//
//   node harness/probes/race-perf.mjs --iso disc.iso --state scene.sav --port N
//     [--baseline <git ref | dir>] [--candidate <git ref | dir>]   (default: this tree)
//     [--config wgpu | --query "..."] [--phase steady|postload] [--warmup 25] [--secs 20]
//     [--runs 4 (even with --baseline)] [--min-pairs 4] [--hold KeyX] [--warm]
//     [--max-load L] [--load-wait 300] [--lock-wait 1800]
//     [--counters [--counter-events frontend|e1,e2 | macOS: delivery|discarded|discarded_indirect|bottlenecks]] [--pcsample [periodMs] [--pc-raw]] [--symbols functions.json] [--out dir]
//     [--headroom [--frames-per-vi-ref R]] [--display] [--unique-frames secs] [--region-sample N [--region-secs 10]] [--mem-stats [--mem-warm 5]] [--baseline-query "..."]
//     [--calm-wait S (default --lock-wait): wait for load ≤ --max-load before taking the lock]
//     [--chrome-args "--flag …"] [--baseline-chrome-args "--flag …"]
//     [--emulated-window S [--emulated-warmup W (default --warmup)] [--emulated-poll-ms 100]]
//
// - Pairing and interleaving: run i measures both sides back to back, the
//   order alternating (base, head | head, base | …), so drift on the machine
//   hits both sides alike; the change is the median of per-run ratios.
// - Speed is the core's own (VI ticks over host time from the VI timeline),
//   never the page's gameSpeed (5-8 points higher): one measure only.
// - Machine load: the 1-minute load must be under --max-load (default: a
//   quarter of the cores) before each side, and a window whose median load
//   is above it fails. Never waited for under the perf lock: loaded, the
//   lock goes back, the calm is awaited up to --load-wait s outside it, the
//   lock is taken again in turn and the run played again (both sides); at
//   most 3 times, and no calm within --load-wait gives the runs up.
// - The runs are even and the pairs balanced in order (trunk first as often
//   as head first), with at least --min-pairs valid pairs; otherwise the
//   change is withheld and the probe exits non-zero.
// - The shared perf lock (~/projects/gc-web-emu/.perf-lock) is taken before
//   the first launch and released on every exit path.
// - Every run checks that the core it loaded is the one asked for (coreid in
//   the query, or the side's own core): a mismatch fails the run.
// - --pcsample samples the guest PC from a worker of its own during the
//   window (no CDP): where the emulated CPU spends its time. Real-time
//   sampling: it cannot tell "more work" from "the same work, slower".
// - --chrome-args: extra Chromium flags for both sides (space-separated,
//   each starting with --); --baseline-chrome-args replaces them on the
//   baseline side, so one tree can be compared with itself under two
//   Chromium configurations (e.g. --js-flags=--no-liftoff). Recorded in
//   summary.json (chrome.sideArgs): such a result is never stock Chrome for
//   kpi-report. Each run also records bootMs, from the Chrome launch to the
//   session ready (boot, compilations included).
// - --counters on macOS (no root): xctrace's CPU Counters, attached to the
//   renderer for the window (lib/xctrace-counters.mjs; never Instruments'
//   window). --counter-events names the guided mode: delivery (default:
//   I-cache, iTLB, other latency and bandwidth fractions of the front end),
//   discarded, discarded_indirect, bottlenecks. The busiest thread's EL0
//   cycles give cyclesPerGuestCycle; each window also gets
//   perKiloGuestCycles (host cycles, and the cycles each fraction stands
//   for, per 1000 guest cycles), with perKiloChange in a pair. Each trace
//   (~150 MB a second) is deleted once read.
// - --run-timeout S (default 1800, 0 = none): a side's measure that has not
//   ended after S host seconds fails its run (timedOut); the session closes,
//   the window's counters stop, and two such runs in a row give up the rest.
// - A homebrew (harness/homebrew/out or the committed fixtures, the only discs
//   allowed in CI) needs no --state: it is measured from its boot.
//   --pin-cpu-thread N (Linux) then moves the busiest renderer thread, the
//   emulated CPU thread, alone onto vCPU N (.github/workflows/bench.yml).
// - --emulated-window S: the window is S GUEST seconds instead of --secs host
//   seconds. With a host-time window the faster side covers another stretch
//   of the scene (another idle share), which biases the pair (PROGRAM.md,
//   2026-10-22). Each run loads the savestate, pauses, presses the key,
//   resumes, runs W guest seconds, then measures S guest seconds; node polls
//   the core's ticks every --emulated-poll-ms during the window (the one
//   page call allowed in it). speed is then guest seconds covered over host
//   seconds; the run records guestTicksStart/End, guestSecondsCovered,
//   hostMs, overshootTicks and speedVi (the VI timeline's, same span), and
//   --counters are divided by the ticks covered.
// - --warm boots again in the same profile (JIT cache in IndexedDB) and
//   measures again: cold and warm caches on the same run.
// - Region JIT counters (P4, lib/jit-region-stats.mjs): off by default. With
//   --region-sample N, after the speed window (never during it: the counters
//   and their timers cost time), a separate stats window of --region-secs
//   resets them (host time sampled on 1 call in N, 0 = counters only) and
//   reads them. summary.json carries the pooled shares of the cold stats
//   windows as p4 (candidate) and baselineP4; a core without the export
//   gives p4: null with the reason (p4Why), never a failure. A core with the
//   256-byte struct also gives the idle-skipped cycles, taken out of
//   regionCycleShare (PROGRAM.md, 2026-10-20), the idle time apart
//   (idleTimeShare), and its diagnostics (p4.diagnostics). The speed
//   windows are identical with or without it; p4 is compared between sides
//   only when both have it (p4Compare).
// - --worker-read a,b: worker requests (cumulative counters, e.g. a patch's
//   validationRead* export) called just before and just after the speed
//   window; each window carries workerReads[name] = { start, end, delta }
//   (delta: end - start per numeric field but the reply's id). A request the core lacks gives
//   its error, never a failure.
// - --worker-set 'name={json}' (candidate) / --baseline-worker-set (baseline,
//   default none): validationSet* worker requests sent once the side's page
//   is open, before its windows, e.g. a diagnosis perturbation on one side
//   only ('validationSetWgpuPerturbation={"readbackNoMap":true}'); several
//   separated by ';'. Each reply is kept in the run (workerSets).
// - --headless: Chrome headless even when HARNESS_DISPLAY says x11 (the
//   summary's chrome.display and chrome.displayArgs give the mode used).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { exportRef } from "../cli.mjs";
import { defaultDisplay, ensureServer, loadHarnessState, readCoreProgress, readFrameInfo, readTimeline, REPO_ROOT, workerRequest, X11_ARGS } from "../lib/browser.mjs";
import { PRESETS, SCENE_PROTOCOLS, sceneProtocolCheck, visualProbeCheck, xfbDecodeOff } from "../lib/matrix.mjs";
import { claim, release } from "../lib/ownership.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { MIN_BATTERY_PERCENT, powerDrained, powerSnapshot } from "../lib/system.mjs";
import { openSession, rebootSession } from "../lib/session.mjs";
import { calmThenLock, calmUnderLock, defaultMaxLoad, loadGaveUp } from "../lib/env.mjs";
import { describe, median, percentile, round } from "../lib/stats.mjs";
import { coreStats, displayStats, hitchList, mergeTimeline, presentationStats } from "../lib/timeline.mjs";
import { consistentRead, decodeRegionStats, poolStats, regionShares, topMisses } from "../lib/jit-region-stats.mjs";
import { consistentMemRead, decodeMemStats, memAccessShares, poolMemStats } from "../lib/mem-access-stats.mjs";
import { consistentHeadroomRead, decodeHeadroomStats, headroomOf, invalidReasons, pacingExpectation, querySpeed, unlimitedAllowed } from "../lib/headroom.mjs";
import { runSteps, validateSteps } from "../lib/steps.mjs";
import { summarizePcSamples } from "../../src/harness-pc-sampler.js";
import { busiestThread, checkPerfAccess, counterEvents, counterSanity, cyclesPerGuestCycle, instructionsPerGuestCycle, perfCounters } from "../lib/perf-counters.mjs";
import { checkXctrace, freeDiskGB, perKiloGuestCycles, xctraceCounters, xctraceNeedGB } from "../lib/xctrace-counters.mjs";
import { emulatedStart } from "../lib/emulated-window.mjs";

const HOMEBREW_OUT = path.join(REPO_ROOT, "harness", "homebrew", "out");
// Our homebrews only (no game content): built locally (out/) or the
// committed fixtures; the only discs race-perf runs in CI.
const HOMEBREW_FIXTURES = path.join(REPO_ROOT, "harness", "homebrew", "fixtures");
export const isHomebrew = (iso) => [HOMEBREW_OUT, HOMEBREW_FIXTURES].some((d) => iso.startsWith(d + path.sep));
export const STATE_ROUTE = "**/__harness_state.sav";

// The host CPU model (Linux: lscpu "Model name"), read with each window of a
// pinned run: the CI bench pairs only windows of the same model (a runner
// can be live-migrated).
export function cpuModel() {
  try {
    return /^Model name:\s*(.+)$/m.exec(execFileSync("lscpu", { encoding: "utf8" }))?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

// The busiest renderer thread (the emulated CPU thread once the game runs)
// moved alone onto `cpu` (taskset -p); { tid, cpu } or { error }.
export async function pinBusiestThread(profileDir, cpu) {
  if (process.platform !== "linux") return { error: "--pin-cpu-thread: Linux only" };
  try {
    const best = await busiestThread(profileDir, 1500, { withShare: true });
    if (!best) return { error: "no renderer thread" };
    execFileSync("taskset", ["-p", "-c", String(cpu), String(best.tid)], { stdio: "ignore" });
    const comm = readFileSync(`/proc/${best.tid}/comm`, "utf8").trim();
    return { tid: Number(best.tid), thread: comm, busyPct: best.busyPct, cpu };
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 200) };
  }
}

export function sideOrder(run) {
  return run % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
}

// Paired change of `metric` (candidate over baseline, per run index). A
// pair counts only when both sides measured; the conclusion needs at least
// `minPairs` pairs, as many with trunk first as with head first (drift over
// a campaign then hits both sides alike), otherwise it is withheld.
// A pair whose ln(candidate / baseline) lies more than OUTLIER_MADS robust
// standard deviations (1.4826 x the median absolute deviation) AND more than
// OUTLIER_MIN (5 %) from the pairs' median is set aside, named in `excluded`
// (layout A/A' 2026-10-24: one window at -25 % among pairs within 1 %); the
// floor keeps ordinary noise in when a few pairs agree so closely that the
// MAD is a fraction of a percent. The latest extra pairs of the larger order
// then go too, so both orders stay equal.
export const OUTLIER_MADS = 3;
export const OUTLIER_MIN = 0.05;
export function outlierPairs(pairs) {
  if (pairs.length < 4) return [];
  const lr = pairs.map((p) => Math.log1p(p.ratio));
  const m = median(lr), mad = median(lr.map((x) => Math.abs(x - m)));
  if (!(mad > 0)) return [];
  return pairs.filter((p, i) => Math.abs(lr[i] - m) > Math.max(OUTLIER_MADS * 1.4826 * mad, OUTLIER_MIN));
}

export function pairedSpeedChange(runs, { metric = "speed", minPairs = 4, phase = "cold" } = {}) {
  let pairs = [];
  for (const r of runs) {
    const b = r.baseline?.[phase]?.[metric], c = r.candidate?.[phase]?.[metric];
    if (Number.isFinite(b) && Number.isFinite(c) && b > 0) pairs.push({ run: r.run, first: sideOrder(r.run)[0], ratio: c / b - 1 });
  }
  const perRun = pairs.map((p) => round(p.ratio * 100, 1));
  const excluded = outlierPairs(pairs).map((p) => ({ run: p.run, pct: round(p.ratio * 100, 1), why: `outlier: more than ${OUTLIER_MADS} MAD and ${OUTLIER_MIN * 100} % from the pairs' median` }));
  pairs = pairs.filter((p) => !excluded.some((x) => x.run === p.run));
  if (excluded.length) {
    for (;;) {
      const ab = pairs.filter((p) => p.first === "baseline"), ba = pairs.filter((p) => p.first !== "baseline");
      if (ab.length === ba.length) break;
      const extra = (ab.length > ba.length ? ab : ba).at(-1);
      excluded.push({ run: extra.run, pct: round(extra.ratio * 100, 1), why: "order balance after an outlier" });
      pairs = pairs.filter((p) => p !== extra);
    }
  }
  const baseFirst = pairs.filter((p) => p.first === "baseline").length;
  const out = { pairs: pairs.length, baselineFirst: baseFirst, candidateFirst: pairs.length - baseFirst, perRun, ...(excluded.length ? { excluded } : {}), median: null, withheld: null };
  if (pairs.length < minPairs) out.withheld = `${pairs.length} valid pair(s), at least ${minPairs} needed`;
  else if (baseFirst !== pairs.length - baseFirst) out.withheld = `order unbalanced: trunk first in ${baseFirst} pair(s), head first in ${pairs.length - baseFirst}`;
  else out.median = round(median(pairs.map((p) => p.ratio)) * 100, 1);
  return out;
}

// user + system clock ticks of every thread of `pid` (Linux /proc).
function linuxThreadTicks(pid) {
  const out = new Map();
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    try {
      const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // fields from 3 (state) on
      out.set(tid, Number(f[11]) + Number(f[12])); // utime, stime (fields 14, 15)
    } catch {} // the thread ended meanwhile
  }
  return out;
}
let clockTicks = null;

// System + user CPU seconds of each thread of `pid` (macOS ps -M: a header,
// then one row per thread, the first being the main thread, not a total;
// both times as [m]m:ss.ss).
export function darwinThreadSeconds(pid, text = null) {
  const sec = (t) => { const [m, r] = t.split(":"); return Number(m) * 60 + Number(r); };
  const out = text ?? execFileSync("ps", ["-M", "-p", String(pid)], { encoding: "utf8" });
  return out.split("\n").slice(1).filter(Boolean).map((l) => {
    const t = l.match(/\d+:\d+\.\d+/g) ?? [];
    return t.length >= 2 ? sec(t[0]) + sec(t[1]) : null;
  }).filter((x) => x != null);
}

// %CPU of each thread of `pid` now, over 500 ms: on macOS from each thread's
// system + user time (ps -M, in the kernel's order; its %cpu column is a
// decaying average that still carries the boot: a thread at 18 % read 60 %,
// review of #292); on Linux from /proc (ps -L reports a lifetime average);
// null where there is no per-thread view (Windows).
function threadCpus(pid) {
  if (process.platform === "darwin") {
    const a = darwinThreadSeconds(pid);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    const b = darwinThreadSeconds(pid);
    // threads matched by row; a thread started or ended in between shifts the rows
    if (a.length !== b.length) return null;
    return b.map((t, i) => Math.round((1000 * (t - a[i])) / 0.5) / 10);
  }
  if (process.platform === "linux") {
    clockTicks ??= Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100;
    const a = linuxThreadTicks(pid);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    const b = linuxThreadTicks(pid);
    return [...b].filter(([tid]) => a.has(tid)).map(([tid, t]) => Math.round((1000 * (t - a.get(tid))) / clockTicks / 0.5) / 10);
  }
  return null;
}

// The renderer of this profile and the CPU of its busiest threads.
export function rendererThreads(profileDir) {
  return processThreads(profileDir, "renderer");
}

// The same for Chrome's GPU process (Dawn's command execution and the
// compositor that hands out BeginFrames): on the Spark the emulator's
// presents finished ~11 ms late with the GPU itself at 17 %, whatever the
// resolution or the GPU clock, where a blank WebGPU page had no lag.
export function gpuProcessThreads(profileDir) {
  return processThreads(profileDir, "gpu-process");
}

function processThreads(profileDir, type) {
  if (!["darwin", "linux"].includes(process.platform)) return { error: `no per-thread CPU on ${process.platform}` };
  try {
    const ps = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 << 20 });
    const pids = ps.split("\n").filter((l) => l.includes(profileDir) && l.includes(`--type=${type}`)).map((l) => l.trim().split(/\s+/)[0]);
    let best = null;
    for (const pid of pids) {
      const threads = threadCpus(pid).sort((a, b) => b - a);
      if (!best || (threads[0] ?? 0) > best.busiest) best = { pid: Number(pid), busiest: threads[0] ?? null, next: threads.slice(1, 4) };
    }
    return best;
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

// Load the scene, hold the key, settle, then a window with no page call.
export async function measure(session, o) {
  const { page } = session;
  // A homebrew (no savestate) is measured from its boot.
  // --steps: a scene from input steps after the boot (e.g. menus → race).
  if (o.steps) {
    await runSteps(page, o.steps);
  } else if (o.state) {
    const loaded = await loadHarnessState(page, session.url);
    if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
  }
  let pinned = null;
  // --emulated-window: the key is pressed while the core is paused, and the
  // warmup and the window are counted in guest seconds (lib/emulated-window.mjs).
  if (o.hold && !o.emulatedWindow) await page.keyboard.down(o.hold);
  try {
    const emu = o.emulatedWindow ? await emulatedStart(page, { warmup: o.emulatedWarmup, pollMs: o.emulatedPollMs, press: o.hold ? () => page.keyboard.down(o.hold) : undefined }) : null;
    if (!emu) await page.waitForTimeout(o.warmup * 1000);
    // A core without the sampler export (older trunk) is measured anyway;
    // the run says why it has no PC histogram.
    const pcStart = o.pcsample ? await workerRequest(page, "validationPcSampler", { action: "start", periodMs: o.pcsample }, 10000) : null;
    const sampling = Boolean(pcStart?.started);
    // o.onWindow (race-multi's hardware counters): called just before and
    // just after the window, from node only (no page call inside it).
    // --pin-cpu-thread N (Linux): the emulated CPU thread alone on vCPU N
    // (the CI bench leaves its SMT sibling idle and the rest of Chrome on
    // the other core, through HARNESS_CHROME_PATH's taskset). After the
    // warmup and over 1.5 s: right after boot a V8 compile thread can be
    // the busiest (CI pilot, 2026-10-23).
    if (o.pinCpuThread != null) pinned = await pinBusiestThread(session.profileDir, o.pinCpuThread);
    if (o.onWindow) await o.onWindow("start", session);
    await readTimeline(page); // drop everything before the window
    // --headroom (0113): the counters reset and the core ticks read just
    // before the window, both read again just after it.
    const hrStart = o.headroom ? await headroomRead(page, 0) : null;
    // speed=unlimited with a renderer: the core's own pacing config (0150),
    // the proof that SyncOnSkipIdle is what the side claims (pacingExpectation).
    const pacingConfig = pacingExpectation(new URL(session.url).search, { decoupledUnlimited: o.decoupledUnlimited })
      ? await workerRequest(page, "validationReadPacingConfig", {}, 10000).catch((e) => ({ error: String(e.message || e) }))
      : undefined;
    // A scene whose region stats must cover the window itself (matrix.mjs
    // regionStatsInWindow): reset now, read just after the window.
    const regionInWindow = o.regionInWindow && o.regionSample != null;
    const readsStart = await workerReads(page, o.workerRead);
    if (regionInWindow) await workerRequest(page, "validationReadJitRegionStats", { sampleEvery: o.regionSample }, 10000);
    // The emulated time this host-time window covers (judge, 2026-10-22: a
    // faster side covers more of the scene): core ticks just before and just
    // after, outside the window.
    const ticksBefore = (await readCoreProgress(page).catch(() => null))?.coreTicks ?? null;
    const t0 = await page.evaluate(() => performance.timeOrigin + performance.now());
    // The window: node timers only. The rings (VI 8192, presents 16384)
    // hold far more than a window, so nothing is read until it ends.
    const loads = [], threads = [], gpuThreads = [];
    // Emulated: node polls the guest ticks (one worker call per poll).
    const emulated = emu && await emu.window(o.emulatedWindow, {
      poll: (t, fraction) => {
        loads.push(os.loadavg()[0]);
        if (fraction >= 0.5 && threads.length === 0) {
          threads.push(rendererThreads(session.profileDir));
          gpuThreads.push(gpuProcessThreads(session.profileDir));
        }
      }
    });
    for (let s = 0; !emu && s < o.secs; s += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      loads.push(os.loadavg()[0]);
      if (s === Math.floor(o.secs / 2)) {
        threads.push(rendererThreads(session.profileDir));
        gpuThreads.push(gpuProcessThreads(session.profileDir));
      }
    }
    const hrEnd = hrStart && !hrStart.error ? await headroomRead(page) : null;
    const readsEnd = await workerReads(page, o.workerRead);
    const regionInWindowEnd = regionInWindow ? await workerRequest(page, "validationReadJitRegionStats", {}, 10000) : null;
    const counters = o.onWindow ? await o.onWindow("end", session) : undefined;
    const chunk = await readTimeline(page);
    const t1 = await page.evaluate(() => performance.timeOrigin + performance.now());
    const pc = sampling ? await workerRequest(page, "validationPcSampler", { action: "stop" }, 20000) : pcStart && { error: pcStart.error ?? "not started" };
    threads.push(rendererThreads(session.profileDir));
    gpuThreads.push(gpuProcessThreads(session.profileDir));
    const info = await readFrameInfo(page);
    const progress = await readCoreProgress(page);
    const ticksAfter = progress?.coreTicks ?? null;
    const timeline = mergeTimeline([chunk]);
    const core = coreStats(timeline, { ticksPerSecond: progress?.coreTicksPerSecond, until: t1 });
    const pres = presentationStats(timeline);
    const viMs = timeline.vi.slice(1).map((v, i) => v.t - timeline.vi[i].t);
    const xfbDt = /xfb_dt:([\d.]+) avg:([\d.]+) max:([\d.]+)/.exec(String(info?.ppcWasmHelperStats ?? ""));
    // CachedInterpreter code space (patch 0138): cache clears (all, and
    // because the space was full) and the highest offset written, since boot.
    // readFrameInfo keeps FRAME_FIELDS only: the helper stats string is read
    // from the page's last frame info directly.
    const helperStats = info?.ppcWasmHelperStats ?? await page.evaluate(() => window.__lastFrameInfo?.ppcWasmHelperStats ?? null).catch(() => null);
    const code = /codeclears:(\d+) codefull:(\d+) codehighkib:(\d+) codesizemib:(\d+)/.exec(String(helperStats ?? ""));
    const medianLoad = median(loads);
    // Unique images (--unique-frames): a window of its own after the speed
    // window (its GPU readbacks never weigh on the speed), before the stats.
    let uniqueFrames = null;
    if (o.uniqueFrames) {
      // Off until now: no readback may have happened (readbacksBefore 0).
      const before = await workerRequest(page, "validationUniqueFrames", { action: "status" }, 10000);
      const started = await workerRequest(page, "validationUniqueFrames", { action: "start" }, 10000);
      if (started?.started) {
        await new Promise((r) => setTimeout(r, o.uniqueFrames * 1000));
        uniqueFrames = { ...(await workerRequest(page, "validationUniqueFrames", { action: "stop" }, 20000)), readbacksBefore: before?.readbacksTotal ?? null };
      } else {
        uniqueFrames = { error: started?.error ?? "unique-frame counter did not start" };
      }
    }
    // The stats window, after everything the speed window reads.
    // --mem-stats (0117) shares that window: both are reset together and
    // read after it. The core's first reset clears the JIT cache (blocks are
    // emitted again with their counts), so it is made --mem-warm seconds
    // before the window, and the window starts with a second reset (no cache
    // clear): the recompiles and interpreted runs stay out of it.
    let regionEnd = regionInWindowEnd, memEnd = null;
    if (o.memStats && o.memWarm > 0) {
      const first = await workerRequest(page, "validationReadMemAccessStats", { reset: 0 }, 10000);
      if (first && !first.error) await new Promise((r) => setTimeout(r, o.memWarm * 1000));
    }
    if ((o.regionSample != null && !regionInWindow) || o.memStats) {
      if (o.regionSample != null && !regionInWindow) regionEnd = await workerRequest(page, "validationReadJitRegionStats", { sampleEvery: o.regionSample }, 10000);
      if (o.memStats) memEnd = await workerRequest(page, "validationReadMemAccessStats", { reset: 0 }, 10000);
      const live = (r) => r && !r.error;
      if (live(regionEnd) || live(memEnd)) {
        await new Promise((r) => setTimeout(r, o.regionSecs * 1000));
        if (live(regionEnd)) regionEnd = await workerRequest(page, "validationReadJitRegionStats", {}, 10000);
        if (live(memEnd)) memEnd = await workerRequest(page, "validationReadMemAccessStats", {}, 10000);
      }
    }
    // Regions the engine set aside without the core ever seeing them (another
    // heap layout, 0078; heap patches, 0084): read even without
    // --region-sample, so that a launch running without its region cache
    // never goes unnoticed (2026-10-22: 0/143 on a loaded machine).
    const pipeline = regionEnd ? null : await workerRequest(page, "validationReadJitRegionStats", {}, 10000).catch(() => null);
    // The FMA emitter's mode (patch 0129): relaxed_madd fused or the plain-f64 path.
    const relaxedMadd = await workerRequest(page, "validationReadRelaxedMadd", {}, 10000).catch(() => null);
    return {
      windowMs: Math.round(t1 - t0),
      ...(pacingConfig ? { pacingConfig } : {}),
      ...(o.workerRead.length ? { workerReads: workerReadDeltas(readsStart, readsEnd) } : {}),
      relaxedMadd: relaxedMadd?.mode ?? null, fusedMadd: relaxedMadd?.coreFused ?? null,
      // Guest seconds this window covered (core ticks / ticks per second);
      // the reads bracket the window, so a few host ms more than windowMs.
      guestCovered: guestCovered(ticksBefore, ticksAfter, progress?.coreTicksPerSecond),
      load1: { min: round(Math.min(...loads), 2), median: round(medianLoad, 2), max: round(Math.max(...loads), 2), limit: o.maxLoad },
      overloaded: medianLoad > o.maxLoad,
      complete: timeline.complete,
      timelineLost: timeline.lost,
      ...(o.headroom ? { headroom: hrStart?.error ? { error: hrStart.error } : hrEnd?.error ? { error: hrEnd.error } : headroomOf(hrEnd.stats, { guestSeconds: (hrEnd.ticks - hrStart.ticks) / (hrEnd.tps || 1), ticksPerSecond: hrEnd.tps, viOutputs: timeline.vi.length }) } : {}),
      // Emulated: the speed over the guest seconds the window covered (the
      // VI timeline's own over the same span kept as speedVi).
      ...(emulated ? { ...emulated, speed: emulated.speed, speedVi: round(core.speed) } : { speed: round(core.speed) }),
      speedP5: round(core.speedP5), speedMin: round(core.speedMin),
      gameFps: info?.vis ?? null,
      presents: pres.presents, viOutputs: timeline.vi.length,
      // --display: what the screen showed (one worker rAF per BeginFrame).
      ...(o.display ? { display: displayStats(timeline) } : {}),
      presentsPerSecond: round(pres.presents / ((t1 - t0) / 1000), 1),
      ...(o.uniqueFrames ? { uniqueFrames, uniqueFpsEstimate: uniqueFrames?.uniqueShare == null ? null : round((pres.presents / ((t1 - t0) / 1000)) * uniqueFrames.uniqueShare, 1) } : {}),
      viIntervalMs: { p50: round(percentile(viMs, 50)), p99: round(percentile(viMs, 99)), max: round(viMs.length ? Math.max(...viMs) : null) },
      presentIntervalMs: { p50: round(pres.frameP50), p99: round(pres.frameP99), max: round(pres.frameMax) },
      hitchesPerMin: round(pres.hitchesPerMin),
      // Where they happen (timeline.mjs): [ms into the window, interval ms, VI since load].
      hitchList: hitchList(timeline, { origin: t0 }),
      coreprofXfbDtMaxMs: xfbDt ? Number(xfbDt[3]) : null,
      codeSpace: code ? { clears: Number(code[1]), fullClears: Number(code[2]), highKiB: Number(code[3]), sizeMiB: Number(code[4]) } : null,
      rendererThreads: threads,
      gpuProcessThreads: gpuThreads,
      freezes: { core: core.freezes?.length ?? 0, present: pres.freezes.length },
      pc: pc && !pc.error ? summarizePcSamples(pc, { functions: o.functions }) : pc,
      // --pc-raw: the whole window's histogram, not only its top 40.
      ...(o.pcRaw && pc && !pc.error ? { pcHistogram: pcHistogramOf(pc) } : {}),
      ...regionRecord(regionEnd),
      ...(pipeline && !pipeline.error ? regionPipeline(pipeline) : {}),
      ...(counters ? { counters } : {}),
      ...(pinned ? { pinned, cpuModel: cpuModel() } : {}),
      ...(o.memStats ? memRecord(memEnd) : {})
    };
  } finally {
    if (o.hold) await page.keyboard.up(o.hold).catch(() => {});
  }
}

// Headroom counters (0113) and the core ticks, read together; reset >= 0
// zeroes and turns the counters on.
// The window's phase after the state load. On the DGX Spark the first
// ~15-20 s after a load are a transient (regions installing, pipelines and
// GPU caches cold, the replay pump busy): 5 s after the load it gave 23-38
// pictures a second, ~200 ms holes and 11-21 ms of GPU per present, 20 s
// after it 60, none and 3 ms (2026-10-28, x11-bis-oldnew-w20); a state load
// 2.5 s earlier (#325) then looked like a 37 -> 24 regression. steady: the
// window from STEADY_MIN_WARMUP s on (default warmup 25, window 20); postload:
// the transient itself (default warmup 0, window 15). Without --phase, the
// warmup says which (and --display under STEADY_MIN_WARMUP is warned about).
export const STEADY_MIN_WARMUP = 20;
export function windowPhase({ phase = null, warmup = null, secs = null, display = false, warn = () => {} } = {}) {
  if (phase != null && !["steady", "postload"].includes(phase)) throw new Error(`--phase ${phase}: steady or postload`);
  if (phase === "postload") return { phase, warmup: warmup ?? 0, secs: secs ?? 15 };
  const w = warmup ?? 25;
  if (phase === "steady" && w < STEADY_MIN_WARMUP) throw new Error(`--phase steady --warmup ${w}: the first ${STEADY_MIN_WARMUP} s after the load are the post-load transient (--phase postload measures it)`);
  if (phase == null && w < STEADY_MIN_WARMUP && display) warn(`--warmup ${w} with --display: the window is in the post-load transient (the first ~${STEADY_MIN_WARMUP} s); --phase postload to measure it on purpose, --warmup ${STEADY_MIN_WARMUP}+ for the steady state`);
  return { phase: w < STEADY_MIN_WARMUP ? "postload" : "steady", warmup: w, secs: secs ?? 20 };
}

// --worker-set / --baseline-worker-set: 'validationSetX={json};validationSetY={json}'.
export function workerSetsOf(spec, flag) {
  if (spec == null || spec === "") return [];
  return String(spec).split(";").map((x) => x.trim()).filter(Boolean).map((item) => {
    const eq = item.indexOf("=");
    const name = eq < 0 ? item : item.slice(0, eq);
    if (!/^validationSet[A-Za-z]+$/.test(name)) throw new Error(`--${flag} ${name}: expected a validationSet* worker request`);
    let payload = {};
    if (eq >= 0) {
      try { payload = JSON.parse(item.slice(eq + 1)); } catch { throw new Error(`--${flag} ${name}: the payload is not JSON`); }
    }
    return { name, payload };
  });
}

// --worker-read: each request's reply (or its error), in order.
async function workerReads(page, names) {
  const out = {};
  for (const name of names) out[name] = await workerRequest(page, name, {}, 10000).catch((e) => ({ error: String(e.message || e) }));
  return out;
}

// Start, end and end - start of each numeric field (cumulative counters).
export function workerReadDeltas(start, end) {
  return Object.fromEntries(Object.keys(start).map((name) => {
    const a = start[name], b = end[name];
    const delta = a && b && !a.error && !b.error
      ? Object.fromEntries(Object.keys(b).filter((k) => k !== "id" && typeof b[k] === "number" && typeof a[k] === "number").map((k) => [k, b[k] - a[k]]))
      : null;
    return [name, { start: a, end: b, delta }];
  }));
}

async function headroomRead(page, reset = -1) {
  const r = await workerRequest(page, "validationReadHeadroomStats", { reset }, 10000).catch((e) => ({ error: String(e.message || e) }));
  if (r?.error) return { error: /Unknown upstream worker message/.test(r.error) ? "engine without validationReadHeadroomStats" : r.error };
  const p = await readCoreProgress(page).catch(() => null);
  const stats = consistentHeadroomRead(decodeHeadroomStats(r.bytes), decodeHeadroomStats(r.again));
  const ticks = Number(p?.coreTicks), tps = Number(p?.coreTicksPerSecond);
  if (!Number.isFinite(ticks) || !(tps > 0)) return { error: "no core ticks" };
  return stats.error ? { error: stats.error } : { stats, ticks, tps };
}

// --pc-raw: every sampled guest PC of a window with its count, hottest
// first ([pc hex, count]); the top 40 of summarizePcSamples left a flat race
// 17 % covered (0139 sizing, 2026-10-24).
export function pcHistogramOf({ counts }) {
  return [...(counts ?? [])].sort((a, b) => b[1] - a[1]).map(([pc, c]) => [`0x${Number(pc).toString(16).padStart(8, "0")}`, c]);
}

// A change measured while another harness held the perf lock too is not a
// measure: withheld, with the overlap as the reason.
export function withheldOnOverlap(change, overlaps) {
  if (!change || !overlaps.length) return change;
  return { ...change, median: null, withheld: `perf lock overlap: ${overlaps.map((x) => `${x.at}: ${x.why}`).join("; ")}` };
}

export function guestCovered(before, after, ticksPerSecond) {
  const n = (v) => (typeof v === "bigint" ? Number(v) : typeof v === "string" ? Number(v) : v);
  const b = n(before), a = n(after), tps = n(ticksPerSecond);
  if (![b, a, tps].every(Number.isFinite) || tps <= 0 || a < b) return null;
  return { ticks: a - b, seconds: Math.round(((a - b) / tps) * 1000) / 1000 };
}

// p4 of one stats window, or null and why (not asked, no export, torn or
// inconsistent counters).
export function regionRecord(reply) {
  if (!reply) return { p4: null, p4Why: "region stats not asked (no --region-sample)" };
  if (reply.error) return { p4: null, p4Why: /Unknown upstream worker message/.test(reply.error) ? "engine without validationReadJitRegionStats" : reply.error };
  const stats = consistentRead(decodeRegionStats(reply.bytes), decodeRegionStats(reply.again));
  if (stats.error) return { p4: null, p4Why: stats.error };
  const p4 = regionShares(stats);
  const samples = {
    ...(Array.isArray(reply.installSamples) ? { installSamples: reply.installSamples } : {}),
    // layoutRefused, the launch's heap layout (it varies between launches, and
    // the host work per guest cycle with it, bench 2026-10-22), and the 0084
    // heap patches
    ...regionPipeline(reply),
    ...(reply.regionChain ? { regionChain: reply.regionChain } : {}),
    ...(reply.regionCalls ? { regionCalls: reply.regionCalls } : {}), // 0142
    // 0156: the 64 block-start PCs with the most guest cycles outside the
    // regions in this window (pc, cycles, why)
    ...(Array.isArray(reply.missTop) && reply.missTop.length ? { missTop: reply.missTop } : {})
  };
  return p4.error ? { p4: null, p4Why: p4.error, ...samples } : { p4, p4Raw: stats, ...samples };
}

// The region pipeline counters a stats reply carries besides the stats.
export function regionPipeline(reply) {
  return {
    ...(Number.isInteger(reply.layoutRefused) ? { layoutRefused: reply.layoutRefused } : {}),
    ...(Number.isInteger(reply.layoutHash) ? { layoutHash: reply.layoutHash } : {}),
    ...(reply.layout ? { layout: reply.layout } : {}),
    ...(Number.isInteger(reply.heapPatched) ? { heapPatched: reply.heapPatched, heapPatchedBytes: reply.heapPatchedBytes ?? null, heapPatchFailed: reply.heapPatchFailed ?? null } : {}),
    // 0107: installs in throttle sleeps and the worst lateness they caused
    ...(reply.regionSleep ? { regionSleep: reply.regionSleep } : {})
  };
}

// Memory accesses per instruction of one stats window (0104), or null and why.
export function memRecord(reply) {
  if (!reply) return { memAccess: null, memAccessWhy: "not asked (no --mem-stats)" };
  if (reply.error) return { memAccess: null, memAccessWhy: /Unknown upstream worker message/.test(reply.error) ? "engine without validationReadMemAccessStats" : reply.error };
  const stats = consistentMemRead(decodeMemStats(reply.bytes), decodeMemStats(reply.again));
  if (stats.error) return { memAccess: null, memAccessWhy: stats.error };
  const shares = memAccessShares(stats);
  return shares.error ? { memAccess: null, memAccessWhy: shares.error } : { memAccess: shares, memRaw: stats };
}

// One side's memory access ratio over its stats windows (pooled counters).
export function summarizeMem(windows) {
  const recs = windows.filter(Boolean);
  const raw = recs.map((w) => w.memRaw).filter(Boolean);
  const why = [...new Set(recs.filter((w) => !w.memRaw).map((w) => w.memAccessWhy).filter(Boolean))].join("; ") || "no window";
  if (!raw.length) return { memAccess: null, why };
  const pooled = memAccessShares(poolMemStats(raw));
  if (pooled.error) return { memAccess: null, why: pooled.error };
  return { memAccess: { ...pooled, windows: raw.length, missingWindows: recs.length - raw.length }, why: raw.length < recs.length ? why : null };
}

// One side's p4 over its stats windows: shares of the pooled counters (so
// the four time shares add up to 1), the counts summed, and `windows`. Null
// with the distinct reasons when no window has counters.
export function summarizeP4(windows) {
  const recs = windows.filter(Boolean);
  const raw = recs.map((w) => w.p4Raw).filter(Boolean);
  const why = [...new Set(recs.filter((w) => !w.p4Raw).map((w) => w.p4Why).filter(Boolean))].join("; ") || "no window";
  if (!raw.length) return { p4: null, why };
  const sum = poolStats(raw);
  const pooled = regionShares(sum);
  if (pooled.error) return { p4: null, why: pooled.error };
  // Diagnostics (0075 struct of 256 bytes): the region pipeline as the last
  // window saw it, the summed chaining counters, and its top misses.
  const diagnostics = sum.diagnostics
    ? { ...Object.fromEntries(Object.entries(sum.diagnostics).filter(([k]) => !/^topMiss|^spare$/.test(k))), topMisses: topMisses(raw.at(-1)) }
    : null;
  // Region chaining (patch 0102), summed over the windows that have it.
  const chains = recs.map((w) => w.regionChain).filter(Boolean);
  if (diagnostics && chains.length) {
    diagnostics.regionChain = { enabled: chains.every((c) => c.enabled === 1) ? 1 : 0 };
    for (const k of ["chained", "outOfTime", "noRegion", "refused"]) diagnostics.regionChain[k] = chains.reduce((a, c) => a + (c[k] ?? 0), 0);
    // The most frequent transitions back to the dispatcher, summed by pc.
    for (const k of ["exitTargets", "breakEntries"]) {
      const sum = new Map();
      for (const c of chains) for (const [pc, n] of c[k] ?? []) sum.set(pc, (sum.get(pc) ?? 0) + n);
      if (sum.size) diagnostics.regionChain[k] = [...sum].sort((a, b) => b[1] - a[1]).slice(0, 12);
    }
  }
  return { p4: { ...pooled, windows: raw.length, missingWindows: recs.length - raw.length, diagnostics }, why: raw.length < recs.length ? why : null };
}

export function memSummary(runs, sides, good = (r) => r && !r.error) {
  const side = (n) => summarizeMem(runs.map((r) => r[n]).filter(good).map((r) => r.cold));
  const c = side("candidate"), b = sides.baseline ? side("baseline") : null;
  return { memAccess: c.memAccess, memAccessWhy: c.why, baselineMemAccess: b?.memAccess ?? null, baselineMemAccessWhy: b?.why ?? null };
}

// The FMA emitter's mode per side (patch 0129), as the runs saw it: one value,
// or "mixed" when the runs disagree.
export function fusedMaddSummary(runs, sides, good = (r) => r && !r.error) {
  const side = (n) => {
    const seen = [...new Set(runs.map((r) => r[n]).filter(good).map((r) => r.cold?.fusedMadd ?? null))];
    return seen.length === 1 ? seen[0] : seen.length ? "mixed" : null;
  };
  return { fusedMadd: side("candidate"), baselineFusedMadd: sides.baseline ? side("baseline") : null };
}

// p4 / baselineP4 and their reasons; the sides are compared only when both
// have counters (one side without the export is not a comparison).
export function p4Summary(runs, sides, good = (r) => r && !r.error) {
  const side = (n) => summarizeP4(runs.map((r) => r[n]).filter(good).map((r) => r.cold));
  const c = side("candidate"), b = sides.baseline ? side("baseline") : null;
  return {
    p4: c.p4, p4Why: c.why,
    baselineP4: b?.p4 ?? null, baselineP4Why: b?.why ?? null,
    p4Compare: !b ? null : c.p4 && b.p4 ? "both sides" : c.p4 || b.p4 ? `withheld: counters on the ${c.p4 ? "candidate" : "baseline"} only` : "neither side"
  };
}

// The overlap seen by the lock held now, or null. No lock held (given up
// for the load: the lock went back and was never taken again): nothing to
// check, never a TypeError.
export function lockOverlapAt(release, at) {
  const c = release?.check?.();
  return c && !c.ok ? { at, why: c.why } : null;
}

// Times a pair may let the lock go for the load before giving its runs up.
const MAX_RELOCKS = 3;

// loadGate: the load before the side (calmUnderLock, outside the lock when
// loaded); the window is then judged on its median load.
// `p`, or an error marked runTimeout once `ms` have passed (0: no limit);
// a late rejection of `p` is swallowed.
export function withRunTimeout(p, ms, what) {
  if (!ms) return p;
  let timer;
  p.catch(() => {});
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${ms / 1000} s (--run-timeout)`), { runTimeout: true })), ms); })])
    .finally(() => clearTimeout(timer));
}

async function measureSide(side, o, loadGate) {
  const server = await ensureServer({ port: o.port, root: side.root, coreCandidates: o.coreCandidates });
  // the side is judged against its gate's limit (on the bench, computed per
  // gate by lib/bench-load.mjs), recorded with it in loadGate
  if (loadGate?.limit != null) o = { ...o, maxLoad: loadGate.limit };
  try {
    const bootStart = performance.now();
    const session = await openSession({ base: server.base, server, query: side.query ?? o.query, iso: o.iso, display: o.browserDisplay, routes: o.state ? { [STATE_ROUTE]: o.state } : {}, chromeArgs: side.chromeArgs ?? [], harness: o.display ? { displayed: true } : {} });
    const record = { url: session.url, served: server.identity, core: session.core, loadGate, bootMs: round(performance.now() - bootStart, 0) };
    if (side.workerSets?.length) {
      record.workerSets = [];
      for (const { name, payload } of side.workerSets) {
        record.workerSets.push({ name, payload, reply: await workerRequest(session.page, name, payload, 10000).catch((e) => ({ error: String(e.message || e) })) });
      }
    }
    // --run-timeout: a measure that never ends (a hung page or a frozen
    // core: 64 min under the lock, 2026-10-23) fails the run; the session
    // closes and the window's counters (o.onWindow.abort) stop.
    const timed = (p, what) => withRunTimeout(p, o.runTimeoutMs, what);
    try {
      record.cold = await timed(measure(session, o), "cold window");
      if (o.warm) {
        record.warmCore = await rebootSession(session, server);
        record.warm = await timed(measure(session, o), "warm window");
      }
      // Per guest cycle: host instructions, and host cycles (which decide
      // when a change moves the IPC), for the warm window too (--warm).
      // xctrace (macOS): per 1000 guest cycles, the host cycles and the cycles
      // each fraction stands for (I-cache, iTLB, …).
      for (const w of [record.cold, record.warm]) if (w?.counters) Object.assign(w, { instructionsPerGuestCycle: instructionsPerGuestCycle(w), cyclesPerGuestCycle: cyclesPerGuestCycle(w), ...(w.counters.tool === "xctrace" ? { perKiloGuestCycles: perKiloGuestCycles(w) } : {}) });
      // Counters that cannot be the CPU thread's are kept but never paired.
      for (const w of [record.cold, record.warm]) {
        const why = w?.counters ? counterSanity(w) : null;
        if (why) { Object.assign(w, { countersRejected: why, instructionsPerGuestCycle: null, cyclesPerGuestCycle: null }); console.warn(`[race-perf] ${side.name}: counters rejected, ${why}`); }
      }
    } catch (error) {
      record.error = String(error?.message || error).slice(0, 300);
      if (error?.runTimeout) {
        record.timedOut = true;
        await o.onWindow?.abort?.(session);
      }
      // The harness lost Chrome (CDP pipe fault, lib/browser.mjs): infra.
      if (session.pipeFault()) record.infraCrash = session.pipeFault().message;
    }
    record.fatal = session.watch.fatal();
    await session.close();
    return record;
  } catch (error) {
    // core-mismatch and boot failures end up here.
    return { error: String(error?.message || error).slice(0, 300), fatal: [] };
  } finally {
    await server.stop();
  }
}

// A numeric option, rejected unless it is a finite number in range.
// Chromium flags from one option: space-separated, each a --flag.
export function chromeArgsOf(text, option) {
  const args = String(text ?? "").split(/\s+/).filter(Boolean);
  const bad = args.filter((a) => !/^--[\w-]+(=\S*)?$/.test(a) || /^--(headless|remote-debugging|user-data-dir)/.test(a));
  if (bad.length) throw new Error(`--${option}: ${bad.join(" ")} is not an extra Chromium flag this harness passes (--name or --name=value; never headless, debugging or profile flags)`);
  return args;
}

export function num(values, name, { min = -Infinity, int = false } = {}) {
  const v = Number(values[name]);
  if (values[name] == null || values[name] === "" || !Number.isFinite(v) || v < min || (int && !Number.isInteger(v))) {
    throw new Error(`--${name} ${values[name]}: expected ${int ? "an integer" : "a number"}${min > -Infinity ? ` ≥ ${min}` : ""}`);
  }
  return v;
}

// A side: a directory served as is, or a git ref exported to a temporary dir.
function resolveSide(name, spec) {
  if (!spec) return { name, label: "this tree", root: REPO_ROOT, temp: false };
  if (existsSync(spec) && statSync(spec).isDirectory()) return { name, label: path.resolve(spec), root: path.resolve(spec), temp: false };
  return { name, label: spec, root: exportRef(spec), temp: true };
}

const brief = (m) => m && `speed ${m.speed} % (p5 ${m.speedP5}) game ${m.gameFps} fps vi p99 ${m.viIntervalMs.p99} ms hitches ${m.hitchesPerMin}/min busiest thread ${m.rendererThreads.at(-1)?.busiest} % load ${m.load1.median}${m.overloaded ? " OVERLOADED" : ""}${m.pc?.samples ? ` pc ${m.pc.samples} samples` : ""}${m.layoutRefused > 0 ? ` REGIONS REFUSED FOR THE HEAP LAYOUT ${m.layoutRefused}` : ""}${m.heapPatched > 0 ? ` heap-patched ${m.heapPatched}` : ""}`;

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, state: { type: "string" },
      baseline: { type: "string" }, candidate: { type: "string" },
      config: { type: "string", default: "wgpu" }, query: { type: "string" },
      runs: { type: "string", default: "4" }, "min-pairs": { type: "string" }, "load-wait": { type: "string", default: "300" }, "calm-wait": { type: "string" }, warmup: { type: "string" }, secs: { type: "string" }, phase: { type: "string" },
      "emulated-window": { type: "string" }, "emulated-warmup": { type: "string" }, "emulated-poll-ms": { type: "string", default: "100" },
      hold: { type: "string", default: "KeyX" }, warm: { type: "boolean", default: false },
      "max-load": { type: "string" }, "lock-wait": { type: "string", default: "1800" },
      pcsample: { type: "string" }, "pc-raw": { type: "boolean", default: false }, symbols: { type: "string" }, "region-sample": { type: "string" }, "worker-read": { type: "string" }, "region-secs": { type: "string", default: "10" }, counters: { type: "boolean", default: false }, steps: { type: "string" }, "counter-events": { type: "string" }, "pin-cpu-thread": { type: "string" }, "run-timeout": { type: "string", default: "1800" }, "unique-frames": { type: "string" }, display: { type: "boolean", default: false }, "mem-stats": { type: "boolean", default: false }, "mem-warm": { type: "string", default: "5" }, headroom: { type: "boolean", default: false }, "frames-per-vi-ref": { type: "string" }, "baseline-query": { type: "string" }, "decoupled-unlimited": { type: "boolean", default: false }, "chrome-args": { type: "string" }, "baseline-chrome-args": { type: "string" }, "worker-set": { type: "string" }, "baseline-worker-set": { type: "string" }, headless: { type: "boolean", default: false },
      "core-candidate": { type: "string", multiple: true, default: [] },
      port: { type: "string", default: process.env.HARNESS_PORT }, out: { type: "string" }
    },
    allowPositionals: false
  });
  // A homebrew boots into its workload: no savestate needed (CI bench).
  if (!values.iso || !values.port || (!values.state && !isHomebrew(path.resolve(values.iso)))) {
    throw new Error("usage: race-perf.mjs --iso disc.iso --state scene.sav --port N (or HARNESS_PORT) [--baseline ref|dir] [--candidate ref|dir] [--runs 4] [--phase steady|postload] [--warmup 25] [--secs 20] [--warm] [--max-load L] [--pcsample 0.25]");
  }
  const iso = path.resolve(values.iso), state = values.state ? path.resolve(values.state) : null;
  for (const f of [iso, state].filter(Boolean)) if (!existsSync(f)) throw new Error(`not found: ${f}`);
  const localOnly = !isHomebrew(iso);
  // --steps replaces the savestate as the scene.
  const steps = values.steps ? JSON.parse(readFileSync(path.resolve(values.steps), "utf8")) : null;
  if (steps) validateSteps(steps);
  if (localOnly && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
  const query = `${values.query ?? PRESETS[values.config] ?? values.config}&metrics=1`;
  // --baseline-query: the baseline side boots with its own query (same tree
  // with and without a switch, e.g. aot=1 against the default).
  const baselineQuery = values["baseline-query"] ? `${values["baseline-query"]}&metrics=1` : null;
  // speed=unlimited decouples emulated time from the rendering while the
  // core leaves SyncOnSkipIdle off (research/deep-headroom-kpi.md §1): refused
  // unless the query turns it on (synconidle=1) or renders nothing
  // (video=null); with a renderer, each run is then invalid unless the core
  // itself reports it on (pacingExpectation, validationReadPacingConfig).
  for (const q of [query, baselineQuery].filter(Boolean)) {
    if (querySpeed(q) === "unlimited" && !unlimitedAllowed(q, { decoupledUnlimited: values["decoupled-unlimited"] === true })) throw new Error("speed=unlimited without synconidle=1 (or video=null): emulated time runs ahead of the rendering (research/deep-headroom-kpi.md); measure the headroom at speed=1 with --headroom");
  }
  if (baselineQuery && !values.baseline) throw new Error("--baseline-query needs --baseline");
  // A coreid on both sides would pin them to one core (trunk against head
  // would compare a core with itself): with --baseline, a coreid only on
  // the candidate side, the baseline keeping its own core (a lever's PR core
  // against trunk's, the CI bench's candidate_core_run).
  if (values.baseline && baselineQuery && new URLSearchParams(baselineQuery).has("coreid")) throw new Error("--baseline compares the two sides' own cores: no coreid in --baseline-query");
  if (values.baseline && !baselineQuery && new URLSearchParams(query).has("coreid")) throw new Error("--baseline compares the two sides' own cores: a coreid in --query needs a --baseline-query without it (else both sides load it)");
  const chromeArgs = chromeArgsOf(values["chrome-args"], "chrome-args");
  const baselineChromeArgs = values["baseline-chrome-args"] == null ? chromeArgs : chromeArgsOf(values["baseline-chrome-args"], "baseline-chrome-args");
  const workerSets = workerSetsOf(values["worker-set"], "worker-set");
  const baselineWorkerSets = workerSetsOf(values["baseline-worker-set"], "baseline-worker-set");
  if (values["baseline-chrome-args"] != null && !values.baseline) throw new Error("--baseline-chrome-args needs --baseline");
  const runs = num(values, "runs", { min: 1, int: true });
  if (values["counter-events"] && !values.counters) throw new Error("--counter-events needs --counters");
  if (values.baseline && runs % 2) throw new Error(`--runs ${runs}: with --baseline the runs must be even, so trunk goes first as often as head`);
  const o = {
    // Chrome's display mode: HARNESS_DISPLAY (x11: spark-run --headed),
    // else headless; --headless forces headless whatever the environment.
    browserDisplay: values.headless ? "headless" : defaultDisplay(),
    iso, state, steps, port: num(values, "port", { min: 1, int: true }), query, runs,
    // --decoupled-unlimited: speed=unlimited without synconidle=1 on purpose
    // (the cost of the CPU<->GPU coupling); an upper bound, never a KPI.
    decoupledUnlimited: values["decoupled-unlimited"] === true,
    minPairs: values["min-pairs"] ? num(values, "min-pairs", { min: 2, int: true }) : Math.min(runs, 4),
    ...windowPhase({ phase: values.phase, warmup: values.warmup == null ? null : num(values, "warmup", { min: 0 }), secs: values.secs == null ? null : num(values, "secs", { min: 2, int: true }), display: values.display, warn: (m) => console.warn(`[race-perf] ${m}`) }),
    // --emulated-window S: S guest seconds after --emulated-warmup W guest
    // seconds (default: --warmup), ticks polled every --emulated-poll-ms.
    ...(values["emulated-window"] ? {
      emulatedWindow: num(values, "emulated-window", { min: 1 }),
      emulatedWarmup: values["emulated-warmup"] == null ? (values.warmup == null ? 25 : num(values, "warmup", { min: 0 })) : num(values, "emulated-warmup", { min: 0 }),
      emulatedPollMs: num(values, "emulated-poll-ms", { min: 10, int: true })
    } : {}),
    hold: values.hold || null, warm: values.warm,
    maxLoad: values["max-load"] ? num(values, "max-load", { min: 0.1 }) : defaultMaxLoad(),
    loadWait: num(values, "load-wait", { min: 0 }),
    pcsample: values.pcsample ? num(values, "pcsample", { min: 0.05 }) : null,
    pcRaw: values["pc-raw"],
    // --mem-stats needs the region counters (its region estimates ride on
    // them): on without timers (0) unless --region-sample says otherwise.
    workerRead: (values["worker-read"] ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
      if (!/^validationRead[A-Za-z]+$/.test(x)) throw new Error(`--worker-read ${x}: expected a validationRead* worker request`);
      return x;
    }),
    regionSample: values["region-sample"] == null ? (values["mem-stats"] ? 0 : null) : num(values, "region-sample", { min: 0, int: true }),
    regionSecs: num(values, "region-secs", { min: 1 }),
    // --counters (Linux perf): host instructions per guest cycle of the
    // emulated CPU thread, per window (lib/perf-counters.mjs).
    // --counter-events frontend|e1,e2: more PMU events in the same window.
    // On macOS, xctrace's CPU Counters on the renderer instead (no root,
    // lib/xctrace-counters.mjs): host cycles and the mode's fractions;
    // --counter-events names the mode (delivery by default).
    ...(values.counters && process.platform === "darwin"
      ? (checkXctrace(), { xctrace: true, onWindow: xctraceCounters({ mode: values["counter-events"] ?? "delivery", pidOf: (session) => rendererThreads(session.profileDir)?.pid }) })
      : values.counters ? (checkPerfAccess(), { onWindow: perfCounters(undefined, { extra: counterEvents(values["counter-events"]) }) }) : {}),
    uniqueFrames: values["unique-frames"] == null ? null : num(values, "unique-frames", { min: 2 }),
    pinCpuThread: values["pin-cpu-thread"] == null ? null : num(values, "pin-cpu-thread", { min: 0, int: true }),
    runTimeoutMs: num(values, "run-timeout", { min: 0 }) * 1000,
    memStats: values["mem-stats"],
    memWarm: num(values, "mem-warm", { min: 0 }),
    headroom: values.headroom,
    // A KPI scene's pinned protocol (matrix.mjs SCENE_PROTOCOLS): region
    // stats over the window itself where the scene asks for it.
    regionInWindow: Boolean(state && SCENE_PROTOCOLS[path.basename(state)]?.regionStatsInWindow),
    framesPerViRef: values["frames-per-vi-ref"] == null ? null : num(values, "frames-per-vi-ref", { min: 0.01 }),
    display: values.display,
    functions: values.symbols ? JSON.parse(readFileSync(values.symbols, "utf8")).sort((a, b) => a[0] - b[0]) : null,
    coreCandidates: values["core-candidate"]
  };
  const sceneCheck = sceneProtocolCheck(state ? path.basename(state) : null, {
    warmup: o.emulatedWindow ? o.emulatedWarmup : o.warmup, window: o.emulatedWindow ?? o.secs, emulated: Boolean(o.emulatedWindow),
    hold: o.hold, regionSample: o.regionSample, regionStatsInWindow: o.regionInWindow
  });
  if (sceneCheck.errors.length) throw new Error(`scene protocol: ${sceneCheck.errors.join("; ")}`);
  for (const w of sceneCheck.warnings) console.warn(`[race-perf] scene protocol: ${w}`);
  const visual = visualProbeCheck([query, baselineQuery], { "--display": o.display, "--unique-frames": o.uniqueFrames != null });
  if (visual) throw new Error(visual);
  if (xfbDecodeOff(query) || xfbDecodeOff(baselineQuery)) console.warn("[race-perf] xfbdecode=0: game fps reads 0 (no decoded XFB), speed and headroom are unaffected");
  const lockWait = num(values, "lock-wait", { min: 0 });

  const sides = {};
  // Exported refs are removed on every exit, Ctrl-C included (the perf
  // lock's signal handler exits the process, which runs this).
  const dropExports = () => { for (const s of Object.values(sides)) if (s.temp && existsSync(s.root)) { release(s.root); rmSync(s.root, { recursive: true, force: true }); } };
  process.once("exit", dropExports);
  sides.candidate = { ...resolveSide("candidate", values.candidate), chromeArgs, workerSets };
  if (values.baseline) sides.baseline = { ...resolveSide("baseline", values.baseline), query: baselineQuery, chromeArgs: baselineChromeArgs, workerSets: baselineWorkerSets };
  // A calm machine first (--calm-wait, default --lock-wait), then the lock.
  const calmWait = values["calm-wait"] == null ? lockWait : num(values, "calm-wait", { min: 0 });
  const acquire = () => acquirePerfLock({ requireMains: true, name: `harness race-perf (${REPO_ROOT})`, waitSec: lockWait, log: (m) => console.log(`[race-perf] ${m}`) });
  let releaseLock = await calmThenLock({ maxLoad: o.maxLoad, calmWait, log: (m) => console.log(`[race-perf] before the lock: ${m}`), acquire });
  // A local-only disc never writes into the repo.
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const outDir = values.out ? path.resolve(values.out) : localOnly
    ? path.resolve(process.env.HARNESS_PRIVATE_OUT || path.join(REPO_ROOT, "..", "measures", "harness"), `race-perf-${stamp}`)
    : path.join(REPO_ROOT, "harness", "results", `race-perf-${stamp}`);
  mkdirSync(path.dirname(outDir), { recursive: true });
  mkdirSync(outDir);
  claim(outDir, REPO_ROOT, "results");

  const records = [];
  let gaveUp = null;
  // Two holders of the perf lock at once would measure on a shared machine:
  // checked when taken, before each run and at the end (lockIntegrity).
  const lockOverlap = [];
  const checkLock = (at) => {
    const overlap = lockOverlapAt(releaseLock, at);
    if (overlap) { lockOverlap.push(overlap); console.warn(`[race-perf] perf lock overlap detected (${at}): ${overlap.why}`); }
  };
  checkLock("taken");
  try {
    // Times each run was played again after the lock went back for the load.
    let relocks = 0, timeouts = 0, powerCounted = false;
    const loadRetries = new Map();
    for (let run = 1; run <= o.runs && !gaveUp; run += 1) {
      checkLock(`before run ${run}`);
      // xctrace traces are large: the campaign stops before the disk fills.
      if (o.xctrace && freeDiskGB() < xctraceNeedGB()) {
        gaveUp = `disk: ${round(freeDiskGB(), 1)} GB free < ${xctraceNeedGB()} GB (xctrace): remaining runs given up`;
        console.warn(`[race-perf] ${gaveUp}`);
        break;
      }
      const record = { run, loadRetries: loadRetries.get(run) ?? 0 };
      let replay = false;
      for (const name of sideOrder(run).filter((n) => sides[n])) {
        // Loaded: the lock goes back during the wait (--load-wait), and the
        // run is played again once it is taken back, both sides together.
        const g = await calmUnderLock({ lock: releaseLock, maxLoad: o.maxLoad, waitSec: o.loadWait, acquire, log: (m) => console.log(`[race-perf] run ${run} ${name}: ${m}`) });
        releaseLock = g.lock;
        gaveUp = loadGaveUp(g.gate);
        if (gaveUp) { console.warn(`[race-perf] run ${run} ${name}: ${gaveUp}`); break; }
        if (g.relocked) {
          // an unplug already counted when it was seen (below): once, not twice
          if (powerCounted) powerCounted = false;
          else relocks += 1;
          checkLock(`taken again in run ${run}`);
          if (relocks > MAX_RELOCKS) { gaveUp = `unplugged or loaded ${relocks} times (the lock let go for power or load): remaining runs given up`; console.warn(`[race-perf] ${gaveUp}`); break; }
          replay = true;
          break;
        }
        powerCounted = false; // back on mains without a relock: nothing left to discount
        const powerStart = powerSnapshot();
        const powerAtStart = powerStart?.source ?? null;
        record[name] = await measureSide(sides[name], o, g.gate);
        const r = record[name];
        // On mains but the charge fell during the side, or ended under
        // MIN_BATTERY_PERCENT (the charger not keeping up, 2026-10-29): kept
        // in the record, left out of the speeds like an overloaded run.
        const powerEnd = powerSnapshot();
        if (r && powerDrained(powerStart, powerEnd)) {
          r.powerDrained = { start: powerStart?.percent ?? null, end: powerEnd?.percent ?? null };
          console.log(`[race-perf] run ${run} ${name}: POWER, charge ${powerStart?.percent ?? "?"} -> ${powerEnd?.percent ?? "?"} % (fell or under ${MIN_BATTERY_PERCENT} %): not counted`);
        }
        // Unplugged during the side: played again, both sides, once on mains
        // (the next gate gives the lock back while on battery). A failed
        // reading (null) or AC <-> UPS is no change.
        if (powerSnapshot()?.source === "battery" && powerAtStart !== "battery") {
          console.log(`[race-perf] run ${run} ${name}: on battery during the side (${powerAtStart} → battery): not a measure`);
          // measured partly on battery: never kept, whatever comes next
          delete record[name];
          relocks += 1;
          powerCounted = true;
          if (relocks > MAX_RELOCKS) { gaveUp = `unplugged or loaded ${relocks} times (the lock let go for power or load): remaining runs given up`; console.warn(`[race-perf] ${gaveUp}`); break; }
          replay = true;
          break;
        }
        console.log(`[race-perf] run ${run} ${name}: ${r.error ?? brief(r.cold)}${r.warm ? ` | warm: ${brief(r.warm)}` : ""}`);
        // Two runs in a row that timed out: the campaign stops (the lock goes).
        timeouts = r.timedOut ? timeouts + 1 : 0;
        if (timeouts >= 2) { gaveUp = `${timeouts} runs in a row timed out (--run-timeout ${o.runTimeoutMs / 1000} s): remaining runs given up`; console.warn(`[race-perf] ${gaveUp}`); break; }
        // A window xctrace refused for the disk: the campaign stops there.
        const disk = [r.cold, r.warm].map((w) => w?.counters?.error).find((e) => /^disk:/.test(e ?? ""));
        if (o.xctrace && disk) { gaveUp = `${disk}: remaining runs given up`; console.warn(`[race-perf] ${gaveUp}`); break; }
      }
      if (replay) { loadRetries.set(run, (loadRetries.get(run) ?? 0) + 1); console.log(`[race-perf] run ${run} played again (lock taken back)`); run -= 1; continue; }
      if (gaveUp && !Object.keys(sides).some((n) => record[n])) break;
      writeFileSync(path.join(outDir, `run${run}.json`), JSON.stringify(record, null, 1) + "\n");
      records.push(record);
    }
    checkLock("end");
  } finally {
    releaseLock?.();
    dropExports();
  }
  // xctrace: its raw ktraces still open at the last window, deleted once
  // closed (outside the lock: it may wait minutes).
  const xctraceCleanup = o.onWindow?.finish ? await o.onWindow.finish() : null;
  const runsDone = records;

  // A run that breaks a validity rule (headroom.mjs invalidReasons: ring
  // overflow, speed above its target, no unique image, a frozen renderer
  // (no present or no game frame), game frames per VI
  // off the reference) is set aside with its reasons.
  for (const r of records) for (const n of Object.keys(sides)) {
    const c = r[n]?.cold;
    if (!c) continue;
    const why = invalidReasons(c, { target: querySpeed(sides[n].query ?? o.query) === "unlimited" ? null : querySpeed(sides[n].query ?? o.query), framesPerViRef: o.framesPerViRef, pacing: pacingExpectation(sides[n].query ?? o.query, { decoupledUnlimited: o.decoupledUnlimited }) });
    if (why.length) c.invalid = why;
  }
  const good = (r) => r && !r.error && !r.fatal?.length && !r.powerDrained && !r.cold?.overloaded && !r.warm?.overloaded && !r.cold?.invalid?.length;
  const summarize = (name, phase) => {
    const m = runsDone.map((r) => r[name]).filter(good).map((r) => r[phase]).filter(Boolean);
    if (!m.length) return null;
    return {
      speed: describe(m.map((x) => x.speed)), gameFps: describe(m.map((x) => x.gameFps)),
      viP99Ms: describe(m.map((x) => x.viIntervalMs.p99)), presentP99Ms: describe(m.map((x) => x.presentIntervalMs.p99)),
      hitchesPerMin: describe(m.map((x) => x.hitchesPerMin)), busiestThread: describe(m.map((x) => x.rendererThreads.at(-1)?.busiest)),
      presentsPerSecond: describe(m.map((x) => x.presentsPerSecond)),
      // --counters with xctrace: per 1000 guest cycles, and the fractions.
      ...(m.some((x) => x.perKiloGuestCycles) ? {
        perKiloGuestCycles: Object.fromEntries(Object.keys(m.find((x) => x.perKiloGuestCycles).perKiloGuestCycles).map((k) => [k, describe(m.map((x) => x.perKiloGuestCycles?.[k]), 3)])),
        counterFractions: Object.fromEntries(Object.keys(m.find((x) => x.counters?.fractions)?.counters.fractions ?? {}).map((k) => [k, describe(m.map((x) => x.counters?.fractions?.[k]), 5)]))
      } : {}),
      ...(m.some((x) => x.headroom) ? {
        headroom: describe(m.map((x) => x.headroom?.headroom), 4),
        maxSpeedCpu: describe(m.map((x) => x.headroom?.maxSpeedCpu), 4),
        maxSpeedGpu: describe(m.map((x) => x.headroom?.maxSpeedGpu), 4),
        throttleSleepShare: describe(m.map((x) => x.headroom?.throttleSleepShare), 4),
        presentSleepShare: describe(m.map((x) => x.headroom?.presentSleepShare), 4),
        xfbCopiesPerVi: describe(m.map((x) => x.headroom?.xfbCopiesPerVi), 4),
        gameFramesPerSecond: describe(m.map((x) => x.headroom?.gameFramesPerSecond), 2),
        headroomApplies: m.every((x) => x.headroom?.headroomApplies),
        headroomWhy: [...new Set(m.map((x) => x.headroom?.error).filter(Boolean))].join("; ") || null
      } : {}),
      guestSecondsCovered: describe(m.map((x) => x.guestCovered?.seconds), 3),
      ...(m.some((x) => x.display) ? {
        displayedPerSecond: describe(m.map((x) => x.display?.displayedPerSecond)),
        displayedP95: describe(m.map((x) => x.display?.displayedP95)),
        droppedPerMin: describe(m.map((x) => x.display?.droppedPerMin)),
        judderPct: describe(m.map((x) => x.display?.judderPct)),
        offOneVsyncPct: describe(m.map((x) => x.display?.offOneVsyncPct)),
        displayWhy: [...new Set(m.map((x) => (x.display?.supported === false ? x.display.why : null)).filter(Boolean))].join("; ") || null
      } : {}),
      // Unique images (--unique-frames): measured in their own window; the
      // speed window's presents/s × that window's share of new images.
      ...(m.some((x) => x.uniqueFrames) ? {
        uniqueShare: describe(m.map((x) => x.uniqueFrames?.uniqueShare), 4),
        uniqueFpsEstimate: describe(m.map((x) => x.uniqueFpsEstimate)),
        uniqueFramesWhy: [...new Set(m.map((x) => x.uniqueFrames?.error).filter(Boolean))].join("; ") || null
      } : {}),
      ...(phase === "cold" ? { bootMs: describe(runsDone.map((r) => r[name]).filter(good).map((r) => r.bootMs).filter((v) => v != null)) } : {})
    };
  };
  // The PC histogram exists on one side only when the other side's core
  // lacks the export (an older trunk): say so, it is not a comparison.
  const pcSides = o.pcsample ? Object.keys(sides).filter((n) => runsDone.some((r) => r[n]?.cold?.pc?.samples)) : [];
  const pcNote = o.pcsample && pcSides.length < Object.keys(sides).length ? `guest PC sampled on ${pcSides.join(", ") || "no side"} only` : null;
  if (pcNote) console.warn(`[race-perf] warning: ${pcNote}`);
  const failed = Object.keys(sides).flatMap((n) => runsDone.filter((r) => !good(r[n])).map((r) => ({ run: r.run, side: n, why: r[n]?.infraCrash ? "infra" : r[n]?.error ?? (r[n]?.fatal?.length ? "crash" : r[n]?.powerDrained ? `power: charge ${r[n].powerDrained.start ?? "?"} -> ${r[n].powerDrained.end ?? "?"} %` : r[n]?.cold?.invalid?.length ? `invalid: ${r[n].cold.invalid.join("; ")}` : "overloaded") })));
  // Which Chrome ran: a wrapper (HARNESS_CHROME_PATH, e.g. the E-core one) or
  // extra flags left exported would otherwise pass for a regression.
  const sideArgs = Object.fromEntries(Object.entries(sides).filter(([, s]) => s.chromeArgs?.length).map(([n, s]) => [n, s.chromeArgs.join(" ")]));
  // The display mode and the flags it adds (x11: X11_ARGS), with the result.
  const chrome = { path: process.env.HARNESS_CHROME_PATH || "chrome stable", args: process.env.HARNESS_CHROME_ARGS || "", display: o.browserDisplay, displayArgs: o.browserDisplay === "x11" ? [...X11_ARGS] : [], ...(Object.keys(sideArgs).length ? { sideArgs } : {}) };
  if (process.env.HARNESS_CHROME_PATH || process.env.HARNESS_CHROME_ARGS) console.warn(`[race-perf] Chrome: ${chrome.path}${chrome.args ? ` ${chrome.args}` : ""}`);
  for (const [n, a] of Object.entries(sideArgs)) console.warn(`[race-perf] Chrome flags on the ${n}: ${a}`);
  const summary = {
    sceneProtocol: sceneCheck.protocol ? { state: state && path.basename(state), ...sceneCheck.protocol, warnings: sceneCheck.warnings } : null,
    probe: "race-perf", at: new Date().toISOString(),
    // --decoupled-unlimited: the sides it decoupled (harness/lib/kpi.mjs
    // refuses such a result: an upper bound, not a KPI).
    ...(o.decoupledUnlimited ? { decoupledUnlimited: Object.keys(sides).filter((n) => pacingExpectation(sides[n].query ?? o.query, { decoupledUnlimited: true }) === "decoupled") } : {}),
    chrome,
    iso: path.basename(iso), state: steps ? null : state && path.basename(state), steps: steps ? path.basename(values.steps) : null, query: o.query, baselineQuery: sides.baseline?.query ?? null, phase: o.phase, warmupSec: o.warmup, secs: o.secs,
    // Window in guest seconds (null: host seconds, --secs).
    emulatedWindow: o.emulatedWindow ? { secs: o.emulatedWindow, warmup: o.emulatedWarmup, pollMs: o.emulatedPollMs } : null, hold: o.hold, maxLoad: o.maxLoad,
    sides: Object.fromEntries(Object.entries(sides).map(([n, s]) => [n, s.label])),
    runs: runsDone.length, failed, gaveUp,
    ...(xctraceCleanup ? { xctraceCleanup } : {}),
    // Runs played again after the lock went back for the load: { run: times }.
    loadRetries: Object.fromEntries(runsDone.filter((r) => r.loadRetries).map((r) => [r.run, r.loadRetries])),
    candidate: { cold: summarize("candidate", "cold"), warm: summarize("candidate", "warm") },
    baseline: sides.baseline ? { cold: summarize("baseline", "cold"), warm: summarize("baseline", "warm") } : null,
    change: sides.baseline ? withheldOnOverlap(pairedSpeedChange(runsDone.filter((r) => good(r.baseline) && good(r.candidate)), { minPairs: o.minPairs }), lockOverlap) : null,
    // Checks of the perf lock that found another holder (empty: none).
    lockOverlap,
    // --headroom: the same pairing on maxSpeedCpu, the number a speed=1 A/B
    // decides on (the speed itself sits at 100 %), cold and, with --warm, warm.
    ...(o.headroom && sides.baseline ? { headroomChange: Object.fromEntries(["cold", ...(o.warm ? ["warm"] : [])].map((phase) => {
      const as = (r, side) => ({ [phase]: { v: r[side]?.[phase]?.headroom?.maxSpeedCpu } });
      const pairs = runsDone.filter((r) => good(r.baseline) && good(r.candidate));
      return [phase, pairedSpeedChange(pairs.map((r) => ({ run: r.run, baseline: as(r, "baseline"), candidate: as(r, "candidate") })), { metric: "v", minPairs: o.minPairs, phase })];
    })) } : {}),
    // --counters: the same pairing on host instructions per guest cycle (lower is better).
    ...(o.onWindow && sides.baseline ? { counterChange: pairedSpeedChange(runsDone.filter((r) => good(r.baseline) && good(r.candidate)), { metric: "instructionsPerGuestCycle", minPairs: o.minPairs }) } : {}),
    // Host cycles per guest cycle: they decide when the instructions and the
    // IPC move apart (PROGRAM.md, 2026-10-23).
    ...(o.onWindow && sides.baseline ? { cycleChange: pairedSpeedChange(runsDone.filter((r) => good(r.baseline) && good(r.candidate)), { metric: "cyclesPerGuestCycle", minPairs: o.minPairs }) } : {}),
    // --counters with xctrace: the same pairing on each per-1000-guest-cycle
    // quantity (host cycles, I-cache / iTLB / bandwidth-bound cycles), cold
    // and, with --warm, warm.
    ...(sides.baseline && runsDone.some((r) => r.candidate?.cold?.perKiloGuestCycles) ? { perKiloChange: Object.fromEntries(["cold", ...(o.warm ? ["warm"] : [])].map((phase) => {
      const pairs = runsDone.filter((r) => good(r.baseline) && good(r.candidate));
      const keys = Object.keys(pairs.find((r) => r.candidate?.[phase]?.perKiloGuestCycles)?.candidate[phase].perKiloGuestCycles ?? {});
      const as = (r, side, k) => ({ [phase]: { v: r[side]?.[phase]?.perKiloGuestCycles?.[k] } });
      return [phase, Object.fromEntries(keys.map((k) => [k, pairedSpeedChange(pairs.map((r) => ({ run: r.run, baseline: as(r, "baseline", k), candidate: as(r, "candidate", k) })), { metric: "v", minPairs: o.minPairs, phase })]))];
    })) } : {}),
    // --warm: the same pairings on the warm windows (the profile's second boot).
    ...(o.warm && sides.baseline ? { warmChange: Object.fromEntries(["speed", ...(o.onWindow ? ["instructionsPerGuestCycle", "cyclesPerGuestCycle"] : [])].map((m) => [m, pairedSpeedChange(runsDone.filter((r) => good(r.baseline) && good(r.candidate)), { metric: m, minPairs: o.minPairs, phase: "warm" })])) } : {}),
    pcsample: pcNote,
    // P4 counters (KPI: region and dispatch shares), cold stats windows of good runs.
    ...p4Summary(runsDone, sides, good),
    ...fusedMaddSummary(runsDone, sides, good),
    // Memory accesses per instruction (0104), cold stats windows of good runs.
    ...(o.memStats ? memSummary(runsDone, sides, good) : {}),
    // What each side served (commit, dirty), for kpi-report: from its first good run.
    served: Object.fromEntries(Object.keys(sides).map((n) => [n, runsDone.map((r) => r[n]).find(good)?.served ?? null]))
  };
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  const med = (n) => summary[n]?.cold?.speed?.median ?? "-";
  console.log(`[race-perf] ${sides.baseline ? `baseline ${med("baseline")} % → candidate ${med("candidate")} %, paired change ${summary.change.median ?? `withheld (${summary.change.withheld})`}${summary.change.median != null ? ` % over ${summary.change.pairs} pairs` : ""}` : `speed median ${med("candidate")} %`}${failed.length ? `; ${failed.length} failed run(s): ${failed.map((f) => `r${f.run} ${f.side} ${f.why}`).join(", ")}` : ""} -> ${outDir}`);
  process.exitCode = failed.length || summary.change?.withheld || lockOverlap.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
