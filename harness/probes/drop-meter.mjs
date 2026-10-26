#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Speed drops over a whole play-through, headless only:
//
//   node harness/probes/drop-meter.mjs --iso disc.iso --port N [--runs 6]
//     [--visits 2] [--candidate ref|dir] [--baseline ref|dir]
//     [--noise <A/A>/summary.json] [--trend measures/drops/trend.jsonl]
//     [--scenario harness/probes/drop-scenario.json] [--state scene.sav]
//     [--config product | --query "..."] [--sample-ms 50] [--native ref.json]
//     [--shots] [--region-counters] [--pc-window FROM-TO] [--max-load L] [--load-wait 300] [--lock-wait 14400 | --no-lock]
//     [--out dir]
//   node harness/probes/drop-meter.mjs --analyze <out dir> [--native ref.json]
//   node harness/probes/drop-meter.mjs --trace drop-trace-….json   (salon's dev HUD)
//
// Merge guard: --baseline origin/main (the candidate defaults to this tree)
// alternates the sides run by run and gives a verdict per visit and per
// phase of the scenario (each against its own A/A noise): a metric
// regresses when its median moved the worse way by more than its noise (the
// A/A of --noise, else the two sides' spread). Exit code 2 on a regression.
// Nightly: --trend appends the run's medians to a JSONL file and rewrites
// the table next to it (.md). Output: summary.json (machine) and its `human`
// lines (also printed).
//
// A run boots the disc on a new, empty Chrome profile and plays the
// scenario: boot, menus, the race's load, the race. Its steps fire at a
// GUEST time (seconds of emulated time since boot, from the core's ticks),
// so every run, whatever its speed, presses the same buttons at the same
// place of the game. --visits 2 plays it again in the same profile (the
// player's next launch: region cache, JIT cache, pipeline list warm).
//
// Recorded, nothing sampled away: every VI output (host time, guest ticks)
// and every presentation (validationReadTimeline); every --sample-ms the
// worker's cumulative counters (validationDropSampler: JIT compiles and
// their synchronous time, region installs, disc reads and the CPU's waits
// for them, GPU and EFB waits, throttle sleeps and late wake-ups, wgpu
// pipeline creation, the worker's own stalls) and the page's (main-thread
// stalls, audio underruns). lib/drops.mjs cuts that into 100 ms windows and
// gives the drops with their cause, the loads (host vs guest duration), and
// the summary per run, per visit and per phase of the scenario; over the
// runs, the spread of every metric (the A/A noise).
//
// Raw data is kept (raw-<run>-v<visit>.json.gz): --analyze re-reads it, e.g.
// with a native reference (research/native-dolphin, guest seconds and game
// frames of the same scenario) to compare game frames per guest second.
// A timing measure: calm machine first, then the shared perf lock.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

import { bootIso, ensureServer, grabFrame, launchChrome, loadHarnessState, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { dropEvents, dropSummary, loadSegments, nativeFps, noiseOf, phaseSummaries, rowsOf, trendLine, trendTable, VERDICT_MIN_RUNS, visitVerdict, windowsOf, worstDrops } from "../lib/drops.mjs";
import { exportRef } from "../cli.mjs";
import { calmLock, loadGaveUp } from "../lib/env.mjs";
import { claim } from "../lib/ownership.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { chromeInfo, isLocalOnly, probeOutDir } from "../lib/probe-out.mjs";
import { savePng } from "../lib/session.mjs";
import { median, round } from "../lib/stats.mjs";
import { machineSnapshot, sampleChromeRss } from "../lib/system.mjs";
import { mergeTimeline } from "../lib/timeline.mjs";
import { num, sideOrder, STATE_ROUTE } from "./race-perf.mjs";

// What the site runs (salon packages/core engineParams, profile "fast", with
// a WebGPU adapter).
export const PRODUCT_QUERY = "core=upstream&video=wgpu&presenter=webgpu&cpu=dual&speed=1&oc=1&pacing=tick&fastsw=1&wasmjit=1&jitwarmup=700&aot=1&aotcompiler=1&jitoffthread=1";

// Scenario: [{ at: guest seconds since boot, label?, tap|down|up|click|mark,
// hold?, only? }]. A label starts a phase (until the next label). `end`
// (guest seconds) ends the run. only: "cold" (the first visit, e.g. the
// prompt that creates the save file) or "warm" (the next ones).
export function validateScenario(s) {
  if (!s || !Array.isArray(s.steps) || !(s.end > 0)) throw new Error("scenario: { steps: [...], end: guest seconds }");
  let at = 0;
  s.steps.forEach((x, i) => {
    const kinds = ["tap", "down", "up", "click", "mark"].filter((k) => k in x);
    if (kinds.length !== 1) throw new Error(`scenario step ${i}: exactly one of tap/down/up/click/mark`);
    if (!(x.at >= at)) throw new Error(`scenario step ${i}: at ${x.at} must be a guest second ≥ the previous step's`);
    if (x.only != null && !["cold", "warm"].includes(x.only)) throw new Error(`scenario step ${i}: only must be "cold" or "warm"`);
    at = x.at;
  });
  if (!(s.end > at)) throw new Error(`scenario: end ${s.end} must come after the last step (${at})`);
  return s;
}

// In the page, before the app: main-thread stalls (a 50 ms timer that ran
// late) and the audio output's underruns, same clock as the worker's rows.
function installPageSampler(everyMs) {
  const rows = [];
  let due = performance.now();
  const tick = () => {
    const now = performance.now();
    const a = window.__audio?.causalTelemetry?.();
    rows.push([performance.timeOrigin + now, Math.max(0, now - due), a ? Number(a.underrunCount ?? 0) : null]);
    due = Math.max(due + everyMs, now);
    setTimeout(tick, Math.max(0, due - performance.now()));
  };
  setTimeout(tick, everyMs);
  window.__dropPage = { drain: () => rows.splice(0, rows.length) };
}

const guestSec = async (page) => {
  const p = await workerRequest(page, "validationReadCoreProgress", {}, 5000);
  return p?.coreTicks > 0 && p.coreTicksPerSecond > 0 ? { sec: p.coreTicks / p.coreTicksPerSecond, tps: p.coreTicksPerSecond } : null;
};

export const stepsFor = (scenario, visit) => scenario.steps.filter((x) => x.only == null || x.only === (visit === 1 ? "cold" : "warm"));

async function playVisit(o, server, profileDir, shotDir, visit) {
  const raw = { markers: [], chunks: [], rows: [], page: [], loads: [], rss: [] };
  const context = await launchChrome({ profileDir });
  try {
    await context.assertInvisible("after launch");
    await context.addInitScript(installPageSampler, o.sampleMs);
    const page = context.pages()[0] ?? (await context.newPage());
    const t0 = Date.now();
    raw.launchT = t0;
    await bootIso(page, { url: `${server.base}?${o.query}`, iso: o.iso, timeoutMs: 120000 });
    raw.bootMs = Date.now() - t0;
    raw.browser = await page.evaluate(() => navigator.userAgent.match(/(?:Headless)?Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent).catch(() => null);
    await context.assertInvisible("after boot");
    // --state: the scene starts at a savestate (e.g. a 2-player race); the
    // scenario's guest seconds then count from the load.
    let base = 0;
    if (o.state) {
      await page.route(STATE_ROUTE, (route) => route.fulfill({ path: o.state, contentType: "application/octet-stream" }));
      raw.stateLoad = await loadHarnessState(page, `${server.base}/`);
      if (!raw.stateLoad?.loaded) throw new Error(`savestate not loaded: ${JSON.stringify(raw.stateLoad).slice(0, 200)}`);
      base = (await guestSec(page))?.sec ?? 0;
      raw.stateBaseSec = base;
    }
    // Counters that need turning on (0113 headroom, 0162 cadence), then the sampler.
    raw.headroom = (await workerRequest(page, "validationReadHeadroomStats", { reset: 0 }, 5000))?.error ?? "on";
    raw.cadence = await workerRequest(page, "validationReadPresentCadence", { reset: 0 }, 5000).then((r) => r?.error ?? (r?.supported === false ? "unsupported" : "on"));
    // --region-counters: the region stats counting guest cycles (no timing):
    // cheap, but not nothing; compare such runs only with each other.
    if (o.regionCounters) raw.regionCounters = (await workerRequest(page, "validationReadJitRegionStats", { sampleEvery: 0 }, 10000))?.error ?? "on";
    raw.sampler = await workerRequest(page, "validationDropSampler", { action: "start", everyMs: o.sampleMs }, 5000);
    // An older tree (a baseline before the sampler) still gives the
    // timeline: speeds, presents, drops, without their causes.
    const sampling = Boolean(raw.sampler?.started);
    if (!sampling) raw.samplerMissing = raw.sampler?.error ?? "engine without validationDropSampler";
    raw.audio = await page.evaluate(() => window.__audio?.setMuted?.(false).then(() => "unmuted", (e) => String(e?.message || e)) ?? "no audio").catch((e) => String(e.message || e));
    let draining = true;
    const drainOnce = async () => {
      raw.chunks.push(await readTimeline(page).catch((e) => ({ error: String(e.message || e) })));
      const d = sampling ? await workerRequest(page, "validationDropSampler", { action: "drain" }, 10000) : null;
      if (d?.rows) raw.rows.push(d);
      const p = await page.evaluate(() => window.__dropPage?.drain() ?? []).catch(() => []);
      raw.page.push(...p);
      raw.loads.push([Date.now(), os.loadavg()[0]]);
      // Resident memory of this profile's Chrome processes (MB): the peak of
      // a launch (e.g. regions kept as bytes and as modules).
      const m = sampleChromeRss(profileDir);
      if (!m.error) raw.rss.push([Date.now(), m.totalMB, m.byType.renderer ?? null]);
    };
    const drain = (async () => { while (draining) { await drainOnce(); await page.waitForTimeout(1000); } })();
    try {
      // --pc-window FROM-TO: the guest-PC sampler over those guest seconds.
      const pcSteps = o.pcWindow ? [{ at: o.pcWindow[0], pc: "start" }, { at: o.pcWindow[1], pc: "stop" }] : [];
      const steps = [...stepsFor(o.scenario, visit), ...pcSteps].sort((a, b) => a.at - b.at);
      for (const step of [...steps, { at: o.scenario.end, mark: "end" }]) {
        const deadline = Date.now() + Math.max(60000, step.at * 1000 * 20);
        for (;;) {
          const g = await guestSec(page);
          if (g && g.sec - base >= step.at) break;
          if (Date.now() > deadline) throw new Error(`guest second ${step.at} not reached (${g ? (g.sec - base).toFixed(1) : "?"})`);
          await page.waitForTimeout(g && step.at - (g.sec - base) > 1 ? 200 : 15);
        }
        const t = performance.timeOrigin + performance.now();
        // The phase starts at its guest second: the analysis places it on the
        // VI ring (this host time is the poll's, up to ~20 ms late).
        if (step.label) raw.markers.push({ t, label: step.label, guest: step.at + base });
        if ("tap" in step) {
          await page.keyboard.down(step.tap);
          await page.waitForTimeout(step.hold ?? 120);
          await page.keyboard.up(step.tap);
        } else if ("down" in step) await page.keyboard.down(step.down);
        else if ("up" in step) await page.keyboard.up(step.up);
        else if ("click" in step) await page.mouse.click(step.click[0], step.click[1]);
        else if (step.pc === "start") {
          raw.pc = { start: await workerRequest(page, "validationPcSampler", { action: "start", periodMs: 0.25 }, 5000) };
          raw.jitCacheAtWindow = await workerRequest(page, "validationReadJitCacheReadiness", {}, 5000);
        }
        else if (step.pc === "stop") {
          const r = await workerRequest(page, "validationPcSampler", { action: "stop" }, 10000);
          raw.pc.window = o.pcWindow;
          raw.pc.samples = r?.n ?? null;
          raw.pc.error = r?.error ?? null;
          raw.pc.top = (r?.counts ?? []).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([pc, n]) => [`0x${(pc >>> 0).toString(16)}`, n]);
        }
        if (shotDir && step.label) savePng(await grabFrame(page), path.join(shotDir, `${String(raw.markers.length).padStart(2, "0")}-${step.label}.png`));
      }
      raw.endT = performance.timeOrigin + performance.now();
      raw.endGuest = o.scenario.end + base;
    } finally {
      draining = false;
      await drain;
    }
    await drainOnce();
    raw.tps = (await guestSec(page))?.tps ?? null;
    // The JIT cache and the off-thread compiler at the end (cheap, read only).
    raw.jitCache = await workerRequest(page, "validationReadJitCacheReadiness", {}, 5000);
    if (sampling) {
      const r = await workerRequest(page, "validationDropSampler", { action: "stop" }, 5000);
      if (r?.rows) raw.rows.push(r);
      raw.samplerEnd = { lost: r?.lost, errors: r?.errors, lastError: r?.lastError, lagMaxMs: r?.lagMaxMs, jitTime: raw.sampler.jitTime };
    }
    if (o.visits > 1) raw.flushed = await page.evaluate(() => window.__host?.adapter?.flushUserData?.().then(() => true, (e) => String(e?.message || e)) ?? "no adapter").catch((e) => String(e.message || e));
    return raw;
  } catch (error) {
    return { ...raw, error: String(error?.message || error).slice(0, 300) };
  } finally {
    await context.close().catch(() => {});
  }
}

// The phase bounds at the host time the VI ring reached their guest second
// (markers with `guest`; a site trace or an older record keeps its own).
export function markersOnVi(raw, vi) {
  if (!(raw.tps > 0) || !vi.length) return {};
  const at = (g) => {
    const target = g * raw.tps;
    const v = vi.find((x) => x.ticks >= target);
    return v ? v.t : null;
  };
  const markers = raw.markers.map((m) => (m.guest != null && at(m.guest) != null ? { ...m, t: at(m.guest) } : m));
  const endT = raw.endGuest != null && at(raw.endGuest) != null ? at(raw.endGuest) : raw.endT;
  return { markers, endT };
}

// One visit's analysis from its raw record (pure but for the reference).
export function analyzeVisit(raw, { native = null } = {}) {
  // (raw is reassigned below with the markers placed on the VI ring)
  if (raw.error) return { error: raw.error };
  const timeline = mergeTimeline(raw.chunks);
  // A ring that overflowed or a read that failed leaves holes a drop could
  // hide in: the run is not used.
  if (!timeline.complete) return { error: `timeline incomplete (lost presents ${timeline.lost.presents}, VI ${timeline.lost.vi}, failed reads ${timeline.failedReads})` };
  const rows = rowsOf(raw.rows);
  raw = { ...raw, ...markersOnVi(raw, timeline.vi) };
  const page = raw.page.map(([t, lagMs, underruns]) => ({ t, lagMs, underruns }));
  const from = raw.markers[0]?.t ?? null;
  const windows = windowsOf({ vi: timeline.vi, presents: timeline.presents, rows, page, markers: raw.markers, tps: raw.tps, from, to: raw.endT });
  const span = (e) => e.t >= (from ?? -Infinity) && e.t <= (raw.endT ?? Infinity);
  const presents = timeline.presents.filter(span), vi = timeline.vi.filter(span);
  const events = dropEvents(windows);
  const loads = loadSegments(windows).map((l) => (native && l.guestStart != null ? { ...l, nativeFps: nativeFps(native, l.guestStart, l.guestStart + l.guestMs / 1000) } : l));
  const phases = phaseSummaries({ windows, presents, vi, tps: raw.tps });
  if (native) for (const p of phases) {
    const ws = windows.filter((w) => w.label === p.label && w.guestStart != null);
    p.nativeFps = ws.length ? nativeFps(native, ws[0].guestStart, ws.at(-1).guestStart + 0.1) : null;
  }
  const loadAvg = raw.loads.map((x) => x[1]);
  // When the region count reached its final value: host ms from the launch
  // and guest seconds (a warm boot that delays its regions shows here).
  const withRegions = rows.filter((r) => r.regionsInstalled != null);
  const finalRegions = withRegions.at(-1)?.regionsInstalled ?? null;
  const allAt = finalRegions == null ? null : withRegions.find((r) => r.regionsInstalled === finalRegions);
  const regionsDone = allAt ? { regions: finalRegions, hostMsFromLaunch: raw.launchT ? Math.round(allAt.t - raw.launchT) : null, guestSec: allAt.ticks != null && raw.tps ? round(allAt.ticks / raw.tps, 2) : null } : null;
  const rss = (raw.rss ?? []).map((x) => x[1]);
  return {
    timelineComplete: timeline.complete, sampled: rows.length > 0, browser: raw.browser ?? null, bootMs: raw.bootMs, pc: raw.pc ?? null,
    load1: { median: round(median(loadAvg), 2), max: round(Math.max(...loadAvg), 2) },
    regionsDone, rssPeakMB: rss.length ? Math.max(...rss) : null,
    summary: { ...dropSummary({ windows, presents, vi, tps: raw.tps }), loads: loads.length, loadExcessMs: loads.reduce((a, l) => a + l.excessMs, 0), rssPeakMB: rss.length ? Math.max(...rss) : null, regionsDoneMs: regionsDone?.hostMsFromLaunch ?? null },
    phases, loads, worst: worstDrops(events), drops: events.length,
    // the 100 ms timeline, compact: [ms from start, speed %, VI/s, presents, max present gap, lost ms, top cause]
    timeline: windows.map((w) => {
      const top = Object.entries(w.causes).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
      return [Math.round(w.t0 - windows[0].t0), round(w.speed, 1), w.vis, w.presents, round(w.maxPresentGap, 1), round(w.lostMs, 1), top && top[1] > 1 ? top[0] : null];
    })
  };
}

// Over the runs of one visit number: A/A noise of the run summaries and of
// each phase's, the loads by phase, the drops that recur.
export function summarizeVisits(analyses) {
  const ok = analyses.filter((a) => !a.error);
  const byLabel = {};
  for (const a of ok) for (const p of a.phases) (byLabel[p.label] ??= []).push(p);
  const loadsByLabel = {};
  for (const a of ok) for (const l of a.loads) (loadsByLabel[l.label] ??= []).push(l);
  const drops = ok.flatMap((a, run) => a.worst.map((d) => ({ run: run + 1, ...d })));
  return {
    runs: ok.length, failed: analyses.filter((a) => a.error).map((a) => a.error),
    noise: noiseOf(ok.map((a) => a.summary)),
    phases: Object.fromEntries(Object.entries(byLabel).map(([k, ps]) => [k, noiseOf(ps.map(({ label, ...x }) => x))])),
    loads: Object.fromEntries(Object.entries(loadsByLabel).map(([k, ls]) => [k, { perRun: round(ls.length / ok.length, 2), ...noiseOf(ls.map((l) => ({ hostMs: l.hostMs, guestMs: l.guestMs, excessMs: l.excessMs, worstSecond: l.worstSecond }))) }])),
    worst: drops.sort((a, b) => b.lostMs - a.lostMs).slice(0, 15)
  };
}

// A side: this tree, a directory served as is, or a git ref exported.
function resolveSide(name, spec) {
  if (!spec) return { name, label: "this tree", root: REPO_ROOT, temp: false };
  if (existsSync(spec) && statSync(spec).isDirectory()) return { name, label: path.resolve(spec), root: path.resolve(spec), temp: false };
  return { name, label: spec, root: exportRef(spec), temp: true };
}

// The 5 lines a person reads: per visit, the candidate's headline numbers,
// and the verdict when there is a baseline.
export function humanSummary(summary) {
  const lines = [];
  for (const v of summary.visitSummary) {
    const n = v.candidate.noise, top = v.candidate.worst[0];
    lines.push(`${v.visit === 1 ? "cold" : "warm"} (${v.candidate.runs} runs): lost ${n.lostMs?.median ?? "–"} ms, <95 % ${n.pctBelow95?.median ?? "–"} % of the time, worst 1 s ${n.worstSecond?.median ?? "–"} %, hitches >100 ms ${n.hitches100?.median ?? "–"}, load excess ${n.loadExcessMs?.median ?? "–"} ms; worst drop ${top ? `${top.label} ${Math.round(top.lostMs)} ms (${top.cause})` : "none"}`);
    if (v.verdict) {
      const bad = v.verdict.regressions.map((r) => `${r.where} ${r.metric} ${r.baseline} → ${r.candidate} (> ${r.threshold})`);
      lines.push(`   verdict: ${v.verdict.inconclusive ? "NO VERDICT (see noVerdict)" : v.verdict.regression ? `REGRESSION ${bad.join(", ")}` : "no regression beyond the noise"}${v.verdict.improvement ? " (some improvement)" : ""}`);
    }
  }
  if (summary.noVerdict) lines.push(`NO VERDICT: ${summary.noVerdict.join("; ")}`);
  if (summary.confirmation) lines.push(`confirmation batch: ${summary.confirmation.confirmed ? `REGRESSION REPRODUCED (${summary.confirmation.metrics.join(", ")})` : `not reproduced (${summary.confirmation.metrics.join(", ") || "none"} on the 2nd batch)`}`);
  return lines;
}

// Why a comparison gives no verdict (exit code 3), or null (pure).
export function noVerdictReasons({ analyses, visits, gaveUp = null, verdicts }) {
  const reasons = [];
  if (gaveUp) reasons.push(gaveUp);
  const sampled = new Set(analyses.filter((a) => !a.analysis.error).map((a) => `${a.side}:${a.analysis.sampled}`));
  const bySide = (side) => [...sampled].filter((x) => x.startsWith(`${side}:`)).map((x) => x.split(":")[1]);
  if (bySide("baseline").length && (bySide("baseline").join() !== bySide("candidate").join() || bySide("candidate").length > 1)) {
    reasons.push("the sides were not sampled alike (one without the drop sampler): their costs differ");
  }
  for (let v = 1; v <= visits; v += 1) {
    const vv = verdicts[v];
    if (!vv) continue;
    for (const side of ["baseline", "candidate"]) {
      const usable = analyses.filter((a) => a.visit === v && a.side === side && !a.analysis.error && !a.analysis.overloaded).length;
      if (usable < VERDICT_MIN_RUNS) reasons.push(`visit ${v}: ${usable} usable ${side} run(s) (errors and overloaded runs left out), ${VERDICT_MIN_RUNS} needed`);
    }
    if (vv.inconclusive) reasons.push(`visit ${v}: a metric or a phase has no verdict`);
  }
  return reasons.length ? [...new Set(reasons)] : null;
}

function writeSummary(outDir, meta, analyses, visits, { noise = null, confirm = null } = {}) {
  const summary = { ...meta, visitSummary: [] };
  const verdicts = {};
  for (let v = 1; v <= visits; v += 1) {
    const of = (side) => analyses.filter((a) => a.visit === v && a.side === side).map((a) => a.analysis);
    const candidate = summarizeVisits(of("candidate"));
    const entry = { visit: v, candidate };
    if (analyses.some((a) => a.side === "baseline")) {
      entry.baseline = summarizeVisits(of("baseline"));
      const ok = (xs) => xs.filter((a) => !a.error && !a.overloaded);
      entry.verdict = verdicts[v] = visitVerdict(ok(of("baseline")), ok(of("candidate")), noise?.[v] ?? null);
    }
    summary.visitSummary.push(entry);
  }
  if (analyses.some((a) => a.side === "baseline")) {
    summary.noVerdict = noVerdictReasons({ analyses, visits, gaveUp: meta.gaveUp, verdicts });
    if (confirm) summary.confirmation = confirm;
  }
  summary.human = humanSummary(summary);
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  return summary;
}

// One file per side, run and visit: a run played again (-retry) replaces
// its failed first attempt (pure).
export function runFiles(names, re) {
  const best = new Map();
  for (const f of names) {
    const m = f.match(re);
    if (!m) continue;
    const key = `${m[1]}-${m[2]}-${m[3]}`;
    if (!best.has(key) || m[4]) best.set(key, f);
  }
  return [...best.values()].sort();
}

// "visit|phase:metric" of every gating regression of a summary (pure).
export function regressionKeys(summary) {
  return summary.visitSummary.flatMap((v) => (v.verdict?.regressions ?? []).map((r) => `${v.visit}|${r.where}:${r.metric}`));
}

export function exitCodeOf(summary, { compared, failed }) {
  if (!compared) return failed ? 1 : 0;
  if (summary.noVerdict || summary.confirmation?.noVerdict) return 3;
  if (summary.confirmation) return summary.confirmation.confirmed ? 2 : 0;
  if (regressionKeys(summary).length) return 2;
  return failed ? 1 : 0;
}

// The A/A noise of a previous summary.json, per visit number.
// It must come from the same measure: scenario, savestate, query, sampling.
export function readNoise(file, expect = null) {
  const s = JSON.parse(readFileSync(file, "utf8"));
  if (s.probe !== "drop-meter") throw new Error(`--noise ${file}: not a drop-meter summary`);
  if (expect) {
    const differ = ["scenario", "state", "query", "sampleMs"].filter((k) => (s[k] ?? null) !== (expect[k] ?? null));
    const named = { cpuModel: [s.machine?.cpuModel, expect.cpuModel], browser: [s.browser, expect.browser] };
    // the same machine, and the same browser when both runs say which
    if (expect.cpuModel && s.machine?.cpuModel && s.machine.cpuModel !== expect.cpuModel) differ.push("cpuModel");
    if (expect.browser && s.browser && s.browser !== expect.browser) differ.push("browser");
    if (differ.length) throw new Error(`--noise ${file}: another measure (${differ.map((k) => `${k} ${named[k]?.[0] ?? s[k]} vs ${named[k]?.[1] ?? expect[k]}`).join("; ")})`);
  }
  return Object.fromEntries(s.visitSummary.map((v) => [v.visit, { run: (v.candidate ?? v).noise, phases: (v.candidate ?? v).phases ?? {} }]));
}

function logRun(log, tag, a) {
  if (a.error) return log(`${tag}: ${a.error}`);
  const s = a.summary;
  log(`${tag}: lost ${s.lostMs} ms, <95 % ${s.pctBelow95} %, <90 % ${s.pctBelow90} %, worst 1 s ${s.worstSecond} %, hitches >50 ${s.hitches50} >100 ${s.hitches100}, p99 ${s.presentP99} ms, ${s.loads} loads +${s.loadExcessMs} ms, underruns ${s.underruns}, load1 ${a.load1.median}${a.overloaded ? " OVERLOADED" : ""}`);
  for (const d of a.worst.slice(0, 3)) log(`   drop ${d.label} @${round(d.guestStart, 1)} gs: ${d.durationMs} ms, lost ${d.lostMs} ms, min ${d.minSpeed} %, cause ${d.cause}, ${d.jitBlocks} new blocks (${d.defers} deferred), causes ${JSON.stringify(d.causesMs)}`);
}

async function analyzeDir(dir, native, log, noiseFile = null) {
  const meta = JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8"));
  const noise = noiseFile ? readNoise(noiseFile, { ...meta, cpuModel: meta.machine?.cpuModel }) : null;
  const analyses = [];
  for (const f of runFiles(readdirSync(dir), /^raw-(candidate|baseline)-(\d+)-v(\d+)(-retry)?\.json\.gz$/)) {
    const [, side, run, visit] = f.match(/raw-(\w+)-(\d+)-v(\d+)/);
    const analysis = analyzeVisit(JSON.parse(gunzipSync(readFileSync(path.join(dir, f)))), { native });
    analysis.overloaded = analysis.load1?.median > meta.maxLoad;
    analyses.push({ side, run: Number(run), visit: Number(visit), analysis });
    writeFileSync(path.join(dir, f.replace(/^raw-/, "").replace(/\.json\.gz$/, ".json")), JSON.stringify(analysis) + "\n");
    logRun(log, f, analysis);
  }
  const summary = writeSummary(dir, { ...meta, reanalyzedAt: new Date().toISOString(), native: Boolean(native) }, analyses, meta.visits ?? 1, { noise });
  for (const l of summary.human) log(l);
}

// The guard's false-positive rate, from real runs of ONE tree: random
// disjoint draws of VERDICT_MIN_RUNS runs as "baseline" and as "candidate"
// (the same run id for both visits), judged by the guard's own verdict.
// Sources: "dir" (every side) or "dir:side". Confirmed: a second,
// independent draw must regress on the same metric (--confirm).
export function falsePositiveRate(pool, { visits, noise = null, draws = 2000, n = VERDICT_MIN_RUNS, random = Math.random }) {
  const ids = [...new Set(pool.map((a) => a.id))];
  if (ids.length < 2 * n) throw new Error(`${ids.length} runs: ${2 * n} needed for a ${n} against ${n} draw`);
  const pick = () => {
    const order = ids.map((id) => [random(), id]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    return [order.slice(0, n), order.slice(n, 2 * n)];
  };
  const keysOf = ([b, c]) => {
    const out = [];
    for (let v = 1; v <= visits; v += 1) {
      const of = (set) => pool.filter((a) => a.visit === v && set.includes(a.id)).map((a) => a.analysis);
      const vv = visitVerdict(of(b), of(c), noise?.[v] ?? null);
      out.push(...vv.regressions.map((r) => `${v}|${r.where}:${r.metric}`));
    }
    return out;
  };
  let single = 0, confirmed = 0;
  const byKey = {};
  for (let d = 0; d < draws; d += 1) {
    const k1 = keysOf(pick());
    if (!k1.length) continue;
    single += 1;
    for (const k of k1) byKey[k] = (byKey[k] ?? 0) + 1;
    const k2 = keysOf(pick());
    if (k1.some((k) => k2.includes(k))) confirmed += 1;
  }
  return { draws, runs: ids.length, singleBatch: round(single / draws, 4), confirmed: round(confirmed / draws, 4),
    byMetric: Object.entries(byKey).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, c]) => [k, round(c / draws, 4)]) };
}

async function falsePositives(sources, { noiseFile, draws, log }) {
  const pool = [];
  let meta = null;
  for (const src of sources) {
    const [dir, side] = src.split(":");
    meta ??= JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8"));
    for (const f of runFiles(readdirSync(dir), /^(candidate|baseline)-(\d+)-v(\d+)(-retry)?\.json$/)) {
      const [, s, run, visit] = f.match(/^(\w+)-(\d+)-v(\d+)/);
      if (side && s !== side) continue;
      const analysis = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      if (analysis.error || analysis.overloaded || !analysis.phases?.[0] || analysis.summary?.dropLostMs === undefined) continue;
      pool.push({ id: `${dir}:${s}:${run}`, visit: Number(visit), analysis });
    }
  }
  // The noise must come from other runs than the ones drawn: an sd taken
  // from the pool itself makes the rate look lower than it is.
  const noiseDir = noiseFile ? path.resolve(path.dirname(noiseFile)) : null;
  if (noiseDir && sources.some((src) => path.resolve(src.split(":")[0]) === noiseDir)) throw new Error(`--noise ${noiseFile}: from a directory of the pool; take it from another A/A`);
  const noise = noiseFile ? readNoise(noiseFile, { ...meta, cpuModel: meta.machine?.cpuModel }) : null;
  const r = falsePositiveRate(pool, { visits: meta.visits ?? 2, noise, draws });
  log(`false positives over ${r.draws} A-against-A draws of ${VERDICT_MIN_RUNS} runs (${r.runs} runs of one tree): one batch ${(100 * r.singleBatch).toFixed(1)} %, confirmed by a second batch ${(100 * r.confirmed).toFixed(1)} %`);
  for (const [k, f] of r.byMetric) log(`   ${k}: ${(100 * f).toFixed(1)} %`);
  return r;
}

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, scenario: { type: "string", default: path.join(REPO_ROOT, "harness", "probes", "drop-scenario.json") },
      runs: { type: "string", default: "6" }, visits: { type: "string", default: "2" },
      candidate: { type: "string" }, baseline: { type: "string" }, noise: { type: "string" }, trend: { type: "string" }, "no-confirm": { type: "boolean", default: false },
      "false-positives": { type: "string", multiple: true }, draws: { type: "string", default: "2000" },
      config: { type: "string", default: "product" }, query: { type: "string" }, "sample-ms": { type: "string", default: "50" },
      native: { type: "string" }, analyze: { type: "string" }, trace: { type: "string" }, state: { type: "string" }, shots: { type: "boolean", default: false },
      "region-counters": { type: "boolean", default: false }, "pc-window": { type: "string" },
      "max-load": { type: "string" }, "load-wait": { type: "string", default: "300" }, "lock-wait": { type: "string", default: "14400" }, "calm-wait": { type: "string" }, "no-lock": { type: "boolean", default: false },
      port: { type: "string", default: process.env.HARNESS_PORT }, out: { type: "string" }
    }
  });
  const log = (m) => console.log(`[drops] ${m}`);
  const native = values.native ? JSON.parse(readFileSync(values.native, "utf8")) : null;
  if (values.analyze) return analyzeDir(path.resolve(values.analyze), native, log, values.noise ?? null);
  if (values["false-positives"]) return falsePositives(values["false-positives"], { noiseFile: values.noise ?? null, draws: num(values, "draws", { min: 10, int: true }), log });
  // A trace the site's drop HUD recorded (salon, ?engine.drophud=1): a
  // player's real session through the same analysis.
  if (values.trace) {
    const raw = JSON.parse(readFileSync(path.resolve(values.trace), "utf8"));
    if (raw.format !== "salon-drop-trace-v1") throw new Error(`${values.trace}: not a salon drop trace (format ${raw.format})`);
    const analysis = analyzeVisit(raw, { native });
    const out = path.resolve(values.trace).replace(/\.json$/, "") + ".analysis.json";
    writeFileSync(out, JSON.stringify(analysis) + "\n");
    logRun(log, path.basename(values.trace), analysis);
    log(`-> ${out}`);
    return;
  }
  if (!values.iso) throw new Error("usage: drop-meter.mjs --iso disc.iso --port N [--runs 6] [--visits 2] [--candidate ref|dir] [--baseline ref|dir] [--noise aa/summary.json] [--trend file.jsonl] | --analyze dir");
  const iso = path.resolve(values.iso);
  if (isLocalOnly(iso) && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
  const scenario = validateScenario(JSON.parse(readFileSync(values.scenario, "utf8")));
  const query = new URLSearchParams(values.query ?? (values.config === "product" ? PRODUCT_QUERY : values.config));
  query.set("metrics", "1");
  const o = {
    iso, scenario, query: query.toString(), runs: num(values, "runs", { min: 1, int: true }), visits: num(values, "visits", { min: 1, int: true }),
    sampleMs: num(values, "sample-ms", { min: 10 }), port: num(values, "port", { min: 1, int: true }),
    state: values.state ? path.resolve(values.state) : null,
    regionCounters: values["region-counters"], pcWindow: values["pc-window"] ? values["pc-window"].split("-").map(Number) : null,
    maxLoad: values["max-load"] ? num(values, "max-load", { min: 0.1 }) : Math.max(2, os.cpus().length / 4), loadWait: num(values, "load-wait", { min: 0 })
  };
  const noise = values.noise ? readNoise(values.noise, { scenario: path.basename(values.scenario), state: o.state ? path.basename(o.state) : null, query: o.query, sampleMs: o.sampleMs, cpuModel: machineSnapshot().cpuModel }) : null;
  const sides = { candidate: resolveSide("candidate", values.candidate) };
  if (values.baseline) sides.baseline = resolveSide("baseline", values.baseline);
  const lockWait = num(values, "lock-wait", { min: 0 });
  const lock = await calmLock({
    maxLoad: o.maxLoad, calmWait: values["calm-wait"] == null ? lockWait : num(values, "calm-wait", { min: 0 }), log: (m) => log(`before the lock: ${m}`),
    acquire: values["no-lock"] ? null : () => acquirePerfLock({ name: `harness drop-meter (${REPO_ROOT})`, waitSec: lockWait, log })
  });
  const outDir = probeOutDir("drop-meter", iso, values.out);
  const meta = {
    probe: "drop-meter", at: new Date().toISOString(), locked: !values["no-lock"], machine: machineSnapshot(), chrome: chromeInfo(), iso: path.basename(iso),
    scenario: path.basename(values.scenario), state: o.state ? path.basename(o.state) : null, query: o.query, sampleMs: o.sampleMs, runs: o.runs, visits: o.visits, maxLoad: o.maxLoad,
    sides: Object.fromEntries(Object.entries(sides).map(([k, s]) => [k, s.label])), noise: values.noise ?? null,
    definition: "windows of 100 ms from the scenario's first step; speed = guest/host time (VI ticks); drops: windows < 90 % or a present gap > 50 ms, merged; loads: disc reads ≥ 2.5 MiB/s (0.5 s average), merged within 1 s, excess = host − guest ms; time under 95/90 %: 1 s sliding windows; verdict: median moved the worse way beyond the A/A noise"
  };
  const analyses = [];
  let gaveUp = null;
  // One batch: o.runs runs, the sides alternating; run numbers go on.
  const runBatch = async (batch) => {
    const first = analyses.length ? Math.max(...analyses.map((a) => a.run)) + 1 : 1;
    for (let run = first; run < first + o.runs && !gaveUp; run += 1) {
      for (const name of sideOrder(run).filter((n) => sides[n])) {
        const gate = await lock.waitCalmUnlocked({ waitSec: o.loadWait, log });
        gaveUp = loadGaveUp(gate);
        if (gaveUp) { log(gaveUp); break; }
        const server = await ensureServer({ port: o.port, root: sides[name].root });
        meta.served ??= {};
        meta.served[name] ??= server.identity;
        try {
          // A run with an invalid visit (a crash, a timeline with holes) is
          // played once more on a new profile, so one bad run does not cost
          // the comparison its verdict; the failed one is kept as evidence.
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-harness-drops-"));
            const releaseProfile = claim(profileDir, REPO_ROOT, "chrome-profile");
            const tries = [];
            try {
              for (let visit = 1; visit <= o.visits; visit += 1) {
                const tag = attempt === 1 ? `${name}-${run}-v${visit}` : `${name}-${run}-v${visit}-retry`;
                const raw = await playVisit(o, server, profileDir, values.shots ? path.join(outDir, `shots-${tag}`) : null, visit);
                raw.gate = gate;
                raw.batch = batch;
                writeFileSync(path.join(outDir, `raw-${tag}.json.gz`), gzipSync(JSON.stringify(raw)));
                const analysis = analyzeVisit(raw, { native });
                analysis.overloaded = analysis.load1?.median > o.maxLoad;
                analysis.batch = batch;
                tries.push({ side: name, run, visit, batch, analysis });
                writeFileSync(path.join(outDir, `${tag}.json`), JSON.stringify(analysis) + "\n");
                logRun(log, `${name} run ${run} visit ${visit}${attempt > 1 ? " (retry)" : ""}`, analysis);
                if (analysis.error) break;
              }
            } finally {
              releaseProfile();
              rmSync(profileDir, { recursive: true, force: true });
            }
            if (tries.every((x) => !x.analysis.error) || attempt === 2) { analyses.push(...tries); break; }
            log(`${name} run ${run}: ${tries.find((x) => x.analysis.error).analysis.error}; played again`);
          }
        } finally {
          await server.stop();
        }
      }
    }
  };
  let confirm = null;
  try {
    await runBatch(1);
    meta.browser = analyses.find((a) => a.analysis.browser)?.analysis.browser ?? null;
    // A regression fails the guard only if a second batch, judged on its
    // own, regresses on the same metric (review of #261: ~24 tests a run).
    if (sides.baseline && !gaveUp && !values["no-confirm"]) {
      const first = writeSummary(outDir, { ...meta, gaveUp }, analyses, o.visits, { noise });
      const found = regressionKeys(first);
      if (found.length && !first.noVerdict) {
        log(`regression on the first batch (${found.join(", ")}): a second batch to confirm`);
        await runBatch(2);
        const second = writeSummary(outDir, { ...meta, gaveUp }, analyses.filter((a) => a.batch === 2), o.visits, { noise });
        const again = regressionKeys(second);
        confirm = { first: found, second: again, metrics: found.filter((k) => again.includes(k)), confirmed: found.some((k) => again.includes(k)), noVerdict: second.noVerdict };
      }
    }
  } finally {
    lock.release();
    for (const s of Object.values(sides)) if (s.temp) rmSync(s.root, { recursive: true, force: true });
  }
  const summary = writeSummary(outDir, { ...meta, gaveUp }, confirm ? analyses.filter((a) => a.batch === 1) : analyses, o.visits, { noise, confirm });
  if (values.trend) {
    const commit = meta.served?.candidate?.commit ?? execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const file = path.resolve(values.trend);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ...trendLine({ at: meta.at, commit, visitSummary: summary.visitSummary.map((v) => ({ visit: v.visit, ...v.candidate })) }), out: outDir }) + "\n");
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    writeFileSync(file.replace(/\.jsonl$/, "") + ".md", `# Drop meter, nightly on main\n\n${trendTable(lines)}`);
  }
  for (const l of summary.human) log(l);
  log(`-> ${outDir}`);
  // 0 no regression, 2 regression (reproduced when --confirm), 3 no verdict
  // (gave up, too few usable runs, a metric or phase without one, sides
  // sampled differently, a confirmation without one), 1 a run failed and
  // nothing else could be said.
  process.exitCode = exitCodeOf(summary, { compared: Boolean(sides.baseline), failed: analyses.some((a) => a.analysis.error) });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
