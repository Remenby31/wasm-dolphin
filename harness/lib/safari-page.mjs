// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Real Safari for a probe (macOS only), through safaridriver (WebDriver): a
// page object with the few Playwright calls the parcours makes (goto,
// evaluate, waitForFunction, waitForTimeout, locator(...).waitFor/screenshot,
// mouse.click, on), so the probe's loop runs unchanged in Safari.
//  - Safari must not already run (those would be the user's windows). The
//    session's Safari is known by its exact pid (the one process "Safari"
//    that appeared with the session): only that pid is ever stopped, never a
//    process found by name.
//  - The window goes off screen at once and its position is read back: a
//    window that overlaps the desktop aborts the run (assertInvisible, as
//    Chrome's). An optional focus guard (SAFARI_FOCUS_GUARD: a binary
//    re-activating the given app) gives the focus back. The screen must stay
//    unlocked (a locked screen hides the page and Safari drops the window
//    ~30 s later).
//  - Safari cannot be handed a file: the disc is served by HTTP ranges on
//    127.0.0.1 (startDiscServer) to the harness page's origin only, and
//    mounted as the worker's remote disc descriptor { remoteDisc, name, size }
//    (src/remote-disc.js: loopback only).
//  - close() ends the WebDriver session, stops safaridriver, then the
//    session's Safari by its pid (SIGTERM, SIGKILL if it hangs), and removes
//    the WebDriver session folders it left; SIGINT/SIGTERM/SIGHUP run the
//    same close before exiting. Every call has a timeout.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createReadStream, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTOMATION_DIR = `${homedir()}/Library/Containers/com.apple.Safari/Data/tmp/SafariAutomation`;
const SESSION_DIR = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const pgrep = (args) => (spawnSync("pgrep", args, { encoding: "utf8", timeout: 10_000 }).stdout ?? "").split("\n").filter(Boolean).map(Number);
const automationDirs = () => { try { return readdirSync(AUTOMATION_DIR).filter((n) => SESSION_DIR.test(n)); } catch { return []; } };
const osa = (script) => execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" }).trim();
const frontmostBundle = () => { try { return osa('tell application "System Events" to get bundle identifier of first application process whose frontmost is true'); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// The disc by HTTP ranges, readable only from the harness page's origin
// (CORS: any other page open on this Mac gets a 403, never a byte). GET and
// the preflight only; a range past the disc's end is a 416. Resolves once
// listening, rejects when the port is taken.
export function startDiscServer(iso, { port, origin }) {
  if (!/^https?:\/\/[^/]+$/.test(origin ?? "")) throw new Error(`startDiscServer: origin "${origin}" is not a page origin (http://127.0.0.1:<port>)`);
  const size = statSync(iso).size;
  const name = path.basename(iso);
  const headers = { "access-control-allow-origin": origin, vary: "origin", "access-control-allow-headers": "range", "access-control-expose-headers": "content-range",
    "cross-origin-resource-policy": "cross-origin", "cache-control": "no-store", "content-type": "application/octet-stream" };
  const server = createServer((req, res) => {
    if (req.headers.origin !== origin) { res.writeHead(403, { vary: "origin" }); return res.end(); }
    if (req.method === "OPTIONS") { res.writeHead(204, headers); return res.end(); }
    if (req.method !== "GET") { res.writeHead(405, { ...headers, allow: "GET, OPTIONS" }); return res.end(); }
    if (req.url !== `/${encodeURIComponent(name)}`) { res.writeHead(404, headers); return res.end(); }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    const a = m ? Number(m[1]) : NaN, b = m ? Math.min(m[2] === "" ? size - 1 : Number(m[2]), size - 1) : NaN;
    if (!m || a >= size || b < a) { res.writeHead(416, { ...headers, "content-range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, "content-range": `bytes ${a}-${b}/${size}`, "content-length": b - a + 1 });
    createReadStream(iso, { start: a, end: b }).on("error", () => res.destroy()).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      server.on("error", () => {});
      const actual = server.address().port;
      resolve({ descriptor: { remoteDisc: `http://127.0.0.1:${actual}/${encodeURIComponent(name)}`, name, size }, close: () => server.close() });
    });
  });
}

// The engine app's boot of a remote disc: what bootIso does with a file
// input, through the page's host (mountFile + start).
export async function bootRemoteDisc(page, { url, descriptor, timeoutMs = 120000 }) {
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.__host?.adapter), null, { timeout: 30000 });
  await page.evaluate(async (d) => { await window.__host.mountFile(d); window.__host.start(); return true; }, descriptor);
  await page.waitForFunction(() => window.__host?.adapter?.loaded === true, null, { timeout: timeoutMs });
}

// Stops one process by its exact pid: SIGTERM, then SIGKILL after graceMs.
// Never by name. Synchronous (a signal handler's cleanup must finish before
// the process exits). True when it is gone.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function stopPid(pid, { graceMs = 8000, kill = process.kill.bind(process), isAlive = alive, wait = sleepSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) return true;
  try { kill(pid, "SIGTERM"); } catch {}
  for (let t = 0; t < graceMs && isAlive(pid); t += 100) wait(100);
  if (isAlive(pid)) try { kill(pid, "SIGKILL"); } catch {}
  for (let t = 0; t < 3000 && isAlive(pid); t += 100) wait(100);
  return !isAlive(pid);
}

// The session's Safari: the one pid that appeared since `before`; none (null)
// when zero or several did (then nothing is ever stopped by pid).
export function sessionPid(before, after) {
  const fresh = after.filter((p) => !before.includes(p));
  return fresh.length === 1 ? fresh[0] : null;
}

// SIGINT/SIGTERM/SIGHUP: the synchronous cleanup runs first (prepended:
// before the perf lock's handler, which exits at once), then the other
// handlers; with none left, exit 128 + signal. Returns the uninstall.
export function onSignals(cleanupSync, { proc = process, exit = (code) => process.exit(code) } = {}) {
  const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  const handlers = Object.fromEntries(Object.keys(codes).map((sig) => [sig, () => {
    uninstall();
    try { cleanupSync(); } catch {}
    if (proc.listenerCount(sig) === 0) exit(codes[sig]);
  }]));
  const uninstall = () => { for (const [sig, h] of Object.entries(handlers)) proc.off(sig, h); };
  for (const [sig, h] of Object.entries(handlers)) proc.prependOnceListener(sig, h);
  return uninstall;
}

// A window rect ({ x, y, width, height }) against the desktop's bounds
// ([left, top, right, bottom], every display): any overlap is visible.
export function windowOnScreen(rect, bounds) {
  if (!rect || !bounds || bounds.length !== 4 || bounds.some((n) => !Number.isFinite(n))) return true; // unknown: assumed visible
  const [l, t, r, b] = bounds;
  return rect.x < r && rect.x + rect.width > l && rect.y < b && rect.y + rect.height > t;
}
const desktopBounds = () => { try { return osa('tell application "Finder" to get bounds of window of desktop').split(",").map((s) => Number(s.trim())); } catch { return null; } };

// A page exception from an evaluate (not a transport error: those retry).
class PageError extends Error {}

export async function launchSafariPage({ port = 8306, log = () => {} } = {}) {
  if (pgrep(["-x", "Safari"]).length) throw new Error("Safari is already running: the user's own windows, no run");
  const before = new Set(automationDirs());
  const front = frontmostBundle();
  const guardBin = process.env.SAFARI_FOCUS_GUARD;
  const guard = guardBin ? spawn(guardBin, [front ?? "com.apple.finder"], { stdio: "ignore" }) : null;
  const driver = spawn("/usr/bin/safaridriver", ["-p", String(port)], { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  let id = null, closed = false, safariPid = null;
  // WebKit's helper processes (WebContent, GPU, Networking) are XPC services
  // of launchd, not Safari's children: the ones born with the session are
  // counted as the session's (Safari was not running before it).
  const webkitBefore = pgrep(["-f", "com.apple.WebKit."]);
  const cmd = async (method, p, body) => {
    const res = await fetch(id ? `${base}/session/${id}${p}` : `${base}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(150_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`webdriver ${method} ${p}: ${res.status} ${JSON.stringify(json.value ?? json).slice(0, 300)}`);
    return json.value;
  };
  // Everything after the WebDriver session: safaridriver, the session's
  // Safari by its pid (one not identified is left running, and said so,
  // rather than guessed by name), the guard, the session folders. Sync: also
  // the signal path.
  const stopAll = () => {
    try { driver.kill(); } catch {}
    const gone = safariPid ? stopPid(safariPid) : false;
    if (!safariPid && pgrep(["-x", "Safari"]).length) log("safari: the session's Safari was not identified by pid: left running");
    try { guard?.kill(); } catch {}
    if (gone) for (const n of automationDirs()) if (!before.has(n)) try { rmSync(`${AUTOMATION_DIR}/${n}`, { recursive: true, force: true }); } catch {}
    if (front) try { osa(`tell application id "${front}" to activate`); } catch {}
  };
  let uninstallSignals = () => {};
  const close = async () => {
    if (closed) return;
    closed = true;
    uninstallSignals();
    try { if (id) await Promise.race([cmd("DELETE", ""), sleep(10_000)]); } catch {}
    id = null;
    stopAll();
  };
  uninstallSignals = onSignals(() => { if (!closed) { closed = true; stopAll(); } });
  const assertInvisible = async (when) => {
    const rect = await cmd("GET", "/window/rect");
    if (windowOnScreen(rect, desktopBounds())) {
      await close();
      throw new Error(`safari: the window is on screen ${when} (${JSON.stringify(rect)}): run aborted`);
    }
  };
  let created = null;
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await (await fetch(`${base}/status`, { signal: AbortSignal.timeout(5_000) })).json()).value?.ready) break; } catch {}
      await sleep(100);
    }
    created = await cmd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
    id = created?.sessionId;
    if (!id) throw new Error("no Safari session");
    safariPid = sessionPid([], pgrep(["-x", "Safari"]));
    await cmd("POST", "/timeouts", { script: 120_000, pageLoad: 120_000, implicit: 0 });
    await cmd("POST", "/window/rect", { x: 20000, y: 20000, width: 1280, height: 800 });
    await assertInvisible("after launch");
    if (front) try { osa(`tell application id "${front}" to activate`); } catch {}
  } catch (e) {
    await close();
    throw e;
  }
  // A function's source and one argument, run in the page. A page exception
  // comes back as a PageError (Playwright's evaluate semantics); a WebDriver
  // error as a plain Error.
  const evaluate = async (fn, arg) => {
    const r = await cmd("POST", "/execute/async", {
      script: `const done = arguments[arguments.length - 1]; Promise.resolve().then(() => (${String(fn)})(arguments[0])).then((v) => done({ ok: true, v: v === undefined ? null : v }), (e) => done({ ok: false, e: String(e && e.stack || e) }));`,
      args: [arg === undefined ? null : arg]
    });
    if (!r?.ok) throw new PageError(r?.e ?? "evaluate failed");
    return r.v;
  };
  // "Not yet" (a falsy value, or a WebDriver error while the page loads) is
  // retried; a page exception ends the wait at once.
  const waitForFunction = async (fn, arg, { timeout = 30000 } = {}) => {
    const deadline = Date.now() + timeout;
    let last = null;
    for (;;) {
      try {
        if (await evaluate(fn, arg)) return true;
      } catch (e) {
        if (e instanceof PageError) throw e;
        last = e;
      }
      if (Date.now() > deadline) throw new Error(`waitForFunction: ${timeout} ms${last ? ` (last WebDriver error: ${last.message})` : ""}`);
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
      // The element's pixels as a PNG. Playwright's style option (the
      // overlays hidden) is a style sheet put in the page for the capture
      // and taken out after.
      screenshot: async ({ style } = {}) => {
        if (style) await evaluate((css) => { const el = document.createElement("style"); el.id = "__safari_shot_style"; el.textContent = css; document.head.appendChild(el); return true; }, style);
        try {
          const el = await cmd("POST", "/element", { using: "css selector", value: selector });
          return Buffer.from(await cmd("GET", `/element/${Object.values(el)[0]}/screenshot`), "base64");
        } finally {
          if (style) await evaluate(() => { document.getElementById("__safari_shot_style")?.remove(); return true; }).catch(() => {});
        }
      },
      setInputFiles: async () => { throw new Error("Safari cannot be handed a file: use bootRemoteDisc"); }
    })
  };
  // The session's own processes (for a load reading): its Safari and the
  // WebKit helpers born since the launch.
  const ownPids = () => [...(safariPid ? [safariPid] : []), ...pgrep(["-f", "com.apple.WebKit."]).filter((p) => !webkitBefore.includes(p))];
  log(`safari: session ${id} (${created?.capabilities?.browserVersion ?? "?"}, pid ${safariPid ?? "unidentified"})`);
  return { page, close, assertInvisible, ownPids, pid: safariPid, browserVersion: created?.capabilities?.browserVersion ?? null };
}
