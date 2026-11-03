#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Where the emulated CPU thread's host time goes, second by second, and what
// grows in the seconds that dip (speed under 100 %, or the CPU thread
// saturated). Headless by default (HARNESS_DISPLAY: the bench screen under
// spark-run --headed, for video=wgpu); one tree, one run.
//
//   node harness/probes/cpu-window.mjs --iso disc.iso --port N
//     [--state scene.sav | --steps steps.json] [--steps-during steps.json] [--candidate dir]
//     [--config product | wgpu | --query "..."] [--warmup 25] [--secs 30] [--step 1]
//     [--hold KeyX | --hold ""] [--vi FROM-TO] [--dip-speed 99] [--dip-busy 0.95]
//     [--region-sample 64] [--mem-warm 5] [--untimed-secs 5]
//     [--max-load L] [--load-wait 300] [--lock-wait 1800] [--calm-wait S] [--out dir]
//
// The query: the product's by default (drop-meter's PRODUCT_QUERY, what
// Salon runs: aot=1&aotcompiler=1&jitoffthread=1, so regions run); --config
// names a preset of lib/matrix.mjs instead, --query any query.
// The run: boot, the scene (savestate or input steps), --hold pressed,
// --warmup s, then the counters are turned on (each reset >= 0 once):
// memory accesses (validationReadMemAccessStats; its first reset clears the
// JIT cache: the blocks recompile, the installed regions stay, unverified
// until their next run (0075 ClearOffThreadAndRegionState), so --mem-warm s
// pass first), AX HLE (validationReadAxHleStats), headroom
// (validationReadHeadroomStats), the CPU-thread diag when the core has it
// (validationReadCpuThreadDiag, patch 0213: CoreTiming events by type, the
// throttle's bookkeeping, the slice set-up, RetryDeferredWasmBlocks, the
// stale-region checks; an engine without it leaves those columns empty),
// and the region JIT stats (validationReadJitRegionStats) first untimed
// (sampleEvery 0) for
// --untimed-secs, the window that prices the timing (timingCost), then with
// sampleEvery --region-sample: every region call, block call and Idle
// timed, block lookups 1 in N, scaled by the core.
// Then a snapshot of the structs and the core ticks every --step s for
// --secs s (reads only, never a reset), and the VIs drained from the
// timeline between two snapshots; each row is lib/cpu-window.mjs
// cpuWindowBreakdown of two consecutive snapshots. --vi keeps the rows that
// overlap a VI range (VI outputs since the savestate load, as race-perf's
// hitchList gives them); classifyDips and contrast run on the rows kept.
// --steps-during: input steps played from the first snapshot on, while the
// rows run (a transition measured as it happens: a menu's last presses and
// the load they start); the run fails if they do not finish within --secs.
//
// The counters cost the CPU thread time (two clock reads per block call):
// the speed under the profiler is below the speed without it; dips are
// still dips, the parts compare between rows of the same run.
//
// summary.json: rows, dips, contrast, the snapshots (decoded) and the setup.
// Calm machine first, then the shared perf lock; the watchdog runs only
// while the lock is held and the run measures (never during a wait for calm
// or mains power, when the lock is given back), and its exit releases the
// lock;
// the lock is held; the process always exits.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { ensureServer, loadHarnessState, readCoreProgress, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { classifyDips, contrast, cpuWindowBreakdown, formatTable, inflationNote, parseViRange, phaseCheck, regionWarning, rowsInViRange, screenOf, SPLIT_NOTE, timingCost, viRangeOf } from "../lib/cpu-window.mjs";
import { calmLock, defaultMaxLoad, loadGaveUp } from "../lib/env.mjs";
import { consistentAxRead, decodeAxStats } from "../lib/ax-hle-stats.mjs";
import { consistentCpuThreadDiagRead, decodeCpuThreadDiag } from "../lib/cpu-thread-diag.mjs";
import { consistentHeadroomRead, decodeHeadroomStats } from "../lib/headroom.mjs";
import { consistentRead, decodeRegionStats } from "../lib/jit-region-stats.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { consistentMemRead, decodeMemStats } from "../lib/mem-access-stats.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { chromeInfo, probeOutDir } from "../lib/probe-out.mjs";
import { openSession } from "../lib/session.mjs";
import { median, round } from "../lib/stats.mjs";
import { runSteps, validateSteps } from "../lib/steps.mjs";
import { mergeTimeline } from "../lib/timeline.mjs";
import { PRODUCT_QUERY } from "./drop-meter.mjs";
import { num, STATE_ROUTE } from "./race-perf.mjs";

const log = (m) => console.log(`[cpu-window] ${m}`);
const unknown = (e) => (/Unknown upstream worker message/.test(e) ? "engine without this worker message" : e);

// A reply copied twice by the worker, decoded and checked for a tear.
function decoded(reply, decode, consistent) {
  if (!reply) return { error: "no reply" };
  if (reply.error) return { error: unknown(reply.error) };
  return consistent(decode(reply.bytes), decode(reply.again));
}

// The counters' structs and the core ticks, read only (no reset). `t`:
// the node time halfway through the reads.
// light: the product's counters only (headroom, the 0213 diag): the region,
// memory and AX stats are never read (a read can turn them on).
export async function snapshot(page, { light = false } = {}) {
  const t0 = performance.now();
  const req = (type, payload) => workerRequest(page, type, payload, 10000).catch((e) => ({ error: String(e?.message || e) }));
  const off = { error: LIGHT_OFF };
  const headroom = decoded(await req("validationReadHeadroomStats", { reset: -1 }), decodeHeadroomStats, consistentHeadroomRead);
  const region = light ? off : decoded(await req("validationReadJitRegionStats", {}), decodeRegionStats, consistentRead);
  const ax = light ? off : decoded(await req("validationReadAxHleStats", { reset: -1 }), decodeAxStats, consistentAxRead);
  const mem = light ? off : decoded(await req("validationReadMemAccessStats", {}), decodeMemStats, consistentMemRead);
  const diag = decoded(await req("validationReadCpuThreadDiag", { reset: -1 }), decodeCpuThreadDiag, consistentCpuThreadDiagRead);
  const p = await readCoreProgress(page).catch(() => null);
  const progress = p && !p.error ? { coreTicks: Number(p.coreTicks), coreTicksPerSecond: Number(p.coreTicksPerSecond), frame: p.frame ?? null } : { error: p?.error ?? "no core progress" };
  // the screen's signals, as parcours reads them (the replay's draws since
  // boot, the frame rates): what phase a row is in (lib/cpu-window.mjs phaseCheck)
  const screen = await page.evaluate(() => {
    const f = window.__lastFrameInfo || {};
    const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const d = /wgx:d(\d+)/.exec(String(f.ppcWasmHelperStats || ""));
    return { draws: d ? Number(d[1]) : null, producedFps: n(f.newFramesProducedPerSec), newFps: n(f.newFramesPerSec) };
  }).catch(() => null);
  return { t: (t0 + performance.now()) / 2, headroom, region, ax, mem, diag, progress, screen };
}

// Every counter on and reset (n >= 0), once: what each reset answered. The
// region stats untimed here (sampleEvery 0); timeRegions() times them.
export const LIGHT_OFF = "--light: not read (the product's counters only)";
async function enableStats(page, { light = false } = {}) {
  const req = (type, payload) => workerRequest(page, type, payload, 10000).catch((e) => ({ error: String(e?.message || e) }));
  const status = (r) => (r?.error ? unknown(r.error) : "on");
  // --light: headroom and the 0213 diag only, what a product run has (the
  // region stats publish a sorted copy of their miss map every 64 slices)
  if (light) {
    return {
      mem: "off (--light)", ax: "off (--light)", region: "off (--light)",
      headroom: status(await req("validationReadHeadroomStats", { reset: 0 })),
      cpuThread: status(await req("validationReadCpuThreadDiag", { reset: 0 }))
    };
  }
  return {
    mem: status(await req("validationReadMemAccessStats", { reset: 0 })),
    ax: status(await req("validationReadAxHleStats", { reset: 0 })),
    headroom: status(await req("validationReadHeadroomStats", { reset: 0 })),
    // 0213; a core without DolphinWeb_CpuThreadDiagStats answers an error:
    // its columns stay empty (why.cpuThread)
    cpuThread: status(await req("validationReadCpuThreadDiag", { reset: 0 })),
    region: status(await req("validationReadJitRegionStats", { sampleEvery: 0 }))
  };
}
const timeRegions = (page, o) => workerRequest(page, "validationReadJitRegionStats", { sampleEvery: o.regionSample }, 10000).catch((e) => ({ error: String(e?.message || e) }));

// The drop sampler's last row of a drain ({ columns, rows }), as an object
// of cumulative counters, or null when it gave none.
export function lastSamplerRow(drained) {
  const row = drained?.rows?.at?.(-1);
  if (!row || !Array.isArray(drained.columns)) return null;
  return Object.fromEntries(drained.columns.map((c, i) => [c, row[i]]));
}
// What the sampler's counters did between two rows (its rows lag the
// snapshots by up to --sampler-ms): JIT compiles and their CPU-thread time
// (0167), the synchronous Module and Instance time (u32 µs, wrap), blocks
// posted off-thread, region installs, disc waits, new compiles sent.
export const SAMPLER_DELTAS = ["jitCompiles", "jitUs", "jitModuleUs", "jitInstanceUs", "offThreadDefers", "regionsInstalled", "regionInstallMs", "discWaits", "discWaitUs", "jitNewCompiles", "efbWaitUs"];
export function samplerDelta(a, b) {
  if (!a || !b) return null;
  const wrap = (x) => (x < 0 ? x + 2 ** 32 : x);
  return Object.fromEntries(SAMPLER_DELTAS.map((c) => {
    const d = a[c] == null || b[c] == null ? null : b[c] - a[c];
    return [c, d == null ? null : c === "jitModuleUs" || c === "jitInstanceUs" ? wrap(d) : d];
  }));
}

// A watchdog that counts only while armed: armed once the gate returned
// with the lock held, disarmed when the measure ends (or fails), so a lock
// given back to wait for calm or mains power (calmLock) is never counted
// (2026-11-02: a watchdog started at the first lock killed a run that was
// waiting for calm, 900 s later). Firing releases the lock, then exits.
export function heldWatchdog({ seconds, release, exit = (c) => process.exit(c), log = (m) => console.error(m), timers = { setTimeout, clearTimeout } }) {
  let timer = null;
  const disarm = () => {
    if (timer != null) timers.clearTimeout(timer);
    timer = null;
  };
  return {
    arm() {
      disarm();
      timer = timers.setTimeout(() => {
        timer = null;
        log(`[cpu-window] watchdog: ${seconds} s measuring under the lock`);
        try {
          release();
        } finally {
          exit(2);
        }
      }, seconds * 1000);
    },
    disarm,
    get armed() {
      return timer != null;
    }
  };
}

// The 0213 line: coverage of other over the rows, and the top 3 CoreTiming
// event types per guest second in the dips, the normal rows and grown.
export function cpuThreadLine(c, rows) {
  const cov = rows.map((r) => r.cpuThread?.coverageOfOther).filter(Number.isFinite);
  if (!cov.length) return `CPU-thread diag: none (${rows.find((r) => r.why?.cpuThread)?.why.cpuThread ?? "no row"})`;
  const mean = cov.reduce((a, b) => a + b, 0) / cov.length;
  const fmt = (l) => (l.length ? l.map(([k, v]) => `${k} ${v}`).join(", ") : "-");
  return `CPU-thread diag: coverage of other ${round(mean * 100, 1)} % (mean of ${cov.length} rows); event ms per guest s, dips: ${fmt(c.events.dips)}; normal: ${fmt(c.events.normal)}; grew: ${fmt(c.events.grew)}`;
}

async function closeBounded(session) {
  await Promise.race([session.close().catch(() => {}), new Promise((r) => setTimeout(r, 20000))]);
}

async function measure(o, server) {
  const routes = o.state ? { [STATE_ROUTE]: o.state } : {};
  // the display from the environment (HARNESS_DISPLAY): headless by default,
  // the bench's screen under spark-run --headed (video=wgpu needs it there)
  // --display: the worker's rAF records what each BeginFrame shows (as
  // drop-meter and parcours --display); --sampler-ms: the drop sampler
  // (validationDropSampler, with patch 0167's per-compile timer) runs as in
  // parcours and drop-meter, drained at every row. Both to price what those
  // probes add to the run they measure.
  const session = await openSession({ base: server.base, server, query: o.query, iso: o.iso, routes, harness: o.display ? { displayed: true } : {} });
  const { page } = session;
  try {
    if (o.samplerMs) {
      const started = await workerRequest(page, "validationDropSampler", { action: "start", everyMs: o.samplerMs }, 5000).catch((e) => ({ error: String(e?.message || e) }));
      if (started?.error) throw new Error(`--sampler-ms: ${started.error}`);
    }
    // --counters-before-load: every counter reset (and so the JIT cache the
    // memory stats' first reset clears) BEFORE the state load. The state
    // load empties the JIT cache itself (patch 0171), as in production; what
    // this avoids is a SECOND clear after the load, which production never
    // has. The block recompiles right after the load are therefore real
    // costs, measured, not an artefact. The rows start at the load only with
    // --warmup 0 --untimed-secs 0 (summary: rowsStartAfterLoadSec).
    let enabled = null;
    if (o.countersBeforeLoad) {
      enabled = await enableStats(page, { light: o.light });
      await page.waitForTimeout(Math.max(o.memWarm, 1) * 1000);
    }
    let loadedAt = null, warm = null;
    if (o.state) {
      const loaded = await loadHarnessState(page, session.url);
      if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
      loadedAt = performance.now();
      // --reload-after S: the warm case (the player has played, the regions
      // are built and installed): S seconds of play, then the same state
      // loaded again in the same session; the rows start at that second load.
      if (o.reloadAfter) {
        await page.waitForTimeout(o.reloadAfter * 1000);
        const before = decodeRegionStats((await workerRequest(page, "validationReadJitRegionStats", {}, 10000).catch(() => null))?.bytes ?? null);
        const again = await loadHarnessState(page, session.url);
        if (!again?.loaded) throw new Error(`savestate reload failed: ${JSON.stringify(again)}`);
        loadedAt = performance.now();
        warm = { afterSec: o.reloadAfter, regionsInstalled: before?.diagnostics?.regionsInstalled ?? null, regionsQueued: before?.diagnostics?.regionsQueued ?? null };
        log(`warm: reloaded after ${o.reloadAfter} s, ${warm.regionsInstalled} region(s) installed, ${warm.regionsQueued} queued`);
      }
    } else if (o.steps) {
      await runSteps(page, o.steps);
    }
    if (o.hold) await page.keyboard.down(o.hold);
    await page.waitForTimeout(o.warmup * 1000);
    if (!enabled) {
      enabled = await enableStats(page, { light: o.light });
      // The memory stats' first reset clears the JIT cache (the block
      // recompiles stay out of the rows); every reset applies at the next
      // slice, Throttle or mail.
      await page.waitForTimeout(Math.max(o.memWarm, 1) * 1000);
    }
    log(`counters: ${Object.entries(enabled).map(([k, v]) => `${k} ${v}`).join(", ")}${o.countersBeforeLoad ? " (reset before the state load)" : ""}`);
    // The untimed window (region counters only): the timing's price.
    let untimed = null;
    if (o.untimedSecs > 0) {
      const u0 = await snapshot(page, { light: o.light });
      await page.waitForTimeout(o.untimedSecs * 1000);
      untimed = cpuWindowBreakdown(u0, await snapshot(page, { light: o.light }));
    }
    const timed = o.light ? null : await timeRegions(page, o);
    if (timed?.error) enabled.regionTimed = unknown(timed.error);
    if (!o.light) await page.waitForTimeout(1000); // the region reset applies at the next slice (--light: no region stats, rows from the load on)
    await readTimeline(page); // drop the VIs before the first snapshot
    const snaps = [await snapshot(page, { light: o.light })];
    if (o.samplerMs) snaps[0].sampler = lastSamplerRow(await workerRequest(page, "validationDropSampler", { action: "drain" }, 10000).catch(() => null));
    const rows = [], loads = [];
    const start = performance.now();
    // played alongside the rows; an error is kept and thrown after them
    const duringRun = o.during ? runSteps(page, o.during).then(() => ({ doneS: round((performance.now() - start) / 1000, 2) }), (e) => ({ error: e })) : null;
    const steps = Math.max(1, Math.round(o.secs / o.step));
    for (let i = 1; i <= steps; i += 1) {
      // a fixed schedule: a slow read does not shift the next one
      const wait = start + i * o.step * 1000 - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const snap = await snapshot(page, { light: o.light });
      const chunk = await readTimeline(page).catch((e) => ({ error: String(e?.message || e) }));
      if (o.samplerMs) snap.sampler = lastSamplerRow(await workerRequest(page, "validationDropSampler", { action: "drain" }, 10000).catch(() => null)) ?? snaps.at(-1).sampler ?? null;
      const timeline = mergeTimeline([chunk]);
      loads.push(os.loadavg()[0]);
      const row = { i, atS: round((snap.t - snaps[0].t) / 1000, 2), vi: viRangeOf(timeline.vi), viLost: timeline.lost.vi || 0, screen: screenOf(snaps.at(-1), snap), sampler: samplerDelta(snaps.at(-1).sampler, snap.sampler), ...cpuWindowBreakdown(snaps.at(-1), snap) };
      snaps.push(snap);
      rows.push(row);
      if (session.watch.fatal().length) throw new Error(`page fatal: ${JSON.stringify(session.watch.fatal()).slice(0, 300)}`);
    }
    const duringDone = duringRun ? await Promise.race([duringRun, Promise.resolve({ unfinished: true })]) : null;
    if (duringDone?.error) throw duringDone.error;
    if (duringDone?.unfinished) throw new Error(`--steps-during did not finish within --secs ${o.secs}: lengthen --secs`);
    const medianLoad = median(loads);
    const rowsStartAfterLoadSec = loadedAt != null && Number.isFinite(snaps[0]?.t) ? round((snaps[0].t - loadedAt) / 1000, 2) : null;
    return { enabled, untimed, rows, snapshots: snaps, rowsStartAfterLoadSec, stepsDuringDoneS: duringDone?.doneS ?? null, warm, load1: { median: round(medianLoad, 2), max: round(Math.max(...loads), 2), limit: o.maxLoad }, overloaded: medianLoad > o.maxLoad, fatal: session.watch.fatal() };
  } finally {
    if (o.hold) await page.keyboard.up(o.hold).catch(() => {});
    await closeBounded(session);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, state: { type: "string" }, steps: { type: "string" }, "steps-during": { type: "string" }, candidate: { type: "string" },
      config: { type: "string", default: "product" }, query: { type: "string" },
      warmup: { type: "string", default: "25" }, secs: { type: "string", default: "30" }, step: { type: "string", default: "1" },
      hold: { type: "string", default: "KeyX" }, vi: { type: "string" },
      "dip-speed": { type: "string", default: "99" }, "dip-busy": { type: "string", default: "0.95" },
      "region-sample": { type: "string", default: "64" }, "mem-warm": { type: "string", default: "5" }, "untimed-secs": { type: "string", default: "5" },
      "max-load": { type: "string" }, "load-wait": { type: "string", default: "300" }, "lock-wait": { type: "string", default: "1800" }, "calm-wait": { type: "string" },
      port: { type: "string", default: process.env.HARNESS_PORT }, out: { type: "string" },
      // set by spark-run for every probe: one tree, one window here
      runs: { type: "string" }, baseline: { type: "string" }, "baseline-query": { type: "string" },
      "counters-before-load": { type: "boolean", default: false }, light: { type: "boolean", default: false }, display: { type: "boolean", default: false }, "sampler-ms": { type: "string" }, "reload-after": { type: "string" }
    },
    allowPositionals: false
  });
  if (!values.iso || !values.port || (values.state && values.steps)) {
    throw new Error("usage: cpu-window.mjs --iso disc.iso --port N [--state scene.sav | --steps steps.json] [--candidate dir] [--warmup 25] [--secs 30] [--step 1] [--hold KeyX] [--vi FROM-TO] [--out dir]");
  }
  if (values.baseline || values["baseline-query"]) throw new Error("cpu-window profiles one tree: --candidate only, no --baseline or --baseline-query");
  if (values.runs != null && values.runs !== "1") console.error(`[cpu-window] --runs ${values.runs} ignored: one window per run (--secs sets its length)`);
  const iso = path.resolve(values.iso), state = values.state ? path.resolve(values.state) : null;
  for (const f of [iso, state].filter(Boolean)) if (!existsSync(f)) throw new Error(`not found: ${f}`);
  const steps = values.steps ? JSON.parse(readFileSync(path.resolve(values.steps), "utf8")) : null;
  if (steps) validateSteps(steps);
  const during = values["steps-during"] ? JSON.parse(readFileSync(path.resolve(values["steps-during"]), "utf8")) : null;
  if (during) validateSteps(during);
  let root = REPO_ROOT;
  if (values.candidate) {
    root = path.resolve(values.candidate);
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`--candidate ${values.candidate}: a tree directory (git archive one first)`);
  }
  const o = {
    iso, state, steps, during, root,
    query: `${values.query ?? (values.config === "product" ? PRODUCT_QUERY : PRESETS[values.config] ?? values.config)}&metrics=1`,
    warmup: num(values, "warmup", { min: 0 }), secs: num(values, "secs", { min: 1 }), step: num(values, "step", { min: 0.25 }),
    hold: values.hold || null, vi: parseViRange(values.vi), countersBeforeLoad: Boolean(values["counters-before-load"]), light: Boolean(values.light), display: Boolean(values.display), samplerMs: values["sampler-ms"] ? num(values, "sampler-ms", { min: 10, int: true }) : null, reloadAfter: values["reload-after"] ? num(values, "reload-after", { min: 1 }) : null,
    dipSpeed: num(values, "dip-speed", { min: 0 }), dipBusy: num(values, "dip-busy", { min: 0 }),
    regionSample: num(values, "region-sample", { min: 0, int: true }), memWarm: num(values, "mem-warm", { min: 0 }), untimedSecs: num(values, "untimed-secs", { min: 0 }),
    maxLoad: values["max-load"] ? num(values, "max-load", { min: 0.1 }) : defaultMaxLoad(),
    loadWait: num(values, "load-wait", { min: 0 }), port: num(values, "port", { min: 1, int: true })
  };
  if (o.secs < o.step) throw new Error(`--secs ${o.secs} < --step ${o.step}`);
  // thresholds checked before any lock (classifyDips refuses them too)
  if (o.dipBusy > 1) throw new Error(`--dip-busy ${o.dipBusy}: a share of host time, 0 to 1`);
  if (o.regionSample === 0) log("--region-sample 0: counters only, every region/block/dispatch/idle time will be null");
  const lockWait = num(values, "lock-wait", { min: 0 });
  const calmWait = values["calm-wait"] == null ? lockWait : num(values, "calm-wait", { min: 0 });

  const lock = await calmLock({ maxLoad: o.maxLoad, calmWait, log: (m) => log(`before the lock: ${m}`), acquire: () => acquirePerfLock({ requireMains: true, name: `harness cpu-window (${REPO_ROOT})`, waitSec: lockWait, log }) });
  // Never hold the lock for ever (a hung browser): the measure only, armed
  // with the lock held (heldWatchdog), never a wait for calm or power.
  const budgetSec = 240 + o.warmup + o.memWarm + o.untimedSecs + o.secs * 2;
  const watchdog = heldWatchdog({ seconds: budgetSec, release: () => lock.release() });
  let code = 1;
  let server = null;
  try {
    const outDir = probeOutDir("cpu-window", o.iso, values.out);
    server = await ensureServer({ port: o.port, root: o.root });
    const gate = await lock.waitCalmUnlocked({ waitSec: o.loadWait });
    const gaveUp = loadGaveUp(gate);
    if (gaveUp) throw new Error(gaveUp);
    // the gate returned with the lock held (taken back if it went for calm)
    watchdog.arm();
    const run = await measure(o, server);
    watchdog.disarm();
    // --vi: a range no row covers, or past the run, is a failure (exit 1),
    // never an empty "no dip row"
    const sel = rowsInViRange(run.rows, o.vi);
    const rows = classifyDips(sel.rows, { speedBelow: o.dipSpeed, busyAbove: o.dipBusy });
    const c = contrast(rows);
    const lastRegion = run.snapshots.at(-1)?.region;
    const regionsInstalled = lastRegion && !lastRegion.error ? lastRegion.diagnostics?.regionsInstalled ?? null : null;
    const coverage = run.rows.map((r) => r.regionCoverage?.raw).filter(Number.isFinite);
    const meanCoverage = coverage.length ? round(coverage.reduce((a, b) => a + b, 0) / coverage.length, 4) : null;
    const warning = regionWarning({ query: o.query, rows: run.rows, region: lastRegion });
    const cost = timingCost(run.untimed, run.rows);
    const summary = {
      probe: "cpu-window", at: new Date().toISOString(), chrome: chromeInfo(), served: server.identity ?? null, root: o.root,
      iso: path.basename(o.iso), scene: o.state ? `state ${path.basename(o.state)}` : o.steps ? `steps ${path.basename(values.steps)}` : "boot",
      query: o.query, hold: o.hold, warmupSec: o.warmup, secs: o.secs, stepSec: o.step, regionSample: o.regionSample, memWarmSec: o.memWarm,
      // the counters (and the JIT cache the memory stats' first reset clears)
      // reset before the state load; the load clears the cache itself
      // (0171), so post-load block recompiles are real, not an artefact
      countersBeforeLoad: o.countersBeforeLoad,
      // --light: the product's counters only (no region, memory or AX stats)
      light: o.light, displayTrace: o.display, samplerMs: o.samplerMs,
      countersNote: o.countersBeforeLoad
        ? "counters reset before the state load: no second JIT cache clear after it; the load's own clear (0171) and its recompiles are measured"
        : "counters reset after the warmup: the memory stats' first reset clears the JIT cache (block recompiles after it are an artefact of the probe)",
      rowsStartAfterLoadSec: run.rowsStartAfterLoadSec,
      // a transition played with --steps-during: COMPLETE only when the
      // rows show the compile wave, then the game phase after it; an
      // INCOMPLETE run (the route lost its way) is left out, as in parcours
      // --reload-after: the rows follow a second load of the state, after that much play
      warm: run.warm,
      stepsDuring: values["steps-during"] ? { file: path.basename(values["steps-during"]), doneAtS: run.stepsDuringDoneS, ...phaseCheck(run.rows) } : null,
      vi: o.vi, dipSpeed: o.dipSpeed, dipBusy: o.dipBusy, loadGate: gate, load1: run.load1, overloaded: run.overloaded, fatal: run.fatal,
      enabled: run.enabled, regionsInstalled, meanRegionCoverage: meanCoverage, regionWarning: warning,
      untimedSecs: o.untimedSecs, untimed: run.untimed, timingCost: cost,
      rowsTotal: run.rows.length, rowsKept: rows.length, rowsDroppedNoVi: sel.droppedNoVi, viError: sel.error,
      splitNote: SPLIT_NOTE, inflation: inflationNote(cost),
      dips: rows.filter((r) => r.dip).map((r) => ({ i: r.i, vi: r.vi, speedPct: r.speedPct, cpuBusyShare: r.cpuBusyShare, why: r.dipWhy })),
      contrast: c,
      rows,
      // with --vi, every row the run measured (the selection may be empty)
      ...(o.vi ? { allRows: run.rows } : {}),
      snapshots: run.snapshots
    };
    writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
    log(`query ${o.query}`);
    log(`regions: ${regionsInstalled ?? "?"} installed, coverage ${meanCoverage == null ? "?" : `${round(meanCoverage * 100, 1)} %`} of guest cycles (mean of the rows)`);
    if (warning) log(`WARNING: ${warning}`);
    log(inflationNote(cost));
    log(`timing cost: ${cost.ratio == null ? `unknown (${cost.why})` : `x${cost.ratio} CPU-thread busy ms per guest second timed (${cost.timedBusyMsPerGuestSecond}) vs untimed (${cost.untimedBusyMsPerGuestSecond}); speed ${cost.timedSpeedPct} % timed vs ${cost.untimedSpeedPct} % untimed`}`);
    console.log(formatTable(rows));
    log(cpuThreadLine(c, run.rows));
    if (sel.droppedNoVi) log(`${sel.droppedNoVi} row(s) without a VI range left out by --vi`);
    if (sel.error) {
      // the rows are in summary.json, the selection failed: never exit 0
      console.error(`[cpu-window] FAILED: ${sel.error} (all ${run.rows.length} rows in summary.json) -> ${outDir}`);
      code = 1;
    } else {
      log(`${rows.length} row(s)${o.vi ? ` in VI ${o.vi.join("-")}` : ""}, ${summary.dips.length} dip(s): ${c.verdict}${run.overloaded ? " (OVERLOADED: load median over the limit)" : ""} -> ${outDir}`);
      code = run.overloaded || run.fatal?.length ? 1 : 0;
    }
  } catch (error) {
    console.error(`[cpu-window] ${String(error?.stack || error)}`);
    code = 1;
  } finally {
    await server?.stop?.().catch(() => {});
    watchdog.disarm();
    lock.release();
  }
  process.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
