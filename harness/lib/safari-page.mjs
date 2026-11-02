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
// the preflight only; a range past the disc's end is a 416, a GET without a
// range too unless the file is at most wholeMax bytes (a savestate fetched
// whole by the page's __loadStateFile; 0, the disc's default: never).
// Resolves once listening, rejects when the port is taken.
export function startDiscServer(iso, { port, origin, wholeMax = 0 }) {
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
    if (req.headers.range === undefined && size <= wholeMax) {
      res.writeHead(200, { ...headers, "content-length": size });
      return createReadStream(iso).on("error", () => res.destroy()).pipe(res);
    }
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

// `ps -o lstart=,comm=` of one pid ("Mon Nov  2 10:45:12 2026  /Applications/
// Safari.app/Contents/MacOS/Safari"): is it still a Safari started at or
// after sinceMs (lstart has whole seconds)? A recycled pid, or a Safari the
// user started before the session, is not.
export function isSessionSafari(psLine, sinceMs) {
  const m = /^\s*(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.+?)\s*$/.exec(psLine ?? "");
  if (!m) return false;
  const started = new Date(m[1]).getTime();
  return path.basename(m[2]) === "Safari" && Number.isFinite(started) && started >= Math.floor(sinceMs / 1000) * 1000;
}
const psLine = (pid) => spawnSync("ps", ["-o", "lstart=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000, env: { ...process.env, LC_ALL: "C" } }).stdout ?? "";

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

// The displays as WebDriver sees them: AppKit's NSScreen frames ([x, y,
// width, height], points, origin at the main display's bottom left, y up)
// turned to the window rect's coordinates (origin at the main display's top
// left, y down). The main display comes first.
export function screensTopLeft(frames) {
  if (!Array.isArray(frames) || !frames.length || frames.some((f) => !Array.isArray(f) || f.length !== 4 || f.some((n) => !Number.isFinite(n)))) return null;
  const mainHeight = frames[0][3];
  return frames.map(([x, y, w, h]) => ({ x, y: mainHeight - (y + h), width: w, height: h }));
}

// The window's area on the displays, in points (0: on none). null when the
// rect or the displays are unknown (then it counts as visible).
export function visibleArea(rect, screens) {
  if (!rect || !screens) return null;
  // a malformed rect (strings, a negative size) is unknown, never "0 visible"
  if (!["x", "y", "width", "height"].every((k) => typeof rect[k] === "number" && Number.isFinite(rect[k])) || rect.width < 0 || rect.height < 0) return null;
  let area = 0;
  for (const s of screens) {
    const w = Math.min(rect.x + rect.width, s.x + s.width) - Math.max(rect.x, s.x);
    const h = Math.min(rect.y + rect.height, s.y + s.height) - Math.max(rect.y, s.y);
    if (w > 0 && h > 0) area += w * h;
  }
  return area;
}

// The displays read through AppKit (osascript JavaScript; never the Finder,
// which can hang for minutes).
const screens = () => {
  try {
    return screensTopLeft(JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e",
      'ObjC.import("AppKit"); const s = $.NSScreen.screens; const out = []; for (let i = 0; i < s.count; i++) { const f = s.objectAtIndex(i).frame; out.push([f.origin.x, f.origin.y, f.size.width, f.size.height]); } JSON.stringify(out)'],
    { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" })));
  } catch { return null; }
};

// What may stay on screen: macOS keeps a corner of any window on a display
// (a window moved past every edge comes back with 40x52 points showing), so
// a window cannot be put wholly off screen and stay rendered (minimized,
// the page is hidden and throttled). SAFARI_MAX_VISIBLE_PT (points², default
// 0: nothing) lets that corner through when the run's owner accepts it, never
// more than the corner itself (2080 = 40x52; Main Salon, 2026-11-02: with no
// focus taken and the tolerance in each run's summary).
export const MAX_VISIBLE_CORNER_PT = 40 * 52;
// Digits only ("0x820", "1e3" are refused); a bad value is an error, never 0
// in silence.
export function maxVisiblePoints(env = process.env) {
  const v = env.SAFARI_MAX_VISIBLE_PT;
  if (v === undefined || v === "") return 0;
  if (!/^\d+$/.test(v)) throw new Error(`SAFARI_MAX_VISIBLE_PT "${v}": points², digits only`);
  const n = Number(v);
  if (n > MAX_VISIBLE_CORNER_PT) throw new Error(`SAFARI_MAX_VISIBLE_PT ${n}: at most ${MAX_VISIBLE_CORNER_PT} (macOS's 40x52 corner)`);
  return n;
}

// One visibility check: the window's area on screen within the tolerance,
// and the app in front still the one that was before the launch (Safari
// never takes the focus). The failure, or null.
export function visibilityFailure({ area, allowed, front, frontNow }) {
  if (frontNow === "com.apple.Safari") return "Safari is in front (the focus was taken)";
  if (area === null) return "the window's rect or the displays unread";
  if (area > allowed) return `${area} pt² visible > ${allowed}`;
  if (!front) return "the app in front unread at the launch";
  if (frontNow !== front) return `the app in front changed: ${front} -> ${frontNow ?? "unread"}`;
  return null;
}

// A page exception from an evaluate (not a transport error: those retry).
class PageError extends Error {}

export async function launchSafariPage({ port = 8306, log = () => {} } = {}) {
  if (pgrep(["-x", "Safari"]).length) throw new Error("Safari is already running: the user's own windows, no run");
  // the tolerance read (and refused when malformed) before Safari starts
  const allowed = maxVisiblePoints();
  const before = new Set(automationDirs());
  const front = frontmostBundle();
  const guardBin = process.env.SAFARI_FOCUS_GUARD;
  const guard = guardBin ? spawn(guardBin, [front ?? "com.apple.finder"], { stdio: "ignore" }) : null;
  const driver = spawn("/usr/bin/safaridriver", ["-p", String(port)], { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  let id = null, closed = false, stopped = false, safariPid = null, sessionSince = 0;
  // WebKit's helper processes (WebContent, GPU, Networking) are XPC services
  // of launchd, not Safari's children: the ones born with the session are
  // counted as the session's (Safari was not running before it). An
  // approximation: a WebView another app opens meanwhile is counted too.
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
    if (stopped) return;
    stopped = true;
    try { driver.kill(); } catch {}
    // Checked again right before the kill: still a Safari started since the
    // session's creation, else left alone (a recycled pid, the user's).
    const ours = safariPid !== null && isSessionSafari(psLine(safariPid), sessionSince);
    if (safariPid !== null && !ours && alive(safariPid)) log(`safari: pid ${safariPid} is no longer the session's Safari: left alone`);
    const gone = ours ? stopPid(safariPid) : false;
    if (safariPid === null && pgrep(["-x", "Safari"]).length) log("safari: the session's Safari was not identified by pid: left running");
    try { guard?.kill(); } catch {}
    if (gone) for (const n of automationDirs()) if (!before.has(n)) try { rmSync(`${AUTOMATION_DIR}/${n}`, { recursive: true, force: true }); } catch {}
    if (front) try { osa(`tell application id "${front}" to activate`); } catch {}
  };
  let uninstallSignals = () => {};
  // The signal handlers stay until everything is stopped: a Ctrl-C during
  // the DELETE's wait still stops the session's Safari.
  const close = async () => {
    if (closed) return;
    closed = true;
    try { if (id) await Promise.race([cmd("DELETE", ""), sleep(10_000)]); } catch {}
    id = null;
    stopAll();
    uninstallSignals();
  };
  uninstallSignals = onSignals(stopAll);
  // Each check is kept (visibility: for the run's summary).
  const visibility = [];
  const assertInvisible = async (when) => {
    const rect = await cmd("GET", "/window/rect");
    const area = visibleArea(rect, screens());
    const frontNow = frontmostBundle();
    const failure = visibilityFailure({ area, allowed, front, frontNow });
    visibility.push({ when, rect, area, allowed, front, frontNow, failure });
    if (failure) {
      await close();
      throw new Error(`safari: ${when}: ${failure} (${JSON.stringify(rect)}): run aborted`);
    }
    if (area > 0) log(`safari: ${area} pt² of the window on screen ${when} (macOS's corner, SAFARI_MAX_VISIBLE_PT ${allowed}), ${frontNow} still in front`);
  };
  let created = null;
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await (await fetch(`${base}/status`, { signal: AbortSignal.timeout(5_000) })).json()).value?.ready) break; } catch {}
      await sleep(100);
    }
    sessionSince = Date.now();
    created = await cmd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
    id = created?.sessionId;
    if (!id) throw new Error("no Safari session");
    safariPid = sessionPid([], pgrep(["-x", "Safari"]));
    if (safariPid !== null && !isSessionSafari(psLine(safariPid), sessionSince)) safariPid = null;
    await cmd("POST", "/timeouts", { script: 120_000, pageLoad: 120_000, implicit: 0 });
    await cmd("POST", "/window/rect", { x: 20000, y: 20000, width: 1280, height: 800 });
    // the focus given back first (Safari activates as it opens), then checked
    if (front) try { osa(`tell application id "${front}" to activate`); } catch {}
    await assertInvisible("after launch");
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
  // tolerance: what this run allowed on screen, for its summary (also at 0)
  return { page, close, assertInvisible, ownPids, visibility, tolerance: { maxVisiblePt: allowed, corner: MAX_VISIBLE_CORNER_PT },  pid: safariPid, browserVersion: created?.capabilities?.browserVersion ?? null };
}
