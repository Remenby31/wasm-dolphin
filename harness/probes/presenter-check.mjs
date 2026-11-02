#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Which presenter a boot really ends up with, or that a boot fails as it
// must. Headless. Used by the Windows no-GPU lane:
//   --expect-presenter 2d      the software renderer with presenter=webgpu
//                              without a usable GPU (fallback adapter and
//                              software WebGL refused) shows the 2D canvas
//   --expect-video-fallback R  video=wgpu without a usable adapter boots the
//                              software renderer instead (core-host
//                              videoFallback), for reason R (e.g.
//                              fallback-adapter: SwiftShader)
//   --expect-boot-error RE     a boot that must fail before the core starts,
//                              with a message matching RE (page or worker
//                              console): video=wgpu with the detached
//                              presenter (wgpudetached=1) and no usable adapter
//
//   node harness/probes/presenter-check.mjs --iso disc.iso --port N --query "..."
//     (--expect-presenter webgpu|webgl|2d | --expect-video-fallback R | --expect-boot-error RE) [--out file.json]
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { bootIso, ensureServer, launchChrome, workerRequest } from "../lib/browser.mjs";

const { values } = parseArgs({
  options: {
    iso: { type: "string" }, port: { type: "string", default: process.env.HARNESS_PORT }, query: { type: "string" },
    "expect-presenter": { type: "string" }, "expect-boot-error": { type: "string" }, "expect-video-fallback": { type: "string" },
    out: { type: "string" },
  },
});
if (!values.iso || !values.port || !values.query || !(values["expect-presenter"] || values["expect-boot-error"] || values["expect-video-fallback"])) {
  throw new Error("usage: presenter-check.mjs --iso disc.iso --port N --query Q (--expect-presenter P | --expect-video-fallback R | --expect-boot-error RE)");
}

const server = await ensureServer({ port: values.port });
const context = await launchChrome({ profileDir: mkdtempSync(path.join(os.tmpdir(), "gc-presenter-")) });
const consoleLines = [];
const r = { query: values.query, booted: false, presenter: null, bootError: null };
try {
  const page = await context.newPage();
  const keep = (m) => consoleLines.push(m.text());
  page.on("console", keep);
  page.on("worker", (w) => w.on("console", keep));
  try {
    await bootIso(page, { url: `${server.base}?${values.query}`, iso: path.resolve(values.iso), timeoutMs: values["expect-boot-error"] ? 30000 : 60000 });
    r.booted = true;
    await page.waitForTimeout(3000);
    const d = await workerRequest(page, "rendererDiagnostics", {}, 10000);
    r.presenter = d?.activePresenterBackend ?? null;
    r.adapter = d?.adapter ? { vendor: d.adapter.vendor, architecture: d.adapter.architecture } : null;
    r.videoBackend = await page.evaluate(() => window.__host?.videoBackend ?? null).catch(() => null);
    r.videoFallback = await page.evaluate(() => window.__host?.videoFallback ?? null).catch(() => null);
  } catch (e) {
    r.bootError = String(e?.message || e).split("\n")[0];
  }
} finally {
  await context.close();
}
r.consoleErrors = consoleLines.filter((t) => /error|needs a usable WebGPU adapter|fallback/i.test(t)).slice(0, 20);
console.log(`[presenter-check] ${JSON.stringify(r)}`);
if (values.out) writeFileSync(values.out, JSON.stringify(r, null, 1));
let ok;
if (values["expect-presenter"]) {
  ok = r.booted && r.presenter === values["expect-presenter"];
} else if (values["expect-video-fallback"]) {
  ok = r.booted && r.videoBackend === "Software Renderer" && r.videoFallback?.reason === values["expect-video-fallback"];
} else {
  const re = new RegExp(values["expect-boot-error"]);
  ok = !r.booted && consoleLines.some((t) => re.test(t));
}
if (!ok) {
  console.error(`[presenter-check] expectation not met`);
  process.exit(1);
}
process.exit(0);
