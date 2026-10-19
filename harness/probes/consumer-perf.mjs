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
//     [--max-load L] [--shared-lock | --private-lock]
//
// 1. Reads the machine and the browser: OS, CPU, memory, Chrome version and
//    the WebGPU adapter (vendor, architecture, fallback or not, and the
//    features the hardware renderer needs).
// 2. Picks the backends (lib/consumer.mjs): wgpu on a real adapter with those
//    features, the software renderer otherwise (auto); or as asked.
// 3. Plays the steps into the race, timed in emulated frames so a slower
//    machine lands in the same scene, and saves a state into a fresh
//    temporary directory. The state holds game memory: it never leaves the
//    machine and is deleted on every exit path (Ctrl-C and SSH hang-up too).
// 4. Per backend, checks the renderer first: loads the state, captures an
//    exact frame, refuses a blank one (no numbers are published for a renderer
//    that draws nothing), and records the presenter the page really used. The
//    capture is kept with the local results so the operator sees the scene.
// 5. Runs race-perf.mjs per backend (cold and warm cache) and writes
//    report.json + report.md, with the machine load seen before each backend.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, launchChrome, loadHarnessState, pageCall, readCoreProgress, readFrameInfo, REPO_ROOT } from "../lib/browser.mjs";
import { cpuBusy, isBlankFrame, pickBackends, presenterOf, sanitizeLabel, WGPU_FEATURES } from "../lib/consumer.mjs";
import { browserInfo } from "../lib/env.mjs";
import { captureSourceOk, PRESETS } from "../lib/matrix.mjs";
import { captureInSession, openSession, savePng } from "../lib/session.mjs";
import { emulatedWait, runSteps, validateSteps } from "../lib/steps.mjs";
import { machineSnapshot } from "../lib/system.mjs";

const BACKENDS = { wgpu: "wgpu", soft: "rec" }; // backend -> harness preset
const STATE_ROUTE = "**/__harness_state.sav";
const CHECK_VI = 180; // exact capture 3 s (emulated) after loading the state

const { values } = parseArgs({
  options: {
    iso: { type: "string" },
    port: { type: "string", default: process.env.HARNESS_PORT ?? "8084" },
    backend: { type: "string", default: "auto" },
    runs: { type: "string", default: "4" },
    warmup: { type: "string", default: "25" },
    secs: { type: "string", default: "20" },
    steps: { type: "string", default: path.join(REPO_ROOT, "harness", "probes", "local-race-steps.json") },
    label: { type: "string", default: os.hostname() },
    out: { type: "string" },
    "max-load": { type: "string" },
    // The development Mac shares one perf lock between agents (PROGRAM.md);
    // a lone consumer machine needs none of its own path.
    "shared-lock": { type: "boolean", default: process.platform === "darwin" },
    "private-lock": { type: "boolean", default: false },
  },
});
if (!values.iso) throw new Error("usage: consumer-perf.mjs --iso <disc on this machine> [--port N] [--backend auto|wgpu|soft|both] [--runs 4]");
const iso = path.resolve(values.iso);
if (!existsSync(iso)) throw new Error(`disc image not found: ${iso}`);
if (process.env.CI) throw new Error("local disc: never run in CI");
pickBackends({}, values.backend); // validates --backend before anything starts
const steps = validateSteps(JSON.parse(readFileSync(values.steps, "utf8")));
const port = Number(values.port);
const label = sanitizeLabel(values.label);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.resolve(values.out ?? path.join(process.env.HARNESS_PRIVATE_OUT || path.join(REPO_ROOT, "..", "measures", "harness"), `consumer-${label}-${stamp}`));
mkdirSync(outDir, { recursive: true });

// The savestate holds game memory: a fresh temporary directory, removed on
// every way out of this process, never under the checkout nor the results.
const scratch = mkdtempSync(path.join(os.tmpdir(), "gc-consumer-"));
let child = null;
const cleanup = () => rmSync(scratch, { recursive: true, force: true });
process.on("exit", cleanup);
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  process.on(sig, () => {
    child?.kill(sig);
    cleanup();
    process.exit(code);
  });
}

// One node child per race-perf run, awaited without blocking this process,
// so a signal reaches the handlers above.
function runNode(script, args, env = {}) {
  return new Promise((resolve) => {
    child = spawn(process.execPath, [script, ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const onData = (chunk) => {
      tail += chunk;
      const lines = tail.split(/\r?\n/);
      tail = lines.pop();
      for (const l of lines) if (/^\[(race-perf|harness)\]|Error/.test(l)) console.log(`  ${l}`);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (status) => { child = null; resolve(status); });
  });
}

// Busy CPU over 2 s and the load average, before a backend runs.
async function machineLoad() {
  const before = os.cpus();
  await new Promise((r) => setTimeout(r, 2000));
  return { busy: cpuBusy(before, os.cpus()), loadavg1: Math.round(os.loadavg()[0] * 100) / 100 };
}

async function withServer(fn) {
  const server = await ensureServer({ port });
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

// The machine, the browser and its WebGPU adapter, from a page of the app.
function probeBrowser() {
  return withServer(async (server) => {
    const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-consumer-probe-"));
    const context = await launchChrome({ profileDir });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(server.base, { waitUntil: "domcontentloaded" });
      const browser = await browserInfo(page);
      const adapter = await page.evaluate(async (wanted) => {
        if (!navigator.gpu) return { available: false, why: "navigator.gpu missing" };
        const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }).catch((e) => ({ error: String(e?.message || e) }));
        if (!a || a.error) return { available: false, why: a?.error ?? "no adapter" };
        const info = a.info ?? {};
        return {
          available: true,
          fallback: Boolean(a.isFallbackAdapter ?? info.isFallbackAdapter),
          vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
          features: [...a.features].sort(), missingFeatures: wanted.filter((f) => !a.features.has(f)),
          maxBufferSize: a.limits.maxBufferSize, maxTextureDimension2D: a.limits.maxTextureDimension2D,
        };
      }, WGPU_FEATURES);
      return { browser, adapter };
    } finally {
      await context.close().catch(() => {});
      rmSync(profileDir, { recursive: true, force: true });
    }
  });
}

// Boot, play the steps in emulated time, save a state into `to`.
function makeState(to) {
  return withServer(async (server) => {
    const session = await openSession({ base: server.base, server, query: `${PRESETS.rec}&metrics=1`, iso });
    try {
      const wait = emulatedWait(async () => (await readCoreProgress(session.page))?.frame ?? 0);
      await runSteps(session.page, steps, { wait });
      await wait(5000);
      const r = await pageCall(session.page, "__saveStateFile", undefined, 120000);
      if (!r?.saved || !r.b64) throw new Error(`save failed: ${JSON.stringify({ ...r, b64: undefined })}`);
      writeFileSync(to, Buffer.from(r.b64, "base64"));
      return { bytes: r.size, frame: (await readCoreProgress(session.page))?.frame ?? null };
    } finally {
      await session.close();
    }
  });
}

// Load the state with `backend`, capture an exact frame CHECK_VI outputs
// later: not blank, from the expected source, and the presenter in use.
function checkRenderer(backend, state) {
  const query = `${PRESETS[BACKENDS[backend]]}&metrics=1`;
  return withServer(async (server) => {
    const session = await openSession({ base: server.base, server, query, iso, routes: { [STATE_ROUTE]: state } });
    try {
      const loaded = await loadHarnessState(session.page, session.url);
      if (!loaded?.loaded) return { ok: false, why: `savestate load failed: ${JSON.stringify(loaded).slice(0, 200)}` };
      const capture = await captureInSession(session, { index: CHECK_VI, fromLoad: true, timeoutMs: 120000 });
      const info = await session.page.evaluate(() => window.__lastFrameInfo?.ppcWasmHelperStats ?? "").catch(() => "");
      const presenter = presenterOf(info);
      const frameInfo = await readFrameInfo(session.page).catch(() => null);
      if (capture.error) return { ok: false, why: `capture: ${capture.error}`, presenter };
      const png = savePng(capture, path.join(outDir, `${backend}-check.png`));
      if (!captureSourceOk(query, capture.source)) return { ok: false, why: `capture source ${capture.source} is not what this renderer shows`, presenter, png };
      if (isBlankFrame(capture)) return { ok: false, why: "blank picture", presenter, png };
      return { ok: true, presenter, source: capture.source, png, gameFps: frameInfo?.vis ?? null, core: session.core?.loaded ?? null };
    } finally {
      await session.close();
    }
  });
}

const machine = machineSnapshot();
const chromeArgs = process.env.HARNESS_CHROME_ARGS ?? "";
const chromePath = process.env.HARNESS_CHROME_PATH || "chrome stable";
console.log(`[consumer-perf] ${machine.platform}, ${machine.cpuModel} x${machine.cpus}, ${machine.totalMemGiB} GiB${chromeArgs ? `, Chrome args "${chromeArgs}"` : ""}${process.env.HARNESS_CHROME_PATH ? `, Chrome ${chromePath}` : ""}`);
const { browser, adapter } = await probeBrowser();
console.log(`[consumer-perf] Chrome ${browser.chrome ?? "?"}, WebGPU ${adapter.available ? `${adapter.vendor} ${adapter.architecture} ${adapter.description || adapter.device || ""}${adapter.fallback ? " (fallback)" : ""}` : `unavailable (${adapter.why})`}`);
const choice = pickBackends(adapter, values.backend);
if (choice.why && choice.backends.includes("wgpu")) console.warn(`[consumer-perf] warning: wgpu asked for, but ${choice.why}`);
if (!choice.wgpuOk && values.backend === "auto") console.log(`[consumer-perf] wgpu skipped (${choice.why}): software renderer only`);

const state = path.join(scratch, "race.sav");
console.log(`[consumer-perf] playing the steps into the race (emulated time) and saving a state`);
const saved = await makeState(state);
console.log(`[consumer-perf] state saved at frame ${saved.frame}`);
const lockEnv = values["private-lock"] || !values["shared-lock"] ? { HARNESS_PERF_LOCK: path.join(scratch, ".perf-lock") } : {};
const results = {};
for (const backend of choice.backends) {
  const check = await checkRenderer(backend, state);
  console.log(`[consumer-perf] ${backend}: renderer check ${check.ok ? "ok" : `FAILED (${check.why})`}, presenter ${check.presenter ?? "?"}${check.png ? `, scene ${check.png}` : ""}`);
  results[backend] = { check };
  if (!check.ok) continue;
  results[backend].load = await machineLoad();
  console.log(`[consumer-perf] ${backend}: CPU busy ${results[backend].load.busy.percent} % before the runs; ${values.runs} runs, ${values.warmup} s warmup + ${values.secs} s window, cold and warm`);
  const dir = path.join(outDir, backend);
  results[backend].exit = await runNode(path.join(REPO_ROOT, "harness", "probes", "race-perf.mjs"), [
    "--iso", iso, "--state", state, "--port", values.port, "--config", BACKENDS[backend],
    "--runs", values.runs, "--warmup", values.warmup, "--secs", values.secs, "--warm", "--out", dir, "--lock-wait", "1800",
    ...(values["max-load"] ? ["--max-load", values["max-load"]] : []),
  ], lockEnv);
  const summaryFile = path.join(dir, "summary.json");
  results[backend].summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, "utf8")) : null;
}
cleanup();

const med = (d) => d?.median ?? null;
const row = (backend, phase) => {
  const s = results[backend]?.summary?.candidate?.[phase];
  return s && { speed: med(s.speed), gameFps: med(s.gameFps), viP99Ms: med(s.viP99Ms), presentP99Ms: med(s.presentP99Ms), hitchesPerMin: med(s.hitchesPerMin), busiestThread: med(s.busiestThread) };
};
const windows = process.platform === "win32";
const report = {
  label, at: new Date().toISOString(), machine, browser, adapter, chromeArgs, chromePath, backendChoice: choice, savestateFrame: saved.frame,
  loadGuard: windows ? "inactive: Windows reports no load average; CPU busy is measured before each backend instead" : "1-minute load average",
  query: Object.fromEntries(choice.backends.map((b) => [b, PRESETS[BACKENDS[b]]])),
  results: Object.fromEntries(choice.backends.map((b) => [b, {
    check: results[b].check, load: results[b].load ?? null, exit: results[b].exit ?? null, failed: results[b].summary?.failed ?? null,
    cold: row(b, "cold"), warm: row(b, "warm"),
  }])),
};
writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 1) + "\n");
const gpu = adapter.available ? `${adapter.vendor ?? "?"} / ${adapter.architecture ?? "?"}${adapter.description ? ` (${adapter.description})` : ""}${adapter.fallback ? ", fallback adapter" : ""}${adapter.missingFeatures?.length ? `, missing ${adapter.missingFeatures.join(", ")}` : ""}` : `none (${adapter.why})`;
const md = [
  `# Race speed on ${label}`,
  "",
  `${machine.platform}, ${machine.cpuModel} ×${machine.cpus}, ${machine.totalMemGiB} GiB, Chrome ${browser.chrome ?? "?"}${process.env.HARNESS_CHROME_PATH ? ` (${chromePath})` : ""}${chromeArgs ? ` with \`${chromeArgs}\`` : ""}. WebGPU adapter: ${gpu}.`,
  "",
  "| Backend | Presenter | Cache | Speed % | Game fps | VI p99 ms | Present p99 ms | Hitches/min | Busiest thread % |",
  "|---|---|---|---|---|---|---|---|---|",
  ...choice.backends.flatMap((b) => {
    const r = report.results[b];
    if (!r.check.ok) return [`| ${b} | ${r.check.presenter ?? "?"} | | renderer check failed: ${r.check.why} | | | | | |`];
    return ["cold", "warm"].map((ph) => r[ph]
      ? `| ${b} | ${r.check.presenter ?? "?"} | ${ph} | ${r[ph].speed} | ${r[ph].gameFps} | ${r[ph].viP99Ms} | ${r[ph].presentP99Ms} | ${r[ph].hitchesPerMin} | ${r[ph].busiestThread ?? "n/a"} |`
      : `| ${b} | ${r.check.presenter ?? "?"} | ${ph} | no valid run | | | | | |`);
  }),
  "",
  `Medians over ${values.runs} runs of ${values.secs} s after ${values.warmup} s in the race (race-perf.mjs). Speed is the core's own (VI ticks over host time).${choice.why ? ` wgpu: ${choice.why}.` : ""}`,
  "",
  `Machine load before each backend: ${choice.backends.filter((b) => results[b].load).map((b) => `${b} ${results[b].load.busy.percent} % CPU busy`).join(", ") || "n/a"}.${windows ? " **Windows: the load guard is inactive (no load average); keep the machine idle and check the CPU busy figure.**" : ""}`,
  "",
  `Check the scene: ${choice.backends.filter((b) => results[b].check.png).map((b) => `\`${b}-check.png\``).join(", ") || "no capture"} must show the race.`,
  "",
].join("\n");
writeFileSync(path.join(outDir, "report.md"), md);
console.log(`[consumer-perf] ${path.join(outDir, "report.md")}`);
console.log(md);
process.exitCode = choice.backends.some((b) => !results[b].check.ok || results[b].exit !== 0) ? 1 : 0;
