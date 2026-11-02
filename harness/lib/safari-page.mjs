// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Real Safari for a probe (macOS only), through safaridriver (WebDriver): a
// page object with the few Playwright calls the parcours makes (goto,
// evaluate, waitForFunction, waitForTimeout, locator(...).waitFor/screenshot,
// mouse.click, on), so the probe's loop runs unchanged in Safari.
//  - Safari must not already run (those would be the user's windows); the
//    session's window goes off screen at once, and an optional focus guard
//    (SAFARI_FOCUS_GUARD: a binary re-activating the given app) gives the
//    focus back; the screen must stay unlocked (a locked screen hides the
//    page and Safari drops the window ~30 s later).
//  - Safari cannot be handed a file: the disc is served by HTTP ranges on
//    127.0.0.1 (startDiscServer) and mounted as the worker's remote disc
//    descriptor { remoteDisc, name, size } (src/remote-disc.js: loopback only).
//  - close() ends the session, stops safaridriver, quits Safari (killed if it
//    hangs) and removes the WebDriver session folders it left: every call has
//    a timeout.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createReadStream, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTOMATION_DIR = `${homedir()}/Library/Containers/com.apple.Safari/Data/tmp/SafariAutomation`;
const SESSION_DIR = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const pids = (name) => (spawnSync("pgrep", ["-x", name], { encoding: "utf8", timeout: 10_000 }).stdout ?? "").split("\n").filter(Boolean).map(Number);
const automationDirs = () => { try { return readdirSync(AUTOMATION_DIR).filter((n) => SESSION_DIR.test(n)); } catch { return []; } };
const osa = (script) => execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" }).trim();
const frontmostBundle = () => { try { return osa('tell application "System Events" to get bundle identifier of first application process whose frontmost is true'); } catch { return null; } };

// The disc by HTTP ranges, readable from a cross-origin isolated page.
export function startDiscServer(iso, { port }) {
  const size = statSync(iso).size;
  const name = path.basename(iso);
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "range", "access-control-expose-headers": "content-range",
    "cross-origin-resource-policy": "cross-origin", "cache-control": "no-store", "content-type": "application/octet-stream" };
  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, headers); return res.end(); }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
    if (!m || req.url !== `/${encodeURIComponent(name)}`) { res.writeHead(m ? 404 : 416, headers); return res.end(); }
    const a = Number(m[1]), b = Math.min(Number(m[2]), size - 1);
    res.writeHead(206, { ...headers, "content-range": `bytes ${a}-${b}/${size}`, "content-length": b - a + 1 });
    createReadStream(iso, { start: a, end: b }).pipe(res);
  }).listen(port, "127.0.0.1");
  return { descriptor: { remoteDisc: `http://127.0.0.1:${port}/${encodeURIComponent(name)}`, name, size }, close: () => server.close() };
}

// The engine app's boot of a remote disc: what bootIso does with a file
// input, through the page's host (mountFile + start).
export async function bootRemoteDisc(page, { url, descriptor, timeoutMs = 120000 }) {
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.__host?.adapter), null, { timeout: 30000 });
  await page.evaluate(async (d) => { await window.__host.mountFile(d); window.__host.start(); return true; }, descriptor);
  await page.waitForFunction(() => window.__host?.adapter?.loaded === true, null, { timeout: timeoutMs });
}

export async function launchSafariPage({ port = 8306, log = () => {} } = {}) {
  if (pids("Safari").length) throw new Error("Safari is already running: the user's own windows, no run");
  const before = new Set(automationDirs());
  const front = frontmostBundle();
  const guardBin = process.env.SAFARI_FOCUS_GUARD;
  const guard = guardBin ? spawn(guardBin, [front ?? "com.apple.finder"], { stdio: "ignore" }) : null;
  const driver = spawn("/usr/bin/safaridriver", ["-p", String(port)], { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  let id = null, closed = false;
  const cmd = async (method, p, body) => {
    const res = await fetch(id ? `${base}/session/${id}${p}` : `${base}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(150_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`webdriver ${method} ${p}: ${res.status} ${JSON.stringify(json.value ?? json).slice(0, 300)}`);
    return json.value;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    try { if (id) await Promise.race([cmd("DELETE", ""), sleep(10_000)]); } catch {}
    id = null;
    try { driver.kill(); } catch {}
    try { osa('tell application "Safari" to quit'); } catch {}
    for (let i = 0; i < 50 && pids("Safari").length; i++) await sleep(200);
    for (const pid of pids("Safari")) try { process.kill(pid, "SIGKILL"); } catch {}
    try { guard?.kill(); } catch {}
    if (!pids("Safari").length) for (const n of automationDirs()) if (!before.has(n)) try { rmSync(`${AUTOMATION_DIR}/${n}`, { recursive: true, force: true }); } catch {}
    if (front) try { osa(`tell application id "${front}" to activate`); } catch {}
  };
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await (await fetch(`${base}/status`, { signal: AbortSignal.timeout(5_000) })).json()).value?.ready) break; } catch {}
      await sleep(100);
    }
    const created = await cmd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
    id = created?.sessionId;
    if (!id) throw new Error("no Safari session");
    await cmd("POST", "/timeouts", { script: 120_000, pageLoad: 120_000, implicit: 0 });
    await cmd("POST", "/window/rect", { x: 20000, y: 20000, width: 1280, height: 800 });
    if (front) try { osa(`tell application id "${front}" to activate`); } catch {}
  } catch (e) {
    await close();
    throw e;
  }
  // A function's source and one argument, run in the page; a thrown error
  // comes back as an error (Playwright's evaluate semantics).
  const evaluate = async (fn, arg) => {
    const r = await cmd("POST", "/execute/async", {
      script: `const done = arguments[arguments.length - 1]; Promise.resolve().then(() => (${String(fn)})(arguments[0])).then((v) => done({ ok: true, v: v === undefined ? null : v }), (e) => done({ ok: false, e: String(e && e.stack || e) }));`,
      args: [arg === undefined ? null : arg]
    });
    if (!r?.ok) throw new Error(r?.e ?? "evaluate failed");
    return r.v;
  };
  const waitForFunction = async (fn, arg, { timeout = 30000 } = {}) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await evaluate(fn, arg).catch(() => false)) return true;
      if (Date.now() > deadline) throw new Error(`waitForFunction: ${timeout} ms`);
      await sleep(100);
    }
  };
  const page = {
    goto: (url) => cmd("POST", "/url", { url }),
    evaluate,
    waitForFunction,
    waitForTimeout: (ms) => sleep(ms),
    on: () => {},
    mouse: {
      click: (x, y) => cmd("POST", "/actions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
        { type: "pointerMove", x: Math.round(x), y: Math.round(y), origin: "viewport" }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] })
    },
    locator: (selector) => ({
      waitFor: ({ timeout = 30000 } = {}) => waitForFunction((s) => Boolean(document.querySelector(s)), selector, { timeout }),
      // The element's pixels as a PNG (Playwright's style option has no
      // WebDriver equivalent: overlays stay in the picture).
      screenshot: async () => {
        const el = await cmd("POST", "/element", { using: "css selector", value: selector });
        return Buffer.from(await cmd("GET", `/element/${Object.values(el)[0]}/screenshot`), "base64");
      },
      setInputFiles: async () => { throw new Error("Safari cannot be handed a file: use bootRemoteDisc"); }
    })
  };
  log(`safari: session ${id} (${created?.capabilities?.browserVersion ?? "?"})`);
  return { page, close, browserVersion: created?.capabilities?.browserVersion ?? null };
}
