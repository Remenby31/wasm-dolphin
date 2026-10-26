#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Savestates at each internal resolution (patch 0168 follow-up 3): states
// hold the EFB, which grows with N², inside a 1.5 GiB wasm heap. For each
// scale and run: boot (savestate), wait --warmup s, save (size, time until
// the file stopped growing, heap after), load the bytes back (round-trip
// time, heap after), then check the game still runs (frames advance).
//
//   node harness/probes/savestate-scale.mjs --iso disc.iso --state s.sav --port N
//     [--scales 1,2,4] [--runs 3] [--warmup 15] [--hold KeyX] [--out dir]
//
// Times are measured: it takes the perf lock and refuses battery power.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, loadHarnessState, workerRequest } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { openSession } from "../lib/session.mjs";

const STATE_ROUTE = "**/__harness_state.sav";
const { values: o } = parseArgs({
  options: {
    iso: { type: "string" }, state: { type: "string" }, hold: { type: "string", default: "" },
    port: { type: "string", default: process.env.HARNESS_PORT },
    scales: { type: "string", default: "1,2,4" }, runs: { type: "string", default: "3" },
    warmup: { type: "string", default: "15" }, query: { type: "string", default: "" }, out: { type: "string" },
    "allow-battery": { type: "boolean", default: false },
  },
});
if (!o.iso || !o.port) throw new Error("usage: savestate-scale.mjs --iso disc.iso --port N [--state s.sav] [...]");

const ac = (() => {
  try { return /AC Power/.test(execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" })); } catch { return false; }
})();
if (!ac && !o["allow-battery"]) {
  console.error("not on mains power: decisions are measured on mains power (--allow-battery to override)");
  process.exit(3);
}
const release = await acquirePerfLock({ name: "Salon · rendu: savestate-scale", waitSec: 1800, log: (m) => console.log(`[savestate-scale] ${m}`) });
// Never hold the lock for ever (a hung browser): counted from the lock, not
// from the wait for it.
const watchdog = setTimeout(() => { console.error("watchdog: 20 min under the lock"); release(); process.exit(2); }, 20 * 60 * 1000);
const server = await ensureServer({ port: o.port });
const query = (ir) => `${PRESETS.wgpu}&ir=${ir}${o.query ? `&${o.query}` : ""}`;
const frame = (page) => page.evaluate(() => window.__host.frame ?? 0);
const results = { power: ac ? "ac" : "battery", load: os.loadavg(), started: new Date().toISOString(), query: query("N"), state: o.state ? path.basename(o.state) : null, runs: [] };
let failed = false;
try {
  for (let run = 0; run < Number(o.runs); run += 1) {
    for (const ir of o.scales.split(",").map(Number)) {
      const session = await openSession({ base: server.base, server, query: query(ir), iso: o.iso, routes: o.state ? { [STATE_ROUTE]: o.state } : {} });
      try {
        if (o.state) {
          const loaded = await loadHarnessState(session.page, session.url);
          if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
        }
        if (o.hold) await session.page.keyboard.down(o.hold);
        await session.page.waitForTimeout(Number(o.warmup) * 1000);
        // The bytes stay in the page: only sizes and times come back.
        const r = await session.page.evaluate(async () => {
          const req = (type, payload) => window.__host.adapter.request(type, payload);
          const save = await req("saveStateFile", {});
          if (!save?.saved) return { save: { saved: false, error: save?.error ?? null } };
          const t0 = performance.now();
          const load = await req("loadStateFile", { bytes: save.bytes });
          const loadMs = performance.now() - t0;
          return {
            save: { saved: true, size: save.size, elapsedMs: save.elapsedMs, heapBytes: save.heapBytes },
            load: { loaded: Boolean(load?.loaded), ms: Math.round(loadMs) },
          };
        });
        const f0 = await frame(session.page);
        await session.page.waitForTimeout(3000);
        const f1 = await frame(session.page);
        const layout = await workerRequest(session.page, "rendererDiagnostics", {}, 10000).catch(() => null);
        const rec = { run, ir, ...r, runsAfter: f1 > f0, framesAfter: f1 - f0, renderer: layout?.activePresenterBackend ?? null };
        if (!r.save?.saved || !r.load?.loaded || !(f1 > f0)) failed = true;
        console.log(JSON.stringify(rec));
        results.runs.push(rec);
      } finally {
        await session.close();
      }
    }
  }
} finally {
  release();
  clearTimeout(watchdog);
}
results.loadAfter = os.loadavg();
if (o.out) {
  mkdirSync(o.out, { recursive: true });
  writeFileSync(path.join(o.out, "savestate-scale.json"), JSON.stringify(results, null, 1));
}
process.exit(failed ? 1 : 0);
