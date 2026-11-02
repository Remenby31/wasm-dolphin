// harness/lib/safari-page.mjs without launching Safari: the disc server
// (the harness page's origin only, ranges, refusals, a taken port), the
// cleanup on a signal and the stop by exact pid, the window check, and the
// parcours' --browser safari wiring (source contract).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { onSignals, sessionPid, startDiscServer, stopPid, windowOnScreen } from "../harness/lib/safari-page.mjs";
import { otherCpuOf } from "../harness/probes/parcours.mjs";

const ORIGIN = "http://127.0.0.1:8306";
async function disc(t, name = "game disc.iso") {
  const dir = mkdtempSync(path.join(tmpdir(), "safari-disc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const iso = path.join(dir, name);
  writeFileSync(iso, Buffer.from(Array.from({ length: 64 }, (_, i) => i)));
  const d = await startDiscServer(iso, { port: 0, origin: ORIGIN });
  t.after(() => d.close());
  return d;
}
const get = (url, { origin = ORIGIN, range, method = "GET" } = {}) =>
  fetch(url, { method, headers: { ...(origin ? { origin } : {}), ...(range ? { range } : {}) } });

test("the disc descriptor: name, size, a loopback URL", async (t) => {
  const d = await disc(t);
  assert.equal(d.descriptor.name, "game disc.iso");
  assert.equal(d.descriptor.size, 64);
  assert.match(d.descriptor.remoteDisc, /^http:\/\/127\.0\.0\.1:\d+\/game%20disc\.iso$/);
});

test("only the harness page's origin reads the disc: a foreign page or no origin gets a 403", async (t) => {
  const d = await disc(t);
  const ok = await get(d.descriptor.remoteDisc, { range: "bytes=4-7" });
  assert.equal(ok.status, 206);
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(ok.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(ok.headers.get("content-range"), "bytes 4-7/64");
  assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [4, 5, 6, 7]);
  for (const origin of ["http://evil.example", "http://127.0.0.1:9999", "null", null]) {
    const r = await get(d.descriptor.remoteDisc, { origin, range: "bytes=0-63" });
    assert.equal(r.status, 403, String(origin));
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    assert.equal((await r.arrayBuffer()).byteLength, 0, "never a byte");
  }
  assert.equal((await get(d.descriptor.remoteDisc, { origin: "http://evil.example", method: "OPTIONS" })).status, 403, "nor a preflight");
  assert.equal((await get(d.descriptor.remoteDisc, { method: "OPTIONS" })).status, 204);
  assert.throws(() => startDiscServer("x.iso", { port: 0, origin: "*" }), /not a page origin/);
});

test("ranges past the end are a 416 and the server stays up; POST is a 405; only the disc", async (t) => {
  const d = await disc(t);
  assert.equal((await get(d.descriptor.remoteDisc, { range: "bytes=64-100" })).status, 416);
  assert.equal((await get(d.descriptor.remoteDisc, { range: "bytes=1000-2000" })).headers.get("content-range"), "bytes */64");
  assert.equal((await get(d.descriptor.remoteDisc, { range: "bytes=9-3" })).status, 416);
  assert.equal((await get(d.descriptor.remoteDisc)).status, 416, "no range, no bytes");
  assert.equal((await get(d.descriptor.remoteDisc, { range: "bytes=60-99" })).headers.get("content-range"), "bytes 60-63/64");
  assert.equal((await get(d.descriptor.remoteDisc, { range: "bytes=62-" })).headers.get("content-range"), "bytes 62-63/64");
  assert.equal((await get(d.descriptor.remoteDisc, { method: "POST", range: "bytes=0-1" })).status, 405);
  assert.equal((await get(d.descriptor.remoteDisc.replace(/[^/]+$/, "other.iso"), { range: "bytes=0-1" })).status, 404);
  assert.equal((await get(d.descriptor.remoteDisc, { range: "bytes=0-0" })).status, 206, "still serving");
});

test("a taken port rejects the start instead of crashing", async (t) => {
  const busy = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => busy.once("listening", r));
  t.after(() => busy.close());
  const dir = mkdtempSync(path.join(tmpdir(), "safari-disc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "d.iso"), "x");
  await assert.rejects(startDiscServer(path.join(dir, "d.iso"), { port: busy.address().port, origin: ORIGIN }), /EADDRINUSE/);
});

test("a signal runs the cleanup before the other handlers (the perf lock's exit), then exits 128 + n", () => {
  const proc = new EventEmitter();
  const calls = [];
  const exits = [];
  proc.once("SIGTERM", () => calls.push("lock"));
  const uninstall = onSignals(() => calls.push("cleanup"), { proc, exit: (c) => exits.push(c) });
  proc.emit("SIGTERM");
  assert.deepEqual(calls, ["cleanup", "lock"], "the cleanup first");
  assert.deepEqual(exits, [], "the remaining handler exits, not ours");
  assert.equal(proc.listenerCount("SIGINT"), 0, "every signal's handler removed once one fired");
  uninstall();
  const alone = new EventEmitter();
  onSignals(() => { throw new Error("cleanup failed"); }, { proc: alone, exit: (c) => exits.push(c) });
  alone.emit("SIGINT");
  assert.deepEqual(exits, [130], "alone: exits itself, even when the cleanup threw");
  const off = new EventEmitter();
  onSignals(() => calls.push("never"), { proc: off })();
  assert.equal(off.listenerCount("SIGHUP"), 0, "uninstall leaves nothing");
});

test("the session's Safari is stopped by its exact pid only: SIGTERM, then SIGKILL", () => {
  const sent = [];
  let living = new Set([4242]);
  const fakes = { kill: (pid, sig) => { sent.push([pid, sig]); if (sig === "SIGKILL") living.delete(pid); }, isAlive: (pid) => living.has(pid), wait: () => {} };
  assert.equal(stopPid(4242, { ...fakes, graceMs: 300 }), true);
  assert.deepEqual(sent, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  sent.length = 0;
  living = new Set([7]);
  fakes.kill = (pid, sig) => { sent.push([pid, sig]); living.delete(pid); };
  assert.equal(stopPid(7, { ...fakes }), true);
  assert.deepEqual(sent, [[7, "SIGTERM"]], "gone on SIGTERM: no SIGKILL");
  sent.length = 0;
  for (const bad of [null, 0, 1, -5, 3.5]) assert.equal(stopPid(bad, fakes), true);
  assert.deepEqual(sent, [], "no pid, nothing sent");
  // the session's pid: the one that appeared, or none
  assert.equal(sessionPid([], [812]), 812);
  assert.equal(sessionPid([], [812, 900]), null, "two Safaris: neither is ours for sure");
  assert.equal(sessionPid([812], [812]), null);
  const src = readFileSync(new URL("../harness/lib/safari-page.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /for \(const pid of pgrep|pkill|killall|tell application "Safari" to quit/, "never by name");
});

test("a window overlapping the desktop is visible; one beyond it or unread is not trusted", () => {
  const desk = [0, 0, 3008, 1692];
  assert.equal(windowOnScreen({ x: 20000, y: 20000, width: 1280, height: 800 }, desk), false);
  assert.equal(windowOnScreen({ x: 2900, y: 100, width: 1280, height: 800 }, desk), true, "a corner on screen");
  assert.equal(windowOnScreen({ x: -1500, y: 0, width: 1280, height: 800 }, [-1920, 0, 3008, 1692]), true, "a display on the left");
  assert.equal(windowOnScreen({ x: 3008, y: 0, width: 1280, height: 800 }, desk), false, "just past the edge");
  assert.equal(windowOnScreen(null, desk), true);
  assert.equal(windowOnScreen({ x: 20000, y: 20000, width: 1, height: 1 }, null), true, "bounds unread: assumed visible");
});

test("otherCpu counts the session's Safari and WebKit helpers as ours", () => {
  const ps = ["  12 1 50.0 node parcours.mjs", " 812 1 90.0 /Applications/Safari.app/Contents/MacOS/Safari", " 820 1 120.0 /System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc", " 900 1 30.0 /usr/bin/other"].join("\n");
  assert.equal(otherCpuOf(ps, { selfPid: 12, now: 1 })[1], 240, "without them: Safari counted as foreign");
  assert.equal(otherCpuOf(ps, { selfPid: 12, ownPids: [812, 820], now: 1 })[1], 30);
});

test("parcours --browser safari boots the disc descriptor, never a file, and checks the window", () => {
  const src = readFileSync(new URL("../harness/probes/parcours.mjs", import.meta.url), "utf8");
  assert.match(src, /browser: \{ type: "string", default: "chrome" \}/);
  assert.match(src, /--browser safari runs on macOS only/);
  assert.match(src, /if \(safari\) await bootRemoteDisc\(page, \{ url: `\$\{server\.base\}\?\$\{o\.query\}`, descriptor: o\.safari\.descriptor/);
  assert.match(src, /await startDiscServer\(iso, \{ port: o\.port \+ 2, origin: `http:\/\/127\.0\.0\.1:\$\{o\.port\}` \}\)/);
  assert.match(src, /if \(safari\) await safari\.assertInvisible\("after boot"\)/);
  assert.match(src, /otherCpu\(profileDir, safari\?\.ownPids\(\) \?\? \[\]\)/);
  assert.match(src, /if \(safari\) await safari\.close\(\)/);
});
