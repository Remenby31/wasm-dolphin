// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Input and picture gates of a presentation change (first: ?wgpureplayms=4
// by default, 2026-10-29; since then the old replay is --extra
// "&wgpureplayms=0"), base and candidate interleaved in ABBA blocks,
// each visit a fresh profile, a savestate loaded as soon as the core takes it.
//  - picture: the core's own XFB at VI outputs --vi (default 240,600) after
//    the load (captureAtVi: a fixed emulated frame, never a fixed time); the
//    candidate's difference to the base against base-to-base (the noise of
//    dual core), mean absolute RGB at the best offset within ±2 px.
//  - input: a one-frame A press every 400 ms for 24 s from 5 s after the
//    load; the worker's host -> next distinct frame tracker (?inputlatency=1):
//    presses seen, p95 and max per visit, then per side.
//
//   node harness/probes/replay-gates.mjs --iso disc.iso --state scene.sav --port N --out dir
//     --query "<base query>" --extra "&wgpureplayms=0" [--runs 4 (visits per side, even)] [--vi 240,600]
//     [--candidate <dir to serve>] [--lock-wait 14400]
// One tree serves both sides (only --extra differs): no --baseline.
// --slot-saves N: N slot saves in a row after the load, each bounded at 60 s;
// any that fails or never answers fails the visit.
// --slot-reload: after the file load, the state goes through the slot path
// (save slot 1, load slot 1) and frames count from that load; the save runs
// at a host-time moment, so its frames are compared within a run, not across
// trees (its integrity is, the slot load inside the window).
// --bad-state-load: after the file load, import a state that passes every
// page-side check (this game, this version, the payload's start) but ends
// right after the RAM, and load it: Dolphin fails it and undoes the load.
// The worker must refuse it (patch 0210: a load the core did not apply never
// counts as loaded, nor restarts the VI count) and the frames that follow
// still count from the file load. Else the visit fails.
// Each visit ends with the pthreads in use against the pool
// (validationReadPthreads; summary.pthreads: the most seen running).
// --exact (glitch-meter G3, lib/glitch-oracle.mjs): the deterministic
// oracle. cpu=single and video=wgpu required; base is the reference (every
// WebGPU cache and grouping off, each switch read back from the replay's
// runtime config), candidate the default (+ --extra). Per VI the reference
// must give one hash across its visits and every default visit that same
// hash: 0 pixels apart. A difference fails (exit 1) and keeps the reference,
// the default and their difference (x8) as out/mismatch-<VI>-*.png. No
// input phase (the frames are the measure).
// --flicker S (glitch-meter G4, lib/flicker.mjs): after the frames, S
// seconds of presented pictures (sampled rows) watched for one that comes
// and goes (A-B-A); one found fails (exit 1) and keeps its three pictures
// as out/flicker-visit<n>-<k>.png.
// visits.json keeps each captured frame's sha256 (hashes), so the frames of
// two trees can be compared exactly from two runs.
// Exit 1 when a visit failed, a side has no picture or no input reading, or
// a visit's replay integrity broke (glitch-meter G2, lib/integrity.mjs).
// Holds the perf lock (HARNESS_PERF_LOCK); a watchdog after it; always exits.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ensureServer, loadHarnessState, captureAtVi, workerRequest } from "../lib/browser.mjs";
import { integrityBrief, integrityOf, readIntegrity, treeHasIntegrity } from "../lib/integrity.mjs";
import { openSession, savePng } from "../lib/session.mjs";
import { distinctRuns, findFlicker, tripleStrip } from "../lib/flicker.mjs";
import { diffFrame, exactVerdict, oracleQueryError, referenceQuery, referenceSwitchesOn } from "../lib/glitch-oracle.mjs";
import { setPad } from "../lib/gamepad-mock.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";

const { values: o } = parseArgs({ options: {
  iso: { type: "string" }, state: { type: "string" }, port: { type: "string" }, out: { type: "string" },
  query: { type: "string" }, extra: { type: "string" }, runs: { type: "string", default: "4" }, vi: { type: "string", default: "240,600" },
  candidate: { type: "string" }, "lock-wait": { type: "string", default: "14400" },
  "slot-reload": { type: "boolean", default: false }, "slot-saves": { type: "string", default: "0" },
  "bad-state-load": { type: "boolean", default: false },
  exact: { type: "boolean", default: false }, flicker: { type: "string", default: "0" }
}, strict: true });
for (const k of ["iso", "state", "port", "out", "query", ...(o.exact ? [] : ["extra"])]) if (!o[k]) throw new Error(`--${k} is required`);
o.extra ??= "";
if (o.exact) {
  const why = oracleQueryError(o.query);
  if (why) throw new Error(why);
}
if (existsSync(o.out)) throw new Error(`${o.out} exists`);
const root = path.resolve(o.candidate ?? path.join(import.meta.dirname, "..", ".."));
const perSide = Math.max(2, Number(o.runs) + (Number(o.runs) % 2));
// one tree serves both sides: with the counters, its worker must answer
const integrityExpected = treeHasIntegrity(root);
const VIS = o.vi.split(",").map(Number).filter((n) => n > 0);
const log = (m) => console.log(`[gates] ${m}`);
const order = [];
for (let b = 0; b < perSide / 2; b += 1) order.push(...(b % 2 ? ["candidate", "base", "base", "candidate"] : ["base", "candidate", "candidate", "base"]).slice(0, 4));
const release = await acquirePerfLock({ name: `replay-gates ${o.extra}`, waitSec: Number(o["lock-wait"]), log });
const watchdog = setTimeout(() => { console.error("watchdog: 60 min under the lock"); release(); process.exit(2); }, 60 * 60 * 1000);
const server = await ensureServer({ port: Number(o.port), root });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);
// --bad-state-load: the harness state's headers (game, version), as numbers
function badStateHeader() {
  const bytes = readFileSync(o.state);
  return [...bytes.subarray(0, 32 + bytes.readUInt32LE(28) + 16)];
}
const visits = [];
try {
  for (const [n, side] of order.entries()) {
    const query = o.exact
      ? (side === "base" ? `${referenceQuery(o.query)}&metrics=1` : `${o.query}&metrics=1${o.extra}`)
      : `${o.query}&inputlatency=1&metrics=1${side === "candidate" ? o.extra : ""}`;
    const session = await openSession({ base: server.base, server, query, iso: o.iso, gamepads: { connected: 1 }, routes: { "**/__harness_state.sav": o.state } });
    const v = { n, side, frames: {}, input: null };
    try {
      const loaded = await loadHarnessState(session.page, session.url);
      if (!loaded?.loaded) throw new Error(`savestate not loaded: ${JSON.stringify(loaded)}`);
      // glitch-meter G2: the replay's integrity from the load to the visit's end
      const integrityStart = await readIntegrity(session.page, { expected: integrityExpected });
      // --slot-reload: the same state through the slot path (save to slot 1,
      // load slot 1), the frames counted from that load and the slot load
      // inside the integrity window (its frames depend on when the save ran:
      // compare its integrity, not its pixels, across trees)
      // --slot-saves N: N slot saves in a row (no load), each bounded; one
      // that never answers fails the visit (the deadlock 0209 removed)
      if (Number(o["slot-saves"]) > 0) {
        v.saves = [];
        for (let k = 0; k < Number(o["slot-saves"]); k += 1) {
          const t0 = Date.now();
          const r = await workerRequest(session.page, "saveState", { slot: 1 }, 60000);
          const ms = Date.now() - t0;
          v.saves.push({ ms, saved: Boolean(r?.saved), error: r?.error ?? null });
          log(`visit ${n} ${side}: save ${k + 1} ${r?.saved ? "ok" : `FAILED (${r?.error})`} in ${ms} ms`);
          await new Promise((res) => setTimeout(res, 2000));
        }
        const failed = v.saves.filter((x) => !x.saved).length;
        if (failed) throw new Error(`${failed} of ${v.saves.length} slot saves failed`);
      }
      if (o["slot-reload"]) {
        // each step bounded and timed: a slot request that never answers
        // fails the visit instead of holding the bench (2026-10-31: 49 min)
        const step = async (type) => {
          const t0 = Date.now();
          const r = await workerRequest(session.page, type, { slot: 1 }, 60000);
          log(`visit ${n} ${side}: ${type} slot 1 ${r?.error ? `failed: ${r.error}` : "ok"} in ${Date.now() - t0} ms`);
          return r;
        };
        const saved = await step("saveState");
        const loaded = saved?.error ? null : await step("loadState");
        const slot = { saved: Boolean(saved?.saved), loaded: Boolean(loaded?.loaded) };
        if (!slot.saved || !slot.loaded) throw new Error(`slot reload failed: ${JSON.stringify(slot)}`);
        v.slotReload = slot;
      }
      if (o["bad-state-load"]) {
        const t0 = Date.now();
        const r = await withTimeout(session.page.evaluate(async (header) => {
          try {
            return await window.__host.adapter.request("importSaveState", { bytes: truncatedState(header), load: true });
          } catch (e) {
            return { error: String(e?.message || e) };
          }
          // the state's own headers, uncompressed; its payload: the console
          // flag and MEM1 size the page checks, 24 MiB of RAM, then 4 KiB
          function truncatedState(head) {
            const payload = 0x1800000 + 4096;
            const out = new Uint8Array(head.length + payload);
            out.set(head);
            const view = new DataView(out.buffer);
            const base = 32 + view.getUint32(28, true);
            view.setUint16(base + 2, 0, true);
            view.setUint32(base + 4, 0, true);
            view.setBigUint64(base + 8, BigInt(payload), true);
            view.setUint32(head.length + 1, 0x1800000, true);
            return out.buffer;
          }
        }, badStateHeader()), 90000, "bad state load").catch((e) => ({ error: e.message }));
        v.badLoad = { loaded: r?.loaded ?? null, error: r?.error ?? null, ms: Date.now() - t0 };
        log(`visit ${n} ${side}: bad state load: ${JSON.stringify(v.badLoad)}`);
        if (!/did not load the save state/.test(v.badLoad.error ?? "")) {
          throw new Error(`a state the core cannot apply must be refused: ${JSON.stringify(v.badLoad)}`);
        }
      }
      if (o.exact) {
        // what the replay really runs: a reference with a switch still on
        // compares nothing
        const diag = await workerRequest(session.page, "rendererDiagnostics", {}, 10000);
        v.runtimeConfig = diag?.runtimeConfig ?? null;
        if (side === "base") {
          const on = referenceSwitchesOn(v.runtimeConfig);
          if (on.length) throw new Error(`the reference still runs: ${on.join(", ")}`);
        }
      }
      for (const index of VIS) {
        const f = await captureAtVi(session.page, { index, fromLoad: true, timeoutMs: 60000 });
        v.frames[index] = f.error ? { error: f.error } : { width: f.width, height: f.height, b64: Buffer.from(f.data).toString("base64"),
          // comparable across trees and runs: the same pixels, the same hash
          sha256: createHash("sha256").update(f.data).digest("hex") };
      }
      // --flicker: the presented pictures watched for an A-B-A
      if (Number(o.flicker) > 0) {
        const started = await workerRequest(session.page, "validationFlickerWatch", { action: "start" }, 10000);
        if (!started?.started) throw new Error(`flicker watch: ${started?.error ?? "not started"}`);
        await sleep(Number(o.flicker) * 1000);
        const watch = await workerRequest(session.page, "validationFlickerWatch", { action: "stop" }, 60000);
        if (watch?.error) throw new Error(`flicker watch: ${watch.error}`);
        const found = findFlicker(distinctRuns(watch));
        found.flagged.slice(0, 5).forEach((t, k) => savePng(tripleStrip(t, watch.cols, watch.rows), path.join(o.out, `flicker-visit${n}-${k}.png`)));
        v.flicker = { presents: watch.presents, kept: watch.kept, gaps: watch.gaps, errors: watch.errors, full: watch.full,
          distinct: found.distinct, triples: found.triples, closestRatio: found.closestRatio,
          flagged: found.flagged.map(({ frames, ...t }) => t) };
        log(`visit ${n} ${side}: flicker ${watch.presents} presents, ${found.distinct} distinct, ${found.triples} triples, closest ratio ${found.closestRatio}, ${found.flagged.length} A-B-A`);
        if (!found.triples) throw new Error(`flicker watch: no triple to judge (${watch.kept} sampled presents, ${watch.gaps} gaps)`);
      }
      // --exact: the frames are the measure, no input phase
      if (!o.exact) {
        await sleep(5000);
        for (const t0 = Date.now(); Date.now() - t0 < 24000;) {
          await setPad(session.page, 0, { pressed: ["A"] });
          await sleep(34);
          await setPad(session.page, 0, {});
          await sleep(366);
        }
        await sleep(1000);
        v.input = await session.page.evaluate(() => window.__causalTelemetry?.input?.visible ?? null);
      }
      v.integrity = integrityOf(integrityStart, await readIntegrity(session.page, { expected: integrityExpected }), { postload: true });
      v.pthreads = await workerRequest(session.page, "validationReadPthreads", {}, 10000).catch((e) => ({ error: String(e?.message || e) }));
    } catch (e) {
      v.error = String(e?.message || e);
    } finally {
      await session.close();
    }
    const i = v.input;
    log(`visit ${n} ${side}: ${v.error ?? `frames ${VIS.map((x) => (v.frames[x]?.error ? "err" : "ok")).join("/")}, input ${i ? `${i.visibleCount} seen, p95 ${Math.round(i.visibleAgeP95Ms)} ms, max ${Math.round(i.visibleAgeMaxMs)} ms` : "none"}${integrityBrief(v.integrity)}`}`);
    visits.push(v);
  }
} finally {
  await server.stop();
  release();
  clearTimeout(watchdog);
}
// mean absolute RGB difference at the best offset within ±2 px (every other pixel)
function frameDiff(a, b) {
  let best = Infinity;
  for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
    let s = 0, c = 0;
    for (let y = 2; y < Math.min(a.height, b.height) - 2; y += 2) for (let x = 2; x < Math.min(a.width, b.width) - 2; x += 2) {
      const i = (y * a.width + x) * 4, j = ((y + oy) * b.width + x + ox) * 4;
      s += Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]); c += 3;
    }
    if (c) best = Math.min(best, s / c);
  }
  return Math.round(best * 100) / 100;
}
const frameOf = (x) => ({ width: x.width, height: x.height, data: Buffer.from(x.b64, "base64") });
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const summary = { probe: "replay-gates", extra: o.extra, order, picture: {}, input: {},
  integrity: visits.filter((v) => v.integrity?.fatal?.length).map((v) => ({ visit: v.n, side: v.side, fatal: v.integrity.fatal })) };
{
  const read = visits.map((v) => v.pthreads).filter((p) => Number.isFinite(p?.running));
  summary.pthreads = read.length ? { maxRunning: Math.max(...read.map((p) => p.running)), maxAllocated: Math.max(...read.map((p) => p.allocated)), poolSize: read[0].poolSize } : null;
  log(`pthreads: ${JSON.stringify(summary.pthreads)}`);
}
summary.flicker = visits.filter((v) => v.flicker?.flagged?.length).map((v) => ({ visit: v.n, side: v.side, flagged: v.flicker.flagged }));
for (const f of summary.flicker) log(`FLICKER visit ${f.visit} ${f.side}: ${f.flagged.length} A-B-A (first at present ${f.flagged[0].seqB}, ratio ${f.flagged[0].ratio})`);
for (const f of summary.integrity) log(`INTEGRITY visit ${f.visit} ${f.side}: ${f.fatal.join(", ")}`);
for (const index of VIS) {
  const of = (side) => visits.filter((v) => v.side === side && v.frames[index]?.b64).map((v) => frameOf(v.frames[index]));
  const B = of("base"), C = of("candidate"), bb = [], cb = [];
  for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) bb.push(frameDiff(B[i], B[j]));
  for (const c of C) for (const b of B) cb.push(frameDiff(b, c));
  summary.picture[index] = { baseVsBase: bb, candidateVsBase: cb, baseMax: bb.length ? Math.max(...bb) : null, candidateMedian: median(cb), candidateMax: cb.length ? Math.max(...cb) : null };
  log(`picture VI ${index}: base vs base ${JSON.stringify(bb)}; candidate vs base median ${summary.picture[index].candidateMedian} (max ${summary.picture[index].candidateMax})`);
}
for (const side of ["base", "candidate"]) {
  const xs = visits.filter((v) => v.side === side && v.input);
  summary.input[side] = {
    visits: xs.length, presses: xs.reduce((s, v) => s + (v.input.visibleCount || 0), 0),
    p95Median: median(xs.map((v) => v.input.visibleAgeP95Ms)), max: xs.length ? Math.max(...xs.map((v) => v.input.visibleAgeMaxMs || 0)) : null,
    pollToVisibleP95Median: median(xs.map((v) => v.input.pollToVisibleP95Ms))
  };
  log(`input ${side}: ${JSON.stringify(summary.input[side])}`);
}
mkdirSync(o.out, { recursive: true });
writeFileSync(path.join(o.out, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
writeFileSync(path.join(o.out, "visits.json"), JSON.stringify(visits.map(({ frames, ...v }) => ({ ...v,
  hashes: Object.fromEntries(Object.entries(frames).map(([vi, f]) => [vi, f.sha256 ?? null])) })), null, 1) + "\n");
// --exact: the oracle's verdict, and the pictures of every difference
if (o.exact) {
  const hashed = visits.map((v) => ({ side: v.side, hashes: Object.fromEntries(Object.entries(v.frames).map(([vi, f]) => [vi, f.sha256 ?? null])) }));
  const verdict = exactVerdict(hashed, VIS.map(String));
  for (const row of verdict.rows.filter((r) => r.mismatches > 0)) {
    const ref = visits.find((v) => v.side === "base" && v.frames[row.vi]?.sha256 === row.reference);
    const bad = visits.find((v) => v.side === "candidate" && v.frames[row.vi]?.b64 && v.frames[row.vi].sha256 !== row.reference);
    const a = frameOf(ref.frames[row.vi]), b = frameOf(bad.frames[row.vi]);
    const diff = diffFrame(a, b);
    row.pixels = diff.pixels;
    savePng(a, path.join(o.out, `mismatch-${row.vi}-reference.png`));
    savePng(b, path.join(o.out, `mismatch-${row.vi}-default-visit${bad.n}.png`));
    savePng(diff, path.join(o.out, `mismatch-${row.vi}-diff-x8.png`));
  }
  summary.exact = verdict;
  writeFileSync(path.join(o.out, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  for (const row of verdict.rows) log(`exact VI ${row.vi}: ${row.missing ? "MISSING" : row.unstable ? "REFERENCE UNSTABLE" : row.mismatches ? `DIFFERS in ${row.mismatches} visit(s), ${row.pixels} px` : "0 px"}`);
  const errors = visits.filter((v) => v.error);
  for (const v of errors) log(`visit ${v.n} ${v.side}: ${v.error}`);
  log(verdict.pass && !errors.length && !summary.integrity.length && !summary.flicker.length ? "EXACT: the default renders the reference's pixels at every VI" : `EXACT FAILED: ${[...verdict.failures, ...errors.map((v) => `visit ${v.n}: ${v.error}`)].join("; ")}`);
  process.exit(verdict.pass && !errors.length && !summary.integrity.length && !summary.flicker.length ? 0 : 1);
}
// a gate that measured nothing never passes
// __causalTelemetry.input.visible is never null (without the tracker it is
// {enabled: false, visibleCount: 0}): a visit counts only with presses seen
const failed = visits.filter((v) => v.error || !v.input?.enabled || !v.input.visibleCount || VIS.some((i) => !v.frames[i]?.b64));
const empty = ["base", "candidate"].filter((side) => !summary.input[side].visits || !summary.input[side].presses || VIS.some((i) => !summary.picture[i][side === "base" ? "baseVsBase" : "candidateVsBase"].length));
if (failed.length || empty.length) log(`FAILED: ${failed.length} visit(s) without a full reading${empty.length ? `, no data for ${empty.join(" and ")}` : ""}`);
// a picture known wrong (an integrity counter moved) fails the gate too
process.exit(failed.length || empty.length || summary.integrity.length || summary.flicker.length ? 1 : 0);
