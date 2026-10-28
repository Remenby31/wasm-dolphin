#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Display filter in a running game (WebGPU path, presentvsync): for each
// ?fsr= / ?displayfit= / ?ir= combination, boot (or load a savestate), let
// it run, then check the canvas is the display box at the backbuffer's
// aspect, the filter drew the frames shown, and the renderer logged no
// error. --switch then changes the filter while the game runs
// (host.setDisplayFilter) and checks the canvas follows. Grabs the canvas
// (what the player sees) to --out, which must be outside the repo for a
// commercial disc.
//
//   node harness/probes/display-filter-live.mjs --iso disc.iso --port N [--state s.sav --hold KeyX]
//     [--cases "fsr=off,fsr=light,fsr=strong,ir=3&displayfit=1"] [--viewport 1600x1200] [--wait 8]
//     [--switch light,off,strong] [--out dir]
//
// Correctness only, never a speed or GPU-time measurement (no perf lock).
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, loadHarnessState, workerRequest } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { grabFrame, openSession, savePng } from "../lib/session.mjs";
import { displayFilterOutputSize } from "../../src/wgpu-display-filter.js";

const STATE_ROUTE = "**/__harness_state.sav";
const { values: o } = parseArgs({
  options: {
    iso: { type: "string" }, state: { type: "string" }, hold: { type: "string", default: "" },
    port: { type: "string", default: process.env.HARNESS_PORT },
    cases: { type: "string", default: "fsr=off,fsr=light,fsr=strong" },
    viewport: { type: "string", default: "1600x1200" }, wait: { type: "string", default: "8" },
    switch: { type: "string", default: "" }, query: { type: "string", default: "" },
    out: { type: "string" }
  }
});
if (!o.iso || !o.port) throw new Error("usage: display-filter-live.mjs --iso disc.iso --port N [...]");
if (o.out) mkdirSync(o.out, { recursive: true });
const watchdog = setTimeout(() => { console.error("watchdog: 20 min"); process.exit(3); }, 20 * 60_000);
watchdog.unref();

const [vw, vh] = o.viewport.split("x").map(Number);
const server = await ensureServer({ port: o.port });
// "pageaspect=16:9" in a case is the probe's, not the engine's: the engine
// page's aspect selector, set after the boot (a box that differs from the
// backbuffer's aspect).
const engineCase = (c) => c.split("&").filter((kv) => !kv.startsWith("pageaspect=")).join("&");
const query = (c) => `${PRESETS.wgpu}${o.query ? `&${o.query}` : ""}&${engineCase(c)}`;

async function boot(c) {
  const session = await openSession({ base: server.base, server, query: query(c), iso: o.iso, routes: o.state ? { [STATE_ROUTE]: o.state } : {} });
  await session.page.setViewportSize({ width: vw, height: vh });
  if (o.state) {
    const loaded = await loadHarnessState(session.page, session.url);
    if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
  }
  const aspect = /(?:^|&)pageaspect=([0-9:]+)/.exec(c)?.[1];
  if (aspect) await session.page.selectOption("#aspectSelect", aspect);
  if (o.hold) await session.page.keyboard.down(o.hold);
  return session;
}

// What the worker says, and what the canvas should be.
async function inspect(page) {
  const pv = await workerRequest(page, "validationReadPresentVsync", {}, 10000);
  const diag = await workerRequest(page, "rendererDiagnostics", {}, 10000);
  const f = pv?.displayFilter ?? null;
  const [bw, bh] = f?.backbuffer ?? [0, 0];
  const want = f?.active ? displayFilterOutputSize({ width: bw, height: bh }, f.box) : { width: bw, height: bh };
  const sizeOk = Boolean(f?.canvas) && f.canvas[0] === want.width && f.canvas[1] === want.height;
  return { filter: f, expectedCanvas: [want.width, want.height], sizeOk, shown: pv?.shown ?? null, errors: diag?.lastErrors ?? null };
}

// Mean luma of the leftmost and rightmost 2 % of columns.
function edgeLuma(f) {
  const n = Math.max(1, Math.round(f.width * 0.02));
  const mean = (x0) => {
    let s = 0;
    for (let y = 0; y < f.height; y++) for (let x = x0; x < x0 + n; x++) {
      const i = (y * f.width + x) * 4;
      s += 0.299 * f.data[i] + 0.587 * f.data[i + 1] + 0.114 * f.data[i + 2];
    }
    return Math.round(s / (n * f.height));
  };
  return { left: mean(0), right: mean(f.width - n) };
}

const slug = (c) => c.replace(/[^a-z0-9]+/gi, "-");
const results = { viewport: o.viewport, state: o.state ? path.basename(o.state) : null, load: os.loadavg()[0].toFixed(1), cases: [], switch: [] };
let failed = false;
for (const c of o.cases.split(",")) {
  const session = await boot(c);
  try {
    await session.page.waitForTimeout(Number(o.wait) * 1000);
    const rec = { case: c, url: session.url, ...(await inspect(session.page)) };
    const before = rec.filter?.frames ?? 0;
    await session.page.waitForTimeout(1000);
    const after = (await inspect(session.page)).filter?.frames ?? 0;
    rec.filterFramesPerSec = after - before;
    const shown = await grabFrame(session.page);
    rec.grabbed = shown.error ?? [shown.width, shown.height];
    // The picture fills the canvas: neither side's 2 % of columns is black
    // (a pillarboxed 16:9 had ~4.5 % per side).
    if (!shown.error) rec.edges = edgeLuma(shown);
    if (o.out && !shown.error) savePng(shown, path.join(o.out, `${slug(c)}.png`));
    const wantsFilter = /fsr=(light|strong|1|2)|displayfit=1/.test(c);
    // ?widescreen=1 (patch 0178): a 16:9 backbuffer, 480N lines.
    const ir = Number(/(?:^|&)ir=(\d)/.exec(c)?.[1] ?? 1);
    const [bw, bh] = rec.filter?.backbuffer ?? [0, 0];
    rec.edgesOk = !rec.edges || (rec.edges.left > 4 && rec.edges.right > 4);
    rec.backbufferOk = /widescreen=1/.test(c) ? bh === 480 * ir && bw === (Math.floor((2560 * ir + 2) / 3) & ~1) : bh === 480 * ir && bw === 640 * ir;
    rec.ok = rec.sizeOk && rec.backbufferOk && rec.edgesOk && Boolean(rec.filter) && rec.filter.active === wantsFilter &&
      (!wantsFilter || rec.filterFramesPerSec > 0) && !(Array.isArray(rec.errors) && rec.errors.length);
    if (!rec.ok) failed = true;
    results.cases.push(rec);
  } finally {
    await session.close();
  }
}

if (o.switch) {
  const session = await boot("fsr=off");
  try {
    await session.page.waitForTimeout(Number(o.wait) * 1000);
    for (const sharpness of o.switch.split(",")) {
      const applied = await session.page.evaluate((s) => window.__host.setDisplayFilter({ sharpness: s }), sharpness);
      await session.page.waitForTimeout(1500);
      const rec = { sharpness, applied, ...(await inspect(session.page)) };
      rec.ok = rec.sizeOk && rec.filter?.sharpness === sharpness && rec.filter.active === (sharpness !== "off");
      if (!rec.ok) failed = true;
      results.switch.push(rec);
    }
  } finally {
    await session.close();
  }
}

console.log(JSON.stringify({ ok: !failed, ...results }, null, 2));
if (o.out) writeFileSync(path.join(o.out, "display-filter-live.json"), JSON.stringify(results, null, 2));
server.close?.();
process.exit(failed ? 1 : 0);
