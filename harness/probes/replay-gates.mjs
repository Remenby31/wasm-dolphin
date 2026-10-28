// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Input and picture gates of a presentation change (first: ?wgpureplayms=4
// by default, 2026-10-28), base and candidate interleaved in ABBA blocks,
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
//     --query "<base query>" --extra "&wgpureplayms=4" [--runs 4 (visits per side, even)] [--vi 240,600]
//     [--candidate <dir to serve>] [--lock-wait 14400]
// One tree serves both sides (only --extra differs): no --baseline.
// Exit 1 when a visit failed or a side has no picture or no input reading.
// Holds the perf lock (HARNESS_PERF_LOCK); a watchdog after it; always exits.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ensureServer, loadHarnessState, captureAtVi } from "../lib/browser.mjs";
import { openSession } from "../lib/session.mjs";
import { setPad } from "../lib/gamepad-mock.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";

const { values: o } = parseArgs({ options: {
  iso: { type: "string" }, state: { type: "string" }, port: { type: "string" }, out: { type: "string" },
  query: { type: "string" }, extra: { type: "string" }, runs: { type: "string", default: "4" }, vi: { type: "string", default: "240,600" },
  candidate: { type: "string" }, "lock-wait": { type: "string", default: "14400" }
}, strict: true });
for (const k of ["iso", "state", "port", "out", "query", "extra"]) if (!o[k]) throw new Error(`--${k} is required`);
if (existsSync(o.out)) throw new Error(`${o.out} exists`);
const root = path.resolve(o.candidate ?? path.join(import.meta.dirname, "..", ".."));
const perSide = Math.max(2, Number(o.runs) + (Number(o.runs) % 2));
const VIS = o.vi.split(",").map(Number).filter((n) => n > 0);
const log = (m) => console.log(`[gates] ${m}`);
const order = [];
for (let b = 0; b < perSide / 2; b += 1) order.push(...(b % 2 ? ["candidate", "base", "base", "candidate"] : ["base", "candidate", "candidate", "base"]).slice(0, 4));
const release = await acquirePerfLock({ name: `replay-gates ${o.extra}`, waitSec: Number(o["lock-wait"]), log });
const watchdog = setTimeout(() => { console.error("watchdog: 60 min under the lock"); release(); process.exit(2); }, 60 * 60 * 1000);
const server = await ensureServer({ port: Number(o.port), root });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const visits = [];
try {
  for (const [n, side] of order.entries()) {
    const query = `${o.query}&inputlatency=1&metrics=1${side === "candidate" ? o.extra : ""}`;
    const session = await openSession({ base: server.base, server, query, iso: o.iso, gamepads: { connected: 1 }, routes: { "**/__harness_state.sav": o.state } });
    const v = { n, side, frames: {}, input: null };
    try {
      const loaded = await loadHarnessState(session.page, session.url);
      if (!loaded?.loaded) throw new Error(`savestate not loaded: ${JSON.stringify(loaded)}`);
      for (const index of VIS) {
        const f = await captureAtVi(session.page, { index, fromLoad: true, timeoutMs: 60000 });
        v.frames[index] = f.error ? { error: f.error } : { width: f.width, height: f.height, b64: Buffer.from(f.data).toString("base64") };
      }
      await sleep(5000);
      for (const t0 = Date.now(); Date.now() - t0 < 24000;) {
        await setPad(session.page, 0, { pressed: ["A"] });
        await sleep(34);
        await setPad(session.page, 0, {});
        await sleep(366);
      }
      await sleep(1000);
      v.input = await session.page.evaluate(() => window.__causalTelemetry?.input?.visible ?? null);
    } catch (e) {
      v.error = String(e?.message || e);
    } finally {
      await session.close();
    }
    const i = v.input;
    log(`visit ${n} ${side}: ${v.error ?? `frames ${VIS.map((x) => (v.frames[x]?.error ? "err" : "ok")).join("/")}, input ${i ? `${i.visibleCount} seen, p95 ${Math.round(i.visibleAgeP95Ms)} ms, max ${Math.round(i.visibleAgeMaxMs)} ms` : "none"}`}`);
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
const summary = { probe: "replay-gates", extra: o.extra, order, picture: {}, input: {} };
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
writeFileSync(path.join(o.out, "visits.json"), JSON.stringify(visits.map(({ frames, ...v }) => v), null, 1) + "\n");
// a gate that measured nothing never passes
// __causalTelemetry.input.visible is never null (without the tracker it is
// {enabled: false, visibleCount: 0}): a visit counts only with presses seen
const failed = visits.filter((v) => v.error || !v.input?.enabled || !v.input.visibleCount || VIS.some((i) => !v.frames[i]?.b64));
const empty = ["base", "candidate"].filter((side) => !summary.input[side].visits || !summary.input[side].presses || VIS.some((i) => !summary.picture[i][side === "base" ? "baseVsBase" : "candidateVsBase"].length));
if (failed.length || empty.length) log(`FAILED: ${failed.length} visit(s) without a full reading${empty.length ? `, no data for ${empty.join(" and ")}` : ""}`);
process.exit(failed.length || empty.length ? 1 : 0);
