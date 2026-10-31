// Warm-state CPU profile capture for the emulation pthread workers.
//
// This is the §28br "dispatch-vs-block-body split" instrumentation. It answers
// one question: of the CPU time spent emulating, how much is *inside* JIT'd
// PPC block bodies versus the dispatch machinery around them? That ratio is
// the ceiling on what JIT block-linking could ever win, and it must be known
// before committing to that (HIGH-risk) core rebuild.
//
// Why a sampling profiler instead of in-core timers: a block body runs in
// well under a microsecond, while performance.now() in a cross-origin-isolated
// context is quantised to ~5us. Per-dispatch timing would measure its own
// observer overhead. V8's sampling profiler has no such bias and needs no core
// rebuild.
//
// The split falls out of module identity for free. The dispatch loop
// (CachedInterpreter::Run / RunWasmBlock) lives in the single large core
// module; every JIT'd block is its own `new WebAssembly.Module` created in
// DolphinWeb_CachedInterpreterCompileWasmBlock. Different scriptIds, so the
// analyzer can separate them without any naming convention.
//
// WARM STATE IS MANDATORY. Per §28bm, a cold JIT cache produced a phantom
// "46% ceiling" that had to be retracted. This harness refuses to profile
// until the JIT is engaged and the block-compile count has plateaued.
//
// Usage:
//   node tools/serve.mjs                      (in another shell)
//   node tools/cpu-profile-capture.mjs
//
// Env:
//   ROM              disc image path (required)
//   SAVE_STATE_URL   save state to load for a warm in-game scene
//   SAVE_STATE_AT    seconds after boot to load it (default 35)
//   WARMUP_SECONDS   min seconds before profiling starts (default 90)
//   PROFILE_SECONDS  profile duration (default 20)
//   SAMPLE_US        V8 sampling interval in microseconds (default 100)
//   BASE_URL, HEADED, DEBUG_PORT

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

const romPath = process.env.ROM || "";
if (!romPath) throw new Error("set ROM to the disc image to profile");
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8082/";
const warmupSeconds = Number(process.env.WARMUP_SECONDS || 90);
const profileSeconds = Number(process.env.PROFILE_SECONDS || 20);
const sampleUs = Number(process.env.SAMPLE_US || 100);
const debugPort = Number(process.env.DEBUG_PORT || 9333);
const headed = process.env.HEADED === "1";
const saveStateUrl = process.env.SAVE_STATE_URL || "";
const saveStateAt = Number(process.env.SAVE_STATE_AT || 35);
const outDir = path.join(
  root,
  ".omx",
  "cpu-profile",
  new Date().toISOString().replace(/[:.]/g, "-")
);

if (!existsSync(romPath)) throw new Error(`Missing disc image: ${romPath}`);

// ---------------------------------------------------------------------------
// Minimal CDP client. Node 22+ ships a global WebSocket, so this needs no
// dependency. Playwright's newCDPSession only accepts Page/Frame targets;
// Emscripten pthreads are dedicated workers, reachable only by connecting to
// their own debugger URL from /json/list.
// ---------------------------------------------------------------------------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`CDP connect failed: ${url}`)), {
        once: true
      });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function importPlaywright() {
  const local = path.join(root, ".omx", "browser-probe", "node_modules", "playwright", "index.mjs");
  if (existsSync(local)) return import(pathToFileURL(local).href);
  return import("playwright");
}

// ---------------------------------------------------------------------------

const { chromium } = await importPlaywright();
await mkdir(outDir, { recursive: true });

const url = new URL(baseUrl);
url.searchParams.set("core", "upstream");
url.searchParams.set("video", process.env.VIDEO || "software");
url.searchParams.set("presenter", process.env.PRESENTER || "webgpu");
url.searchParams.set("cpu", process.env.CPU || "dual");
url.searchParams.set("speed", process.env.SPEED || "1");
url.searchParams.set("wasmjit", process.env.WASMJIT || "1");
url.searchParams.set("jitwarmup", process.env.JITWARMUP || "60");
url.searchParams.set("jittier", process.env.JITTIER || "guarded");
// forcejit keeps the JIT engaged past the post-activation stall fuse. Per
// §28bp that fuse fires spuriously on the WebGPU presenter path (its
// presentation-derived triggers are structurally ~0 there), which would
// disable the JIT mid-capture and corrupt a steady-state measurement.
// Opt-in: it is a real speed/smoothness tradeoff for shipping, but for
// profiling we want the JIT to stay on for the whole window.
if (process.env.FORCEJIT) url.searchParams.set("forcejit", process.env.FORCEJIT);
url.searchParams.set("oc", process.env.OC || "1");
url.searchParams.set("pacing", process.env.PACING || "tick");
url.searchParams.set("fastsw", process.env.FASTSW || "1");
url.searchParams.set("metrics", "1");

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || "chrome",
  headless: !headed,
  args: [
    `--remote-debugging-port=${debugPort}`,
    "--autoplay-policy=no-user-gesture-required",
    "--enable-unsafe-webgpu",
    "--enable-features=CalculateNativeWinOcclusion"
  ]
});

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.stack || e.message}`));

console.log(`[profile] ${url.toString()}`);
console.log(`[profile] rom: ${romPath}`);
await page.goto(url.toString(), { waitUntil: "domcontentloaded" });

// app.js is reached through a TOP-LEVEL AWAIT in bootstrap.js, so it evaluates
// AFTER domcontentloaded. Setting #romInput before then fires a change event at
// no listener: the input holds the file, nothing reads it, and the run silently
// falls back to the built-in demo scene. That is not hypothetical -- it wasted
// three profiling runs, each reporting "Demo scene ... jitc=0/0" for five
// minutes. boot-matrix.mjs already waits for this; see ARCHITECTURE.md.
await page
  .waitForFunction(
    () => {
      const pill = document.querySelector("#statusPill");
      return Boolean(pill) && pill.textContent.trim() !== "" &&
             !/^Booting/i.test(pill.textContent.trim());
    },
    { timeout: 60000 }
  )
  .catch(() => {
    console.log("[profile] WARNING: #statusPill never left Booting; mount may not take");
  });

await page.setInputFiles("#romInput", romPath);
console.log("[profile] disc mounted; booting");

const bootedAt = Date.now();
const elapsed = () => (Date.now() - bootedAt) / 1000;

// Read the live HUD pills. These are the elements the app actually updates
// each frame; #gameSpeedCounter / #ppcWasmHelperStats stay at placeholder
// values ("0%" / "-") and must NOT be used to judge run health.
async function readStats() {
  return page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? "";
    return {
      speed: text("#hudSpeed"),
      coreFps: text("#hudCoreFps"),
      presentFps: text("#hudFps"),
      visualFps: text("#hudVisualFps"),
      jit: text("#hudJit"),
      jitCache: text("#hudJitCache"),
      frame: text("#hudFrame"),
      mode: text("#hudMode"),
      helper: text("#ppcWasmHelperStats"),
      status: text("#statusPill"),
      title: text("#gameTitle")
    };
  }).catch(() => ({}));
}

const numOf = (s) => Number(/(-?\d+(?:\.\d+)?)/.exec(s || "")?.[1] ?? 0);
const speedOf = (s) => numOf(s.speed);
const jitOn = (s) => /jit\s*on/i.test(s.jit || "");
// "28/28 jitc" — compiled/total. Plateau on the compiled side.
const compiledOf = (s) => numOf(s.jitCache);

// Optional save state: the only practical way to reach a warm in-game scene
// (a race, a battle) rather than profiling an attract loop or a menu.
let saveStateLoaded = false;

// Warm-up gate. Two conditions, both required:
//   1. the JIT is engaged
//   2. the compile count has stopped climbing (compile burst is over)
// Profiling during the burst measures compilation, not steady-state execution.
console.log(`[profile] warming up (min ${warmupSeconds}s, waiting for compile plateau)`);
let lastCompiled = -1;
let plateauTicks = 0;
let warm = false;

while (elapsed() < warmupSeconds + 240) {
  await sleep(2000);
  const stats = await readStats();

  if (saveStateUrl && !saveStateLoaded && elapsed() >= saveStateAt) {
    try {
      await page.evaluate((u) => window.__loadStateFile(u), saveStateUrl);
      saveStateLoaded = true;
      console.log(`[profile] t=${elapsed().toFixed(0)}s loaded save state ${saveStateUrl}`);
    } catch (err) {
      console.warn(`[profile] save state load failed: ${err.message}`);
      saveStateLoaded = true;
    }
  }

  // Warm requires all three: JIT engaged, the game actually advancing, and
  // the compile count settled. Speed alone can look fine mid-compile-burst.
  const compiled = compiledOf(stats);
  const advancing = speedOf(stats) > 20;
  if (jitOn(stats) && advancing && compiled === lastCompiled) plateauTicks++;
  else plateauTicks = 0;
  lastCompiled = compiled;

  if (elapsed() % 10 < 2) {
    console.log(
      `[profile] t=${elapsed().toFixed(0)}s speed=${stats.speed} core=${stats.coreFps} ` +
      `visual=${stats.visualFps} ${stats.jit} jitc=${stats.jitCache} ` +
      `plateau=${plateauTicks} | ${stats.title}`
    );
  }

  // 4 consecutive quiet 2s ticks = 8s with no new compiles.
  if (elapsed() >= warmupSeconds && plateauTicks >= 4) { warm = true; break; }
}

const preStats = await readStats();
// Always screenshot at the warm-up boundary. When a run fails to reach a
// steady state the counters alone cannot distinguish "stuck in a menu",
// "black screen / presenter dead", and "core stalled" — the frame can.
try {
  await page.screenshot({ path: path.join(outDir, "warmup-boundary.png"), timeout: 10000 });
} catch (err) {
  console.warn(`[profile] screenshot failed: ${err.message}`);
}
if (!warm) {
  console.warn(
    "[profile] WARNING: never reached a compile plateau. The capture below is " +
    "NOT a clean warm steady state — treat it as indicative only."
  );
}
if (!jitOn(preStats)) {
  console.warn("[profile] WARNING: JIT does not appear engaged. Check flags/warmup.");
}

// Attach to every worker target and profile them all. The CPU pthread is one
// of several workers (discio, audio, renderer); which one is which is decided
// at analysis time from the samples, not guessed here.
const targets = (await listTargets()).filter(
  (t) => t.type === "worker" || t.type === "shared_worker" || t.type === "page"
);
console.log(`[profile] attaching to ${targets.length} targets`);

const sessions = [];
for (const target of targets) {
  if (!target.webSocketDebuggerUrl) continue;
  try {
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: sampleUs });
    await cdp.send("Profiler.start");
    sessions.push({ target, cdp });
  } catch (err) {
    console.warn(`[profile] skip ${target.type} ${target.title}: ${err.message}`);
  }
}

if (sessions.length === 0) {
  await browser.close();
  throw new Error("No profileable targets. Is the core running?");
}

console.log(`[profile] capturing ${profileSeconds}s at ${sampleUs}us across ${sessions.length} targets`);
await sleep(profileSeconds * 1000);

const written = [];
for (const { target, cdp } of sessions) {
  try {
    const { profile } = await cdp.send("Profiler.stop");
    if (!profile?.samples?.length) continue;
    const safe = `${target.type}-${(target.url || "").split("/").pop() || "root"}`
      .replace(/[^a-z0-9.\-]/gi, "_")
      .slice(0, 80);
    const file = path.join(outDir, `${safe}-${target.id.slice(0, 8)}.cpuprofile`);
    await writeFile(file, JSON.stringify(profile));
    written.push({ file, samples: profile.samples.length, url: target.url, type: target.type });
  } catch (err) {
    console.warn(`[profile] stop failed for ${target.type}: ${err.message}`);
  } finally {
    cdp.close();
  }
}

const postStats = await readStats();
await writeFile(
  path.join(outDir, "run.json"),
  JSON.stringify(
    {
      rom: romPath,
      url: url.toString(),
      warm,
      warmupSeconds,
      profileSeconds,
      sampleUs,
      saveStateUrl: saveStateUrl || null,
      preStats,
      postStats,
      profiles: written
    },
    null,
    2
  )
);
await writeFile(path.join(outDir, "console.log"), consoleLines.join("\n"));

await browser.close();

console.log(`\n[profile] wrote ${written.length} profiles to ${outDir}`);
for (const w of written) console.log(`  ${w.samples.toString().padStart(7)} samples  ${w.type}  ${path.basename(w.file)}`);
console.log(`\nNext: node tools/cpu-profile-analyze.mjs ${outDir}`);
