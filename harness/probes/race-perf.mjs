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
//     [--config wgpu | --query "..."] [--warmup 25] [--secs 20]
//     [--runs 4 (even with --baseline)] [--min-pairs 4] [--hold KeyX] [--warm]
//     [--max-load L] [--load-wait 300] [--lock-wait 1800]
//     [--pcsample [periodMs]] [--symbols functions.json] [--out dir]
//     [--unique-frames secs] [--region-sample N [--region-secs 10]] [--mem-stats] [--baseline-query "..."]
//     [--calm-wait S (default --lock-wait): wait for load ≤ --max-load before taking the lock]
//     [--chrome-args "--flag …"] [--baseline-chrome-args "--flag …"]
//
// - Pairing and interleaving: run i measures both sides back to back, the
//   order alternating (base, head | head, base | …), so drift on the machine
//   hits both sides alike; the change is the median of per-run ratios.
// - Speed is the core's own (VI ticks over host time from the VI timeline),
//   never the page's gameSpeed (5-8 points higher): one measure only.
// - Machine load: as in the matrix (env.mjs), each side first waits up to
//   --load-wait s for the 1-minute load to drop under --max-load (default: a
//   quarter of the cores); a window whose median load is above it fails.
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
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { exportRef } from "../cli.mjs";
import { ensureServer, loadHarnessState, readCoreProgress, readFrameInfo, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { claim, release } from "../lib/ownership.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { openSession, rebootSession } from "../lib/session.mjs";
import { calmThenLock, loadGaveUp, waitForLoad } from "../lib/env.mjs";
import { describe, median, percentile, round } from "../lib/stats.mjs";
import { coreStats, hitchList, mergeTimeline, presentationStats } from "../lib/timeline.mjs";
import { consistentRead, decodeRegionStats, poolStats, regionShares, topMisses } from "../lib/jit-region-stats.mjs";
import { consistentMemRead, decodeMemStats, memAccessShares, poolMemStats } from "../lib/mem-access-stats.mjs";
import { summarizePcSamples } from "../../src/harness-pc-sampler.js";
import { checkPerfAccess, instructionsPerGuestCycle, perfCounters } from "../lib/perf-counters.mjs";

const HOMEBREW_OUT = path.join(REPO_ROOT, "harness", "homebrew", "out");
export const STATE_ROUTE = "**/__harness_state.sav";

export function sideOrder(run) {
  return run % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
}

// Paired change of `metric` (candidate over baseline, per run index). A
// pair counts only when both sides measured; the conclusion needs at least
// `minPairs` pairs, as many with trunk first as with head first (drift over
// a campaign then hits both sides alike), otherwise it is withheld.
export function pairedSpeedChange(runs, { metric = "speed", minPairs = 4 } = {}) {
  const pairs = [];
  for (const r of runs) {
    const b = r.baseline?.cold?.[metric], c = r.candidate?.cold?.[metric];
    if (Number.isFinite(b) && Number.isFinite(c) && b > 0) pairs.push({ run: r.run, first: sideOrder(r.run)[0], ratio: c / b - 1 });
  }
  const baseFirst = pairs.filter((p) => p.first === "baseline").length;
  const out = { pairs: pairs.length, baselineFirst: baseFirst, candidateFirst: pairs.length - baseFirst, perRun: pairs.map((p) => round(p.ratio * 100, 1)), median: null, withheld: null };
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

// %CPU of each thread of `pid` now: ps -M on macOS (the first row is the
// process total); on Linux, /proc over 500 ms (ps -L reports a lifetime
// average); null where there is no per-thread view (Windows).
function threadCpus(pid) {
  if (process.platform === "darwin") {
    return execFileSync("ps", ["-M", "-o", "%cpu=", "-p", pid], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim().split(/\s+/).at(-1))).filter(Number.isFinite).slice(1);
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
  if (!["darwin", "linux"].includes(process.platform)) return { error: `no per-thread CPU on ${process.platform}` };
  try {
    const ps = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 << 20 });
    const pids = ps.split("\n").filter((l) => l.includes(profileDir) && l.includes("--type=renderer")).map((l) => l.trim().split(/\s+/)[0]);
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
  const loaded = await loadHarnessState(page, session.url);
  if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
  if (o.hold) await page.keyboard.down(o.hold);
  try {
    await page.waitForTimeout(o.warmup * 1000);
    // A core without the sampler export (older trunk) is measured anyway;
    // the run says why it has no PC histogram.
    const pcStart = o.pcsample ? await workerRequest(page, "validationPcSampler", { action: "start", periodMs: o.pcsample }, 10000) : null;
    const sampling = Boolean(pcStart?.started);
    // o.onWindow (race-multi's hardware counters): called just before and
    // just after the window, from node only (no page call inside it).
    if (o.onWindow) await o.onWindow("start", session);
    await readTimeline(page); // drop everything before the window
    const t0 = await page.evaluate(() => performance.timeOrigin + performance.now());
    // The window: node timers only. The rings (VI 8192, presents 16384)
    // hold far more than a window, so nothing is read until it ends.
    const loads = [], threads = [];
    for (let s = 0; s < o.secs; s += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      loads.push(os.loadavg()[0]);
      if (s === Math.floor(o.secs / 2)) threads.push(rendererThreads(session.profileDir));
    }
    const counters = o.onWindow ? await o.onWindow("end", session) : undefined;
    const chunk = await readTimeline(page);
    const t1 = await page.evaluate(() => performance.timeOrigin + performance.now());
    const pc = sampling ? await workerRequest(page, "validationPcSampler", { action: "stop" }, 20000) : pcStart && { error: pcStart.error ?? "not started" };
    threads.push(rendererThreads(session.profileDir));
    const info = await readFrameInfo(page);
    const progress = await readCoreProgress(page);
    const timeline = mergeTimeline([chunk]);
    const core = coreStats(timeline, { ticksPerSecond: progress?.coreTicksPerSecond, until: t1 });
    const pres = presentationStats(timeline);
    const viMs = timeline.vi.slice(1).map((v, i) => v.t - timeline.vi[i].t);
    const xfbDt = /xfb_dt:([\d.]+) avg:([\d.]+) max:([\d.]+)/.exec(String(info?.ppcWasmHelperStats ?? ""));
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
    // --mem-stats (0104) shares that window: both are reset together and
    // read after it.
    let regionEnd = null, memEnd = null;
    if (o.regionSample != null || o.memStats) {
      if (o.regionSample != null) regionEnd = await workerRequest(page, "validationReadJitRegionStats", { sampleEvery: o.regionSample }, 10000);
      if (o.memStats) memEnd = await workerRequest(page, "validationReadMemAccessStats", { reset: 0 }, 10000);
      const live = (r) => r && !r.error;
      if (live(regionEnd) || live(memEnd)) {
        await new Promise((r) => setTimeout(r, o.regionSecs * 1000));
        if (live(regionEnd)) regionEnd = await workerRequest(page, "validationReadJitRegionStats", {}, 10000);
        if (live(memEnd)) memEnd = await workerRequest(page, "validationReadMemAccessStats", {}, 10000);
      }
    }
    return {
      windowMs: Math.round(t1 - t0),
      load1: { min: round(Math.min(...loads), 2), median: round(medianLoad, 2), max: round(Math.max(...loads), 2), limit: o.maxLoad },
      overloaded: medianLoad > o.maxLoad,
      complete: timeline.complete,
      speed: round(core.speed), speedP5: round(core.speedP5), speedMin: round(core.speedMin),
      gameFps: info?.vis ?? null,
      presents: pres.presents, viOutputs: timeline.vi.length,
      presentsPerSecond: round(pres.presents / ((t1 - t0) / 1000), 1),
      ...(o.uniqueFrames ? { uniqueFrames, uniqueFpsEstimate: uniqueFrames?.uniqueShare == null ? null : round((pres.presents / ((t1 - t0) / 1000)) * uniqueFrames.uniqueShare, 1) } : {}),
      viIntervalMs: { p50: round(percentile(viMs, 50)), p99: round(percentile(viMs, 99)), max: round(viMs.length ? Math.max(...viMs) : null) },
      presentIntervalMs: { p50: round(pres.frameP50), p99: round(pres.frameP99), max: round(pres.frameMax) },
      hitchesPerMin: round(pres.hitchesPerMin),
      // Where they happen (timeline.mjs): [ms into the window, interval ms, VI since load].
      hitchList: hitchList(timeline, { origin: t0 }),
      coreprofXfbDtMaxMs: xfbDt ? Number(xfbDt[3]) : null,
      rendererThreads: threads,
      freezes: { core: core.freezes?.length ?? 0, present: pres.freezes.length },
      pc: pc && !pc.error ? summarizePcSamples(pc, { functions: o.functions }) : pc,
      ...regionRecord(regionEnd),
      ...(counters ? { counters } : {}),
      ...(o.memStats ? memRecord(memEnd) : {})
    };
  } finally {
    if (o.hold) await page.keyboard.up(o.hold).catch(() => {});
  }
}

// A change measured while another harness held the perf lock too is not a
// measure: withheld, with the overlap as the reason.
export function withheldOnOverlap(change, overlaps) {
  if (!change || !overlaps.length) return change;
  return { ...change, median: null, withheld: `perf lock overlap: ${overlaps.map((x) => `${x.at}: ${x.why}`).join("; ")}` };
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
    ...(Number.isInteger(reply.layoutRefused) ? { layoutRefused: reply.layoutRefused } : {})
  };
  return p4.error ? { p4: null, p4Why: p4.error, ...samples } : { p4, p4Raw: stats, ...samples };
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
  return { p4: { ...pooled, windows: raw.length, missingWindows: recs.length - raw.length, diagnostics }, why: raw.length < recs.length ? why : null };
}

export function memSummary(runs, sides, good = (r) => r && !r.error) {
  const side = (n) => summarizeMem(runs.map((r) => r[n]).filter(good).map((r) => r.cold));
  const c = side("candidate"), b = sides.baseline ? side("baseline") : null;
  return { memAccess: c.memAccess, memAccessWhy: c.why, baselineMemAccess: b?.memAccess ?? null, baselineMemAccessWhy: b?.why ?? null };
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

async function measureSide(side, o) {
  // As the matrix does (env.mjs): wait for the machine to calm down first,
  // then judge the window on its median load.
  const loadGate = await waitForLoad({ maxLoad: o.maxLoad, waitSec: o.loadWait, log: (m) => console.log(`[race-perf] ${side.name}: ${m}`) });
  const server = await ensureServer({ port: o.port, root: side.root, coreCandidates: o.coreCandidates });
  try {
    const bootStart = performance.now();
    const session = await openSession({ base: server.base, server, query: side.query ?? o.query, iso: o.iso, routes: { [STATE_ROUTE]: o.state }, chromeArgs: side.chromeArgs ?? [] });
    const record = { url: session.url, served: server.identity, core: session.core, loadGate, bootMs: round(performance.now() - bootStart, 0) };
    try {
      record.cold = await measure(session, o);
      if (record.cold.counters) record.cold.instructionsPerGuestCycle = instructionsPerGuestCycle(record.cold);
      if (o.warm) {
        record.warmCore = await rebootSession(session, server);
        record.warm = await measure(session, o);
      }
    } catch (error) {
      record.error = String(error?.message || error).slice(0, 300);
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

const brief = (m) => m && `speed ${m.speed} % (p5 ${m.speedP5}) game ${m.gameFps} fps vi p99 ${m.viIntervalMs.p99} ms hitches ${m.hitchesPerMin}/min busiest thread ${m.rendererThreads.at(-1)?.busiest} % load ${m.load1.median}${m.overloaded ? " OVERLOADED" : ""}${m.pc?.samples ? ` pc ${m.pc.samples} samples` : ""}`;

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, state: { type: "string" },
      baseline: { type: "string" }, candidate: { type: "string" },
      config: { type: "string", default: "wgpu" }, query: { type: "string" },
      runs: { type: "string", default: "4" }, "min-pairs": { type: "string" }, "load-wait": { type: "string", default: "300" }, "calm-wait": { type: "string" }, warmup: { type: "string", default: "25" }, secs: { type: "string", default: "20" },
      hold: { type: "string", default: "KeyX" }, warm: { type: "boolean", default: false },
      "max-load": { type: "string" }, "lock-wait": { type: "string", default: "1800" },
      pcsample: { type: "string" }, symbols: { type: "string" }, "region-sample": { type: "string" }, "region-secs": { type: "string", default: "10" }, counters: { type: "boolean", default: false }, "unique-frames": { type: "string" }, "mem-stats": { type: "boolean", default: false }, "baseline-query": { type: "string" }, "chrome-args": { type: "string" }, "baseline-chrome-args": { type: "string" },
      "core-candidate": { type: "string", multiple: true, default: [] },
      port: { type: "string", default: process.env.HARNESS_PORT }, out: { type: "string" }
    },
    allowPositionals: false
  });
  if (!values.iso || !values.state || !values.port) {
    throw new Error("usage: race-perf.mjs --iso disc.iso --state scene.sav --port N (or HARNESS_PORT) [--baseline ref|dir] [--candidate ref|dir] [--runs 4] [--warmup 25] [--secs 20] [--warm] [--max-load L] [--pcsample 0.25]");
  }
  const iso = path.resolve(values.iso), state = path.resolve(values.state);
  for (const f of [iso, state]) if (!existsSync(f)) throw new Error(`not found: ${f}`);
  const localOnly = !iso.startsWith(HOMEBREW_OUT);
  if (localOnly && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
  const query = `${values.query ?? PRESETS[values.config] ?? values.config}&metrics=1`;
  // --baseline-query: the baseline side boots with its own query (same tree
  // with and without a switch, e.g. aot=1 against the default).
  const baselineQuery = values["baseline-query"] ? `${values["baseline-query"]}&metrics=1` : null;
  if (baselineQuery && !values.baseline) throw new Error("--baseline-query needs --baseline");
  // A coreid would pin both sides to one core: trunk against head would
  // then compare a core with itself.
  if (values.baseline && [query, baselineQuery].some((q) => q && new URLSearchParams(q).has("coreid"))) throw new Error("--baseline compares the two sides' own cores: no coreid in --query or --baseline-query");
  const chromeArgs = chromeArgsOf(values["chrome-args"], "chrome-args");
  const baselineChromeArgs = values["baseline-chrome-args"] == null ? chromeArgs : chromeArgsOf(values["baseline-chrome-args"], "baseline-chrome-args");
  if (values["baseline-chrome-args"] != null && !values.baseline) throw new Error("--baseline-chrome-args needs --baseline");
  const runs = num(values, "runs", { min: 1, int: true });
  if (values.baseline && runs % 2) throw new Error(`--runs ${runs}: with --baseline the runs must be even, so trunk goes first as often as head`);
  const o = {
    iso, state, port: num(values, "port", { min: 1, int: true }), query, runs,
    minPairs: values["min-pairs"] ? num(values, "min-pairs", { min: 2, int: true }) : Math.min(runs, 4),
    warmup: num(values, "warmup", { min: 0 }), secs: num(values, "secs", { min: 2, int: true }),
    hold: values.hold || null, warm: values.warm,
    maxLoad: values["max-load"] ? num(values, "max-load", { min: 0.1 }) : Math.max(2, os.cpus().length / 4),
    loadWait: num(values, "load-wait", { min: 0 }),
    pcsample: values.pcsample ? num(values, "pcsample", { min: 0.05 }) : null,
    regionSample: values["region-sample"] == null ? null : num(values, "region-sample", { min: 0, int: true }),
    regionSecs: num(values, "region-secs", { min: 1 }),
    // --counters (Linux perf): host instructions per guest cycle of the
    // emulated CPU thread, per window (lib/perf-counters.mjs).
    ...(values.counters ? (checkPerfAccess(), { onWindow: perfCounters() }) : {}),
    uniqueFrames: values["unique-frames"] == null ? null : num(values, "unique-frames", { min: 2 }),
    memStats: values["mem-stats"],
    functions: values.symbols ? JSON.parse(readFileSync(values.symbols, "utf8")).sort((a, b) => a[0] - b[0]) : null,
    coreCandidates: values["core-candidate"]
  };
  const lockWait = num(values, "lock-wait", { min: 0 });

  const sides = {};
  // Exported refs are removed on every exit, Ctrl-C included (the perf
  // lock's signal handler exits the process, which runs this).
  const dropExports = () => { for (const s of Object.values(sides)) if (s.temp && existsSync(s.root)) { release(s.root); rmSync(s.root, { recursive: true, force: true }); } };
  process.once("exit", dropExports);
  sides.candidate = { ...resolveSide("candidate", values.candidate), chromeArgs };
  if (values.baseline) sides.baseline = { ...resolveSide("baseline", values.baseline), query: baselineQuery, chromeArgs: baselineChromeArgs };
  // A calm machine first (--calm-wait, default --lock-wait), then the lock.
  const calmWait = values["calm-wait"] == null ? lockWait : num(values, "calm-wait", { min: 0 });
  const releaseLock = await calmThenLock({
    maxLoad: o.maxLoad, calmWait, log: (m) => console.log(`[race-perf] before the lock: ${m}`),
    acquire: () => acquirePerfLock({ name: `harness race-perf (${REPO_ROOT})`, waitSec: lockWait, log: (m) => console.log(`[race-perf] ${m}`) })
  });
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
    const c = releaseLock.check?.();
    if (c && !c.ok) { lockOverlap.push({ at, why: c.why }); console.warn(`[race-perf] perf lock overlap detected (${at}): ${c.why}`); }
  };
  checkLock("taken");
  try {
    for (let run = 1; run <= o.runs && !gaveUp; run += 1) {
      checkLock(`before run ${run}`);
      const record = { run };
      for (const name of sideOrder(run).filter((n) => sides[n])) {
        record[name] = await measureSide(sides[name], o);
        const r = record[name];
        console.log(`[race-perf] run ${run} ${name}: ${r.error ?? brief(r.cold)}${r.warm ? ` | warm: ${brief(r.warm)}` : ""}`);
        gaveUp = loadGaveUp(r.loadGate);
        if (gaveUp) { console.warn(`[race-perf] run ${run} ${name}: ${gaveUp}`); break; }
      }
      writeFileSync(path.join(outDir, `run${run}.json`), JSON.stringify(record, null, 1) + "\n");
      records.push(record);
    }
    checkLock("end");
  } finally {
    releaseLock();
    dropExports();
  }
  const runsDone = records;

  const good = (r) => r && !r.error && !r.fatal?.length && !r.cold?.overloaded && !r.warm?.overloaded;
  const summarize = (name, phase) => {
    const m = runsDone.map((r) => r[name]).filter(good).map((r) => r[phase]).filter(Boolean);
    if (!m.length) return null;
    return {
      speed: describe(m.map((x) => x.speed)), gameFps: describe(m.map((x) => x.gameFps)),
      viP99Ms: describe(m.map((x) => x.viIntervalMs.p99)), presentP99Ms: describe(m.map((x) => x.presentIntervalMs.p99)),
      hitchesPerMin: describe(m.map((x) => x.hitchesPerMin)), busiestThread: describe(m.map((x) => x.rendererThreads.at(-1)?.busiest)),
      presentsPerSecond: describe(m.map((x) => x.presentsPerSecond)),
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
  const failed = Object.keys(sides).flatMap((n) => runsDone.filter((r) => !good(r[n])).map((r) => ({ run: r.run, side: n, why: r[n]?.infraCrash ? "infra" : r[n]?.error ?? (r[n]?.fatal?.length ? "crash" : "overloaded") })));
  // Which Chrome ran: a wrapper (HARNESS_CHROME_PATH, e.g. the E-core one) or
  // extra flags left exported would otherwise pass for a regression.
  const sideArgs = Object.fromEntries(Object.entries(sides).filter(([, s]) => s.chromeArgs?.length).map(([n, s]) => [n, s.chromeArgs.join(" ")]));
  const chrome = { path: process.env.HARNESS_CHROME_PATH || "chrome stable", args: process.env.HARNESS_CHROME_ARGS || "", ...(Object.keys(sideArgs).length ? { sideArgs } : {}) };
  if (process.env.HARNESS_CHROME_PATH || process.env.HARNESS_CHROME_ARGS) console.warn(`[race-perf] Chrome: ${chrome.path}${chrome.args ? ` ${chrome.args}` : ""}`);
  for (const [n, a] of Object.entries(sideArgs)) console.warn(`[race-perf] Chrome flags on the ${n}: ${a}`);
  const summary = {
    probe: "race-perf", at: new Date().toISOString(),
    chrome,
    iso: path.basename(iso), state: path.basename(state), query: o.query, baselineQuery: sides.baseline?.query ?? null, warmupSec: o.warmup, secs: o.secs, hold: o.hold, maxLoad: o.maxLoad,
    sides: Object.fromEntries(Object.entries(sides).map(([n, s]) => [n, s.label])),
    runs: runsDone.length, failed, gaveUp,
    candidate: { cold: summarize("candidate", "cold"), warm: summarize("candidate", "warm") },
    baseline: sides.baseline ? { cold: summarize("baseline", "cold"), warm: summarize("baseline", "warm") } : null,
    change: sides.baseline ? withheldOnOverlap(pairedSpeedChange(runsDone.filter((r) => good(r.baseline) && good(r.candidate)), { minPairs: o.minPairs }), lockOverlap) : null,
    // Checks of the perf lock that found another holder (empty: none).
    lockOverlap,
    // --counters: the same pairing on host instructions per guest cycle (lower is better).
    ...(o.onWindow && sides.baseline ? { counterChange: pairedSpeedChange(runsDone.filter((r) => good(r.baseline) && good(r.candidate)), { metric: "instructionsPerGuestCycle", minPairs: o.minPairs }) } : {}),
    pcsample: pcNote,
    // P4 counters (KPI: region and dispatch shares), cold stats windows of good runs.
    ...p4Summary(runsDone, sides, good),
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
