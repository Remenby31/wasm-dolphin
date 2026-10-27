#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Display filter (src/wgpu-display-filter.js) on a synthetic picture, no
// disc: the WGSL compiles and validates on this GPU, and each pass does what
// it says.
// - EASU: a flat area stays flat, the output stays within its 2x2 input
//   neighbourhood (no ringing), an edge comes out steeper than bilinear;
// - area at 2x: the exact 2x2 box average;
// - RCAS: a flat area stays flat, an edge gains contrast, nothing clips;
// - same size, no sharpness: a plain copy.
// --bench N: GPU time per frame of each plan (N frames each, timestamp
// queries when the adapter offers them, else submitted-work wall time),
// under the perf lock (a timed run on this Mac).
//
//   node harness/probes/display-filter-check.mjs --port N [--bench 300] [--out dir]
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, launchChrome } from "../lib/browser.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { encodePng } from "../lib/png.mjs";

const { values: o } = parseArgs({
  options: {
    port: { type: "string", default: process.env.HARNESS_PORT },
    bench: { type: "string", default: "0" },
    out: { type: "string" }
  }
});
if (!o.port) throw new Error("usage: display-filter-check.mjs --port N [--bench N] [--out dir]");
const watchdog = setTimeout(() => { console.error("watchdog: 10 min"); process.exit(3); }, 10 * 60_000);
watchdog.unref();

const server = await ensureServer({ port: o.port });
const bench = Number(o.bench) || 0;
const lock = bench > 0 ? await acquirePerfLock({ owner: "display-filter-check" }) : null;
const profileDir = path.join(os.tmpdir(), `display-filter-${process.pid}`);
const context = await launchChrome({ profileDir });
let failed = false;
try {
  const page = context.pages()[0] ?? await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.error(`[page] ${m.text()}`); });
  await page.goto(`${server.base}/LICENSE`);
  const result = await page.evaluate(async ({ bench }) => {
    const mod = await import("/src/wgpu-display-filter.js");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    const timestamps = adapter.features.has("timestamp-query");
    const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ["timestamp-query"] : [] });
    const errors = [];
    device.onuncapturederror = (e) => errors.push(String(e.error?.message ?? e.error));
    const format = "bgra8unorm";
    const u = GPUTextureUsage;
    // 640x480 test picture: left half flat grey 128, right half a dark/light
    // vertical edge at x = 400 and a diagonal edge below y = 300.
    const W = 640, H = 480;
    const px = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 128;
      if (x >= 320) v = x < 400 ? 40 : 220;
      if (y >= 300 && x >= 320) v = (x - 320) > (y - 300) ? 40 : 220;
      const i = (y * W + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
    }
    const src = device.createTexture({ size: [W, H], format, usage: u.TEXTURE_BINDING | u.COPY_DST | u.RENDER_ATTACHMENT | u.COPY_SRC });
    device.queue.writeTexture({ texture: src }, px, { bytesPerRow: W * 4 }, [W, H]);
    const filter = mod.createDisplayFilter(device, format);
    const read = async (tex) => {
      const bpr = Math.ceil(tex.width * 4 / 256) * 256;
      const buf = device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
      device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const raw = new Uint8Array(buf.getMappedRange());
      const out = new Uint8Array(tex.width * tex.height * 4);
      for (let y = 0; y < tex.height; y++) {
        for (let x = 0; x < tex.width; x++) {
          const s = y * bpr + x * 4, d = (y * tex.width + x) * 4;
          out[d] = raw[s + 2]; out[d + 1] = raw[s + 1]; out[d + 2] = raw[s]; out[d + 3] = 255;  // BGRA → RGBA
        }
      }
      buf.unmap();
      buf.destroy();
      return { width: tex.width, height: tex.height, data: out };
    };
    const run = async (w, h, sharpness) => {
      const dst = device.createTexture({ size: [w, h], format, usage: u.RENDER_ATTACHMENT | u.COPY_SRC | u.COPY_DST });
      const enc = device.createCommandEncoder();
      const plan = filter.encode(enc, src, dst, sharpness);
      device.queue.submit([enc.finish()]);
      const frame = await read(dst);
      dst.destroy();
      return { plan, frame };
    };
    const at = (f, x, y) => f.data[(y * f.width + x) * 4];
    const checks = {};
    const frames = {};
    // Same size, off: a copy.
    {
      const { plan, frame } = await run(W, H, "off");
      let diff = 0;
      for (let i = 0; i < px.length; i += 4) diff = Math.max(diff, Math.abs(frame.data[i] - px[i]));
      checks.copy = { plan, maxDiff: diff, ok: diff === 0 && !plan.scale && plan.rcas === null };
    }
    // EASU 2x, no sharpening.
    {
      const { plan, frame } = await run(1280, 960, "off");
      frames.easu2x = frame;
      let flatMax = 0;
      for (let y = 20; y < 580; y++) for (let x = 20; x < 600; x++) flatMax = Math.max(flatMax, Math.abs(at(frame, x, y) - 128));
      let outOfRange = 0;
      for (let y = 0; y < 960; y++) for (let x = 0; x < 1280; x++) {
        const v = at(frame, x, y);
        if (v < 39 || v > 221) outOfRange += 1;
      }
      // Edge at source x = 400 → output x = 800: the 10-90 % rise width, in
      // output pixels (bilinear: ~2).
      const row = 200;
      let lo = null, hi = null;
      for (let x = 780; x < 820; x++) {
        const v = at(frame, x, row);
        if (lo === null && v > 40 + 18) lo = x;
        if (hi === null && v > 220 - 18) hi = x;
      }
      checks.easu = { plan, flatMax, outOfRange, riseWidth: hi - lo, ok: plan.scale === "easu" && flatMax <= 1 && outOfRange === 0 && hi - lo <= 2 };
    }
    // Area 0.5x: exact 2x2 average.
    {
      const { plan, frame } = await run(320, 240, "off");
      let maxDiff = 0;
      for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
        let s = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) s += px[((2 * y + dy) * W + 2 * x + dx) * 4];
        maxDiff = Math.max(maxDiff, Math.abs(at(frame, x, y) - s / 4));
      }
      checks.area = { plan, maxDiff, ok: plan.scale === "area" && maxDiff <= 1 };
    }
    // RCAS strong at the same size.
    {
      const { plan, frame } = await run(W, H, "strong");
      frames.rcas = frame;
      let flatMax = 0;
      for (let y = 10; y < 290; y++) for (let x = 10; x < 310; x++) flatMax = Math.max(flatMax, Math.abs(at(frame, x, y) - 128));
      // Next to the edge (x = 399 dark, 400 light): darker / lighter.
      const dark = at(frame, 399, 100), light = at(frame, 400, 100);
      checks.rcas = { plan, flatMax, dark, light, ok: plan.rcas !== null && !plan.scale && flatMax <= 1 && dark < 40 && light > 220 };
    }
    // EASU + RCAS light, 3x.
    {
      const { plan, frame } = await run(1920, 1440, "light");
      frames.easuRcas3x = frame;
      checks.easuRcas = { plan, ok: plan.scale === "easu" && plan.rcas !== null };
    }
    let timing = null;
    if (bench > 0) {
      timing = { method: timestamps ? "timestamp-query" : "submitted-work" };
      const cases = [
        ["copy 1920x1440", 1920, 1440, "off", 1920, 1440],
        ["rcas 1920x1440", 1920, 1440, "light", 1920, 1440],
        ["easu 640x480→2560x1920", 2560, 1920, "off", 640, 480],
        ["easu+rcas 640x480→2560x1920", 2560, 1920, "light", 640, 480],
        ["easu+rcas 640x480→1920x1440", 1920, 1440, "light", 640, 480],
        ["easu+rcas 1280x960→2560x1920", 2560, 1920, "light", 1280, 960],
        ["area 2560x1920→1280x960", 1280, 960, "off", 2560, 1920],
        ["area+rcas 1920x1440→1280x960", 1280, 960, "light", 1920, 1440]
      ];
      for (const [name, w, h, sharpness, sw, sh] of cases) {
        const s = device.createTexture({ size: [sw, sh], format, usage: u.TEXTURE_BINDING | u.RENDER_ATTACHMENT | u.COPY_SRC });
        const dst = device.createTexture({ size: [w, h], format, usage: u.RENDER_ATTACHMENT | u.COPY_SRC | u.COPY_DST });
        const qs = timestamps ? device.createQuerySet({ type: "timestamp", count: 2 }) : null;
        const resolve = qs ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
        const samples = [];
        for (let i = 0; i < bench; i++) {
          const enc = device.createCommandEncoder();
          // Bracket the filter between two empty passes carrying the timestamps.
          if (qs) enc.beginRenderPass({ colorAttachments: [{ view: dst.createView(), loadOp: "load", storeOp: "store" }], timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0 } }).end();
          const t0 = performance.now();
          filter.encode(enc, s, dst, sharpness);
          if (qs) {
            enc.beginRenderPass({ colorAttachments: [{ view: dst.createView(), loadOp: "load", storeOp: "store" }], timestampWrites: { querySet: qs, endOfPassWriteIndex: 1 } }).end();
            const rb = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            enc.resolveQuerySet(qs, 0, 2, resolve, 0);
            enc.copyBufferToBuffer(resolve, 0, rb, 0, 16);
            device.queue.submit([enc.finish()]);
            await rb.mapAsync(GPUMapMode.READ);
            const t = new BigUint64Array(rb.getMappedRange());
            samples.push(Number(t[1] - t[0]) / 1e6);
            rb.unmap();
            rb.destroy();
          } else {
            device.queue.submit([enc.finish()]);
            await device.queue.onSubmittedWorkDone();
            samples.push(performance.now() - t0);
          }
        }
        samples.sort((a, b) => a - b);
        const q = (p) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
        timing[name] = { medianMs: Number(q(0.5).toFixed(3)), p90Ms: Number(q(0.9).toFixed(3)) };
        s.destroy(); dst.destroy(); qs?.destroy(); resolve?.destroy();
      }
    }
    await device.queue.onSubmittedWorkDone();
    const pack = (f) => f ? { width: f.width, height: f.height, data: Array.from(f.data) } : null;
    return {
      adapter: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture },
      errors, checks, timing,
      frames: Object.fromEntries(Object.entries(frames).map(([k, f]) => [k, pack(f)]))
    };
  }, { bench });
  const { frames, ...report } = result;
  if (o.out) {
    mkdirSync(o.out, { recursive: true });
    for (const [name, f] of Object.entries(frames)) {
      writeFileSync(path.join(o.out, `${name}.png`), encodePng({ width: f.width, height: f.height, data: Uint8Array.from(f.data) }));
    }
  }
  failed = report.errors.length > 0 || Object.values(report.checks).some((c) => !c.ok);
  console.log(JSON.stringify({ ok: !failed, load: os.loadavg()[0].toFixed(1), ...report }, null, 2));
} finally {
  await context.close().catch(() => {});
  await lock?.release?.();
  server.close?.();
}
process.exit(failed ? 1 : 0);
