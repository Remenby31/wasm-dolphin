#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Presentation-freeze probe for the hardware renderer. Boots a disc N times
// (headless), plays an optional step script, and drains the timelines every
// second through the harness freeze watch (lib/freeze-probe.mjs): a "core"
// freeze is no VI output for 2 s (the whole emulation stalled), a "present"
// freeze is no present for 2 s while the VI goes on. On a freeze it reads
// validationReadWgpuReplayState (the WebGPU ring consumer state and the
// core's FIFO / pixel-engine snapshot, patch 0080) a few times and writes
// everything to the run's JSON.
//
//   node harness/probes/wgpu-freeze.mjs --iso disc.iso [--runs 10]
//     [--config wgpu | --query "...video=wgpu..."] [--steps steps.json] [--hold 30]
//     [--perturb '{"presentDelayMs":12,"drainEveryMs":60}'] --port N
//
// --perturb uses the harness-only replay perturbations: a blocking present and
// spaced ring drains reproduce, in headless Chrome, the backpressure a visible
// canvas puts on the replay. Never used by the gate.
//
// The core's GPU-sync counters are turned on for this probe only
// (validationEnableGpuSyncDiag). A core without them (no patch 0080) leaves a
// run unjudged: a freeze without its FIFO state is not the evidence sought.
// The FIFO fields are read one by one while the threads run: they agree with
// each other during a stall, not while the FIFO moves.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { createFreezeWatch, probeWorker } from "../lib/freeze-probe.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { claim } from "../lib/ownership.mjs";
import { openSession } from "../lib/session.mjs";
import { runSteps, validateSteps } from "../lib/steps.mjs";

const HOMEBREW_OUT = path.join(REPO_ROOT, "harness", "homebrew", "out");
const REQUEST_TIMEOUT_MS = 3000;

const { values } = parseArgs({
  options: {
    iso: { type: "string" },
    runs: { type: "string", default: "10" },
    config: { type: "string", default: "wgpu" },
    query: { type: "string" },
    steps: { type: "string" },
    hold: { type: "string", default: "30" },
    perturb: { type: "string" },
    port: { type: "string", default: process.env.HARNESS_PORT },
    out: { type: "string" },
  },
});
if (!values.iso || !values.port) {
  throw new Error("usage: wgpu-freeze.mjs --iso disc.iso --port N (or HARNESS_PORT) [--runs N] [--steps steps.json] [--perturb json]");
}
if (!values.query && !PRESETS[values.config]) throw new Error(`unknown --config ${values.config} (presets: ${Object.keys(PRESETS).join(", ")})`);
const baseQuery = values.query ?? PRESETS[values.config];
if (new URLSearchParams(baseQuery).get("video") !== "wgpu") throw new Error(`this probe is for video=wgpu, got: ${baseQuery}`);
const iso = path.resolve(values.iso);
if (!existsSync(iso)) throw new Error(`disc image not found: ${iso}`);
const localOnly = !iso.startsWith(HOMEBREW_OUT);
if (localOnly && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
const query = `${baseQuery}&metrics=1`;
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

// One run: boot, steps, hold, watching the timelines. Never throws: every
// failure ends up in `unjudged`.
async function probeRun(server, run) {
  const unjudged = [];
  const episodes = [];
  let presents = 0, viEntries = 0, lastVi = null, session = null;
  try {
    session = await openSession({ base: server.base, server, query, iso });
  } catch (error) {
    return { run, verdict: "unjudged", unjudged: [`session: ${String(error?.message || error).slice(0, 300)}`], episodes, fatal: [] };
  }
  const { page } = session;
  const request = (type, payload) => workerRequest(page, type, payload, REQUEST_TIMEOUT_MS);
  const watch = createFreezeWatch();
  const poll = async () => {
    const chunk = await readTimeline(page);
    if (chunk?.error || !chunk?.vi?.supported) {
      unjudged.push(chunk?.error ?? chunk?.vi?.why ?? "no VI timeline");
      return;
    }
    if (chunk.vi.lost || chunk.presents.lost) unjudged.push(`timeline entries lost (vi ${chunk.vi.lost}, presents ${chunk.presents.lost})`);
    presents += chunk.presents.t.length;
    viEntries += chunk.vi.t.length;
    if (chunk.vi.t.length) lastVi = chunk.vi.sinceBoot.at(-1);
    const episode = watch.observe(chunk);
    if (episode) {
      const probe = await probeWorker(request);
      const noDiag = probe.unsupported || probe.states.every((s) => s.state?.gpuSync == null);
      if (noDiag) unjudged.push("freeze without the core's GPU-sync state (core without patch 0080?)");
      episodes.push({ ...episode, ...probe });
    }
  };
  try {
    const diag = await request("validationEnableGpuSyncDiag", { enabled: true });
    if (!diag?.coreDiag) unjudged.push(`core GPU-sync diagnostics unavailable: ${JSON.stringify(diag).slice(0, 200)}`);
    if (perturb) {
      const applied = await request("validationSetWgpuPerturbation", perturb);
      if (applied?.error || Object.entries(perturb).some(([k, v]) => applied?.[k] !== v)) {
        throw new Error(`perturbation refused: ${JSON.stringify(applied)}`);
      }
    }
    let stepsDone = false;
    const script = runSteps(page, steps).finally(() => { stepsDone = true; });
    while (!stepsDone) {
      await page.waitForTimeout(1000);
      await poll();
    }
    await script;
    for (let s = 0; s < Number(values.hold); s += 1) {
      await page.waitForTimeout(1000);
      await poll();
    }
    if (!viEntries) unjudged.push("no VI output during the run");
  } catch (error) {
    unjudged.push(String(error?.message || error).slice(0, 300));
  }
  const fatal = session.watch?.fatal?.() ?? [];
  await session.close();
  // A crash is a crash; a freeze is a freeze only with its evidence; a run
  // that could not be watched is unjudged. None of these counts as "ok".
  const verdict = fatal.length ? "crash" : unjudged.length ? "unjudged" : episodes.length ? "frozen" : "ok";
  return { run, url: session.url, core: session.core, verdict, episodes, presents, viEntries, lastVi, unjudged: unjudged.slice(0, 20), fatal };
}

const summary = [];
let server = null;
try {
  server = await ensureServer({ port: Number(values.port) });
  for (let run = 1; run <= Number(values.runs); run += 1) {
    const record = await probeRun(server, run);
    writeFileSync(path.join(outDir, `run${run}.json`), JSON.stringify(record, null, 1) + "\n");
    summary.push({ run, verdict: record.verdict, kinds: record.episodes.map((e) => e.kind), presents: record.presents, viEntries: record.viEntries, lastVi: record.lastVi });
    console.log(JSON.stringify(summary.at(-1)));
  }
} finally {
  await server?.stop();
  writeFileSync(path.join(outDir, "summary.json"),
    JSON.stringify({ iso: path.basename(iso), query, perturb, runs: summary }, null, 1) + "\n");
}
const count = (v) => summary.filter((r) => r.verdict === v).length;
console.log(`[wgpu-freeze] frozen ${count("frozen")}, crash ${count("crash")}, unjudged ${count("unjudged")}, ok ${count("ok")} of ${summary.length} -> ${outDir}`);
