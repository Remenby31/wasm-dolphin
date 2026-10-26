#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Cost of the worker's stream capture at each internal resolution (patch
// 0168 follow-ups 4 and 5). For each scale and run: boot (savestate), wait
// --warmup s, attach the worker capture (a MediaStreamTrackProcessor reads
// and closes every frame, as an encoder would), then read streamCaptureStats
// after --secs s: frames, drops, captureMs mean/max, and every size really
// sent (sizes, min/max): a run that sends anything but 640x480 fails.
//
//   node harness/probes/stream-capture-cost.mjs --iso disc.iso --state s.sav --port N
//     [--scales 1,2,4] [--runs 3] [--warmup 20] [--secs 15] [--hold KeyX] [--out dir]
//
// A timing measurement: it takes the perf lock and refuses to run on battery
// (decisions are taken on mains power). Output of a commercial disc goes to
// --out, outside the repo.
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
    warmup: { type: "string", default: "20" }, secs: { type: "string", default: "15" },
    query: { type: "string", default: "" }, out: { type: "string" },
    "allow-battery": { type: "boolean", default: false },
  },
});
if (!o.iso || !o.port) throw new Error("usage: stream-capture-cost.mjs --iso disc.iso --port N [--state s.sav] [...]");

export function powerSource() {
  try {
    return /AC Power/.test(execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" })) ? "ac" : "battery";
  } catch {
    return "unknown";
  }
}

const power = powerSource();
if (power === "battery" && !o["allow-battery"]) {
  console.error("on battery: decisions are measured on mains power (--allow-battery to override)");
  process.exit(3);
}
// Never hold the lock for ever (a hung browser).
const watchdog = setTimeout(() => { console.error("watchdog: 20 min"); process.exit(2); }, 20 * 60 * 1000);
const release = await acquirePerfLock({ name: "Salon · rendu: stream-capture-cost", waitSec: 1800, log: (m) => console.log(`[capture-cost] ${m}`) });
const server = await ensureServer({ port: o.port });
const query = (ir) => `${PRESETS.wgpu}&ir=${ir}${o.query ? `&${o.query}` : ""}`;
const results = { power, load: os.loadavg(), started: new Date().toISOString(), query: query("N"), state: o.state ? path.basename(o.state) : null, runs: [] };
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
        const attached = await session.page.evaluate(() => {
          const track = window.__host.captureVideoTrack();
          if (!track) return false;
          const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
          (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; value.close(); } })();
          return true;
        });
        if (!attached) throw new Error("no worker capture");
        await session.page.waitForTimeout(Number(o.secs) * 1000);
        const { stats: s } = await workerRequest(session.page, "streamCaptureStats", {}, 10000);
        const speed = await session.page.evaluate(() => window.__host.gameSpeed ?? null);
        const rec = {
          run, ir, frames: s.frames, fps: Number((s.frames / Number(o.secs)).toFixed(1)), dropped: s.dropped, errors: s.errors,
          captureMsMean: s.frames ? Number((s.captureMsTotal / s.frames).toFixed(3)) : null, captureMsMax: Number(s.captureMsMax.toFixed(3)),
          sent: [s.minWidth, s.minHeight, s.maxWidth, s.maxHeight], inputMaxWidth: s.inputMaxWidth, sizes: s.sizes, speed,
        };
        const sizes = Object.keys(s.sizes ?? {});
        rec.only640 = sizes.length > 0 && sizes.every((k) => k.endsWith(":640x480"));
        if (!rec.only640 || s.errors) failed = true;
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
  writeFileSync(path.join(o.out, "capture-cost.json"), JSON.stringify(results, null, 1));
}
process.exit(failed ? 1 : 0);
