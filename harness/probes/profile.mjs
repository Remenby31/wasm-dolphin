#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// One dedicated profiling session (NOT a speed measurement): headless Chrome
// with V8's jitdump on, a disc booted through the harness, a warm-up, then a
// sampling window. Writes <out>/jit/jit-<renderer pid>.dump and
// <out>/window.json (bounds of the window: Date.now() ms and, on Linux,
// CLOCK_MONOTONIC ns = perf -k mono = V8 TimeTicks, perf-jit.cc:219).
//
//   macOS (samply wraps everything, the window filters afterwards):
//     samply record --save-only -r 2000 -o <out>/profile.json.gz -- \
//       node harness/probes/profile.mjs --iso <disc> --out <out> [--query ...]
//   Linux (perf attaches to the renderer for the window only):
//     node harness/probes/profile.mjs --iso <disc> --out <out> --perf perf [--freq 4999]
//   then: node harness/probes/wasm-hot.mjs --jitdump <out>/jit/jit-<pid>.dump
//     (--samply <out>/profile.json.gz | --perf-script samples.txt) --window <out>/window.json
//   On the Spark bench: harness/remote/spark-profile.sh (FIFO queue, lane a).
//
//   [--state scene.sav] [--tree <checkout> (default: this one)] [--serve <dir> (default: --tree)] [--warmup 40] [--secs 20] [--port 8791]
//   [--chrome <path>] [--js-flags "..."] [--event cycles:u]
//   [--emulated-window S [--emulated-warmup W] [--hold KeyX]]
//
// --emulated-window: the window of race-perf --emulated-window (the pinned
// scene protocol): from the savestate, W guest seconds of warmup, then S
// guest seconds, however slow the profiled run is (--warmup, --secs: host
// seconds, ignored). perf stops at the window's last tick read. --hold: the
// key race-perf holds from the savestate on (its default KeyX; none for the
// pinned heavy protocol, --hold "").
//
// The jitdump weighs ~417 MB for 75 s: --out must be outside the repository
// (research/deep-region-profiling.md). The run is heavily perturbed (jitdump,
// no sandbox, sampling): never a speed measurement; it takes the perf lock
// only so it never overlaps someone else's window.
//
// Never a visible browser: the harness launches --headless=new and asserts no
// window (lib/browser.mjs). --no-sandbox: a sandboxed renderer can neither
// open the jitdump (perf-jit.cc:147-152, FATAL on failure) nor, on Linux, has
// it the host's pid (pid namespace): perf inject would not match it.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    tree: { type: "string" }, iso: { type: "string" }, out: { type: "string" }, state: { type: "string" }, serve: { type: "string" },
    query: { type: "string", default: "core=upstream&video=wgpu&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=60&oc=1&aot=1" },
    warmup: { type: "string", default: "40" }, secs: { type: "string", default: "20" }, port: { type: "string", default: "8791" },
    chrome: { type: "string" }, "js-flags": { type: "string", default: "" }, perf: { type: "string" }, freq: { type: "string", default: "4999" }, event: { type: "string" },
    "emulated-window": { type: "string" }, "emulated-warmup": { type: "string", default: "1" }, hold: { type: "string", default: "" }
  }
});
const HERE_TREE = path.resolve(import.meta.dirname, "..", "..");
if (!o.iso || !o.out) { console.error("usage: profile.mjs --iso <disc> --out <dir outside the repo> [--tree <checkout>]"); process.exit(2); }
const tree = path.resolve(o.tree ?? HERE_TREE), out = path.resolve(o.out), jitDir = path.join(out, "jit");
if (!path.relative(HERE_TREE, out).startsWith("..") || !path.relative(tree, out).startsWith("..")) { console.error(`--out ${out}: the jitdump (hundreds of MB) must live outside the repository`); process.exit(2); }
mkdirSync(jitDir, { recursive: true });
if (o.chrome) process.env.HARNESS_CHROME_PATH = path.resolve(o.chrome);

const lib = (f) => import(pathToFileURL(path.join(tree, "harness", "lib", f)).href);
const { ensureServer, loadHarnessState, readCoreProgress, workerRequest } = await lib("browser.mjs");
const { openSession } = await lib("session.mjs");
const { acquirePerfLock } = await lib("perf-lock.mjs");
const { emulatedStart } = await lib("emulated-window.mjs");
const emulated = o["emulated-window"] ? { secs: Number(o["emulated-window"]), warmup: Number(o["emulated-warmup"]) } : null;
if (emulated && !(emulated.secs > 0 && emulated.warmup >= 0)) { console.error("--emulated-window S (> 0) [--emulated-warmup W (>= 0)]"); process.exit(2); }

// --perf-prof: jitdump with code bytes (perf-jit.cc). It implies --log
// (flag-definitions.h:4479): the v8.log goes next to the dump, one file.
const jsFlags = ["--perf-prof", `--perf-prof-path=${jitDir}`, "--no-logfile-per-isolate", `--logfile=${path.join(jitDir, "v8.log")}`, ...o["js-flags"].split(/\s+/).filter(Boolean)];
const chromeArgs = ["--no-sandbox", `--js-flags=${jsFlags.join(" ")}`];
// --serve: the tree to serve (e.g. a bench build, which holds only cores/
// src/ tools/), when the harness libraries come from --tree.
const server = await ensureServer({ port: Number(o.port), root: o.serve ? path.resolve(o.serve) : tree });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[profile] ${new Date().toISOString().slice(11, 19)} ${m}`);

// On this Mac other agents measure speed: take the shared perf lock so this
// (heavily perturbed) run never overlaps one of their windows.
const freeLock = !process.env.PROFILE_NO_LOCK && (process.platform === "darwin" || process.env.HARNESS_PERF_LOCK) ? await acquirePerfLock({ name: "harness profile (not a measure)", waitSec: Number(process.env.PROFILE_LOCK_WAIT ?? 14400), log }) : null;
log(`chrome args: ${chromeArgs.join(" ")}`);
let perf = null, session = null;
try {
  // --state: the scene to profile (a savestate, as race-perf loads it);
  // without it, whatever the disc shows after boot.
  const routes = o.state ? { "**/__harness_state.sav": path.resolve(o.state) } : {};
  session = await openSession({ base: server.base, server, query: o.query, iso: path.resolve(o.iso), chromeArgs, routes });
  const { page } = session;
  if (o.state) {
    const loaded = await loadHarnessState(page, session.url);
    if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
    log(`savestate ${path.basename(o.state)} loaded`);
  }
  log(emulated ? `booted; emulated warm-up ${emulated.warmup} guest s` : `booted; warm-up ${o.warmup} s`);
  const emu = emulated ? await emulatedStart(page, { warmup: emulated.warmup, press: o.hold ? () => page.keyboard.down(o.hold) : undefined }) : null;
  if (!emu) await sleep(Number(o.warmup) * 1000);
  const aot = await workerRequest(page, "validationReadAotProgress", {}, 10000).catch((e) => ({ error: String(e) }));
  const installs = (aot?.events ?? []).filter((e) => e.type === "install" || e.type === "done");
  log(`aot state ${aot?.state ?? aot?.error}; last events ${JSON.stringify(installs.slice(-2))}`);
  const before = await readCoreProgress(page).catch(() => null);

  // The renderer = the jitdump that grew most (one per V8 process).
  const dumps = readdirSync(jitDir).filter((f) => /^jit-\d+\.dump$/.test(f)).map((f) => ({ f, size: statSync(path.join(jitDir, f)).size })).sort((a, b) => b.size - a.size);
  const rendererPid = dumps[0] ? Number(/\d+/.exec(dumps[0].f)[0]) : null;
  log(`jitdumps: ${dumps.map((d) => `${d.f} ${(d.size / 1e6).toFixed(1)} MB`).join(", ")}`);

  const win = { start: Date.now(), monoStartNs: String(process.hrtime.bigint()), rendererPid, query: o.query, iso: path.basename(o.iso) };
  if (o.perf && rendererPid) {
    const [cmd, ...pre] = o.perf.split(/\s+/);
    // An emulated window has no known length: perf runs until SIGINT.
    const args = [...pre, "record", "-k", "mono", "-F", o.freq, ...(o.event ? ["-e", o.event] : []), "-g", "-p", String(rendererPid), "-o", path.join(out, "perf.data"), ...(emu ? [] : ["--", "sleep", o.secs])];
    log(`${cmd} ${args.join(" ")}`);
    perf = spawn(cmd, args, { stdio: "inherit" });
  }
  const perfExit = perf && new Promise((r) => perf.on("exit", r));
  if (emu) {
    log(`window ${emulated.secs} guest s`);
    win.emulated = await emu.window(emulated.secs);
    perf?.kill("SIGINT");
  } else {
    log(`window ${o.secs} s`);
    await sleep(Number(o.secs) * 1000);
  }
  win.end = Date.now(); win.monoEndNs = String(process.hrtime.bigint());
  const after = await readCoreProgress(page).catch(() => null);
  win.progress = { before, after };
  if (perf) await perfExit;
  writeFileSync(path.join(out, "window.json"), JSON.stringify(win, null, 2));
  log(`frames ${before?.frame} -> ${after?.frame}; window.json written`);
} finally {
  await session?.close?.().catch(() => {});
  await session?.context?.close().catch(() => {});
  await server.close?.().catch?.(() => {});
  freeLock?.();
}
process.exit(0);
