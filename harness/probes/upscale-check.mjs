#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Internal resolution on the WebGPU path (patch 0168): does the frame come
// out N times larger and still the same picture? For each scale, boot the
// disc (or load a savestate), capture the XFB the core scans out at a fixed
// VI output (cpu=single: the same frame in every run), and compare it,
// box-downsampled to native, with the 1x capture: a shifted, cropped or
// broken frame shows up as a large difference or a best match away from
// (0, 0). --switch then changes the scale while the game runs
// (setEnhancements) and checks the canvas and the frame follow.
//
//   node harness/probes/upscale-check.mjs --iso disc.iso --port N [--state s.sav --hold KeyX]
//     [--scales 1,2,4] [--query "efbcopyram=1"] [--vi 240] [--switch 2,4,1] [--out dir]
//
// Correctness only, never a speed or GPU-time measurement (no perf lock).
// Captures of a commercial disc go to --out, which must be outside the repo.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, loadHarnessState, workerRequest } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { captureAtVi, grabFrame, openSession, savePng } from "../lib/session.mjs";

const STATE_ROUTE = "**/__harness_state.sav";
const { values: o } = parseArgs({
  options: {
    iso: { type: "string" }, state: { type: "string" }, hold: { type: "string", default: "" },
    port: { type: "string", default: process.env.HARNESS_PORT },
    scales: { type: "string", default: "1,2,4" }, query: { type: "string", default: "" },
    vi: { type: "string", default: "240" }, switch: { type: "string", default: "" },
    "switch-wait": { type: "string", default: "3" }, out: { type: "string" },
    "max-diff": { type: "string", default: "6" },
  },
});
if (!o.iso || !o.port) throw new Error("usage: upscale-check.mjs --iso disc.iso --port N [...]");
if (o.out) mkdirSync(o.out, { recursive: true });

const scales = o.scales.split(",").map(Number);
const vi = Number(o.vi);
const server = await ensureServer({ port: o.port });
const query = (ir) => `${PRESETS.wgpu.replace("cpu=dual", "cpu=single")}&ir=${ir}${o.query ? `&${o.query}` : ""}`;

// Box filter of an RGBA frame by an integer factor.
export function downsample(frame, n) {
  if (n === 1) return frame;
  const w = Math.floor(frame.width / n), h = Math.floor(frame.height / n);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) s += frame.data[((y * n + dy) * frame.width + x * n + dx) * 4 + c];
    data[(y * w + x) * 4 + c] = Math.round(s / (n * n));
  }
  return { width: w, height: h, data };
}

// Mean absolute RGB difference at the best offset within ±2 pixels.
export function compare(a, b) {
  let best = null;
  for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
    let s = 0, n = 0;
    for (let y = 2; y < Math.min(a.height, b.height) - 2; y++) for (let x = 2; x < Math.min(a.width, b.width) - 2; x++) {
      const i = (y * a.width + x) * 4, j = ((y + oy) * b.width + x + ox) * 4;
      s += Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]);
      n += 3;
    }
    const d = s / n;
    if (!best || d < best.meanAbs) best = { meanAbs: Number(d.toFixed(2)), dx: ox, dy: oy };
  }
  return best;
}

async function boot(ir) {
  const session = await openSession({ base: server.base, server, query: query(ir), iso: o.iso, routes: o.state ? { [STATE_ROUTE]: o.state } : {} });
  if (o.state) {
    const loaded = await loadHarnessState(session.page, session.url);
    if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
  }
  if (o.hold) await session.page.keyboard.down(o.hold);
  return session;
}

const rendererErrors = async (page) => {
  const d = await workerRequest(page, "rendererDiagnostics", {}, 10000);
  return { errors: d?.rendererErrors ?? d?.errors ?? null, canvas: d?.canvas ?? null };
};

const results = { query: query("N"), state: o.state ? path.basename(o.state) : null, vi, scales: [], switch: [] };
const frames = new Map();
let failed = false;
for (const ir of scales) {
  const session = await boot(ir);
  try {
    const frame = await captureAtVi(session.page, { index: vi, fromLoad: Boolean(o.state), timeoutMs: 120000 });
    const shown = await grabFrame(session.page);
    const rec = { ir, url: session.url };
    if (frame.error) { rec.error = frame.error; failed = true; } else {
      rec.frame = [frame.width, frame.height];
      frames.set(ir, frame);
      if (o.out) savePng(frame, path.join(o.out, `ir${ir}-vi${vi}.png`));
    }
    rec.canvas = shown.error ? shown.error : [shown.width, shown.height];
    rec.diagnostics = await rendererErrors(session.page);
    results.scales.push(rec);
  } finally {
    await session.close();
  }
}
const base = frames.get(1);
for (const rec of results.scales) {
  const frame = frames.get(rec.ir);
  if (!frame || !base) continue;
  rec.sizeOk = frame.width === base.width * rec.ir && frame.height === base.height * rec.ir;
  rec.vsNative = compare(base, downsample(frame, rec.ir));
  if (!rec.sizeOk || rec.vsNative.meanAbs > Number(o["max-diff"]) || rec.vsNative.dx || rec.vsNative.dy) failed = true;
}

if (o.switch) {
  const session = await boot(1);
  try {
    await session.page.waitForTimeout(3000);
    for (const ir of o.switch.split(",").map(Number)) {
      const applied = await session.page.evaluate((n) => window.__host.setEnhancements({ internalResolution: n }), ir);
      await session.page.waitForTimeout(Number(o["switch-wait"]) * 1000);
      const frame = await captureAtVi(session.page, { ahead: 10, timeoutMs: 60000 });
      const shown = await grabFrame(session.page);
      const rec = { ir, applied, frame: frame.error ?? [frame.width, frame.height], canvas: shown.error ?? [shown.width, shown.height] };
      if (!frame.error && base) {
        rec.sizeOk = frame.width === base.width * ir && frame.height === base.height * ir;
        if (!rec.sizeOk) failed = true;
      }
      if (shown.error || shown.width !== 640 * ir || shown.height !== 480 * ir) failed = true;
      if (o.out && !frame.error) savePng(frame, path.join(o.out, `switch-ir${ir}.png`));
      results.switch.push(rec);
    }
    results.switchDiagnostics = await rendererErrors(session.page);
  } finally {
    await session.close();
  }
}

console.log(JSON.stringify(results, null, 1));
if (o.out) writeFileSync(path.join(o.out, "upscale-check.json"), JSON.stringify(results, null, 1));
process.exit(failed ? 1 : 0);
