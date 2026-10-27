#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// AX HLE share of the CPU thread (patch 0099), headless only:
//
//   node harness/probes/ax-hle.mjs --iso disc.iso --port N
//     (--state scene.sav | --steps steps.json) [--config wgpu | --query "..."]
//     [--runs 3] [--warmup 20] [--secs 20] [--max-load L] [--load-wait 300]
//     [--lock-wait 1800] [--calm-wait S] [--out dir]
//
// The audio synthesis of AX HLE runs a whole command list synchronously
// inside the DSP mailbox MMIO write, on the CPU thread
// (research/deep-thread-budget.md §2). Each run boots the disc, reaches the
// scene (a savestate, e.g. a race, or input steps, e.g. a loaded menu),
// waits --warmup, then resets the core's counters (DolphinWeb_AxHleStats)
// and reads them after --secs: host time in the mail handling over the
// core's window (shareOfWindow), and over the CPU thread's occupancy
// (shareOfActive: the busiest renderer thread, sampled in the window), so a
// scene that sleeps in the throttle is not understated. Two clock reads per
// mail (a few hundred per second): the counters run inside the window.
// A timing measure: calm machine first, then the shared perf lock.
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { ensureServer, loadHarnessState, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { calmLock, loadGaveUp } from "../lib/env.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { chromeInfo, probeOutDir } from "../lib/probe-out.mjs";
import { openSession } from "../lib/session.mjs";
import { describe, median, round } from "../lib/stats.mjs";
import { runSteps, validateSteps } from "../lib/steps.mjs";
import { axShares, consistentAxRead, decodeAxStats } from "../lib/ax-hle-stats.mjs";
import { num, rendererThreads, STATE_ROUTE } from "./race-perf.mjs";

// One read of the core's counters (reset >= 0 zeroes them first).
async function readAx(page, reset = -1) {
  const r = await workerRequest(page, "validationReadAxHleStats", { reset }, 10000);
  if (r?.error) return { error: r.error };
  return consistentAxRead(decodeAxStats(r.bytes), decodeAxStats(r.again));
}

// loadGate: the load before the run (calmLock: never waited for under the lock).
async function measureRun(o, server, loadGate) {
  const record = { loadGate };
  if (loadGaveUp(loadGate)) return record;
  const routes = o.state ? { [STATE_ROUTE]: o.state } : {};
  const session = await openSession({ base: server.base, server, query: o.query, iso: o.iso, routes });
  try {
    const { page } = session;
    if (o.state) {
      const loaded = await loadHarnessState(page, session.url);
      if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
    } else {
      await runSteps(page, o.steps);
    }
    await page.waitForTimeout(o.warmup * 1000);
    const reset = await readAx(page, 0);
    if (reset.error) return { ...record, error: reset.error };
    const loads = [], threads = [];
    for (let s = 0; s < o.secs; s += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      loads.push(os.loadavg()[0]);
      if (s === Math.floor(o.secs / 3) || s === Math.floor((2 * o.secs) / 3)) threads.push(rendererThreads(session.profileDir));
    }
    const stats = await readAx(page);
    const busiest = median(threads.map((t) => t?.busiest).filter(Number.isFinite));
    const medianLoad = median(loads);
    return {
      ...record, stats, threads, load1: { median: round(medianLoad, 2), max: round(Math.max(...loads), 2), limit: o.maxLoad },
      overloaded: medianLoad > o.maxLoad, ax: stats.error ? { error: stats.error } : axShares(stats, busiest),
      fatal: session.watch.fatal()
    };
  } catch (error) {
    return { ...record, error: String(error?.message || error).slice(0, 300) };
  } finally {
    await session.close();
  }
}

// Medians over the good runs.
export function summarizeAx(records) {
  const good = records.filter((r) => r.ax && !r.ax.error && !r.overloaded && !r.error && !r.fatal?.length);
  const pick = (f) => describe(good.map((r) => r.ax[f]), 4);
  return {
    goodRuns: good.length,
    failed: records.map((r, i) => ({ run: i + 1, why: r.error ?? r.ax?.error ?? (r.overloaded ? "overloaded" : r.fatal?.length ? "crash" : null) })).filter((f) => f.why),
    shareOfWindow: pick("shareOfWindow"), shareOfActive: pick("shareOfActive"),
    msPerSecond: pick("msPerSecond"), mailsPerSecond: pick("mailsPerSecond"), meanMailUs: pick("meanMailUs"), mailMaxMs: pick("mailMaxMs")
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, state: { type: "string" }, steps: { type: "string" },
      config: { type: "string", default: "wgpu" }, query: { type: "string" },
      runs: { type: "string", default: "3" }, warmup: { type: "string", default: "20" }, secs: { type: "string", default: "20" },
      "max-load": { type: "string" }, "load-wait": { type: "string", default: "300" }, "lock-wait": { type: "string", default: "1800" }, "calm-wait": { type: "string" },
      port: { type: "string", default: process.env.HARNESS_PORT }, out: { type: "string" }
    }
  });
  if (!values.iso || Boolean(values.state) === Boolean(values.steps)) throw new Error("usage: ax-hle.mjs --iso disc.iso (--state scene.sav | --steps steps.json) --port N [--query ...] [--runs 3] [--warmup 20] [--secs 20]");
  const steps = values.steps ? JSON.parse(readFileSync(values.steps, "utf8")) : null;
  if (steps) validateSteps(steps);
  const lockWait = num(values, "lock-wait", { min: 0 });
  const o = {
    iso: path.resolve(values.iso), state: values.state ? path.resolve(values.state) : null, steps,
    query: `${values.query ?? PRESETS[values.config] ?? values.config}&metrics=1`,
    runs: num(values, "runs", { min: 1, int: true }), warmup: num(values, "warmup", { min: 0 }), secs: num(values, "secs", { min: 2, int: true }),
    maxLoad: values["max-load"] ? num(values, "max-load", { min: 0.1 }) : Math.max(2, os.cpus().length / 4),
    loadWait: num(values, "load-wait", { min: 0 }), port: num(values, "port", { min: 1, int: true })
  };
  const calmWait = values["calm-wait"] == null ? lockWait : num(values, "calm-wait", { min: 0 });
  const log = (m) => console.log(`[ax-hle] ${m}`);
  const lock = await calmLock({ maxLoad: o.maxLoad, calmWait, log: (m) => log(`before the lock: ${m}`), acquire: () => acquirePerfLock({ requireMains: true, name: `harness ax-hle (${REPO_ROOT})`, waitSec: lockWait, log }) });
  const outDir = probeOutDir("ax-hle", o.iso, values.out);
  const server = await ensureServer({ port: o.port, root: REPO_ROOT });
  const records = [];
  let gaveUp = null;
  try {
    for (let run = 1; run <= o.runs; run += 1) {
      const r = await measureRun(o, server, await lock.waitCalmUnlocked({ waitSec: o.loadWait }));
      records.push(r);
      writeFileSync(path.join(outDir, `run${run}.json`), JSON.stringify(r, null, 1) + "\n");
      gaveUp = loadGaveUp(r.loadGate);
      if (gaveUp) { log(`run ${run}: ${gaveUp}`); break; }
      log(`run ${run}: ${r.error ?? (r.ax?.error ? r.ax.error : `AX ${(r.ax.shareOfWindow * 100).toFixed(2)} % of the window, ${r.ax.shareOfActive == null ? "?" : (r.ax.shareOfActive * 100).toFixed(2)} % of the CPU thread's busy time, ${r.ax.mailsPerSecond} mails/s, max ${r.ax.mailMaxMs} ms`)}${r.overloaded ? " OVERLOADED" : ""}`);
    }
  } finally {
    await server.stop();
    lock.release();
  }
  const summary = {
    probe: "ax-hle", at: new Date().toISOString(), chrome: chromeInfo(), served: server.identity,
    iso: path.basename(o.iso), scene: o.state ? `state ${path.basename(o.state)}` : `steps ${path.basename(values.steps)}`,
    query: o.query, warmupSec: o.warmup, secs: o.secs, maxLoad: o.maxLoad, runs: records.length, gaveUp,
    ...summarizeAx(records)
  };
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  log(`AX share of the CPU thread's busy time: median ${summary.shareOfActive.median == null ? "n/a" : `${round(summary.shareOfActive.median * 100, 2)} %`} over ${summary.goodRuns} good run(s) -> ${outDir}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
