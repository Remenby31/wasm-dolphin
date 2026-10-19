#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The upscaling study's measuring campaign (docs/upscaling-study.md), under
// ONE take of the shared perf lock: race speed per configuration
// (race-perf.mjs, one run per invocation, configurations interleaved run by
// run), then GPU pass times, memory and captures (upscale-study.mjs), then
// the filter microbenchmark. The children are pointed at a private lock
// directory so they do not wait for the one held here.
//
//   node harness/probes/upscale-campaign.mjs --iso disc.iso --state scene.sav --port N --out dir
//     [--speed-configs "ir=1;ir=2;ir=3;upscale=easu"] [--runs 3] [--max-load 12]
//     [--study-configs "..."] [--study-runs 2] [--skip-speed] [--skip-study] [--skip-bench]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { REPO_ROOT } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";

const { values } = parseArgs({ options: {
  iso: { type: "string" }, state: { type: "string" }, port: { type: "string" }, out: { type: "string" },
  "speed-configs": { type: "string", default: "ir=1;ir=2;ir=3;upscale=easu" },
  "study-configs": { type: "string", default: "ir=1;ir=2;ir=3;upscale=easu;upscale=bilinear" },
  runs: { type: "string", default: "3" }, "study-runs": { type: "string", default: "2" },
  "max-load": { type: "string", default: "12" }, "load-wait": { type: "string", default: "120" }, "lock-wait": { type: "string", default: "600" },
  "skip-speed": { type: "boolean", default: false }, "skip-study": { type: "boolean", default: false },
  "skip-bench": { type: "boolean", default: false }, "wait-pid": { type: "string" }
} });
for (const k of ["iso", "state", "port", "out"]) if (!values[k]) throw new Error(`--${k} is required`);
const out = path.resolve(values.out);
if (out.startsWith(REPO_ROOT + path.sep)) throw new Error("--out must be outside the repo (commercial disc)");
mkdirSync(out, { recursive: true });
const privateLock = path.join(mkdtempSync(path.join(os.tmpdir(), "upscale-campaign-")), ".perf-lock");
const env = { ...process.env, HARNESS_PERF_LOCK: privateLock };
// GPU timestamps at full precision for the study and the bench (Chrome
// rounds them to 100 µs otherwise); race-perf runs Chrome as usual.
const gpuEnv = { ...env, HARNESS_CHROME_ARGS: `${env.HARNESS_CHROME_ARGS ?? ""} --enable-webgpu-developer-features`.trim() };
const node = (args, log) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env: args[0].includes("race-perf") ? env : gpuEnv,
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 << 20 });
  writeFileSync(path.join(out, `${log}.log`), `${r.stdout}\n--- stderr ---\n${r.stderr}`);
  console.log(`[campaign] ${log}: exit ${r.status} in ${Math.round((Date.now() - t0) / 1000)} s`);
  return r;
};

const release = await acquirePerfLock({ name: "upscaling-study campaign (race-perf ir=1/2/3 + easu, GPU times, filter bench)", waitSec: Number(values["lock-wait"]), log: console.log });
// --wait-pid: a core build still finishing (its install included); nothing
// is measured before it exits.
if (values["wait-pid"]) {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (alive(Number(values["wait-pid"]))) await new Promise((r) => setTimeout(r, 5000));
  console.log(`[campaign] build ${values["wait-pid"]} done at ${new Date().toISOString()}`);
}
const summary = { startedAt: new Date().toISOString(), load1AtStart: os.loadavg()[0], speed: [], study: null, bench: [] };
try {
  if (!values["skip-speed"]) {
    const configs = values["speed-configs"].split(";").filter(Boolean);
    for (let run = 1; run <= Number(values.runs); run++) {
      for (const config of configs) {
        const dir = path.join(out, `speed-${config.replace(/[^\w]+/g, "_")}-run${run}`);
        const r = node(["harness/probes/race-perf.mjs", "--iso", values.iso, "--state", values.state, "--port", values.port,
          "--query", `${PRESETS.wgpu}&${config}`, "--runs", "1", "--warmup", "25", "--secs", "20",
          "--max-load", values["max-load"], "--load-wait", values["load-wait"], "--out", dir], path.basename(dir));
        let rec = null;
        try { rec = JSON.parse(readFileSync(path.join(dir, "run1.json"), "utf8")); } catch {}
        summary.speed.push({ config, run, exit: r.status, url: rec?.candidate?.url, speed: rec?.candidate?.cold?.speed,
          gameFps: rec?.candidate?.cold?.gameFps, load1: rec?.candidate?.cold?.load1, overloaded: rec?.candidate?.cold?.overloaded,
          presentP99: rec?.candidate?.cold?.presentIntervalMs?.p99, threads: rec?.candidate?.cold?.rendererThreads,
          error: rec?.candidate?.error });
        writeFileSync(path.join(out, "campaign.json"), JSON.stringify(summary, null, 1) + "\n");
      }
    }
  }
  if (!values["skip-study"]) {
    node(["harness/probes/upscale-study.mjs", "--iso", values.iso, "--state", values.state, "--port", values.port,
      "--configs", values["study-configs"], "--runs", values["study-runs"], "--warmup", "20", "--secs", "10",
      "--out", path.join(out, "study")], "study");
    try { summary.study = JSON.parse(readFileSync(path.join(out, "study", "records.json"), "utf8")); } catch {}
  }
  if (!values["skip-bench"]) {
    for (let i = 1; i <= 3; i++) {
      const file = path.join(out, `filter-bench-${i}.json`);
      node(["harness/probes/upscale-filter-bench.mjs", "--port", values.port, "--iters", "600", "--out", file], `filter-bench-${i}`);
      try { summary.bench.push(JSON.parse(readFileSync(file, "utf8"))); } catch {}
    }
  }
} finally {
  summary.endedAt = new Date().toISOString();
  writeFileSync(path.join(out, "campaign.json"), JSON.stringify(summary, null, 1) + "\n");
  release();
}
