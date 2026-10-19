// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Chrome (isolated profile, headless by default) + local server plumbing for the harness.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
export const DISPLAYS = Object.freeze(["headless"]);

const ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--enable-unsafe-webgpu",
  // Audio must run without a user gesture so underruns and silence can be measured.
  "--autoplay-policy=no-user-gesture-required",
  // No background throttling of timers, rAF or renderers.
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling"
];

export function chromeLaunchOptions(display = "headless") {
  if (!DISPLAYS.includes(display)) throw new Error(`--display ${display}: the harness only runs headless (no window may appear on this Mac)`);
  return { headless: true, args: ARGS };
}

export async function launchChrome({ profileDir, display = "headless", args = [] }) {
  const opts = chromeLaunchOptions(display);
  const { chromium } = await importPlaywright();
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: opts.headless,
    viewport: { width: 1280, height: 800 },
    // Chrome's log and crash dumps stay in the profile; a session whose
    // renderer crashed copies them out as evidence (session.mjs).
    // HARNESS_CHROME_ARGS: extra flags for one machine (e.g. Linux WebGPU:
    // "--enable-features=Vulkan --use-angle=vulkan"), space-separated.
    args: [...opts.args, ...(process.env.HARNESS_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean), "--enable-logging", "--v=0", `--log-file=${path.join(profileDir, "chrome.log")}`, `--crash-dumps-dir=${path.join(profileDir, "crash-dumps")}`, ...args]
  });
  context.assertInvisible = (when) => assertNoWindow(profileDir, when, () => context.close());
  return context;
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
// retry for up to `retrySec` while the core says Starting.
export async function loadHarnessState(page, url, { retrySec = 60 } = {}) {
  await waitRunning(page);
  let loaded;
  for (let tries = 0; tries < retrySec; tries += 1) {
    loaded = await pageCall(page, "__loadStateFile", new URL("__harness_state.sav", url).href, 120000);
    if (loaded?.loaded || loaded?.beforeState !== "Starting") break;
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
