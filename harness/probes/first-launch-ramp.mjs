#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// First-launch ramp (KPI: time to 90 % speed < 15 s on the Mac), headless only:
//
//   node harness/probes/first-launch-ramp.mjs --iso disc.iso --port N
//     --scene race|heavy --steps steps.json [--sec 90] [--plateau FROM-TO]
//     [--config rec | --query "..."] [--runs 3]
//     [--max-load L] [--load-wait 300] [--lock-wait 1800 | --no-lock] [--out dir]
//     [--visits N [--counters [--counter-events frontend]] [--region-chain]]
//
// The player's very first launch with the region recompiler: each run opens
// a new, empty Chrome profile (no seed: aot-warm-launch needs a seeded one),
// hands the disc to the engine page (t0), plays the steps (the scene: input
// to a race, or a click and the intro that plays by itself) and records
// --sec seconds more. Every second it drains the VI ring, reads the core's
// region pipeline (validationReadJitRegionStats, read only: regions queued
// and installed) and its XFB copies (validationReadHeadroomStats, turned on
// once after the boot). lib/ramp.mjs turns that into the time to 90 % and to
// 95 % of the scene's native game frames per second, counted from the
// scene's start (the product runs decoupled: its VI speed says nothing),
// the plateau (--plateau FROM-TO seconds after the scene's start, default
// the heavy intro 0-17 s, the race's last 10 s), the per-second series and
// the regions over time. The query gets aot=1 unless it says otherwise.
// A timing measure: calm machine first, then the shared perf lock.
//
// --visits N (#167, region formation from the local profile's weights): a
// run is N launches in the SAME profile, the first on an empty one (the
// player's first launch, its weights recorded), the next ones reading the
// weighted profile and the region cache the previous visits left. Each
// visit lasts --sec (at least 70: the profile is written every minute) and
// ends with flushUserData (profile, JIT cache, prewarm) before Chromium
// closes, as a headless close may skip pagehide. Per visit: the ramp as
// above, the optimisation's done event as the engine sent it (compiled =
// modules translated in this visit, the churn; refused, deferred, and
// budgetRefused where the engine has it), the cache installs, and when the
// last region was installed (host ms from t0 and guest seconds from boot).
// --counters adds the emulated CPU thread's host instructions and cycles per
// guest cycle over the scene's window (lib/perf-counters.mjs, Linux).
// --region-chain turns the region counters on (counters only, no host-time
// sampling) for the same window and records the region chaining (patch
// 0102: chained, outOfTime, noRegion, refused, the top exit targets): how
// region-to-region transitions go once #167 splits hot and cold. The
// counters cost the same on both sides of a pair, not nothing: compare a
// --region-chain run only with another.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { bootIso, ensureServer, launchChrome, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { calmLock, loadGaveUp } from "../lib/env.mjs";
import { decodeRegionStats, regionShares } from "../lib/jit-region-stats.mjs";
import { checkPerfAccess, counterEvents, cyclesPerGuestCycle, instructionsPerGuestCycle, perfCounters } from "../lib/perf-counters.mjs";
import { consistentHeadroomRead, decodeHeadroomStats } from "../lib/headroom.mjs";
import { PRESETS, SCENE_NATIVE_FRAMES_PER_VI, VI_PER_SECOND } from "../lib/matrix.mjs";
import { claim } from "../lib/ownership.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { chromeInfo, isLocalOnly, probeOutDir } from "../lib/probe-out.mjs";
import { gameSpeedSeries, rampOf, summarizeRamp } from "../lib/ramp.mjs";
import { median, round } from "../lib/stats.mjs";
import { runSteps, validateSteps } from "../lib/steps.mjs";
import { machineSnapshot } from "../lib/system.mjs";
import { mergeTimeline, speedSeries } from "../lib/timeline.mjs";
import { num } from "./race-perf.mjs";

// Each scene's savestate twin (its native frames per VI) and plateau window.
const SCENES = {
  race: { state: "race-after.sav", plateau: null },
  // The intro plays about 12-30 s after load; the steps end at click + 13 s.
  heavy: { state: "heavy-intro-13s.sav", plateau: [0, 17] }
};

// The region pipeline now (cumulative, readable with the stats off).
async function readRegions(page) {
  const reply = await workerRequest(page, "validationReadJitRegionStats", {}, 5000).catch((e) => ({ error: String(e.message || e) }));
  const d = reply?.bytes && !reply.error ? decodeRegionStats(reply.bytes)?.diagnostics : null;
  return d ? { installed: d.regionsInstalled ?? null, queued: d.regionsQueued ?? null } : null;
}

// The core's XFB copies so far (reset >= 0 turns the counters on and zeroes them).
async function readXfb(page, reset = -1) {
  const r = await workerRequest(page, "validationReadHeadroomStats", { reset }, 5000).catch((e) => ({ error: String(e.message || e) }));
  if (r?.error || !r?.bytes) return { error: r?.error ?? "no reply" };
  const s = consistentHeadroomRead(decodeHeadroomStats(r.bytes), decodeHeadroomStats(r.again));
  return s.error ? s : { xfb: s.xfbCopies, on: s.on };
}

// One visit's region facts from what the drain read (pure: tested). events:
// validationReadAotProgress events; regions: [{ t, installed, ticks }].
export function visitRegions(events, regions, { t0, ticksAtBoot, ticksPerSecond }) {
  const done = events.find((e) => e.type === "done") ?? null;
  const installs = events.filter((e) => e.type === "install");
  const finalInstalled = regions.length ? regions.at(-1).installed : null;
  // The first read that reached the final count: when the last region came.
  const last = finalInstalled == null ? null : regions.find((r) => r.installed === finalInstalled);
  return {
    done: done && Object.fromEntries(Object.entries(done).filter(([k]) => !["t", "type"].includes(k))),
    compiled: done?.compiled ?? null,
    budgetRefused: done?.budgetRefused ?? null,
    fromCache: installs.reduce((n, e) => n + (e.loaded ?? 0), 0),
    installFailed: installs.reduce((n, e) => n + (e.failed ?? 0), 0),
    installedAtEnd: finalInstalled,
    lastInstallMs: last ? last.t - t0 : null,
    lastInstallGuestSec: last && Number.isFinite(last.ticks) && ticksPerSecond > 0 ? round((last.ticks - ticksAtBoot) / ticksPerSecond, 2) : null
  };
}

// The region chaining counters of a stats reply, or why there are none.
export function regionChainOf(reply) {
  if (!reply || reply.error) return { error: reply?.error ?? "no reply" };
  const c = reply.regionChain;
  if (!c) return { error: "engine without region chaining counters (0102)" };
  return { enabled: c.enabled, chained: c.chained, outOfTime: c.outOfTime, noRegion: c.noRegion, refused: c.refused, exitTargets: c.exitTargets ?? [], breakEntries: c.breakEntries ?? [] };
}

// The local profile's size on disk after a visit, or null when there is none.
export const profileBytes = (files) => (Array.isArray(files) && files.length ? files.reduce((n, f) => n + f.bytes, 0) : null);

// Region keys that came or went between two visits are not readable from
// the engine; the modules a visit had to translate (compiled) over those it
// ended with is the churn: 0 once the formation is stable.
export const churnOf = (v) => (v.compiled != null && v.installedAtEnd > 0 ? round(v.compiled / v.installedAtEnd, 4) : null);

async function measureRun(o, server, loadGate) {
  const record = { loadGate };
  if (loadGaveUp(loadGate)) return record;
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-harness-ramp-"));
  const releaseProfile = claim(profileDir, REPO_ROOT, "chrome-profile");
  try {
    if (o.visits === 1) return { ...record, ...(await measureVisit(o, server, profileDir)) };
    record.visits = [];
    for (let v = 1; v <= o.visits; v += 1) {
      const visit = { visit: v, ...(await measureVisit(o, server, profileDir)) };
      if (visit.regionFacts) visit.churn = churnOf(visit.regionFacts);
      visit.profileBytes = profileBytes(visit.profileFiles);
      record.visits.push(visit);
      console.log(`[ramp] visit ${v}: ${visit.error ?? `profile ${visit.profileBytes ?? "NONE"} bytes${visit.regionChain && !visit.regionChain.error ? `, chained ${visit.regionChain.chained}, noRegion ${visit.regionChain.noRegion}` : ""}, compiled ${visit.regionFacts?.compiled ?? "-"}, from cache ${visit.regionFacts?.fromCache ?? "-"}, installed ${visit.regionFacts?.installedAtEnd ?? "-"}, last install at ${visit.regionFacts?.lastInstallMs ?? "-"} ms, churn ${visit.churn ?? "-"}${visit.cyclesPerGuestCycle ? `, ${round(visit.cyclesPerGuestCycle, 3)} cycles per guest cycle` : ""}`}`);
      if (visit.error) break;
    }
    return record;
  } finally {
    releaseProfile();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

// --visits: per visit number, the medians over the runs (pure: tested).
export function summarizeVisits(records, visits) {
  const out = [];
  for (let v = 1; v <= visits; v += 1) {
    const rows = records.map((r) => r.visits?.find((x) => x.visit === v)).filter((x) => x && !x.error);
    const med = (f) => { const xs = rows.map(f).filter(Number.isFinite); return xs.length ? round(median(xs), 4) : null; };
    out.push({
      visit: v, runs: rows.length,
      compiled: med((x) => x.regionFacts?.compiled), churn: med((x) => x.churn), budgetRefused: med((x) => x.regionFacts?.budgetRefused),
      fromCache: med((x) => x.regionFacts?.fromCache), profileBytes: med((x) => x.profileBytes),
      // Visits without a local profile on disk: the weights were never written.
      withoutProfile: rows.filter((x) => x.profileBytes == null).length, installedAtEnd: med((x) => x.regionFacts?.installedAtEnd),
      lastInstallMs: med((x) => x.regionFacts?.lastInstallMs), lastInstallGuestSec: med((x) => x.regionFacts?.lastInstallGuestSec),
      plateauSpeed: med((x) => x.ramp?.plateauSpeed),
      regionCycleShare: med((x) => x.regionShares?.regionCycleShare), regionStops: med((x) => x.regionShares?.regionStops),
      chained: med((x) => x.regionChain?.chained), noRegion: med((x) => x.regionChain?.noRegion), outOfTime: med((x) => x.regionChain?.outOfTime),
      instructionsPerGuestCycle: med((x) => x.instructionsPerGuestCycle), cyclesPerGuestCycle: med((x) => x.cyclesPerGuestCycle)
    });
  }
  return out;
}

// One launch in `profileDir` (kept: the caller removes it).
async function measureVisit(o, server, profileDir) {
  const record = {};
  const context = await launchChrome({ profileDir });
  try {
    await context.assertInvisible("after launch");
    const page = context.pages()[0] ?? (await context.newPage());
    const t0 = Date.now();
    await bootIso(page, { url: `${server.base}?${o.query}`, iso: o.iso, timeoutMs: 120000 });
    record.bootMs = Date.now() - t0;
    const xfbOn = await readXfb(page, 0);
    record.xfbCounter = xfbOn.error ?? "on";
    const chunks = [], regions = [], loads = [], frames = [], aotEvents = [];
    const ticksNow = async () => Number((await workerRequest(page, "validationReadCoreProgress", {}, 5000).catch(() => null))?.coreTicks ?? NaN);
    const ticksAtBoot = await ticksNow();
    let draining = true;
    const drain = (async () => {
      while (draining) {
        chunks.push(await readTimeline(page).catch((e) => ({ error: String(e.message || e) })));
        const r = await readRegions(page);
        if (r) regions.push({ t: Date.now(), ...r, ...(o.visits > 1 ? { ticks: await ticksNow() } : {}) });
        if (o.visits > 1) {
          const p = await workerRequest(page, "validationReadAotProgress", { drain: true }, 5000).catch(() => null);
          if (Array.isArray(p?.events)) aotEvents.push(...p.events.filter((e) => e.type !== "progress"));
        }
        if (!xfbOn.error) {
          const x = await readXfb(page);
          if (!x.error && x.on) frames.push({ t: Date.now(), xfb: x.xfb });
        }
        loads.push(os.loadavg()[0]);
        await page.waitForTimeout(1000);
      }
    })();
    await runSteps(page, o.steps);
    const sceneAt = Date.now();
    // --counters: the CPU thread over the scene's window, per guest cycle.
    const session = { profileDir };
    if (o.counters) await o.counters("start", session);
    const sceneTicks = o.counters ? await ticksNow() : NaN;
    // sampleEvery 0: counters on and reset, no host-time sampling.
    const chainOn = o.regionChain ? await workerRequest(page, "validationReadJitRegionStats", { sampleEvery: 0 }, 10000).catch((e) => ({ error: String(e.message || e) })) : null;
    await page.waitForTimeout(o.sec * 1000);
    if (o.counters) {
      const c = await o.counters("end", session);
      const w = { counters: c, guestTicks: (await ticksNow()) - sceneTicks };
      Object.assign(record, { counters: c, guestTicks: w.guestTicks, instructionsPerGuestCycle: instructionsPerGuestCycle(w), cyclesPerGuestCycle: cyclesPerGuestCycle(w) });
    }
    if (chainOn) {
      const reply = chainOn.error ? chainOn : await workerRequest(page, "validationReadJitRegionStats", {}, 10000).catch((e) => ({ error: String(e.message || e) }));
      record.regionChain = regionChainOf(reply);
      // The same window's region share of guest cycles (outside idle skip),
      // calls, non-entry calls and stops; counters only, so no time shares.
      record.regionShares = reply?.bytes && !reply.error ? regionShares(decodeRegionStats(reply.bytes)) : null;
    }
    draining = false;
    await drain;
    // The profile, the JIT cache and the prewarm written before the close
    // (a headless close may skip pagehide): the next visit reads them.
    if (o.visits > 1) {
      record.flushed = await page.evaluate(() => window.__host?.adapter?.flushUserData?.().then(() => true, (e) => String(e?.message || e)) ?? "no adapter").catch((e) => String(e.message || e));
      // The local profile on disk (OPFS aot-profile/, src/aot-profile.js):
      // a visit that leaves none (a profile never written, #173) measures
      // two identical formations.
      record.profileFiles = await page.evaluate(async () => {
        try {
          const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("aot-profile");
          const out = [];
          for await (const [name, h] of dir.entries()) if (h.kind === "file") out.push({ name, bytes: (await h.getFile()).size });
          return out;
        } catch (e) { return { error: String(e?.name || e) }; }
      }).catch((e) => ({ error: String(e.message || e) }));
    }
    chunks.push(await readTimeline(page).catch((e) => ({ error: String(e.message || e) })));
    const timeline = mergeTimeline(chunks);
    const tps = (await workerRequest(page, "validationReadCoreProgress", {}, 15000).catch(() => null))?.coreTicksPerSecond ?? null;
    if (!(tps > 0)) throw new Error("no core ticks per second (validationReadCoreProgress)");
    record.timelineComplete = timeline.complete;
    record.regionsRead = regions.length > 0;
    record.ramp = rampOf(speedSeries(timeline.vi.filter((v) => v.t >= t0), tps), t0, regions,
      { games: frames.length > 1 ? gameSpeedSeries(frames, o.nativeFps) : null, sceneAt, plateau: o.plateau });
    if (o.visits > 1) record.regionFacts = visitRegions(aotEvents, regions, { t0, ticksAtBoot, ticksPerSecond: tps });
    const medianLoad = median(loads);
    record.load1 = { median: round(medianLoad, 2), max: round(Math.max(...loads), 2), limit: o.maxLoad };
    record.overloaded = medianLoad > o.maxLoad;
    return record;
  } catch (error) {
    return { ...record, error: String(error?.message || error).slice(0, 300) };
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, scene: { type: "string" }, steps: { type: "string" }, sec: { type: "string", default: "90" }, plateau: { type: "string" },
      config: { type: "string", default: "rec" }, query: { type: "string" }, runs: { type: "string", default: "3" },
      "max-load": { type: "string" }, "load-wait": { type: "string", default: "300" }, "lock-wait": { type: "string", default: "1800" }, "calm-wait": { type: "string" }, "no-lock": { type: "boolean", default: false },
      visits: { type: "string", default: "1" }, counters: { type: "boolean", default: false }, "counter-events": { type: "string" }, "region-chain": { type: "boolean", default: false },
      port: { type: "string", default: process.env.HARNESS_PORT }, out: { type: "string" }
    }
  });
  const scene = SCENES[values.scene];
  if (!values.iso || !values.steps || !scene) throw new Error(`usage: first-launch-ramp.mjs --iso disc.iso --scene ${Object.keys(SCENES).join("|")} --steps steps.json --port N [--sec 90] [--plateau FROM-TO] [--runs 3] [--config rec | --query ...]`);
  const plateau = values.plateau ? values.plateau.split("-").map(Number) : scene.plateau;
  if (plateau && !(plateau.length === 2 && plateau[0] >= 0 && plateau[1] > plateau[0])) throw new Error(`--plateau ${values.plateau}: FROM-TO seconds after the scene's start`);
  const iso = path.resolve(values.iso);
  if (isLocalOnly(iso) && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
  const steps = JSON.parse(readFileSync(values.steps, "utf8"));
  validateSteps(steps);
  const base = new URLSearchParams(values.query ?? PRESETS[values.config] ?? values.config);
  if (!base.has("aot")) base.set("aot", "1");
  base.set("metrics", "1");
  const lockWait = num(values, "lock-wait", { min: 0 });
  const o = {
    iso, steps, query: base.toString(), plateau, nativeFps: SCENE_NATIVE_FRAMES_PER_VI[scene.state].framesPerVi * VI_PER_SECOND, sec: num(values, "sec", { min: 10 }), runs: num(values, "runs", { min: 1, int: true }),
    maxLoad: values["max-load"] ? num(values, "max-load", { min: 0.1 }) : Math.max(2, os.cpus().length / 4),
    loadWait: num(values, "load-wait", { min: 0 }), port: num(values, "port", { min: 1, int: true }),
    visits: num(values, "visits", { min: 1, int: true }), regionChain: values["region-chain"]
  };
  // The profile is written every minute: a shorter visit may leave none.
  if (o.visits > 1 && o.sec < 70) throw new Error(`--visits: --sec ${o.sec} is under 70 s (the profile is written every minute)`);
  if (values["counter-events"] && !values.counters) throw new Error("--counter-events needs --counters");
  if (values.counters) { checkPerfAccess(); o.counters = perfCounters(undefined, { extra: counterEvents(values["counter-events"]) }); }
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
      if (o.visits > 1) { log(`run ${run}: ${r.visits?.length ?? 0} visit(s)${r.error ? `, ${r.error}` : ""}`); continue; }
      log(`run ${run}: ${r.error ?? `${r.ramp.metric}: 90 % at ${r.ramp.timeTo90Ms ?? "-"} ms, 95 % at ${r.ramp.timeToFullMs ?? "-"} ms, plateau ${r.ramp.plateauSpeed} % (VI plateau ${r.ramp.vi.plateauSpeed} %), ${r.ramp.regionsAt90 ?? "-"} regions at 90 %, ${r.ramp.regionsAtEnd ?? "-"} at the end`}${r.overloaded ? " OVERLOADED" : ""}`);
    }
  } finally {
    await server.stop();
    lock.release();
  }
  const summary = {
    probe: "first-launch-ramp", at: new Date().toISOString(), locked: !values["no-lock"], machine: machineSnapshot(),
    chrome: chromeInfo(), served: server.identity, iso: path.basename(iso), scene: values.scene, steps: path.basename(values.steps),
    query: o.query, windowSec: o.sec, plateauSec: o.plateau, nativeFps: o.nativeFps, maxLoad: o.maxLoad, runs: records.length, gaveUp,
    definition: "t0 = disc handed to the engine page on a new, empty profile; game: useful game frames (XFB copies) per second over the scene's native rate, counted from the scene's start (end of the steps); time to N % = first second of 5 in a row at >= N %; vi: VI-tick speed from t0 (decoupled in the product config)",
    ...(o.visits > 1 ? { visits: o.visits, visitSummary: summarizeVisits(records, o.visits) } : summarizeRamp(records, o.sec))
  };
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  if (o.visits > 1) {
    for (const v of summary.visitSummary) log(`visit ${v.visit}: profile ${v.profileBytes ?? "NONE"} bytes${v.withoutProfile ? ` (${v.withoutProfile} run(s) without one)` : ""}, compiled ${v.compiled}, churn ${v.churn}, last install ${v.lastInstallMs} ms (${v.lastInstallGuestSec} guest s), from cache ${v.fromCache}${v.cyclesPerGuestCycle != null ? `, ${v.cyclesPerGuestCycle} cycles per guest cycle` : ""} (medians over ${v.runs} run(s))`);
    log(`-> ${outDir}`);
    process.exitCode = records.every((r) => r.visits?.length === o.visits && r.visits.every((v) => !v.error)) ? 0 : 1;
    return;
  }
  log(`${values.scene} (${summary.metric}): 90 % at ${summary.timeTo90Ms.median ?? "n/a"} ms (target < ${summary.targetMs}), plateau ${summary.plateauSpeed.median ?? "n/a"} %, ${summary.failed.length} failed run(s) -> ${outDir}`);
  process.exitCode = summary.goodRuns && !summary.failed.length ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
