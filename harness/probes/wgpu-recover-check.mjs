#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// ?wgpurecover=1 (docs/wgpu-session-fallback.md): lose the WebGPU device
// (harness hook) in a running game, check the host pauses the core and hands
// the page a save state, then boot that state again on each --resume video
// path (a new WebGPU device at 1x, the software renderer) and check the game
// goes on from there. --control also loses the device without the switch, to
// see what the core does today (does it keep running blind?).
//
//   node harness/probes/wgpu-recover-check.mjs --iso disc.iso --port N
//     [--state s.sav --hold KeyX] [--ir 2] [--resume wgpu,software] [--control] [--out dir]
//
// Correctness only, never a speed measurement (no perf lock): the times it
// prints are wall clock under whatever load the machine has. Captures and
// the saved state of a commercial disc go to --out, outside the repo.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, loadHarnessState, readCoreProgress, workerRequest } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { captureAtVi, openSession, savePng } from "../lib/session.mjs";

const STATE_ROUTE = "**/__harness_state.sav";
const { values: o } = parseArgs({
  options: {
    iso: { type: "string" }, state: { type: "string" }, hold: { type: "string", default: "" },
    port: { type: "string", default: process.env.HARNESS_PORT }, ir: { type: "string", default: "2" },
    resume: { type: "string", default: "wgpu,software" }, control: { type: "boolean", default: false },
    settle: { type: "string", default: "5" }, out: { type: "string" },
  },
});
if (!o.iso || !o.port) throw new Error("usage: wgpu-recover-check.mjs --iso disc.iso --port N [...]");
const out = o.out ?? mkdtempSync(path.join(os.tmpdir(), "wgpu-recover-"));
mkdirSync(out, { recursive: true });
// A probe must end, whatever hangs (Chrome, a worker that never answers).
const watchdog = setTimeout(() => { console.error("watchdog: 15 min"); process.exit(2); }, 15 * 60_000);

const server = await ensureServer({ port: o.port });
const RESUME_QUERY = {
  wgpu: `${PRESETS.wgpu}&ir=1`,
  software: PRESETS.rec,
};

async function boot(query, state) {
  const session = await openSession({ base: server.base, server, query, iso: o.iso, routes: state ? { [STATE_ROUTE]: state } : {} });
  if (state) {
    const loaded = await loadHarnessState(session.page, session.url);
    if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
  }
  if (o.hold) await session.page.keyboard.down(o.hold);
  return session;
}

// Core frames over `ms`: does the game advance?
async function progressOver(page, ms) {
  const a = await readCoreProgress(page);
  await page.waitForTimeout(ms);
  const b = await readCoreProgress(page);
  return { frames: (b?.frame ?? 0) - (a?.frame ?? 0), ticks: Number(b?.coreTicks ?? 0) - Number(a?.coreTicks ?? 0) };
}

async function shot(page, name) {
  const frame = await captureAtVi(page, { ahead: 10, timeoutMs: 60000 });
  if (frame.error) return { error: frame.error };
  savePng(frame, path.join(out, `${name}.png`));
  return { size: [frame.width, frame.height], png: `${name}.png` };
}

const results = { ir: Number(o.ir), state: o.state ? path.basename(o.state) : null, out };
let failed = false;

if (o.control) {
  const session = await boot(`${PRESETS.wgpu}&ir=${o.ir}`, o.state);
  try {
    await session.page.waitForTimeout(Number(o.settle) * 1000);
    const lose = await workerRequest(session.page, "validationLoseWebGpuDevice", {}, 10000);
    await session.page.waitForTimeout(500);
    results.control = { lose, afterLoss: await progressOver(session.page, 3000) };
    // Can a state still be written after the loss, without pausing?
    const t0 = Date.now();
    const saved = await session.page.evaluate(async () => {
      try {
        const r = await window.__host.adapter.exportSaveState({ slot: 0 });
        return { bytes: r.bytes.byteLength };
      } catch (e) {
        return { error: String(e?.message || e) };
      }
    });
    results.control.saveAfterLoss = { ...saved, ms: Date.now() - t0 };
  } finally {
    await session.close();
  }
}

const session = await boot(`${PRESETS.wgpu}&ir=${o.ir}&wgpurecover=1`, o.state);
let statePath = null;
try {
  await session.page.waitForTimeout(Number(o.settle) * 1000);
  results.before = await shot(session.page, `before-ir${o.ir}`);
  await session.page.evaluate(() => {
    window.__host.onGpuDeviceLost = (event) => {
      const { state, ...rest } = event;
      let b64 = "";
      if (state) {
        const u8 = new Uint8Array(state);
        let bin = "";
        for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        b64 = btoa(bin);
      }
      window.__wgpuLost = { ...rest, stateBytes: state?.byteLength ?? 0, b64, at: performance.now() };
    };
  });
  const lostAt = await session.page.evaluate(() => performance.now());
  const lose = await workerRequest(session.page, "validationLoseWebGpuDevice", {}, 10000);
  await session.page.waitForFunction(() => window.__wgpuLost, null, { timeout: 60000 });
  const event = await session.page.evaluate(() => window.__wgpuLost);
  const { b64, at, ...rest } = event;
  results.lost = { lose, event: rest, eventAfterMs: Math.round(at - lostAt), afterEvent: await progressOver(session.page, 2000) };
  if (!rest.paused || !rest.stateBytes) failed = true;
  if (results.lost.afterEvent.frames !== 0) failed = true;
  if (b64) {
    statePath = path.join(out, "after-loss.sav");
    writeFileSync(statePath, Buffer.from(b64, "base64"));
  }
} finally {
  await session.close();
}

results.resume = [];
for (const name of statePath ? o.resume.split(",") : []) {
  const rec = { video: name };
  let resumed = null;
  try {
    resumed = await boot(RESUME_QUERY[name], statePath);
    rec.loaded = true;
    rec.progress = await progressOver(resumed.page, 3000);
    rec.shot = await shot(resumed.page, `resumed-${name}`);
    const d = await workerRequest(resumed.page, "rendererDiagnostics", {}, 10000);
    rec.rendererErrors = d?.rendererErrors ?? d?.errors ?? null;
    if (!(rec.progress.frames > 0) || rec.shot.error) failed = true;
  } catch (error) {
    rec.error = String(error?.message || error);
    failed = true;
  } finally {
    await resumed?.close();
  }
  results.resume.push(rec);
}

console.log(JSON.stringify(results, null, 1));
writeFileSync(path.join(out, "wgpu-recover-check.json"), JSON.stringify(results, null, 1));
clearTimeout(watchdog);
process.exit(failed ? 1 : 0);
