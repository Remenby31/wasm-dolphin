#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Presentation-freeze probe for the hardware renderer. Boots a disc N times
// (headless), plays an optional step script, and watches the timelines: a
// freeze is no present for more than 2 s while the VI keeps advancing. On a
// freeze it reads validationReadWgpuReplayState (the WebGPU ring consumer
// state and the core's FIFO / pixel-engine snapshot, patch 0080) every 500 ms
// and writes everything to the run's JSON.
//
//   node harness/probes/wgpu-freeze.mjs --iso disc.iso [--runs 10]
//     [--config wgpu | --query "..."] [--steps steps.json] [--hold 30]
//     [--perturb '{"presentDelayMs":12,"drainEveryMs":60}'] [--port 8084]
//
// --perturb uses the harness-only replay perturbations: a blocking present and
// spaced ring drains reproduce, in headless Chrome, the backpressure a visible
// canvas puts on the replay. Never used by the gate.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { claim } from "../lib/ownership.mjs";
import { openSession } from "../lib/session.mjs";
import { runSteps, validateSteps } from "../lib/steps.mjs";

const HOMEBREW_OUT = path.join(REPO_ROOT, "harness", "homebrew", "out");
const FREEZE_MS = 2000;

const { values } = parseArgs({
  options: {
    iso: { type: "string" },
    runs: { type: "string", default: "10" },
    config: { type: "string", default: "wgpu" },
    query: { type: "string" },
    steps: { type: "string" },
    hold: { type: "string", default: "30" },
    perturb: { type: "string" },
    port: { type: "string", default: process.env.HARNESS_PORT || "8082" },
    out: { type: "string" },
  },
});
if (!values.iso) throw new Error("usage: wgpu-freeze.mjs --iso disc.iso [--runs N] [--steps steps.json] [--perturb json]");
const iso = path.resolve(values.iso);
const localOnly = !iso.startsWith(HOMEBREW_OUT);
if (localOnly && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
const query = `${values.query ?? PRESETS[values.config] ?? values.config}&metrics=1`;
const steps = values.steps ? validateSteps(JSON.parse(readFileSync(values.steps, "utf8"))) : [];
const perturb = values.perturb ? JSON.parse(values.perturb) : null;

// Same placement as the CLI's results: a local-only disc never writes into the repo.
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${process.pid}-${randomBytes(3).toString("hex")}`;
const outDir = values.out ? path.resolve(values.out) : localOnly
  ? path.resolve(process.env.HARNESS_PRIVATE_OUT || path.join(REPO_ROOT, "..", "measures", "harness"), `wgpu-freeze-${stamp}`)
  : path.join(REPO_ROOT, "harness", "results", `wgpu-freeze-${stamp}`);
mkdirSync(path.dirname(outDir), { recursive: true });
mkdirSync(outDir);
claim(outDir, REPO_ROOT, "results");

const server = await ensureServer({ port: Number(values.port) });
const summary = [];
try {
  for (let run = 1; run <= Number(values.runs); run += 1) {
    const session = await openSession({ base: server.base, query, iso });
    const { page } = session;
    let lastPresentT = null;
    let vi = 0;
    let presents = 0;
    let freeze = null;
    const states = [];
    const poll = async () => {
      const tl = await readTimeline(page);
      if (tl?.presents?.t?.length) {
        lastPresentT = tl.presents.t.at(-1);
        presents += tl.presents.t.length;
      }
      const newVi = tl?.vi?.t?.length ?? 0;
      vi += newVi;
      const now = tl?.now;
      if (!freeze && now && lastPresentT && now - lastPresentT > FREEZE_MS && newVi > 0) {
        freeze = { t: now, viSinceBoot: vi, lastPresentAgeMs: Math.round(now - lastPresentT) };
      }
      if (freeze && states.length < 8) {
        states.push({ t: Date.now(), state: await workerRequest(page, "validationReadWgpuReplayState", {}, 3000) });
      }
    };
    try {
      if (perturb) await workerRequest(page, "validationSetWgpuPerturbation", perturb, 10000);
      let stepsDone = false;
      const script = runSteps(page, steps).finally(() => { stepsDone = true; });
      while (!stepsDone) {
        await page.waitForTimeout(freeze ? 500 : 1000);
        await poll();
      }
      await script;
      for (let s = 0; s < Number(values.hold) * 2; s += 1) {
        await page.waitForTimeout(500);
        if (s % 2 === 1 || freeze) await poll();
      }
    } catch (error) {
      freeze = freeze ?? { error: String(error?.message || error).slice(0, 300) };
    } finally {
      await session.close();
    }
    const record = { run, url: session.url, frozen: Boolean(freeze && !freeze.error), freeze, presents, vi, states };
    writeFileSync(path.join(outDir, `run${run}.json`), JSON.stringify(record, null, 1) + "\n");
    summary.push({ run, frozen: record.frozen, presents, vi, error: freeze?.error ?? null });
    console.log(JSON.stringify(summary.at(-1)));
  }
} finally {
  await server.stop();
}
writeFileSync(path.join(outDir, "summary.json"),
  JSON.stringify({ iso: path.basename(iso), query, perturb, runs: summary }, null, 1) + "\n");
console.log(`[wgpu-freeze] frozen ${summary.filter((r) => r.frozen).length}/${summary.length} -> ${outDir}`);
