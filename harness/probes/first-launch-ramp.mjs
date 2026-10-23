#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// First-launch ramp (KPI: time to 90 % speed < 15 s on the Mac), headless only:
//
//   node harness/probes/first-launch-ramp.mjs --iso disc.iso --port N
//     --scene race|heavy --steps steps.json [--sec 90]
//     [--config rec | --query "..."] [--runs 3]
//     [--max-load L] [--load-wait 300] [--lock-wait 1800 | --no-lock] [--out dir]
//
// The player's very first launch with the region recompiler: each run opens
// a new, empty Chrome profile (no seed: aot-warm-launch needs a seeded one),
// hands the disc to the engine page (t0), plays the steps (the scene: input
// to a race, or a click and the intro that plays by itself) and records
// --sec seconds more. Every second it drains the VI ring and reads the
// core's region pipeline (validationReadJitRegionStats, read only: regions
// queued and installed). lib/ramp.mjs turns that into the time to 90 % and
// to 95 % speed, the plateau, the per-second series and the regions over
// time. The query gets aot=1 unless it says otherwise.
// A timing measure: calm machine first, then the shared perf lock.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { bootIso, ensureServer, launchChrome, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { calmLock, loadGaveUp } from "../lib/env.mjs";
import { decodeRegionStats } from "../lib/jit-region-stats.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { claim } from "../lib/ownership.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { chromeInfo, isLocalOnly, probeOutDir } from "../lib/probe-out.mjs";
import { rampOf, summarizeRamp } from "../lib/ramp.mjs";
import { median, round } from "../lib/stats.mjs";
import { runSteps, validateSteps } from "../lib/steps.mjs";
import { machineSnapshot } from "../lib/system.mjs";
import { mergeTimeline, speedSeries } from "../lib/timeline.mjs";
import { num } from "./race-perf.mjs";

const SCENES = ["race", "heavy"];

// The region pipeline now (cumulative, readable with the stats off).
async function readRegions(page) {
  const reply = await workerRequest(page, "validationReadJitRegionStats", {}, 5000).catch((e) => ({ error: String(e.message || e) }));
  const d = reply?.bytes && !reply.error ? decodeRegionStats(reply.bytes)?.diagnostics : null;
  return d ? { installed: d.regionsInstalled ?? null, queued: d.regionsQueued ?? null } : null;
}

async function measureRun(o, server, loadGate) {
  const record = { loadGate };
  if (loadGaveUp(loadGate)) return record;
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-harness-ramp-"));
  const releaseProfile = claim(profileDir, REPO_ROOT, "chrome-profile");
  const context = await launchChrome({ profileDir });
  try {
    await context.assertInvisible("after launch");
    const page = context.pages()[0] ?? (await context.newPage());
    const t0 = Date.now();
    await bootIso(page, { url: `${server.base}?${o.query}`, iso: o.iso, timeoutMs: 120000 });
    record.bootMs = Date.now() - t0;
    const chunks = [], regions = [], loads = [];
    let draining = true;
    const drain = (async () => {
      while (draining) {
        chunks.push(await readTimeline(page).catch((e) => ({ error: String(e.message || e) })));
        const r = await readRegions(page);
        if (r) regions.push({ t: Date.now(), ...r });
        loads.push(os.loadavg()[0]);
        await page.waitForTimeout(1000);
      }
    })();
    await runSteps(page, o.steps);
    record.sceneAtMs = Date.now() - t0;
    await page.waitForTimeout(o.sec * 1000);
    draining = false;
    await drain;
    chunks.push(await readTimeline(page).catch((e) => ({ error: String(e.message || e) })));
    const timeline = mergeTimeline(chunks);
    const tps = (await workerRequest(page, "validationReadCoreProgress", {}, 15000).catch(() => null))?.coreTicksPerSecond ?? null;
    if (!(tps > 0)) throw new Error("no core ticks per second (validationReadCoreProgress)");
    record.timelineComplete = timeline.complete;
    record.regionsRead = regions.length > 0;
    record.ramp = rampOf(speedSeries(timeline.vi.filter((v) => v.t >= t0), tps), t0, regions);
    const medianLoad = median(loads);
    record.load1 = { median: round(medianLoad, 2), max: round(Math.max(...loads), 2), limit: o.maxLoad };
    record.overloaded = medianLoad > o.maxLoad;
    return record;
  } catch (error) {
    return { ...record, error: String(error?.message || error).slice(0, 300) };
  } finally {
    await context.close().catch(() => {});
    releaseProfile();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, scene: { type: "string" }, steps: { type: "string" }, sec: { type: "string", default: "90" },
      config: { type: "string", default: "rec" }, query: { type: "string" }, runs: { type: "string", default: "3" },
      "max-load": { type: "string" }, "load-wait": { type: "string", default: "300" }, "lock-wait": { type: "string", default: "1800" }, "calm-wait": { type: "string" }, "no-lock": { type: "boolean", default: false },
      port: { type: "string", default: process.env.HARNESS_PORT }, out: { type: "string" }
    }
  });
  if (!values.iso || !values.steps || !SCENES.includes(values.scene)) throw new Error(`usage: first-launch-ramp.mjs --iso disc.iso --scene ${SCENES.join("|")} --steps steps.json --port N [--sec 90] [--runs 3] [--config rec | --query ...]`);
  const iso = path.resolve(values.iso);
  if (isLocalOnly(iso) && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
  const steps = JSON.parse(readFileSync(values.steps, "utf8"));
  validateSteps(steps);
  const base = new URLSearchParams(values.query ?? PRESETS[values.config] ?? values.config);
  if (!base.has("aot")) base.set("aot", "1");
  base.set("metrics", "1");
  const lockWait = num(values, "lock-wait", { min: 0 });
  const o = {
    iso, steps, query: base.toString(), sec: num(values, "sec", { min: 10 }), runs: num(values, "runs", { min: 1, int: true }),
    maxLoad: values["max-load"] ? num(values, "max-load", { min: 0.1 }) : Math.max(2, os.cpus().length / 4),
    loadWait: num(values, "load-wait", { min: 0 }), port: num(values, "port", { min: 1, int: true })
  };
  const calmWait = values["calm-wait"] == null ? lockWait : num(values, "calm-wait", { min: 0 });
  const log = (m) => console.log(`[ramp] ${m}`);
  // --no-lock: a plumbing check; kpi-report ignores it (locked: false).
  const lock = await calmLock({
    maxLoad: o.maxLoad, calmWait, log: (m) => log(`before the lock: ${m}`),
    acquire: values["no-lock"] ? null : () => acquirePerfLock({ name: `harness first-launch-ramp (${REPO_ROOT})`, waitSec: lockWait, log })
  });
  const outDir = probeOutDir("first-launch-ramp", iso, values.out);
  const server = await ensureServer({ port: o.port, root: REPO_ROOT });
  const records = [];
  let gaveUp = null;
  try {
    for (let run = 1; run <= o.runs; run += 1) {
      const r = { run, ...(await measureRun(o, server, await lock.waitCalmUnlocked({ waitSec: o.loadWait, log }))) };
      records.push(r);
      writeFileSync(path.join(outDir, `run${run}.json`), JSON.stringify(r, null, 1) + "\n");
      gaveUp = loadGaveUp(r.loadGate);
      if (gaveUp) { log(`run ${run}: ${gaveUp}`); break; }
      log(`run ${run}: ${r.error ?? `90 % at ${r.ramp.timeTo90Ms ?? "-"} ms, 95 % at ${r.ramp.timeToFullMs ?? "-"} ms, plateau ${r.ramp.plateauSpeed} %, ${r.ramp.regionsAt90 ?? "-"} regions at 90 %, ${r.ramp.regionsAtEnd ?? "-"} at the end`}${r.overloaded ? " OVERLOADED" : ""}`);
    }
  } finally {
    await server.stop();
    lock.release();
  }
  const summary = {
    probe: "first-launch-ramp", at: new Date().toISOString(), locked: !values["no-lock"], machine: machineSnapshot(),
    chrome: chromeInfo(), served: server.identity, iso: path.basename(iso), scene: values.scene, steps: path.basename(values.steps),
    query: o.query, windowSec: o.sec, maxLoad: o.maxLoad, runs: records.length, gaveUp,
    definition: "t0 = disc handed to the engine page on a new, empty profile; time to N % = first second of 5 in a row at >= N % VI speed",
    ...summarizeRamp(records, o.sec)
  };
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  log(`${values.scene}: 90 % at ${summary.timeTo90Ms.median ?? "n/a"} ms (target < ${summary.targetMs}), plateau ${summary.plateauSpeed.median ?? "n/a"} %, ${summary.failed.length} failed run(s) -> ${outDir}`);
  process.exitCode = summary.goodRuns && !summary.failed.length ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
