#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// What WebGPU this Chrome gives a page: navigator.gpu, requestAdapter(),
// the adapter's info and features, and whether a device can be created.
// Also its WebGL, in the page and in a worker's OffscreenCanvas (where the
// software presenter runs): context or none, and the unmasked renderer
// (SwiftShader, WARP through ANGLE, a real GPU).
// Headless, no disc. Used by the Windows workflow: with --no-unsafe-webgpu,
// what a player's Chrome gets on a GPU-less PC; with the harness default
// (--enable-unsafe-webgpu), the fallback adapter it allows (SwiftShader on
// the GitHub runner, never WARP).
//
//   node harness/probes/webgpu-adapter.mjs --port N [--expect adapter|none] [--out file.json]
//     [--no-unsafe-webgpu]   (the harness passes --enable-unsafe-webgpu by default:
//                            without it, Chrome as a player has it)
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { ensureServer, launchChrome } from "../lib/browser.mjs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.HARNESS_PORT }, expect: { type: "string" }, out: { type: "string" },
    "no-unsafe-webgpu": { type: "boolean", default: false },
  },
});
if (!values.port) throw new Error("usage: webgpu-adapter.mjs --port N [--expect adapter|none]");

const server = await ensureServer({ port: values.port });
const unsafeWebgpu = !values["no-unsafe-webgpu"];
const context = await launchChrome({ profileDir: mkdtempSync(path.join(os.tmpdir(), "gc-adapter-")), unsafeWebgpu });
let r;
try {
  const page = await context.newPage();
  await page.goto(`${server.base}/index.html`);
  r = await page.evaluate(async () => {
    // WebGL context and renderer string, or null without a context.
    const readGl = String.raw`(canvas) => {
      const gl = canvas.getContext("webgl");
      if (!gl) return null;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return { vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
    }`;
    const out = { ua: navigator.userAgent, gpu: Boolean(navigator.gpu), adapter: null };
    try { out.webgl = new Function(`return (${readGl})`)()(document.createElement("canvas")); } catch (e) { out.webgl = { error: String(e?.message || e) }; }
    out.webglWorker = await new Promise((resolve) => {
      const w = new Worker(URL.createObjectURL(new Blob([`postMessage((${readGl})(new OffscreenCanvas(4, 4)))`], { type: "text/javascript" })));
      w.onmessage = (e) => { resolve(e.data); w.terminate(); };
      w.onerror = (e) => { resolve({ error: String(e.message || e) }); w.terminate(); };
    });
    if (!navigator.gpu) return out;
    try {
      const a = await navigator.gpu.requestAdapter();
      if (!a) return out;
      out.adapter = {
        isFallbackAdapter: a.info?.isFallbackAdapter ?? null,
        vendor: a.info?.vendor ?? null, architecture: a.info?.architecture ?? null,
        device: a.info?.device ?? null, description: a.info?.description ?? null,
        features: [...a.features].sort(),
      };
      const d = await a.requestDevice();
      out.device = Boolean(d);
      d.destroy();
    } catch (e) {
      out.error = String(e?.message || e);
    }
    return out;
  });
} finally {
  await context.close();
}
r.chromeArgs = process.env.HARNESS_CHROME_ARGS ?? "";
r.unsafeWebgpu = unsafeWebgpu;
console.log(`[webgpu-adapter] ${JSON.stringify(r)}`);
if (values.out) writeFileSync(values.out, JSON.stringify(r, null, 1));
const got = r.adapter ? "adapter" : "none";
if (values.expect && values.expect !== got) {
  console.error(`[webgpu-adapter] expected ${values.expect}, got ${got}`);
  process.exit(1);
}
process.exit(0);
