// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Chrome (headed, isolated profile) + local server plumbing for the harness.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FRAME_FIELDS } from "./matrix.mjs";
import { decodePng } from "./png.mjs";

export const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

// Messages that mean the emulator is dead or the JIT emitted bad code.
export const FATAL_PATTERN = /CompileError|LinkError|RuntimeError|WebAssembly\.Module|unreachable executed|Aborted\(|out of memory|worker (?:error|crashed)|memory access out of bounds/i;

export async function importPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href);
  try {
    return await import("playwright");
  } catch {}
  // playwright-cli (the browser driver used for the evaluation) ships playwright.
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
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

// Start tools/serve.mjs on 127.0.0.1:port unless this worktree is already
// served there. Refuses to reuse a server whose app differs from this tree.
export async function ensureServer({ port, root = REPO_ROOT }) {
  const base = `http://127.0.0.1:${port}/`;
  const probePath = "src/app.js"; // serve.mjs only serves an allowlist (index.html, src/, cores/)
  const expected = readFileSync(path.join(root, probePath), "utf8");
  const probe = async () => {
    try {
      const res = await fetch(base + probePath);
      return { up: true, ours: res.ok && (await res.text()) === expected };
    } catch {
      return { up: false, ours: false };
    }
  };
  let state = await probe();
  if (state.up && !state.ours) throw new Error(`port ${port} is served from another tree; stop it or pick another --port`);
  if (state.ours) return { base, stop: async () => {}, owned: false };
  const child = spawn(process.execPath, ["tools/serve.mjs"], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 50 && !(state = await probe()).ours; i += 1) await new Promise((r) => setTimeout(r, 100));
  if (!state.ours) {
    child.kill();
    throw new Error(`server did not come up on ${base}: ${log}`);
  }
  return {
    base,
    owned: true,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      child.kill();
    })
  };
}

export async function launchChrome({ profileDir, headed = true, channel = "chrome", args = [] }) {
  const { chromium } = await importPlaywright();
  if (!headed) console.warn("[harness] headless: rendering numbers are not valid (PROGRAM.md rule 4)");
  return chromium.launchPersistentContext(profileDir, {
    channel,
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: ["--no-first-run", "--no-default-browser-check", ...args]
  });
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

export async function bootIso(page, { url, iso }) {
  if (!existsSync(iso)) throw new Error(`disc image not found: ${iso}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("#romInput").waitFor({ state: "attached", timeout: 30000 });
  // Give the worker a moment to finish module init, as the manual runs did.
  await page.waitForFunction(() => window.__host?.adapter || window.__lastFrameInfo, null, { timeout: 30000 }).catch(() => {});
  await page.locator("#romInput").setInputFiles(iso);
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
export const setCorePaused = (page, paused) => workerRequest(page, "validationSetCorePaused", { paused });

export async function pageCall(page, fnName, arg, timeoutMs = 60000) {
  const call = page.evaluate(([name, a]) => window[name](a), [fnName, arg]);
  return withTimeout(call, timeoutMs, fnName).catch((e) => ({ error: e.message }));
}

// Wait until the core has run at least `frames` frames (or timeout).
export async function waitForCoreFrame(page, frames, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await readCoreProgress(page);
    if (last?.error && /no answer/.test(last.error)) return { ...last, timedOut: true };
    if (last?.frame >= frames) return last;
    await page.waitForTimeout(250);
  }
  return { ...last, timedOut: true };
}

// Grab the displayed frame as RGBA. Primary path is canvas.captureStream()
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
        await video.play();
        window.__harnessCaptureVideo = video;
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no video frame within 3 s")), 3000);
        video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
      });
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) throw new Error("empty capture");
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(video, 0, 0);
      const data = g.getImageData(0, 0, w, h).data;
      let bin = "";
      for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
      return { width: w, height: h, b64: btoa(bin), source: "captureStream" };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }), 15000, "captureStream grab").catch((e) => ({ error: e.message }));
  if (!grabbed.error) {
    return { width: grabbed.width, height: grabbed.height, data: new Uint8Array(Buffer.from(grabbed.b64, "base64")), source: grabbed.source };
  }
  const png = await page.locator("#screen").screenshot({ timeout: 15000 });
  return { ...decodePng(png), source: `screenshot (captureStream failed: ${grabbed.error})` };
}
