#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// What WebGPU this Chrome gives a page: navigator.gpu, requestAdapter(),
// the adapter's info and features, and whether a device can be created.
// Headless, no disc. Used by the Windows WARP workflow: without flags a
// GPU-less Windows runner has no adapter (WARP is refused), with
// --enable-unsafe-webgpu (HARNESS_CHROME_ARGS) it should get WARP.
//
//   node harness/probes/webgpu-adapter.mjs --port N [--expect adapter|none] [--out file.json]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { ensureServer, launchChrome } from "../lib/browser.mjs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const { values } = parseArgs({
  options: { port: { type: "string", default: process.env.HARNESS_PORT }, expect: { type: "string" }, out: { type: "string" } },
});
if (!values.port) throw new Error("usage: webgpu-adapter.mjs --port N [--expect adapter|none]");

const server = await ensureServer({ port: values.port });
const context = await launchChrome({ profileDir: mkdtempSync(path.join(os.tmpdir(), "gc-adapter-")) });
let r;
try {
  const page = await context.newPage();
  await page.goto(`${server.base}/index.html`);
  r = await page.evaluate(async () => {
    const out = { ua: navigator.userAgent, gpu: Boolean(navigator.gpu), adapter: null };
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
console.log(`[webgpu-adapter] ${JSON.stringify(r)}`);
if (values.out) writeFileSync(values.out, JSON.stringify(r, null, 1));
const got = r.adapter ? "adapter" : "none";
if (values.expect && values.expect !== got) {
  console.error(`[webgpu-adapter] expected ${values.expect}, got ${got}`);
  process.exit(1);
}
process.exit(0);
