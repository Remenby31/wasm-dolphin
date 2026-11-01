#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// A parcours: a whole play-through, from the boot (no savestate) through the
// title, the menus, a selection, a load, a full game round, its results and
// back to a menu, played by a pad film. Headless on the Mac (no window may
// show there); on the Spark spark-run requires --headed :N (its bare Xorg:
// WebGPU on the GPU, a real BeginFrame source). Emulation speed and
// what the player sees (new frames, smoothness, hitches) everywhere, not only
// on a few race savestates.
//
//   node harness/probes/parcours.mjs --iso disc.iso --port N --film film.json
//     [--runs 1] [--candidate ref|dir] [--baseline ref|dir] [--noise <A/A>/summary.json]
//     [--config product | --query "..."] [--marker-timeout 120] [--max-sec 1200]
//     [--shots [--shot-every N]] [--max-load L] [--load-wait 300] [--lock-wait 14400 | --no-lock] [--out dir]
//   node harness/probes/parcours.mjs --iso disc.iso --port N --record steps.json --film-out film.json [--auto '{"bias":0}'] [--shots [--shot-every N]]
//   node harness/probes/parcours.mjs --analyze <out dir> [--noise <A/A>/summary.json]
//
// A run boots the disc on a new, empty Chrome profile and plays the film
// (lib/pad-film.mjs, pad-film-worker.js): pad states written into the core's
// direct pad block on the game's own SI polls, RESYNC markers that hold the
// film until the phase found matches (else the run is INCOMPLETE and does
// not count), the autopilot for a game round. Once a second, nothing per
// frame: __lastFrameInfo (speed, new frames shown and produced, occupancy,
// the replay's draws), the drop sampler's counters at 1 s (core ticks, disc
// bytes, EFB→XFB copies), the timeline (every present and VI output), the
// replay's integrity counters, the film's position. lib/parcours.mjs derives
// the seconds, finds the phases (boot, loading, cinematic, menu, game) from
// those signals alone, summarises each phase and each film section, and
// draws timeline-<side>-<run>.png.
//
// A/B: --baseline alternates the sides run by run; each phase and section is
// compared on its own (paired by phase, never by time) against the A/A noise
// of --noise (a parcours of the baseline alone), else the sides' spread
// (lib/drops.mjs verdictOf). Exit 2 on a regression or a broken integrity,
// 3 without a verdict, 1 when a run failed or did not complete.
// --record plays a host-time step list instead (lib/pad-film.mjs: the
// lib/steps.mjs kinds plus mark and auto) and writes the film it recorded:
// a first film is scripted, then replayed.
// The disc and the films are local data: never in the repo (probe-out.mjs
// puts a local disc's results under ../measures/harness).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

import { bootIso, ensureServer, launchChrome, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { exportRef } from "../cli.mjs";
import { calmLock, defaultMaxLoad, loadGaveUp, loadLimit } from "../lib/env.mjs";
import { readIntegrity, treeHasIntegrity } from "../lib/integrity.mjs";
import { claim } from "../lib/ownership.mjs";
import { filmMarkers, filmWithMarks, padFilmStatus, recordPorts, releaseMarker, runRecordSteps, signalStuck, startPadFilm, stopPadFilm, validateFilm, validateRecordSteps } from "../lib/pad-film.mjs";
import { analyzeRun, currentPhase, deriveSeconds, frameDiff, markerIndexes, STILL_DIFF, phaseNoise, parcoursVerdict, renderTimeline, usable } from "../lib/parcours.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { chromeInfo, isLocalOnly, probeOutDir } from "../lib/probe-out.mjs";
import { decodePng } from "../lib/png.mjs";
import { savePng } from "../lib/session.mjs";
import { startEdgeFollower, stopEdgeFollower } from "../lib/edge-follower.mjs";
import { median, round } from "../lib/stats.mjs";
import { machineSnapshot, powerDrained, powerSnapshot } from "../lib/system.mjs";
import { PRODUCT_QUERY } from "./drop-meter.mjs";
import { num, sideOrder } from "./race-perf.mjs";

// What this probe runs in the page and the worker: an A/A's noise holds only
// for the same version. Raised with each such change.
export const PROBE_VERSION = 1;

// The autopilot's stuck signal: while the worker says a port is under the
// autopilot, a picture of the screen every STILL_EVERY_SEC (an element
// screenshot: no capture stream left running) compared with the one before
// (lib/parcours.mjs frameDiff); STILL_CHECKS still ones in a row signal
// stuck, not more often than every STUCK_EVERY_SEC (the way out's own
// time). The engine's visualChangeFps stayed at 60 against a wall (the
// first disc measured): it counts presents, not content.
export const STILL_EVERY_SEC = 2;
export const STILL_CHECKS = 2;
export const STUCK_EVERY_SEC = 6;

// The canvas as RGBA, by a screenshot of the element (the HUD over it hidden).
async function screenFrame(page) {
  const png = await page.locator("#screen").screenshot({ timeout: 10000, style: ".screen-viewport > :not(canvas), .screen-osd { visibility: hidden !important; }" });
  return decodePng(png);
}

// The page's reading of one second: frame info, the replay's draws since
// boot (the worker's "wgx:d<n>" counter in its stats line; null when absent).
async function readInfo(page) {
  return page.evaluate(() => {
    const f = window.__lastFrameInfo || {};
    const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const d = /wgx:d(\d+)/.exec(String(f.ppcWasmHelperStats || ""));
    return {
      t: performance.timeOrigin + performance.now(),
      info: { speed: n(f.gameSpeed), newFps: n(f.newFramesPerSec), producedFps: n(f.newFramesProducedPerSec), newShown: n(f.newFramesShown), outOfOrder: n(f.framesOutOfOrder), cpuBusy: n(f.cpuThreadBusy), gpuBusy: n(f.gpuThreadBusy), replayBusy: n(f.replayBusy), draws: d ? Number(d[1]) : null }
    };
  });
}

// The drop sampler's last row of a drain, as named counters (null: no row).
export function countersOf(drained) {
  const row = drained?.rows?.at(-1);
  if (!row) return null;
  const at = (k) => { const i = drained.columns.indexOf(k); return i < 0 ? null : row[i]; };
  return { t: at("t"), ticks: at("ticks"), frame: at("frame"), discBytes: at("discBytes"), xfbCopies: at("xfbCopies") };
}

// Marker bookkeeping of a played film (pure): status -> what to do now.
// state: { held: ordinal + 1 or 0, since: host ms the hold began }
export function markerStep({ status, markers, phase, now, state, defaultTimeoutSec }) {
  const hold = status?.hold ?? 0;
  if (!hold || hold <= (status.released ?? 0)) return { action: "none" };
  if (state.held !== hold) { state.held = hold; state.since = now; }
  const m = markers[hold - 1];
  if (phase === m.phase) return { action: "release", ordinal: hold - 1 };
  const limit = (m.timeoutSec ?? defaultTimeoutSec) * 1000;
  if (now - state.since > limit) return { action: "missed", ordinal: hold - 1 };
  return { action: "wait" };
}

async function playRun(o, server, { side, run, outDir }) {
  const raw = { side, run, samples: [], reached: [], marks: [], stuckAt: [], loads: [], markers: o.film ? filmMarkers(o.film) : [] };
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-harness-parcours-"));
  const releaseProfile = claim(profileDir, REPO_ROOT, "chrome-profile");
  const context = await launchChrome({ profileDir });
  const shotDir = o.shots ? path.join(outDir, `shots-${side}-${run}`) : null;
  const shot = async (page, name) => { if (shotDir) savePng(await screenFrame(page).catch(() => null) ?? { width: 1, height: 1, data: new Uint8Array(4) }, path.join(shotDir, `${name}.png`)); };
  try {
    await context.assertInvisible("after launch");
    const page = context.pages()[0] ?? (await context.newPage());
    raw.power = powerSnapshot();
    raw.launchT = Date.now();
    await bootIso(page, { url: `${server.base}?${o.query}`, iso: o.iso, timeoutMs: 120000 });
    raw.bootMs = Date.now() - raw.launchT;
    await context.assertInvisible("after boot");
    raw.browser = await page.evaluate(() => navigator.userAgent.match(/(?:Headless)?Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent).catch(() => null);
    const progress = await workerRequest(page, "validationReadCoreProgress", {}, 5000);
    raw.tps = progress?.coreTicksPerSecond ?? null;
    // the 0113 headroom counters (XFB copies) on, as drop-meter turns them on
    raw.headroom = (await workerRequest(page, "validationReadHeadroomStats", { reset: 0 }, 5000))?.error ?? "on";
    raw.sampler = await workerRequest(page, "validationDropSampler", { action: "start", everyMs: 1000 }, 5000);
    raw.integrityStart = await readIntegrity(page, { expected: o.integrityExpected });
    raw.film = await startPadFilm(page, o.film ? { film: o.film } : { record: { ports: recordPorts(o.recordSteps), auto: o.auto } });
    if (raw.film?.error) throw new Error(`pad film: ${raw.film.error}`);
    let rows = [];
    const phaseNow = () => currentPhase(rows, o.detect);
    const markerState = { held: 0, since: 0 };
    let still = 0, lastStuck = -Infinity, prevFrame = null, ended = null, edgeOn = false;
    // --record: the step list runs beside the sampling loop
    const recording = o.recordSteps ? runRecordSteps(page, o.recordSteps, {
      phase: phaseNow,
      onMark: (m) => { raw.marks.push({ ...m, t: rows.at(-1)?.t ?? null }); void shot(page, `${String(raw.marks.length).padStart(2, "0")}-${m.label ?? m.phase}`); },
      log: (m) => o.log(`${side} ${run}: ${m}`)
    }).then(() => { ended = "steps done"; }, (e) => { ended = `steps failed: ${e.message}`; }) : null;
    const t0 = Date.now();
    while (!ended) {
      await page.waitForTimeout(1000 - ((Date.now() - t0) % 1000));
      const { t, info } = await readInfo(page);
      const drained = await workerRequest(page, "validationDropSampler", { action: "drain" }, 5000);
      const tl = await readTimeline(page).catch((e) => ({ error: String(e.message || e) }));
      if (tl?.presents?.lost || tl?.vi?.lost) raw.timelineLost = (raw.timelineLost ?? 0) + (tl.presents?.lost ?? 0) + (tl.vi?.lost ?? 0);
      const integrity = await readIntegrity(page, { expected: o.integrityExpected });
      const status = await padFilmStatus(page);
      raw.samples.push({ t, info, counters: countersOf(drained), presents: tl?.presents?.t ?? [], vi: tl?.vi?.t?.length ?? null, integrity: integrity?.unread || integrity?.unavailable ? null : integrity, film: status ? { pos: status.pos, hold: status.hold, polls: status.polls } : null });
      raw.loads.push([Date.now(), os.loadavg()[0]]);
      rows = deriveSeconds(raw.samples, { tps: raw.tps });
      const phase = phaseNow();
      const sec = Math.round((Date.now() - t0) / 1000);
      if (o.film) {
        const step = markerStep({ status, markers: raw.markers, phase, now: Date.now(), state: markerState, defaultTimeoutSec: o.markerTimeout });
        if (step.action === "release") {
          const m = raw.markers[step.ordinal];
          raw.reached.push({ ordinal: step.ordinal, at: t, t: rows.at(-1)?.t ?? null, pos: status.pos, polls: status.polls, waitedSec: round((Date.now() - markerState.since) / 1000, 1) });
          await releaseMarker(page, step.ordinal + 1);
          o.log(`${side} ${run}: ${sec} s marker ${step.ordinal + 1}/${raw.markers.length} ${m.label ?? m.phase} reached (${m.phase}, waited ${raw.reached.at(-1).waitedSec} s, poll ${status.polls})`);
          await shot(page, `${String(step.ordinal + 1).padStart(2, "0")}-${m.label ?? m.phase}`);
        } else if (step.action === "missed") {
          const m = raw.markers[step.ordinal];
          raw.reached.push({ ordinal: step.ordinal, missed: true, phaseSeen: phase });
          o.log(`${side} ${run}: ${sec} s marker ${step.ordinal + 1} ${m.label ?? m.phase} MISSED after ${m.timeoutSec ?? o.markerTimeout} s (phase ${phase ?? "unsettled"}): the run is INCOMPLETE`);
          await shot(page, `${String(step.ordinal + 1).padStart(2, "0")}-${m.label ?? m.phase}-missed`);
          ended = "marker missed";
        }
        if (status?.result) ended = status.result.type === "error" ? `film worker: ${status.result.error}` : "film end";
      }
      // --edge: the autopilot steers from the picture while it drives
      if (o.edge && Boolean(status?.autoOn) !== edgeOn) {
        edgeOn = Boolean(status?.autoOn);
        if (edgeOn) raw.edge = await startEdgeFollower(page, o.edge);
        else raw.edgeStats = await stopEdgeFollower(page);
        if (o.verbose) o.log(`${side} ${run}: ${sec} s edge follower ${edgeOn ? "on" : "off"}`);
      }
      // the autopilot's way out: a still picture while it drives
      if (status?.autoOn && sec % STILL_EVERY_SEC === 0) {
        const frame = await screenFrame(page).catch(() => null);
        const diff = frameDiff(prevFrame, frame);
        prevFrame = frame;
        still = diff != null && diff < STILL_DIFF ? still + 1 : 0;
        if (still >= STILL_CHECKS && sec - lastStuck >= STUCK_EVERY_SEC) {
          lastStuck = sec;
          still = 0;
          raw.stuckAt.push(sec);
          await signalStuck(page);
          if (o.verbose) o.log(`${side} ${run}: ${sec} s stuck (picture diff ${diff}): the autopilot backs off`);
        }
      } else if (!status?.autoOn) { prevFrame = null; still = 0; }
      if (o.shotEvery && sec % o.shotEvery === 0) await shot(page, `t${String(sec).padStart(4, "0")}`);
      if (o.verbose && sec % 10 === 0) o.log(`${side} ${run}: ${sec} s phase ${phase ?? "-"} speed ${rows.at(-1)?.speed ?? "-"} new ${rows.at(-1)?.newFps ?? "-"} draws/frame ${rows.at(-1)?.drawsPerFrame ?? "-"} disc ${rows.at(-1)?.discBps ?? "-"} film ${status?.pos ?? "-"}${status?.hold ? ` HOLD ${status.hold}` : ""}${status?.autoOn ? " AUTO" : ""}`);
      if (Date.now() - t0 > o.maxSec * 1000) ended = `--max-sec ${o.maxSec} reached`;
    }
    raw.ended = ended;
    if (edgeOn) raw.edgeStats = await stopEdgeFollower(page);
    await recording;
    raw.filmResult = await stopPadFilm(page);
    raw.integrityEnd = await readIntegrity(page, { expected: o.integrityExpected });
    await workerRequest(page, "validationDropSampler", { action: "stop" }, 5000);
    raw.powerEnd = powerSnapshot();
    return raw;
  } catch (error) {
    return { ...raw, error: String(error?.message || error).slice(0, 400) };
  } finally {
    await context.close().catch(() => {});
    releaseProfile();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

// One run's analysis from its raw record (pure but for the PNG written).
export function analyzeRaw(raw, { maxLoad, outDir = null, tag = null } = {}) {
  if (raw.error) return { error: raw.error, ended: raw.ended ?? null };
  const reached = raw.reached?.length || !raw.marks?.length ? raw.reached ?? [] : raw.marks.map((m, k) => ({ ordinal: k, missed: m.missed, at: m.atHost ?? null, t: m.t }));
  const markers = raw.markers?.length ? raw.markers : (raw.marks ?? []).map((m) => ({ phase: m.phase, label: m.label }));
  // a recorded mark is placed at the second it was taken (no host time kept)
  const withAt = reached.map((r) => (r.at == null && r.t != null ? { ...r, at: (raw.samples[0]?.t ?? 0) + r.t * 1000 } : r));
  const a = analyzeRun({ samples: raw.samples, tps: raw.tps, markers, reached: withAt, detect: raw.detect ?? {} });
  const loads = (raw.loads ?? []).map((x) => x[1]);
  a.load1 = { median: round(median(loads), 2), max: loads.length ? round(Math.max(...loads), 2) : null };
  a.overloaded = a.load1.median > loadLimit(raw.gate?.limit ?? maxLoad);
  a.powerDrained = powerDrained(raw.power, raw.powerEnd);
  a.ended = raw.ended ?? null;
  a.stuck = raw.stuckAt?.length ?? 0;
  a.timelineLost = raw.timelineLost ?? 0;
  a.film = raw.filmResult ? { polls: raw.filmResult.polls, missed: raw.filmResult.missed, gapsMs: raw.filmResult.gapsMs } : null;
  a.reached = withAt.map((r) => ({ ordinal: r.ordinal, label: markers[r.ordinal]?.label ?? markers[r.ordinal]?.phase, t: r.t ?? null, missed: Boolean(r.missed), waitedSec: r.waitedSec ?? null }));
  if (outDir && tag) {
    savePng(renderTimeline(a, { markers: markerIndexes(a, withAt, markers) }), path.join(outDir, `timeline-${tag}.png`));
  }
  return a;
}

// The lines a person reads (pure).
export function humanSummary(summary) {
  const lines = [];
  for (const r of summary.runs) {
    if (r.error) { lines.push(`${r.side} ${r.run}: FAILED ${r.error}`); continue; }
    const c = r.completion;
    lines.push(`${r.side} ${r.run}: ${c.completed ? "COMPLETE" : `INCOMPLETE (${c.reached}/${c.markers} markers${c.missing.length ? `, missed ${c.missing.join(", ")}` : ""}${c.phasesInOrder ? "" : ", phases out of order"})`}, ${r.seconds} s, ${r.segments.map((s) => `${s.phase} ${s.to - s.from}`).join(" > ")}${r.integrityFailed ? " INTEGRITY" : ""}${r.overloaded ? " OVERLOADED" : ""}${r.powerDrained ? " POWER" : ""}`);
    for (const [k, p] of Object.entries(r.phases)) lines.push(`   ${k.padEnd(9)} ${String(p.seconds).padStart(4)} s  speed ${p.speed.median} (p5 ${p.speed.p5}, min ${p.speed.min}) %  new ${p.newFps.median} (p5 ${p.newFps.p5})/s  smooth ${p.smoothness.median} (p5 ${p.smoothness.p5}) %  hitches >50 ${p.hitches50} >100 ${p.hitches100}  busy ${p.occupancy.cpuBusy}/${p.occupancy.gpuBusy}/${p.occupancy.replayBusy}`);
  }
  if (summary.verdict) {
    const v = summary.verdict;
    lines.push(`verdict (${v.usable.baseline} baseline, ${v.usable.candidate} candidate usable runs): ${v.regression ? `REGRESSION ${v.regressions.map((r) => `${r.where} ${r.metric} ${r.baseline} → ${r.candidate} (> ${r.threshold})`).join(", ")}` : v.inconclusive ? "NO VERDICT (a phase without enough runs)" : "no regression beyond the noise"}${v.improvement ? " (some improvement)" : ""}`);
  }
  if (summary.noVerdict) lines.push(`NO VERDICT: ${summary.noVerdict.join("; ")}`);
  return lines;
}

// The A/A noise of a previous parcours summary (one side), checked to be the
// same measure.
export function readNoise(file, expect) {
  const s = JSON.parse(readFileSync(file, "utf8"));
  if (s.probe !== "parcours") throw new Error(`--noise ${file}: not a parcours summary`);
  // --edge drives (a capture stream in the page): another measure; unset is none
  const differ = ["probeVersion", "film", "query", "edge"].filter((k) => JSON.stringify(s[k] ?? null) !== JSON.stringify(expect[k] ?? null));
  if (expect.cpuModel && s.machine?.cpuModel && s.machine.cpuModel !== expect.cpuModel) differ.push("cpuModel");
  if (differ.length) throw new Error(`--noise ${file}: another measure (${differ.join(", ")})`);
  if (!s.noise) throw new Error(`--noise ${file}: no A/A noise in it (a comparison, or no usable run)`);
  return s.noise;
}

export function exitCodeOf(summary) {
  if (summary.runs.some((r) => r.integrityFailed)) return 2;
  if (summary.verdict) {
    if (summary.noVerdict) return 3;
    if (summary.verdict.regression) return 2;
  }
  return summary.runs.some((r) => r.error || !r.completion?.completed) ? 1 : 0;
}

function writeSummary(outDir, meta, analyses, noise) {
  const runs = analyses.map((a) => ({ side: a.side, run: a.run, ...a.analysis, rows: undefined }));
  const summary = { ...meta, runs };
  const of = (side) => analyses.filter((a) => a.side === side).map((a) => a.analysis);
  if (meta.sides.baseline) {
    summary.verdict = parcoursVerdict(of("baseline"), of("candidate"), noise);
    const reasons = [];
    if (meta.gaveUp) reasons.push(meta.gaveUp);
    for (const side of ["baseline", "candidate"]) if (of(side).filter(usable).length < 3) reasons.push(`${of(side).filter(usable).length} usable ${side} run(s) (complete, clean, calm), 3 needed`);
    if (summary.verdict.inconclusive) reasons.push("a phase or section has no verdict");
    summary.noVerdict = reasons.length ? reasons : null;
  } else {
    const ok = of("candidate").filter(usable);
    summary.noise = ok.length >= 2 ? phaseNoise(ok) : null;
  }
  summary.human = humanSummary(summary);
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  return summary;
}

function resolveSide(name, spec) {
  if (!spec) return { name, label: "this tree", root: REPO_ROOT, temp: false };
  if (existsSync(spec) && statSync(spec).isDirectory()) return { name, label: path.resolve(spec), root: path.resolve(spec), temp: false };
  return { name, label: spec, root: exportRef(spec), temp: true };
}

async function analyzeDir(dir, { noiseFile, log }) {
  const meta = JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8"));
  const analyses = [];
  for (const f of readdirSync(dir).filter((x) => /^raw-(candidate|baseline)-\d+\.json\.gz$/.test(x)).sort()) {
    const [, side, run] = f.match(/^raw-(\w+)-(\d+)/);
    const raw = JSON.parse(gunzipSync(readFileSync(path.join(dir, f))));
    const analysis = analyzeRaw(raw, { maxLoad: meta.maxLoad, outDir: dir, tag: `${side}-${run}` });
    writeFileSync(path.join(dir, `${side}-${run}.json`), JSON.stringify(analysis) + "\n");
    analyses.push({ side, run: Number(run), analysis });
  }
  const noise = noiseFile ? readNoise(noiseFile, { ...meta, cpuModel: meta.machine?.cpuModel }) : null;
  const { runs, verdict, noise: n, human, noVerdict, ...rest } = meta;
  const summary = writeSummary(dir, { ...rest, reanalyzedAt: new Date().toISOString() }, analyses, noise);
  for (const l of summary.human) log(l);
  return summary;
}

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, film: { type: "string" }, record: { type: "string" }, "film-out": { type: "string" },
      runs: { type: "string", default: "1" }, candidate: { type: "string" }, baseline: { type: "string" }, noise: { type: "string" },
      config: { type: "string", default: "product" }, query: { type: "string" }, "marker-timeout": { type: "string", default: "120" }, "max-sec": { type: "string", default: "1200" },
      edge: { type: "string" }, shots: { type: "boolean", default: false }, "shot-every": { type: "string", default: "0" }, auto: { type: "string" }, verbose: { type: "boolean", default: false }, analyze: { type: "string" },
      "max-load": { type: "string" }, "load-wait": { type: "string", default: "300" }, "lock-wait": { type: "string", default: "14400" }, "no-lock": { type: "boolean", default: false },
      port: { type: "string", default: process.env.HARNESS_PORT }, out: { type: "string" }
    }
  });
  const log = (m) => console.log(`[parcours] ${m}`);
  if (values.analyze) return analyzeDir(path.resolve(values.analyze), { noiseFile: values.noise ?? null, log });
  if (!values.iso || !(values.film || values.record)) throw new Error("usage: parcours.mjs --iso disc.iso --port N (--film film.json [--runs N] [--baseline ref|dir] [--noise aa/summary.json] | --record steps.json --film-out film.json) | --analyze dir");
  if (values.record && !values["film-out"]) throw new Error("--record needs --film-out (where the film goes: local data, never the repo)");
  if (values.record && values.baseline) throw new Error("--record: one run of one tree, no --baseline");
  const iso = path.resolve(values.iso);
  if (isLocalOnly(iso) && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
  const query = new URLSearchParams(values.query ?? (values.config === "product" ? PRODUCT_QUERY : values.config));
  query.set("metrics", "1");
  const film = values.film ? validateFilm(JSON.parse(readFileSync(values.film, "utf8"))) : null;
  const recordSteps = values.record ? validateRecordSteps(JSON.parse(readFileSync(values.record, "utf8"))) : null;
  const o = {
    iso, film, recordSteps, query: query.toString(), log, verbose: values.verbose, shots: values.shots,
    runs: values.record ? 1 : num(values, "runs", { min: 1, int: true }), port: num(values, "port", { min: 1, int: true }),
    markerTimeout: num(values, "marker-timeout", { min: 1 }), maxSec: num(values, "max-sec", { min: 10 }),
    maxLoad: values["max-load"] ? num(values, "max-load", { min: 0.1 }) : defaultMaxLoad(), loadWait: num(values, "load-wait", { min: 0 }),
    detect: film?.detect ?? {},
    // --shot-every N: a picture every N seconds too (with --shots), to place a film's marks
    shotEvery: values.shots ? num(values, "shot-every", { min: 0, int: true }) : 0,
    // --auto '{"bias":-20}': the recorder's autopilot settings (pad-film-worker.js)
    auto: values.auto ? JSON.parse(values.auto) : null,
    // --edge '{"0":[0,0,1,1]}': the autopilot steers from the picture, each
    // port in its view (lib/edge-follower.mjs); '{}' or absent: the sine
    edge: values.edge ? JSON.parse(values.edge) : null
  };
  const filmBytes = values.film ? readFileSync(values.film) : null;
  const filmId = filmBytes ? `${path.basename(values.film)}#${createHash("sha256").update(filmBytes).digest("hex").slice(0, 12)}` : null;
  const machine = machineSnapshot();
  const noise = values.noise ? readNoise(values.noise, { probeVersion: PROBE_VERSION, film: filmId, query: o.query, edge: o.edge, cpuModel: machine.cpuModel }) : null;
  const sides = { candidate: resolveSide("candidate", values.candidate) };
  if (values.baseline) sides.baseline = resolveSide("baseline", values.baseline);
  const lockWait = num(values, "lock-wait", { min: 0 });
  const lock = await calmLock({
    maxLoad: o.maxLoad, calmWait: lockWait, log: (m) => log(`before the lock: ${m}`),
    acquire: values["no-lock"] ? null : () => acquirePerfLock({ requireMains: true, name: `harness parcours (${REPO_ROOT})`, waitSec: lockWait, log })
  });
  // A run that never ends must not hold the lock: a watchdog from here (the
  // lock held), per run --max-sec plus the boot and the closing.
  const watchdog = setTimeout(() => { log("watchdog: the probe overran, exiting"); lock.release(); process.exit(4); }, (o.runs * Object.keys(sides).length * (o.maxSec + 240) + 600) * 1000);
  const outDir = probeOutDir("parcours", iso, values.out);
  const meta = {
    probe: "parcours", probeVersion: PROBE_VERSION, at: new Date().toISOString(), locked: !values["no-lock"], machine, chrome: chromeInfo(), iso: path.basename(iso),
    film: filmId, edge: o.edge, record: values.record ? path.basename(values.record) : null, query: o.query, runs: o.runs, maxLoad: o.maxLoad, markerTimeout: o.markerTimeout,
    sides: Object.fromEntries(Object.entries(sides).map(([k, s]) => [k, s.label])), noiseFrom: values.noise ?? null,
    definition: "one sample a second; speed = guest/host time (core ticks); smoothness = new frames shown / the game's cadence learnt as the site does; phases from disc reads, new frames, EFB→XFB copies and replay draws per frame, ≥ 2 s each; A/B per phase and per film section against the A/A noise"
  };
  const analyses = [];
  let gaveUp = null;
  try {
    for (let run = 1; run <= o.runs && !gaveUp; run += 1) {
      for (const name of sideOrder(run).filter((n) => sides[n])) {
        const gate = await lock.waitCalmUnlocked({ waitSec: o.loadWait, log });
        gaveUp = loadGaveUp(gate);
        if (gaveUp) break;
        const server = await ensureServer({ port: o.port, root: sides[name].root });
        meta.served ??= {};
        meta.served[name] ??= server.identity;
        let raw;
        try {
          raw = await playRun({ ...o, integrityExpected: treeHasIntegrity(sides[name].root) }, server, { side: name, run, outDir });
        } finally {
          await server.stop();
        }
        raw.gate = gate;
        raw.detect = o.detect;
        writeFileSync(path.join(outDir, `raw-${name}-${run}.json.gz`), gzipSync(JSON.stringify(raw)));
        const analysis = analyzeRaw(raw, { maxLoad: o.maxLoad, outDir, tag: `${name}-${run}` });
        writeFileSync(path.join(outDir, `${name}-${run}.json`), JSON.stringify(analysis) + "\n");
        analyses.push({ side: name, run, analysis });
        meta.browser ??= raw.browser ?? null;
        if (values.record) {
          const recorded = filmWithMarks(raw.filmResult?.film ?? { unit: "poll", ports: recordPorts(recordSteps), steps: [], end: 1 }, raw.marks, `Pad film recorded by harness/probes/parcours.mjs --record ${path.basename(values.record)}, query ${o.query}`);
          mkdirSync(path.dirname(path.resolve(values["film-out"])), { recursive: true });
          writeFileSync(values["film-out"], JSON.stringify(recorded) + "\n");
          log(`film: ${recorded.steps.length} steps, ${recorded.end} polls${recorded.missedMarks ? `, marks missed: ${recorded.missedMarks.join(", ")}` : ""} -> ${values["film-out"]}`);
        }
      }
    }
  } finally {
    lock.release();
    for (const s of Object.values(sides)) if (s.temp) rmSync(s.root, { recursive: true, force: true });
  }
  const summary = writeSummary(outDir, { ...meta, gaveUp }, analyses, noise);
  for (const l of summary.human) log(l);
  log(`-> ${outDir}`);
  clearTimeout(watchdog);
  process.exit(exitCodeOf(summary));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(`[parcours] ${e.stack || e.message}`); process.exit(1); });
}
