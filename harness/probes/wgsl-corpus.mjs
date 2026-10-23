#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// WGSL corpus: boots a disc on video=wgpu (headless), optionally loads a
// savestate and plays a step script, and writes the WGSL of every shader
// module the replay created (validationWgslCorpus), one file per hash. The
// corpus feeds tools/wgsl-hlsl-corpus.mjs (Tint -> HLSL -> DXC, the path
// Chrome takes on Windows). A local disc's corpus stays outside the repo.
//
//   node harness/probes/wgsl-corpus.mjs --iso disc.iso --port N --out dir
//     [--state scene.sav] [--steps steps.json] [--secs 60] [--query "...video=wgpu..."]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, loadHarnessState, workerRequest } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { openSession } from "../lib/session.mjs";
import { runSteps, validateSteps } from "../lib/steps.mjs";

const STATE_ROUTE = "**/__harness_state.sav";
const { values } = parseArgs({
  options: {
    iso: { type: "string" }, port: { type: "string", default: process.env.HARNESS_PORT }, out: { type: "string" },
    state: { type: "string" }, steps: { type: "string" }, secs: { type: "string", default: "60" }, query: { type: "string" },
  },
});
if (!values.iso || !values.port || !values.out) throw new Error("usage: wgsl-corpus.mjs --iso disc.iso --port N --out dir [--state s.sav] [--steps steps.json] [--secs 60]");
const iso = path.resolve(values.iso);
if (!existsSync(iso)) throw new Error(`disc image not found: ${iso}`);
const query = `${values.query ?? PRESETS["wgpu-nojit"]}&metrics=1`;
if (new URLSearchParams(query).get("video") !== "wgpu") throw new Error("the corpus needs video=wgpu");
const steps = values.steps ? validateSteps(JSON.parse(readFileSync(values.steps, "utf8"))) : [];

const req = (page, payload) => workerRequest(page, "validationWgslCorpus", payload, 30000);
const server = await ensureServer({ port: values.port });
const session = await openSession({ base: server.base, server, query, iso, routes: values.state ? { [STATE_ROUTE]: path.resolve(values.state) } : {} });
const { page } = session;
let shaders = [];
try {
  const started = await req(page, { action: "start" });
  if (started?.error) throw new Error(started.error);
  if (values.state) {
    const loaded = await loadHarnessState(page, session.url);
    if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
  }
  if (steps.length) await runSteps(page, steps);
  await page.waitForTimeout(Number(values.secs) * 1000);
  const r = await req(page, { action: "read" });
  if (r?.error) throw new Error(r.error);
  shaders = r.shaders ?? [];
  await req(page, { action: "stop" });
} finally {
  await session.close();
}
const out = path.resolve(values.out);
mkdirSync(out, { recursive: true });
for (const s of shaders) writeFileSync(path.join(out, `${s.hash}.s${s.stage}.wgsl`), s.wgsl);
writeFileSync(path.join(out, "index.json"), JSON.stringify({ iso: path.basename(iso), query, at: new Date().toISOString(), shaders: shaders.map(({ hash, stage, wgsl }) => ({ hash, stage, bytes: wgsl.length })) }, null, 1));
console.log(`[wgsl-corpus] ${shaders.length} shader module(s) -> ${out}`);
process.exit(0);
