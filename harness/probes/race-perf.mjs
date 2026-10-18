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
//     [--config wgpu | --query "..."] [--runs 3] [--warmup 25] [--secs 20]
//     [--hold KeyX] [--warm] [--max-load L] [--lock-wait 1800]
//     [--pcsample [periodMs]] [--symbols functions.json] [--out dir]
//
// - Pairing and interleaving: run i measures both sides back to back, the
//   order alternating (base, head | head, base | …), so drift on the machine
//   hits both sides alike; the change is the median of per-run ratios.
// - Speed is the core's own (VI ticks over host time from the VI timeline),
//   never the page's gameSpeed (5-8 points higher): one measure only.
// - Machine load (1-minute average) is recorded through every window; a
//   window above --max-load (default: a quarter of the cores) fails.
// - The shared perf lock (~/projects/gc-web-emu/.perf-lock) is taken before
//   the first launch and released on every exit path.
// - Every run checks that the core it loaded is the one asked for (coreid in
//   the query, or the side's own core): a mismatch fails the run.
// - --pcsample samples the guest PC from a worker of its own during the
//   window (no CDP): where the emulated CPU spends its time. Real-time
//   sampling: it cannot tell "more work" from "the same work, slower".
// - --warm boots again in the same profile (JIT cache in IndexedDB) and
//   measures again: cold and warm caches on the same run.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { exportRef } from "../cli.mjs";
import { bootIso, ensureServer, loadHarnessState, readCoreProgress, readFrameInfo, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { claim, release } from "../lib/ownership.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { openSession } from "../lib/session.mjs";
import { describe, median, percentile, round } from "../lib/stats.mjs";
import { coreStats, mergeTimeline, presentationStats } from "../lib/timeline.mjs";
import { summarizePcSamples } from "../../src/harness-pc-sampler.js";

const HOMEBREW_OUT = path.join(REPO_ROOT, "harness", "homebrew", "out");
const STATE_ROUTE = "**/__harness_state.sav";

export function sideOrder(run) {
  return run % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
}

// Paired change of `metric` (candidate over baseline, per run index).
export function pairedSpeedChange(runs, metric = "speed") {
  const ratios = [];
  for (const r of runs) {
    const b = r.baseline?.cold?.[metric], c = r.candidate?.cold?.[metric];
    if (Number.isFinite(b) && Number.isFinite(c) && b > 0) ratios.push(c / b - 1);
  }
  return { pairs: ratios.length, median: ratios.length ? round(median(ratios) * 100, 1) : null, perRun: ratios.map((x) => round(x * 100, 1)) };
}

// The renderer of this profile and the CPU of its busiest threads (ps -M).
function rendererThreads(profileDir) {
  try {
    const ps = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 << 20 });
    const pids = ps.split("\n").filter((l) => l.includes(profileDir) && l.includes("--type=renderer")).map((l) => l.trim().split(/\s+/)[0]);
    let best = null;
    for (const pid of pids) {
      const rows = execFileSync("ps", ["-M", "-o", "%cpu=", "-p", pid], { encoding: "utf8" })
        .split("\n").map((l) => Number(l.trim().split(/\s+/).at(-1))).filter(Number.isFinite);
      const threads = rows.slice(1).sort((a, b) => b - a); // first row is the process total
      if (!best || (threads[0] ?? 0) > best.busiest) best = { pid: Number(pid), busiest: threads[0] ?? null, next: threads.slice(1, 4) };
    }
    return best;
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

// Load the scene, hold the key, settle, then a window with no page call.
async function measure(session, o) {
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
    const maxLoad = Math.max(...loads);
    return {
      windowMs: Math.round(t1 - t0),
      load1: { min: round(Math.min(...loads), 2), median: round(median(loads), 2), max: round(maxLoad, 2), limit: o.maxLoad },
      overloaded: maxLoad > o.maxLoad,
      complete: timeline.complete,
      speed: round(core.speed), speedP5: round(core.speedP5), speedMin: round(core.speedMin),
      gameFps: info?.vis ?? null,
      presents: pres.presents, viOutputs: timeline.vi.length,
      viIntervalMs: { p50: round(percentile(viMs, 50)), p99: round(percentile(viMs, 99)), max: round(viMs.length ? Math.max(...viMs) : null) },
      presentIntervalMs: { p50: round(pres.frameP50), p99: round(pres.frameP99), max: round(pres.frameMax) },
      hitchesPerMin: round(pres.hitchesPerMin),
      coreprofXfbDtMaxMs: xfbDt ? Number(xfbDt[3]) : null,
      rendererThreads: threads,
      freezes: { core: core.freezes?.length ?? 0, present: pres.freezes.length },
      pc: pc && !pc.error ? summarizePcSamples(pc, { functions: o.functions }) : pc
    };
  } finally {
    if (o.hold) await page.keyboard.up(o.hold).catch(() => {});
  }
}

async function measureSide(side, o) {
  const server = await ensureServer({ port: o.port, root: side.root, coreCandidates: o.coreCandidates });
  try {
    const session = await openSession({ base: server.base, server, query: o.query, iso: o.iso, routes: { [STATE_ROUTE]: o.state } });
    const record = { url: session.url, served: server.identity, core: session.core };
    try {
      record.cold = await measure(session, o);
      if (o.warm) {
        await bootIso(session.page, { url: session.url, iso: o.iso });
        record.warm = await measure(session, o);
      }
    } catch (error) {
      record.error = String(error?.message || error).slice(0, 300);
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

// A side: a directory served as is, or a git ref exported to a temporary dir.
function resolveSide(name, spec) {
  if (!spec) return { name, label: "this tree", root: REPO_ROOT, temp: false };
  if (existsSync(spec) && statSync(spec).isDirectory()) return { name, label: path.resolve(spec), root: path.resolve(spec), temp: false };
  return { name, label: spec, root: exportRef(spec), temp: true };
}

const brief = (m) => m && `speed ${m.speed} % (p5 ${m.speedP5}) game ${m.gameFps} fps vi p99 ${m.viIntervalMs.p99} ms hitches ${m.hitchesPerMin}/min busiest thread ${m.rendererThreads.at(-1)?.busiest} % load ${m.load1.max}${m.overloaded ? " OVERLOADED" : ""}${m.pc?.samples ? ` pc ${m.pc.samples} samples` : ""}`;

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, state: { type: "string" },
      baseline: { type: "string" }, candidate: { type: "string" },
      config: { type: "string", default: "wgpu" }, query: { type: "string" },
      runs: { type: "string", default: "3" }, warmup: { type: "string", default: "25" }, secs: { type: "string", default: "20" },
      hold: { type: "string", default: "KeyX" }, warm: { type: "boolean", default: false },
      "max-load": { type: "string" }, "lock-wait": { type: "string", default: "1800" },
      pcsample: { type: "string" }, symbols: { type: "string" },
      "core-candidate": { type: "string", multiple: true, default: [] },
      port: { type: "string", default: process.env.HARNESS_PORT }, out: { type: "string" }
    },
    allowPositionals: false
  });
  if (!values.iso || !values.state || !values.port) {
    throw new Error("usage: race-perf.mjs --iso disc.iso --state scene.sav --port N (or HARNESS_PORT) [--baseline ref|dir] [--candidate ref|dir] [--runs 3] [--warmup 25] [--secs 20] [--warm] [--max-load L] [--pcsample 0.25]");
  }
  const iso = path.resolve(values.iso), state = path.resolve(values.state);
  for (const f of [iso, state]) if (!existsSync(f)) throw new Error(`not found: ${f}`);
  const localOnly = !iso.startsWith(HOMEBREW_OUT);
  if (localOnly && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
  const o = {
    iso, state, port: Number(values.port),
    query: `${values.query ?? PRESETS[values.config] ?? values.config}&metrics=1`,
    runs: Number(values.runs), warmup: Number(values.warmup), secs: Number(values.secs),
    hold: values.hold || null, warm: values.warm,
    maxLoad: values["max-load"] ? Number(values["max-load"]) : Math.max(2, os.cpus().length / 4),
    pcsample: values.pcsample ? Number(values.pcsample) || 0.25 : null,
    functions: values.symbols ? JSON.parse(readFileSync(values.symbols, "utf8")).sort((a, b) => a[0] - b[0]) : null,
    coreCandidates: values["core-candidate"]
  };

  // A local-only disc never writes into the repo.
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const outDir = values.out ? path.resolve(values.out) : localOnly
    ? path.resolve(process.env.HARNESS_PRIVATE_OUT || path.join(REPO_ROOT, "..", "measures", "harness"), `race-perf-${stamp}`)
    : path.join(REPO_ROOT, "harness", "results", `race-perf-${stamp}`);
  mkdirSync(path.dirname(outDir), { recursive: true });
  mkdirSync(outDir);
  claim(outDir, REPO_ROOT, "results");

  const sides = { candidate: resolveSide("candidate", values.candidate) };
  if (values.baseline) sides.baseline = resolveSide("baseline", values.baseline);
  const releaseLock = await acquirePerfLock({ name: `harness race-perf (${REPO_ROOT})`, waitSec: Number(values["lock-wait"]), log: (m) => console.log(`[race-perf] ${m}`) });
  const runs = [];
  try {
    for (let run = 1; run <= o.runs; run += 1) {
      const record = { run };
      for (const name of sideOrder(run).filter((n) => sides[n])) {
        record[name] = await measureSide(sides[name], o);
        const r = record[name];
        console.log(`[race-perf] run ${run} ${name}: ${r.error ?? brief(r.cold)}${r.warm ? ` | warm: ${brief(r.warm)}` : ""}`);
      }
      writeFileSync(path.join(outDir, `run${run}.json`), JSON.stringify(record, null, 1) + "\n");
      runs.push(record);
    }
  } finally {
    releaseLock();
    for (const s of Object.values(sides)) if (s.temp) { release(s.root); rmSync(s.root, { recursive: true, force: true }); }
  }

  const good = (r) => r && !r.error && !r.fatal?.length && !r.cold?.overloaded && !r.warm?.overloaded;
  const summarize = (name, phase) => {
    const m = runs.map((r) => r[name]).filter(good).map((r) => r[phase]).filter(Boolean);
    if (!m.length) return null;
    return {
      speed: describe(m.map((x) => x.speed)), gameFps: describe(m.map((x) => x.gameFps)),
      viP99Ms: describe(m.map((x) => x.viIntervalMs.p99)), presentP99Ms: describe(m.map((x) => x.presentIntervalMs.p99)),
      hitchesPerMin: describe(m.map((x) => x.hitchesPerMin)), busiestThread: describe(m.map((x) => x.rendererThreads.at(-1)?.busiest))
    };
  };
  const failed = Object.keys(sides).flatMap((n) => runs.filter((r) => !good(r[n])).map((r) => ({ run: r.run, side: n, why: r[n]?.error ?? (r[n]?.fatal?.length ? "crash" : "overloaded") })));
  const summary = {
    iso: path.basename(iso), state: path.basename(state), query: o.query, warmupSec: o.warmup, secs: o.secs, hold: o.hold, maxLoad: o.maxLoad,
    sides: Object.fromEntries(Object.entries(sides).map(([n, s]) => [n, s.label])),
    runs: runs.length, failed,
    candidate: { cold: summarize("candidate", "cold"), warm: summarize("candidate", "warm") },
    baseline: sides.baseline ? { cold: summarize("baseline", "cold"), warm: summarize("baseline", "warm") } : null,
    change: sides.baseline ? pairedSpeedChange(runs.filter((r) => good(r.baseline) && good(r.candidate))) : null
  };
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  const med = (n) => summary[n]?.cold?.speed?.median ?? "-";
  console.log(`[race-perf] ${sides.baseline ? `baseline ${med("baseline")} % → candidate ${med("candidate")} %, paired change ${summary.change.median ?? "-"} % over ${summary.change.pairs} pairs` : `speed median ${med("candidate")} %`}${failed.length ? `; ${failed.length} failed run(s): ${failed.map((f) => `r${f.run} ${f.side} ${f.why}`).join(", ")}` : ""} -> ${outDir}`);
  process.exitCode = failed.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
