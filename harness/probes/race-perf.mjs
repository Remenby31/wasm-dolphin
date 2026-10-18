#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Steady-state performance of one scene: load a savestate, hold a key (the
// accelerator in a race), let the scene settle, then measure without any
// profiler attached (a CDP sampling profiler alone costs 15-20 points of
// speed). Several runs, each in a fresh headless profile.
//
//   node harness/probes/race-perf.mjs --iso disc.iso --state scene.sav --port N
//     [--config wgpu | --query "..."] [--runs 3] [--warmup 25] [--secs 20]
//     [--hold KeyX] [--warm] [--out dir]
//
// Per run: emulated speed from the core's own VI timeline (ticks over host
// time), game frame rate (visual changes: a game that drops frames shows it
// here, not in the speed), VI and presentation interval percentiles, hitches,
// and the CPU of the renderer's busiest thread (a saturated emulated CPU
// thread reads ~100 %). --warm reboots the same profile once the first
// measurement is done and measures again, so cold and warm caches (JIT
// blocks, shaders) are compared on the same run.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { bootIso, ensureServer, pageCall, readCoreProgress, readFrameInfo, readTimeline, REPO_ROOT } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { claim } from "../lib/ownership.mjs";
import { openSession } from "../lib/session.mjs";
import { describe, median, percentile, round } from "../lib/stats.mjs";
import { coreStats, mergeTimeline, presentationStats } from "../lib/timeline.mjs";

const HOMEBREW_OUT = path.join(REPO_ROOT, "harness", "homebrew", "out");
const STATE_ROUTE = "**/__harness_state.sav";
// 1-minute load average above which a window is not trusted: a quarter of the
// cores busy with something else.
const NOISY_LOAD = Math.max(2, os.cpus().length / 4);

const { values } = parseArgs({
  options: {
    iso: { type: "string" },
    state: { type: "string" },
    config: { type: "string", default: "wgpu" },
    query: { type: "string" },
    runs: { type: "string", default: "3" },
    warmup: { type: "string", default: "25" },
    secs: { type: "string", default: "20" },
    hold: { type: "string", default: "KeyX" },
    warm: { type: "boolean", default: false },
    port: { type: "string", default: process.env.HARNESS_PORT },
    out: { type: "string" },
  },
});
if (!values.iso || !values.state || !values.port) {
  throw new Error("usage: race-perf.mjs --iso disc.iso --state scene.sav --port N (or HARNESS_PORT) [--config wgpu | --query q] [--runs 3] [--warmup 25] [--secs 20] [--hold KeyX] [--warm]");
}
const iso = path.resolve(values.iso);
const state = path.resolve(values.state);
if (!existsSync(state)) throw new Error(`savestate not found: ${state}`);
const localOnly = !iso.startsWith(HOMEBREW_OUT);
if (localOnly && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
const query = `${values.query ?? PRESETS[values.config] ?? values.config}&metrics=1`;

// Same placement as the CLI's results: a local-only disc never writes into the repo.
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${process.pid}-${randomBytes(3).toString("hex")}`;
const outDir = values.out ? path.resolve(values.out) : localOnly
  ? path.resolve(process.env.HARNESS_PRIVATE_OUT || path.join(REPO_ROOT, "..", "measures", "harness"), `race-perf-${stamp}`)
  : path.join(REPO_ROOT, "harness", "results", `race-perf-${stamp}`);
mkdirSync(path.dirname(outDir), { recursive: true });
mkdirSync(outDir);
claim(outDir, REPO_ROOT, "results");

const coreSha = JSON.parse(readFileSync(path.join(REPO_ROOT, "cores", "dolphin", "core.lock.json"), "utf8")).sha256;

// The renderer of this profile and the CPU of its busiest thread (ps -M).
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

async function waitRunning(page, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (((await readCoreProgress(page))?.frame ?? 0) > 0) return;
    await page.waitForTimeout(100);
  }
  throw new Error("core never reached Running");
}

// Load the scene, hold the key through warmup and measurement, measure.
async function measure(session) {
  const { page } = session;
  await waitRunning(page);
  // VI outputs start before the core leaves "Starting", and a load sent then
  // is refused: retry until it is accepted.
  let loaded;
  for (let tries = 0; tries < 60; tries += 1) {
    loaded = await pageCall(page, "__loadStateFile", new URL("__harness_state.sav", session.url).href, 120000);
    if (loaded?.loaded || loaded?.beforeState !== "Starting") break;
    await page.waitForTimeout(1000);
  }
  if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
  if (values.hold) await page.keyboard.down(values.hold);
  try {
    await page.waitForTimeout(Number(values.warmup) * 1000);
    await readTimeline(page); // drop everything before the window
    const loadBefore = os.loadavg()[0];
    const t0 = await page.evaluate(() => performance.timeOrigin + performance.now());
    const samples = [], chunks = [];
    for (let s = 0; s < Number(values.secs); s += 1) {
      await page.waitForTimeout(1000);
      samples.push(await readFrameInfo(page));
      if (s % 2 === 1) chunks.push(await readTimeline(page));
    }
    chunks.push(await readTimeline(page));
    const threads = rendererThreads(session.profileDir);
    const t1 = await page.evaluate(() => performance.timeOrigin + performance.now());
    const progress = await readCoreProgress(page);
    const timeline = mergeTimeline(chunks);
    const core = coreStats(timeline, { ticksPerSecond: progress?.coreTicksPerSecond, until: t1 });
    const pres = presentationStats(timeline);
    const viMs = timeline.vi.slice(1).map((v, i) => v.t - timeline.vi[i].t);
    // coreprof xfb_dt: the core's own interval between XFB outputs, max since boot.
    const videoStats = await page.evaluate(() => String(window.__lastFrameInfo?.ppcWasmHelperStats ?? "")).catch(() => "");
    const xfbDt = /xfb_dt:([\d.]+) avg:([\d.]+) max:([\d.]+)/.exec(videoStats);
    const field = (k) => median(samples.map((x) => x[k]));
    return {
      windowMs: Math.round(t1 - t0),
      // Other work on the machine (a build, another browser) slows the
      // emulated CPU thread: such a window is flagged, not trusted.
      load1: [round(loadBefore, 2), round(os.loadavg()[0], 2)],
      noisy: Math.max(loadBefore, os.loadavg()[0]) > NOISY_LOAD,
      complete: timeline.complete,
      speed: round(core.speed), speedP5: round(core.speedP5), speedMin: round(core.speedMin),
      gameFps: field("vis"), coreFps: field("core"), presentFpsPage: field("pres"),
      presents: pres.presents, viOutputs: timeline.vi.length,
      viIntervalMs: { p50: round(percentile(viMs, 50)), p99: round(percentile(viMs, 99)), max: round(viMs.length ? Math.max(...viMs) : null) },
      presentIntervalMs: { p50: round(pres.frameP50), p99: round(pres.frameP99), max: round(pres.frameMax) },
      hitchesPerMin: round(pres.hitchesPerMin),
      coreprofXfbDtMaxMs: xfbDt ? Number(xfbDt[3]) : null,
      jitCompiles: field("jitc"),
      rendererThreads: threads,
      freezes: { core: core.freezes?.length ?? 0, present: pres.freezes.length },
    };
  } finally {
    if (values.hold) await page.keyboard.up(values.hold).catch(() => {});
  }
}

const server = await ensureServer({ port: Number(values.port) });
const runs = [];
try {
  for (let run = 1; run <= Number(values.runs); run += 1) {
    const session = await openSession({ base: server.base, query, iso, routes: { [STATE_ROUTE]: state } });
    const record = { run, url: session.url, coreSha };
    try {
      record.cold = await measure(session);
      if (values.warm) {
        // Same profile, same caches: boot again and measure again.
        await bootIso(session.page, { url: session.url, iso });
        record.warm = await measure(session);
      }
    } catch (error) {
      record.error = String(error?.message || error).slice(0, 300);
    }
    record.fatal = session.watch?.fatal?.() ?? [];
    await session.close();
    writeFileSync(path.join(outDir, `run${run}.json`), JSON.stringify(record, null, 1) + "\n");
    runs.push(record);
    const brief = (m) => m && `speed ${m.speed} % game ${m.gameFps} fps vi p99 ${m.viIntervalMs.p99} ms present p99 ${m.presentIntervalMs.p99} ms hitches ${m.hitchesPerMin}/min busiest thread ${m.rendererThreads?.busiest} % load ${m.load1.join("/")}${m.noisy ? " NOISY" : ""}`;
    console.log(`[race-perf] run ${run}: ${record.error ?? brief(record.cold)}${record.warm ? ` | warm: ${brief(record.warm)}` : ""}`);
  }
} finally {
  await server.stop();
}
const ok = runs.filter((r) => !r.error && !r.fatal.length);
const noisy = ok.filter((r) => r.cold?.noisy || r.warm?.noisy).length;
const summarize = (phase) => {
  const m = ok.map((r) => r[phase]).filter(Boolean);
  if (!m.length) return null;
  return {
    speed: describe(m.map((x) => x.speed)),
    gameFps: describe(m.map((x) => x.gameFps)),
    viP99Ms: describe(m.map((x) => x.viIntervalMs.p99)),
    presentP99Ms: describe(m.map((x) => x.presentIntervalMs.p99)),
    presentMaxMs: describe(m.map((x) => x.presentIntervalMs.max)),
    hitchesPerMin: describe(m.map((x) => x.hitchesPerMin)),
  };
};
const summary = { iso: path.basename(iso), state: path.basename(state), query, coreSha, warmupSec: Number(values.warmup), secs: Number(values.secs),
  hold: values.hold, runs: runs.length, failed: runs.length - ok.length, noisy, cold: summarize("cold"), warm: summarize("warm") };
writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
console.log(`[race-perf] speed median ${summary.cold?.speed.median ?? "-"} % over ${ok.length}/${runs.length} runs${noisy ? `, ${noisy} on a busy machine (load > ${NOISY_LOAD}): rerun` : ""} -> ${outDir}`);
process.exitCode = ok.length === runs.length ? 0 : 1;
