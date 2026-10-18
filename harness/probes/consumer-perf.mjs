#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Race speed on one machine (P9, docs/consumer-perf.md): macOS, Linux or
// Windows, headless Chrome stable, nothing but this checkout and a disc that
// is already on the machine.
//
//   node harness/probes/consumer-perf.mjs --iso <disc on this machine> [--port 8084]
//     [--backend auto|wgpu|soft|both] [--runs 4] [--warmup 25] [--secs 20]
//     [--steps harness/probes/local-race-steps.json] [--label name] [--out dir]
//     [--max-load L] [--shared-lock]
//
// 1. Reads the machine and the browser: OS, CPU, memory, Chrome version and
//    the WebGPU adapter (vendor, architecture, device, fallback or not, and
//    the features the hardware renderer needs).
// 2. Picks the backends: wgpu when a real (non-fallback) adapter has those
//    features, the software renderer otherwise (auto); or as asked.
// 3. Plays the steps into the race once and saves a savestate into a fresh
//    temporary directory (it holds game memory: it never leaves the machine
//    and is deleted at the end, like the disc is never copied).
// 4. Runs race-perf.mjs per backend (cold and warm cache), with a private
//    perf lock unless --shared-lock, and writes report.json + report.md.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, launchChrome, REPO_ROOT } from "../lib/browser.mjs";
import { browserInfo } from "../lib/env.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { machineSnapshot } from "../lib/system.mjs";

// Features the WebGPU renderer asks for (src/upstream-discio-worker.js).
const WGPU_FEATURES = ["clip-distances", "depth-clip-control", "dual-source-blending"];
const BACKENDS = { wgpu: "wgpu", soft: "rec" }; // backend -> race-perf --config preset

const { values } = parseArgs({
  options: {
    iso: { type: "string" },
    port: { type: "string", default: process.env.HARNESS_PORT ?? "8084" },
    backend: { type: "string", default: "auto" },
    runs: { type: "string", default: "4" },
    warmup: { type: "string", default: "25" },
    secs: { type: "string", default: "20" },
    steps: { type: "string", default: path.join(REPO_ROOT, "harness", "probes", "local-race-steps.json") },
    label: { type: "string", default: os.hostname().replace(/[^\w.-]/g, "_") },
    out: { type: "string" },
    "max-load": { type: "string" },
    "shared-lock": { type: "boolean", default: false },
  },
});
if (!values.iso) throw new Error("usage: consumer-perf.mjs --iso <disc on this machine> [--port N] [--backend auto|wgpu|soft|both] [--runs 4]");
const iso = path.resolve(values.iso);
if (!existsSync(iso)) throw new Error(`disc image not found: ${iso}`);
if (process.env.CI) throw new Error("local disc: never run in CI");
if (!["auto", "wgpu", "soft", "both"].includes(values.backend)) throw new Error(`--backend ${values.backend}: auto, wgpu, soft or both`);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.resolve(values.out ?? path.join(process.env.HARNESS_PRIVATE_OUT || path.join(REPO_ROOT, "..", "measures", "harness"), `consumer-${values.label}-${stamp}`));
mkdirSync(outDir, { recursive: true });

// The machine, the browser and its WebGPU adapter, from a page of the app.
async function probeBrowser(port) {
  const server = await ensureServer({ port });
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-consumer-probe-"));
  try {
    const context = await launchChrome({ profileDir });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(server.base, { waitUntil: "domcontentloaded" });
      const info = await browserInfo(page);
      const adapter = await page.evaluate(async (wanted) => {
        if (!navigator.gpu) return { available: false, why: "navigator.gpu missing" };
        const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }).catch((e) => ({ error: String(e?.message || e) }));
        if (!a || a.error) return { available: false, why: a?.error ?? "no adapter" };
        const info = a.info ?? {};
        return {
          available: true,
          fallback: Boolean(a.isFallbackAdapter ?? info.isFallbackAdapter),
          vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
          missingFeatures: wanted.filter((f) => !a.features.has(f)),
          maxBufferSize: a.limits.maxBufferSize, maxTextureDimension2D: a.limits.maxTextureDimension2D,
        };
      }, WGPU_FEATURES);
      return { browser: { ...info, version: context.browser()?.version?.() ?? null }, adapter };
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
    await server.stop();
  }
}

function pickBackends(adapter) {
  const wgpuOk = adapter.available && !adapter.fallback && !adapter.missingFeatures.length;
  const why = wgpuOk ? null : !adapter.available ? adapter.why : adapter.fallback ? "fallback (software) adapter" : `missing ${adapter.missingFeatures.join(", ")}`;
  if (values.backend === "both") return { backends: ["wgpu", "soft"], wgpuOk, why };
  if (values.backend === "wgpu") return { backends: ["wgpu"], wgpuOk, why };
  if (values.backend === "soft") return { backends: ["soft"], wgpuOk, why };
  return { backends: wgpuOk ? ["wgpu"] : ["soft"], wgpuOk, why };
}

// One node child per harness command: the same entry points a person runs.
function node(script, args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 << 20 });
  const lines = `${r.stdout ?? ""}${r.stderr ?? ""}`.split(/\r?\n/).filter((l) => /^\[(race-perf|harness)\]|Error/.test(l));
  for (const l of lines) console.log(`  ${l}`);
  return { status: r.status, lines };
}

const machine = machineSnapshot();
console.log(`[consumer-perf] ${machine.platform}, ${machine.cpuModel} x${machine.cpus}, ${machine.totalMemGiB} GiB`);
const { browser, adapter } = await probeBrowser(Number(values.port));
console.log(`[consumer-perf] Chrome ${browser.chrome ?? browser.version}, WebGPU ${adapter.available ? `${adapter.vendor} ${adapter.architecture} ${adapter.description || adapter.device || ""}${adapter.fallback ? " (fallback)" : ""}` : `unavailable (${adapter.why})`}`);
const choice = pickBackends(adapter);
if (choice.why && choice.backends.includes("wgpu")) console.warn(`[consumer-perf] warning: wgpu asked for, but ${choice.why}`);
if (!choice.wgpuOk && values.backend === "auto") console.log(`[consumer-perf] wgpu skipped (${choice.why}): software renderer only`);

// The savestate holds game memory: a fresh temporary directory, deleted on
// every exit path, never under the checkout nor the results.
const scratch = mkdtempSync(path.join(os.tmpdir(), "gc-consumer-"));
const results = {};
try {
  const state = path.join(scratch, "race.sav");
  console.log(`[consumer-perf] playing the steps into the race and saving a state (${path.basename(values.steps)})`);
  const saved = node(path.join(REPO_ROOT, "harness", "cli.mjs"), ["savestate", "--iso", iso, "--to", state, "--steps", values.steps, "--config", "rec", "--port", values.port]);
  if (saved.status !== 0 || !existsSync(state)) throw new Error("savestate failed: see the lines above");
  const lockEnv = values["shared-lock"] ? {} : { HARNESS_PERF_LOCK: path.join(scratch, ".perf-lock") };
  for (const backend of choice.backends) {
    console.log(`[consumer-perf] ${backend}: ${values.runs} runs, ${values.warmup} s warmup + ${values.secs} s window, cold and warm`);
    const dir = path.join(outDir, backend);
    const r = node(path.join(REPO_ROOT, "harness", "probes", "race-perf.mjs"), [
      "--iso", iso, "--state", state, "--port", values.port, "--config", BACKENDS[backend],
      "--runs", values.runs, "--warmup", values.warmup, "--secs", values.secs, "--warm", "--out", dir, "--lock-wait", "600",
      ...(values["max-load"] ? ["--max-load", values["max-load"]] : []),
    ], lockEnv);
    const summaryFile = path.join(dir, "summary.json");
    results[backend] = { status: r.status, summary: existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, "utf8")) : null };
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const med = (d) => d?.median ?? null;
const row = (backend, phase) => {
  const s = results[backend]?.summary?.candidate?.[phase];
  return s && { speed: med(s.speed), gameFps: med(s.gameFps), viP99Ms: med(s.viP99Ms), presentP99Ms: med(s.presentP99Ms), hitchesPerMin: med(s.hitchesPerMin), busiestThread: med(s.busiestThread) };
};
const report = {
  label: values.label, at: new Date().toISOString(), machine, browser, adapter, backendChoice: choice,
  query: Object.fromEntries(choice.backends.map((b) => [b, PRESETS[BACKENDS[b]]])),
  results: Object.fromEntries(choice.backends.map((b) => [b, { exit: results[b]?.status ?? null, failed: results[b]?.summary?.failed ?? null, cold: row(b, "cold"), warm: row(b, "warm") }])),
};
writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 1) + "\n");
const gpu = adapter.available ? `${adapter.vendor ?? "?"} / ${adapter.architecture ?? "?"}${adapter.description ? ` (${adapter.description})` : ""}${adapter.fallback ? ", fallback adapter" : ""}` : `none (${adapter.why})`;
const md = [
  `# Race speed on ${values.label}`,
  "",
  `${machine.platform}, ${machine.cpuModel} ×${machine.cpus}, ${machine.totalMemGiB} GiB, Chrome ${browser.chrome ?? browser.version}. WebGPU adapter: ${gpu}.`,
  "",
  "| Backend | Cache | Speed % | Game fps | VI p99 ms | Present p99 ms | Hitches/min | Busiest thread % |",
  "|---|---|---|---|---|---|---|---|",
  ...choice.backends.flatMap((b) => ["cold", "warm"].map((ph) => {
    const r = report.results[b][ph];
    return r ? `| ${b} | ${ph} | ${r.speed} | ${r.gameFps} | ${r.viP99Ms} | ${r.presentP99Ms} | ${r.hitchesPerMin} | ${r.busiestThread ?? "n/a"} |` : `| ${b} | ${ph} | no valid run | | | | | |`;
  })),
  "",
  `Medians over ${values.runs} runs of ${values.secs} s after ${values.warmup} s in the race (race-perf.mjs). Speed is the core's own (VI ticks over host time).${choice.why ? ` wgpu: ${choice.why}.` : ""}`,
  "",
].join("\n");
writeFileSync(path.join(outDir, "report.md"), md);
console.log(`[consumer-perf] ${outDir}${path.sep}report.md`);
console.log(md);
process.exitCode = Object.values(results).some((r) => r.status !== 0) ? 1 : 0;
