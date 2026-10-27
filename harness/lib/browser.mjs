// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Chrome (isolated profile, headless by default) + local server plumbing for the harness.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clockCheck, FRAME_FIELDS, withDeterministicClock } from "./matrix.mjs";
import { decodePng } from "./png.mjs";
import { ensureServer as serveTree } from "./server.mjs";

// The checkout root two levels above a module, as a file system path. A URL's
// pathname is not one: on Windows it reads /C:/…, and spaces or accents stay
// percent-encoded on every system.
export function repoRootOf(moduleUrl, { windows = process.platform === "win32" } = {}) {
  const root = fileURLToPath(new URL("../..", moduleUrl), { windows });
  return (windows ? path.win32 : path.posix).resolve(root);
}

export const REPO_ROOT = repoRootOf(import.meta.url);

// Messages that mean the emulator is dead or the JIT emitted bad code.
export const FATAL_PATTERN = /CompileError|LinkError|RuntimeError|WebAssembly\.Module|unreachable executed|Aborted\(|out of memory|worker (?:error|crashed)|memory access out of bounds/i;

export async function importPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href);
  try {
    return await import("playwright");
  } catch {}
  // playwright-cli (the browser driver used for the evaluation) ships playwright.
  // npm is npm.cmd on Windows, which only runs through a shell.
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
  for (const candidate of [
    path.join(globalRoot, "@playwright", "cli", "node_modules", "playwright", "index.mjs"),
    path.join(globalRoot, "playwright", "index.mjs")
  ]) {
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  throw new Error("playwright not found: npm i -g @playwright/cli, or set PLAYWRIGHT_MODULE");
}

export function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms); })
  ]);
}

// Served in-process with an identity check: see server.mjs.
export async function ensureServer({ port, root = REPO_ROOT, patches = [], coreCandidates = [] }) {
  return serveTree({ port, root, patches, coreCandidates });
}

// The browser never shows up on this Mac (PROGRAM.md, "ne jamais gêner
// l'utilisateur"): Chrome --headless=new only. Captures are made by the core
// at an exact VI output, so the compositor does not matter, and WebGPU
// (Apple metal-3) works there; captures were checked byte-identical to a
// windowed Chrome, for software and wgpu. Every windowed variant was tried
// and showed a window (window-position off screen: moved back on screen;
// open -j -g: shown when Chrome opens it), so none is offered. As a guard,
// after launch and after boot no window of our Chrome may be on screen;
// otherwise it is closed and the run fails.
//
// x11, Linux only: Chrome shown on an X server with no screen attached, the
// Spark bench's bare Xorg (salon-xorg.service, DISPLAY=:2) driving a fake
// 1920x1080 panel at 120.00 Hz (EDID SALON120): a real BeginFrame source at
// the screen's rate, which headless (60 Hz, synthetic) is not, for the
// display probes at 120 Hz. No window manager: the window is placed full
// screen at 0,0 by its own flags. WebGPU on the NVIDIA GPU needs Vulkan
// (without it the rAF ran at 1 Hz or WebGPU fell to SwiftShader), with a
// real Vulkan surface: --disable-vulkan-surface put Chrome on a synthetic
// 60 Hz BeginFrame source (16.67 ms, 21-37 BeginFrames a second under the
// emulator). ThrottleRepeatedNoDamageFrames halves the cadence while nothing
// changes (120 -> 60 -> 30 Hz): off, for clean display measures. Blank page
// on :2 with these flags: rAF 8.3 ms median (p5 8.2, p95 8.4), WebGPU canvas
// at 120.01 fps on the NVIDIA adapter, chrome://gpu refresh 120.0032 Hz.
// Refused on macOS whatever the environment: headless stays the only mode
// on the user's Mac. Chosen by HARNESS_DISPLAY=x11 (spark-run --headed).
export const DISPLAYS = Object.freeze(["headless", "x11"]);
export const X11_ARGS = Object.freeze(["--enable-features=Vulkan", "--use-angle=vulkan", "--disable-features=ThrottleRepeatedNoDamageFrames", "--window-position=0,0", "--window-size=1920,1080"]);

// Chrome keeps only the last --enable-features and the last
// --disable-features: every one of each becomes a single flag carrying all
// their values, at the first one's place.
export function mergeFeatureFlags(args) {
  const lists = new Map();
  const out = [];
  for (const a of args) {
    const m = /^(--(?:enable|disable)-features)=(.*)$/.exec(a);
    if (!m) {
      out.push(a);
      continue;
    }
    if (!lists.has(m[1])) {
      lists.set(m[1], []);
      out.push(m[1]);
    }
    for (const v of m[2].split(",").filter(Boolean)) if (!lists.get(m[1]).includes(v)) lists.get(m[1]).push(v);
  }
  return out.map((a) => (lists.has(a) ? `${a}=${lists.get(a).join(",")}` : a));
}

const FEATURE_FLAG = /^--(?:enable|disable)-features=/;

// Playwright passes its own --disable-features (PaintHolding,
// ThirdPartyStoragePartitioning…, a list that changes with its version) and
// --enable-features before ours: Chrome keeping only the last of each, a
// feature flag of ours dropped Playwright's. So when we pass one, Playwright's
// are taken out (ignoreDefaultArgs) and merged back into ours.
export function withPlaywrightFeatures(args, defaults) {
  if (!args.some((a) => FEATURE_FLAG.test(a)) || !defaults?.length) return { args: mergeFeatureFlags(args), ignoreDefaultArgs: undefined };
  return { args: mergeFeatureFlags([...defaults, ...args]), ignoreDefaultArgs: defaults };
}

// Playwright's feature flags for a launch, as it passes them: read from a
// stand-in executable that writes its arguments down and exits (~0.2 s, once
// per process and mode; no Chrome starts). null where a shell script cannot
// stand in (Windows).
const playwrightFeatures = new Map();
export function playwrightFeatureArgs(chromium, { headless, platform = process.platform } = {}) {
  if (platform === "win32") return Promise.resolve(null);
  if (!playwrightFeatures.has(headless)) {
    playwrightFeatures.set(headless, (async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "gc-harness-argv-"));
      const stub = path.join(dir, "chrome");
      try {
        writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.args"\nexit 1\n`, { mode: 0o755 });
        await chromium.launch({ executablePath: stub, headless, timeout: 15000 }).then((b) => b.close(), () => {});
        return readFileSync(`${stub}.args`, "utf8").split("\n").filter((a) => FEATURE_FLAG.test(a));
      } catch {
        return null;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })());
  }
  return playwrightFeatures.get(headless);
}

// The display mode when the caller names none: HARNESS_DISPLAY, else headless.
export function defaultDisplay(env = process.env) {
  return env.HARNESS_DISPLAY || "headless";
}

const ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  // Chrome for Testing opens a visible macOS keychain dialog even headless
  // without these (research/deep-memory-footprint.md). Playwright passes them
  // by default; stated here so no launch depends on its defaults.
  "--use-mock-keychain",
  "--password-store=basic",
  "--enable-unsafe-webgpu",
  // Audio must run without a user gesture so underruns and silence can be measured.
  "--autoplay-policy=no-user-gesture-required",
  // No background throttling of timers, rAF or renderers.
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling"
];

export function chromeLaunchOptions(display = defaultDisplay(), { unsafeWebgpu = true, platform = process.platform, env = process.env } = {}) {
  if (!DISPLAYS.includes(display)) throw new Error(`--display ${display}: the harness only runs headless (no window may appear on this Mac)`);
  // unsafeWebgpu: false launches Chrome as a player has it (no
  // --enable-unsafe-webgpu), e.g. to see the adapter a GPU-less PC gets.
  const args = unsafeWebgpu ? ARGS : ARGS.filter((a) => a !== "--enable-unsafe-webgpu");
  if (display === "x11") {
    if (platform !== "linux") throw new Error(`--display x11: Linux only (the Spark's bare Xorg); on ${platform} the harness only runs headless`);
    if (!env.DISPLAY) throw new Error("--display x11: DISPLAY is not set (the Spark's bare Xorg is :2, spark-run --headed)");
    return { headless: false, viewport: null, args: [...args, ...X11_ARGS] };
  }
  return { headless: true, viewport: { width: 1280, height: 800 }, args };
}

export async function launchChrome({ profileDir, display = defaultDisplay(), args = [], unsafeWebgpu = true }) {
  const opts = chromeLaunchOptions(display, { unsafeWebgpu });
  const { chromium } = await importPlaywright();
  // HARNESS_CHROME_PATH: run this executable instead of Chrome stable, e.g. a
  // wrapper that confines Chrome to the efficiency cores (docs/consumer-perf-extrapolation.md).
  const executablePath = process.env.HARNESS_CHROME_PATH || undefined;
  // HARNESS_CHROME_ARGS: extra flags for one machine (e.g. Linux WebGPU:
  // "--enable-features=Vulkan --use-angle=vulkan"), space-separated.
  const own = [...opts.args, ...(process.env.HARNESS_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean), "--enable-logging", "--v=0", `--log-file=${path.join(profileDir, "chrome.log")}`, `--crash-dumps-dir=${path.join(profileDir, "crash-dumps")}`, ...args];
  const defaults = own.some((a) => FEATURE_FLAG.test(a)) ? await playwrightFeatureArgs(chromium, { headless: opts.headless }) : null;
  if (own.some((a) => FEATURE_FLAG.test(a)) && !defaults) console.warn("[harness] Playwright's own feature flags could not be read: ours replace them");
  const flags = withPlaywrightFeatures(own, defaults);
  const context = await chromium.launchPersistentContext(profileDir, {
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
    headless: opts.headless,
    // x11: the window's own size (no viewport emulation on a real screen)
    viewport: opts.viewport,
    // Chrome's log and crash dumps stay in the profile; a session whose
    // renderer crashed copies them out as evidence (session.mjs).
    args: flags.args,
    ...(flags.ignoreDefaultArgs ? { ignoreDefaultArgs: flags.ignoreDefaultArgs } : {})
  });
  context.assertInvisible = (when) => assertNoWindow(profileDir, when, () => context.close());
  context.pipeFault = null;
  liveContexts.add(context);
  context.on("close", () => liveContexts.delete(context));
  installPipeGuard();
  return context;
}

// Playwright talks to Chrome over a pipe of NUL-separated JSON messages. On
// this Mac under heavy load (2026-10-19, load 100+, several sessions at the
// same minutes) Chrome's side sometimes yields an empty message:
// JSON.parse("") throws in Playwright's own timer callback, outside any
// harness code, and would kill the process with every run not yet written.
// The guard recognises that fault only, marks the contexts open at that
// moment (context.pipeFault) and closes them: their pending calls fail, the
// run reports an infra crash (cli.mjs, probes) and the harness goes on. Any
// other uncaught exception ends the process as node would.
const liveContexts = new Set();
let pipeGuard = null;

export function isPipeFault(error) {
  const stack = String(error?.stack ?? "");
  return error instanceof SyntaxError && /JSON/.test(String(error.message)) && /playwright-core/.test(stack) && /JSON\.parse/.test(stack);
}

export function onUncaught(error, { contexts = liveContexts, exit = (e) => { console.error(e); process.exit(1); } } = {}) {
  if (!isPipeFault(error)) return exit(error);
  const fault = { at: new Date().toISOString(), message: String(error.message), contexts: contexts.size };
  console.error(`[harness] infra: Chrome's CDP pipe sent an unreadable message (${fault.message}); closing ${contexts.size} browser(s), the run is reported as an infra crash`);
  for (const context of [...contexts]) {
    context.pipeFault ??= fault;
    contexts.delete(context);
    context.close().catch(() => {});
  }
  return fault;
}

export function installPipeGuard() {
  if (pipeGuard) return;
  pipeGuard = (error) => onUncaught(error);
  process.on("uncaughtException", pipeGuard);
}

let windowTool = null;
// Compile onscreen-windows.swift once per checkout version.
function onScreenWindows(pids) {
  if (!windowTool) {
    const src = path.join(REPO_ROOT, "harness", "lib", "onscreen-windows.swift");
    const bin = path.join(os.tmpdir(), `gc-harness-wins-${createHash("sha256").update(readFileSync(src)).digest("hex").slice(0, 12)}`);
    if (!existsSync(bin)) execFileSync("swiftc", ["-O", "-o", bin, src], { stdio: "ignore" });
    windowTool = bin;
  }
  return execFileSync(windowTool, pids.map(String), { encoding: "utf8" }).split("\n").filter(Boolean);
}

function profilePids(profileDir) {
  const out = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 << 20 });
  return out.split("\n").filter((l) => l.includes(profileDir)).map((l) => Number(l.trim().split(/\s+/)[0])).filter(Boolean);
}

// macOS only (the user's screen): the Spark's x11 mode shows Chrome on an X
// server nobody looks at, and Linux has no on-screen window list here.
async function assertNoWindow(profileDir, when, close) {
  if (process.platform !== "darwin") return;
  const visible = onScreenWindows(profilePids(profileDir));
  if (visible.length) {
    await close().catch(() => {});
    throw new Error(`our Chrome has a window on screen ${when} (${visible.join("; ")}): closed`);
  }
}

export function watchPage(page) {
  const events = [];
  const push = (type, text) => events.push({ t: Date.now(), type, text: String(text).slice(0, 2000) });
  page.on("console", (m) => { if (m.type() === "error" || FATAL_PATTERN.test(m.text())) push(`console.${m.type()}`, m.text()); });
  page.on("pageerror", (e) => push("pageerror", e.stack || e.message));
  page.on("crash", () => push("crash", "page crashed"));
  page.on("worker", (w) => {
    w.on("close", () => push("worker.close", w.url()));
    w.on?.("console", (m) => { if (m.type() === "error" || FATAL_PATTERN.test(m.text())) push(`worker.${m.type()}`, m.text()); });
  });
  return {
    events,
    fatal: () => events.filter((e) => e.type === "crash" || FATAL_PATTERN.test(e.text))
  };
}

// Boot a disc and return once the core is loaded, with the harness hooks
// enabled from the start (they are off in normal use). Nothing is asked of
// the worker before it exists: the app creates it asynchronously.
export async function bootIso(page, { url: requestedUrl, iso, timeoutMs = 60000, harness = {} }) {
  if (!existsSync(iso)) throw new Error(`disc image not found: ${iso}`);
  // A single emulated CPU thread runs on the fixed clock that makes it repeat
  // (matrix.mjs), whoever boots it: sessions, probes, direct callers.
  const parsed = new URL(requestedUrl);
  parsed.search = withDeterministicClock(parsed.search.slice(1));
  const url = parsed.href;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("#romInput").waitFor({ state: "attached", timeout: 30000 });
  await page.waitForFunction(() => window.__host?.adapter, null, { timeout: 30000 });
  await page.locator("#romInput").setInputFiles(iso);
  await page.waitForFunction(() => Boolean(window.__host?.adapter?.worker), null, { timeout: timeoutMs });
  // harness: extra switches (detTrace: the determinism trace, from the first event).
  const enabled = await workerRequest(page, "validationEnableHarness", harness, timeoutMs);
  await page.waitForFunction(() => window.__host?.adapter?.loaded === true, null, { timeout: timeoutMs });
  // A fixed clock that the core did not take would compare a host-clock run
  // with a fixed-clock one in silence: check it once the core runs.
  let clock = { fixed: false };
  if (new URLSearchParams(parsed.search).has("rtc")) {
    const end = Date.now() + timeoutMs;
    let progress = null;
    while (Date.now() < end) {
      progress = await readCoreProgress(page);
      if ((progress?.frame ?? 0) > 0 && progress?.emulatedRtc) break;
      await page.waitForTimeout(100);
    }
    clock = clockCheck(parsed.search.slice(1), progress);
    if (clock.error) throw new Error(clock.error);
  }
  return { harness: enabled, url, clock };
}

export async function readFrameInfo(page) {
  return withTimeout(page.evaluate((fields) => {
    const f = window.__lastFrameInfo || {};
    const out = { t: Math.round(performance.now()) };
    for (const [k, src] of Object.entries(fields)) out[k] = f[src] ?? null;
    out.pill = document.querySelector("[class*=status]")?.textContent?.trim() ?? null;
    return out;
  }, FRAME_FIELDS), 15000, "read __lastFrameInfo");
}

// Harness-only worker messages (validation*) exposed by the adapter. A dead
// or wedged worker never answers, hence the timeouts.
export async function workerRequest(page, type, payload = {}, timeoutMs = 10000) {
  const call = page.evaluate(async ([t, p]) => {
    try {
      return await window.__host.adapter.request(t, p);
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }, [type, payload]);
  return withTimeout(call, timeoutMs, type).catch((e) => ({ error: e.message }));
}

export const readCoreProgress = (page) => workerRequest(page, "validationReadCoreProgress");

export async function waitRunning(page, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const p = await readCoreProgress(page);
    if ((p?.frame ?? 0) > 0) return; // frames only advance once Running
    await page.waitForTimeout(100);
  }
  throw new Error("core never reached Running");
}

// Load the savestate the session routes at /__harness_state.sav. VI outputs
// start before the core leaves "Starting", and a load sent then is refused:
// retry for up to `retrySec` while the core says Starting, or Uninitialized
// (between the end of booting and the hardware's init, a load is refused too:
// race-perf 2026-10-20 14:00 r5, "loaded":false at frame 82).
export async function loadHarnessState(page, url, { retrySec = 60 } = {}) {
  await waitRunning(page);
  let loaded;
  for (let tries = 0; tries < retrySec; tries += 1) {
    loaded = await pageCall(page, "__loadStateFile", new URL("__harness_state.sav", url).href, 120000);
    if (loaded?.loaded || !["Starting", "Uninitialized"].includes(loaded?.beforeState)) break;
    await page.waitForTimeout(1000);
  }
  return loaded;
}

// The XFB the core scanned out at VI output `index` (since boot, or since
// the last savestate load), captured by the core itself at that output.
// Returns { index, ticks, width, height, data, source } or { error }: an
// output that passed, never comes, or a core without the hook is an error,
// never a picture.
export async function captureAtVi(page, { index, ahead, fromLoad = false, timeoutMs = 60000 }) {
  const call = page.evaluate(async ([payload]) => {
    try {
      const r = await window.__host.adapter.request("validationCaptureAtVi", payload);
      const u8 = new Uint8Array(r.pixels.buffer ?? r.pixels);
      let bin = "";
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return { index: r.index, fromLoad: r.fromLoad, ticks: r.ticks, width: r.width, height: r.height, source: r.source, b64: btoa(bin) };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }, [{ index, ahead, fromLoad, timeoutMs }]);
  const r = await withTimeout(call, timeoutMs + 15000, "validationCaptureAtVi").catch((e) => ({ error: e.message }));
  if (r.error) return r;
  const { b64, ...rest } = r;
  return { ...rest, data: new Uint8Array(Buffer.from(b64, "base64")) };
}

// Everything the worker and the core recorded since the previous read:
// every presentation and every VI output, nothing sampled.
export const readTimeline = (page) => workerRequest(page, "validationReadTimeline", {}, 30000);

export async function pageCall(page, fnName, arg, timeoutMs = 60000) {
  const call = page.evaluate(([name, a]) => window[name](a), [fnName, arg]);
  return withTimeout(call, timeoutMs, fnName).catch((e) => ({ error: e.message }));
}

// Grab the displayed frame as RGBA, for pictures people look at. Never
// used to judge rendering: that is captureAtVi's job. Primary path is canvas.captureStream()
// (the same path a WebRTC host would use); fallback is an element screenshot.
export async function grabFrame(page) {
  const grabbed = await withTimeout(page.evaluate(async () => {
    try {
      const canvas = document.getElementById("screen");
      let video = window.__harnessCaptureVideo;
      if (!video) {
        video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = canvas.captureStream(60);
        window.__harnessCaptureVideo = video;
      }
      if (video.paused) {
        // play() only resolves once the stream has produced a frame.
        await Promise.race([video.play(), new Promise((r) => setTimeout(r, 3000))]);
      }
      // A canvas only feeds the stream when it repaints. A static picture
      // (e.g. an XFB-only homebrew) sends no new frame, so after a short wait
      // the last frame the stream delivered is the current one.
      const fresh = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 1500);
        video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(true); });
      });
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h || video.readyState < 2) throw new Error("no frame captured yet");
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(video, 0, 0);
      const data = g.getImageData(0, 0, w, h).data;
      let bin = "";
      for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
      return { width: w, height: h, b64: btoa(bin), source: fresh ? "captureStream" : "captureStream (no repaint in 1.5 s, last frame)" };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }), 15000, "captureStream grab").catch((e) => ({ error: e.message }));
  if (!grabbed.error) {
    return { width: grabbed.width, height: grabbed.height, data: new Uint8Array(Buffer.from(grabbed.b64, "base64")), source: grabbed.source };
  }
  // Last resort (the canvas has not repainted since the stream was opened):
  // an element screenshot, with the HUD and notices over the canvas hidden.
  const png = await page.locator("#screen").screenshot({
    timeout: 15000,
    style: ".screen-viewport > :not(canvas), .screen-osd { visibility: hidden !important; }"
  });
  return { ...decodePng(png), source: `screenshot (captureStream failed: ${grabbed.error})` };
}
