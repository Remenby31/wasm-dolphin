#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// GPU cost of the presentation upscalers of src/wgpu-upscale-study.js,
// alone: a headless Chrome page filters a synthetic frame (edges, gradients,
// noise) from each source size to each output size, many times, and reads
// the passes' timestamp queries. Run it with
// HARNESS_CHROME_ARGS=--enable-webgpu-developer-features for timestamps at
// full precision (Chrome rounds them to 100 µs otherwise).
//
//   node harness/probes/upscale-filter-bench.mjs [--port 8094] [--iters 300] [--out file.json]
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { launchChrome, REPO_ROOT } from "../lib/browser.mjs";

const { values } = parseArgs({ options: {
  port: { type: "string", default: "8094" }, iters: { type: "string", default: "300" }, out: { type: "string" }
} });
const origin = `http://127.0.0.1:${values.port}`;
const CASES = [
  // [source w, h, output w, h]: 640x480 to 2x / 3x, and a 2x frame to 3x of native.
  [640, 480, 1280, 960], [640, 480, 1920, 1440], [1280, 960, 1920, 1440], [640, 480, 2560, 1440]
];

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import { createPostUpscaler } from "/src/wgpu-upscale-study.js";
window.bench = async ({ cases, iters }) => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  const device = await adapter.requestDevice({ requiredFeatures: ["timestamp-query"] });
  const format = navigator.gpu.getPreferredCanvasFormat();
  const out = [];
  for (const [sw, sh, ow, oh] of cases) {
    // A synthetic frame: diagonal edges, a gradient, some noise.
    const px = new Uint8Array(sw * sh * 4);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4, edge = ((x + 2 * y) >> 5) & 1, n = (x * 73856093 ^ y * 19349663) & 31;
      px[i] = edge ? 220 : 30; px[i + 1] = (x * 255 / sw) | 0; px[i + 2] = (y * 255 / sh + n) & 255; px[i + 3] = 255;
    }
    const target = device.createTexture({ size: [ow, oh], format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const targetView = target.createView();
    const row = [];
    for (const filter of ["bilinear", "easu"]) {
      const up = createPostUpscaler(device, format, { srcW: sw, srcH: sh, outW: ow, outH: oh, filter, sharpness: 0.2 });
      // Its source is bgra/rgba like the canvas: write the frame through a staging rgba texture.
      const tmp = device.createTexture({ size: [sw, sh], format: "rgba8unorm", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
      device.queue.writeTexture({ texture: tmp }, px, { bytesPerRow: sw * 4 }, [sw, sh]);
      const src = createPostUpscaler(device, format, { srcW: sw, srcH: sh, outW: sw, outH: sh, filter: "bilinear", sharpness: 0, externalSource: tmp.createView() });
      { const e = device.createCommandEncoder(); src.encode(e, up.sourceView); device.queue.submit([e.finish()]); }
      // Batches of BATCH back-to-back filters in one submit, so the GPU
      // stays busy (and clocked up) as it is in a game; each filter's passes
      // are timed on their own.
      const BATCH = 30, perIter = filter === "easu" ? 2 : 1, n = BATCH * perIter * 2;
      const qs = device.createQuerySet({ type: "timestamp", count: n });
      const res = device.createBuffer({ size: n * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      const ms = [];
      for (let it = 0; it < iters; it += BATCH) {
        let k = 0;
        const timer = { wrap(desc) { desc.timestampWrites = { querySet: qs, beginningOfPassWriteIndex: k * 2, endOfPassWriteIndex: k * 2 + 1 }; k++; } };
        const e = device.createCommandEncoder();
        for (let b = 0; b < BATCH; b++) up.encode(e, targetView, timer);
        e.resolveQuerySet(qs, 0, n, res, 0);
        const rb = device.createBuffer({ size: n * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        e.copyBufferToBuffer(res, 0, rb, 0, n * 8);
        device.queue.submit([e.finish()]);
        await rb.mapAsync(GPUMapMode.READ);
        const t = new BigInt64Array(rb.getMappedRange());
        // Throughput: first pass begin to last pass end, over the batch
        // (passes of one submit overlap on a tiler; their sum would count
        // the overlap as work).
        if (it > 0) ms.push(Number(t[n - 1] - t[0]) / 1e6 / BATCH);
        rb.unmap(); rb.destroy();
      }
      ms.sort((a, b) => a - b);
      row.push({ filter, p50: ms[ms.length >> 1], p10: ms[(ms.length * 0.1) | 0], p90: ms[(ms.length * 0.9) | 0] });
    }
    out.push({ source: [sw, sh], output: [ow, oh], filters: row });
  }
  const info = adapter.info || {};
  return { adapter: { vendor: info.vendor, architecture: info.architecture, description: info.description }, out };
};
window.ready = true;
</script>`;

const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-upscale-bench-"));
const context = await launchChrome({ profileDir });
try {
  await context.assertInvisible("after launch");
  const page = context.pages()[0] ?? await context.newPage();
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: PAGE });
    if (url.pathname === "/src/wgpu-upscale-study.js") {
      return route.fulfill({ contentType: "text/javascript", body: readFileSync(path.join(REPO_ROOT, "src", "wgpu-upscale-study.js")) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text()); });
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  const result = await page.evaluate((a) => window.bench(a), { cases: CASES, iters: Number(values.iters) });
  result.load1 = os.loadavg()[0];
  result.chromeArgs = process.env.HARNESS_CHROME_ARGS ?? "";
  result.warnings = errors.slice(0, 20);
  console.log(JSON.stringify(result, null, 1));
  if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 1) + "\n");
} finally {
  await context.close().catch(() => {});
  rmSync(profileDir, { recursive: true, force: true });
}
