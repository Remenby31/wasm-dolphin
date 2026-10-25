#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// A WebGL presenter whose context is lost (a GPU crash mid-game) must not
// leave the screen black. Headless, a machine with WebGL: the software
// renderer presented in WebGL, then validationLoseWebGlContext:
//   restored   the context comes back 100 ms later: still WebGL, frames
//              presented again, the blitter rebuilt;
//   replaced   it never comes back: 3 s later the page hands the worker a new
//              canvas, presented in 2D.
// Each case checks the presenter, its counters, that presentation goes on and
// that the visible canvas is not black.
//
//   node harness/probes/presenter-context-loss.mjs --iso disc.iso --port N [--out file.json]
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { bootIso, ensureServer, launchChrome, readFrameInfo, workerRequest } from "../lib/browser.mjs";
import { decodePng } from "../lib/png.mjs";

const QUERY = "core=upstream&video=software&presenter=webgl&cpu=single&speed=1&wasmjit=0&fastsw=1&metrics=1";

// Fraction of pixels brighter than near-black in a PNG; pure.
export function litFraction(png) {
  const { width, height, data } = decodePng(png);
  let lit = 0;
  for (let i = 0; i < width * height * 4; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 48) lit += 1;
  return lit / (width * height);
}

async function runCase(server, iso, restoreAfterMs) {
  const context = await launchChrome({ profileDir: mkdtempSync(path.join(os.tmpdir(), "gc-ctxloss-")) });
  const r = { restoreAfterMs };
  try {
    const page = await context.newPage();
    await bootIso(page, { url: `${server.base}?${QUERY}`, iso, timeoutMs: 90000 });
    await page.waitForTimeout(3000);
    const diag = () => workerRequest(page, "rendererDiagnostics", {}, 10000);
    r.before = (await diag())?.activePresenterBackend;
    r.lose = await workerRequest(page, "validationLoseWebGlContext", { restoreAfterMs }, 10000);
    await page.waitForTimeout(restoreAfterMs >= 0 ? 1500 : 5000);
    const f0 = (await readFrameInfo(page))?.frame ?? 0;
    await page.waitForTimeout(1500);
    const d = await diag();
    r.after = d?.activePresenterBackend;
    r.lostCount = d?.webglContextLostCount ?? 0;
    r.restoredCount = d?.webglContextRestoredCount ?? 0;
    r.replacedCount = d?.presenterReplacedAfterContextLoss ?? 0;
    r.framesAdvanced = ((await readFrameInfo(page))?.frame ?? 0) - f0;
    r.presentationFps = (await readFrameInfo(page))?.pres ?? null;
    r.lit = litFraction(await page.locator("#screen").screenshot());
  } catch (e) {
    r.error = String(e?.message || e).split("\n")[0];
  } finally {
    await context.close();
  }
  return r;
}

async function main() {
  const { values } = parseArgs({ options: { iso: { type: "string" }, port: { type: "string", default: process.env.HARNESS_PORT }, out: { type: "string" } } });
  if (!values.iso || !values.port) throw new Error("usage: presenter-context-loss.mjs --iso disc.iso --port N");
  const server = await ensureServer({ port: values.port });
  const restored = await runCase(server, path.resolve(values.iso), 100);
  const replaced = await runCase(server, path.resolve(values.iso), -1);
  console.log(`[presenter-context-loss] ${JSON.stringify({ restored, replaced })}`);
  if (values.out) writeFileSync(values.out, JSON.stringify({ restored, replaced }, null, 1));
  const ok =
    restored.before === "webgl" && restored.after === "webgl" && restored.lostCount === 1 && restored.restoredCount === 1 && restored.lit > 0.05 && restored.presentationFps > 0 &&
    replaced.before === "webgl" && replaced.after === "2d" && replaced.lostCount === 1 && replaced.replacedCount === 1 && replaced.lit > 0.05 && replaced.presentationFps > 0;
  if (!ok) {
    console.error("[presenter-context-loss] expectation not met");
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
