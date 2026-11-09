#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The PC kit, Mac side (research/pc-windows-kit.md): drives a Windows PC
// over ssh (OpenSSH Server, Tailscale) with harness/remote/pc-win/salon-pc.ps1.
//
//   node harness/remote/pc-run.mjs check --host pc [--iso C:\\discs\\game.iso]
//   node harness/remote/pc-run.mjs setup --host pc [--engine REF]
//   node harness/remote/pc-run.mjs smoke --host pc [--homebrew harness/homebrew/out/gxscene.iso]
//   node harness/remote/pc-run.mjs calibrate --host pc [--browser chrome] [--host-gb6 N]
//   node harness/remote/pc-run.mjs bench --host pc [--browser msedge] [--calibration FILE | --clamp-mhz N | --no-clamp]
//   node harness/remote/pc-run.mjs run --host pc --iso C:\\discs\\game.iso --film 1p=route1.json --film 2p=route2.json
//       [--browser chrome,msedge] [--runs 3] [--calibration FILE | --clamp-mhz N | --no-clamp] [--query Q]
//   node harness/remote/pc-run.mjs all --host pc --iso ... --film ... (check, setup, calibrate, run)
//   node harness/remote/pc-run.mjs status|fetch|restore --host pc --job ID
//   any command with --dry-run: no connection; every ssh/scp printed, a
//   simulated PC answers (the commands' shape and the flow, checked offline)
//
// What it changes on the PC, all undone by restore (run at the end of every
// job, and by the job's own task if the Mac is gone): the kit's power scheme
// (a copy of the active one, carrying the clamp), one scheduled task
// \SalonKit\<job>; files under C:\salon-kit. It never installs a browser or a
// driver, never edits a user scheme, never copies a disc (the PC reads its
// own, --iso is a path ON the PC).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { classifyJit, LIFTOFF_FLAGS, LIFTOFF_GAP } from "../probes/pc-bench.mjs";
import { assertSendable, benchHold, CLASS_CORES, encodePs, gb6Of, j1bMarkdown, j1bTable, JOB_ID, KIT_DIR, KIT_SCHEME, kitCommand, newJobId, parseKitJson, preflight, preflightMarkdown, psQuote, restoreDiff, rowsIn, samplerVerdict, stepWindows, versionOutliers } from "../lib/pc-kit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
export const NODE_VERSION = "v24.22.2";
export const PLAYWRIGHT_VERSION = "1.56.1";
// The J1a product query (research/etat-produit-20261107.md, Salon's Auto on
// an NVIDIA or Apple adapter: 3x, aniso 16, light sharpening, 16:9).
export const J1_QUERY = "core=upstream&video=wgpu&presenter=webgpu&cpu=dual&speed=1&oc=1&pacing=tick&fastsw=1&wasmjit=1&jitwarmup=700&aot=1&aotcompiler=1&jitoffthread=1&ir=3&aniso=16&fsr=light&widescreen=1";
export const POLL_SEC = 30;
const W = (...p) => p.join("\\");
const scpPath = (win) => win.replace(/\\/g, "/");

// ---- transport: real ssh/scp, or a recorder answering as a simulated PC
export function sshTransport(host, { log = console.error } = {}) {
  const base = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15"];
  return {
    dry: false,
    // every call bounded: a hung remote call must not hold the Mac side
    // forever (npm install and tree unpacking take the longest)
    ssh(command, { quiet = false, timeoutSec = 900 } = {}) {
      const r = spawnSync("ssh", [...base, host, command], { encoding: "utf8", maxBuffer: 1 << 28, timeout: timeoutSec * 1000, killSignal: "SIGKILL" });
      if (r.error?.code === "ETIMEDOUT") throw new Error(`ssh ${host}: no answer in ${timeoutSec} s`);
      if (r.status !== 0 && !quiet) throw new Error(`ssh ${host} exit ${r.status}: ${String(r.stderr).trim().slice(-600)}`);
      return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
    },
    put(local, remoteWin) {
      const r = spawnSync("scp", [...base, "-q", local, `${host}:${scpPath(remoteWin)}`], { encoding: "utf8", timeout: 1800 * 1000, killSignal: "SIGKILL" });
      if (r.status !== 0) throw new Error(`scp ${local} -> ${remoteWin}: ${String(r.stderr).trim()}`);
    },
    getDir(remoteWin, localParent) {
      const r = spawnSync("scp", [...base, "-q", "-r", `${host}:${scpPath(remoteWin)}`, localParent], { encoding: "utf8", timeout: 1800 * 1000, killSignal: "SIGKILL" });
      if (r.status !== 0) throw new Error(`scp -r ${remoteWin}: ${String(r.stderr).trim()}`);
    },
    log
  };
}

// A simulated PC for --dry-run and the tests: salon-pc.ps1's answers, its
// power scheme and task state, jobs finishing at once.
export function simulatedPc({ cpu = "13th Gen Intel(R) Core(TM) i9-13900K", log = console.error, overrides = {} } = {}) {
  const st = { active: "381b4222-f694-41f0-9685-ff5bb260df2e", schemes: ["381b4222-f694-41f0-9685-ff5bb260df2e", "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c", "a1841308-3541-4fab-bc81-f71556f20b4a"], tasks: [], snapshots: {}, files: new Set() };
  const proc = { PROCFREQMAX: { ac: 0, dc: 0 }, PROCFREQMAX1: { ac: 0, dc: 0 }, PROCTHROTTLEMAX: { ac: 100, dc: 100 }, PROCTHROTTLEMAX1: { ac: 100, dc: 100 }, PERFBOOSTMODE: { ac: 2, dc: 2 } };
  const calls = [];
  const decode = (command) => {
    const m = /-EncodedCommand (\S+)/.exec(command);
    return m ? Buffer.from(m[1], "base64").toString("utf16le") : command;
  };
  const arg = (s, k) => (new RegExp(`-${k} '([^']*)'`).exec(s) ?? new RegExp(`-${k} (-?\\d+)`).exec(s))?.[1] ?? null;
  const reply = (o) => ({ status: 0, out: `SALONKIT-JSON ${JSON.stringify(o)}\n`, err: "" });
  return {
    dry: true, calls, state: st, log,
    ssh(command) {
      const script = decode(command);
      calls.push({ kind: "ssh", command, script });
      log(`[dry-run] ssh: ${script}`);
      const action = arg(script, "Action");
      const job = arg(script, "Job");
      switch (action) {
        case "check": return reply({
          action, os: { caption: "Microsoft Windows 11 Pro", build: "26100" }, cpu: { name: cpu, cores: 24, logical: 32 },
          classAffinity: { mask: "0xfff", cores: 6, threads: 12, efficiencyClass: 1, hybrid: true },
          memory: { totalGiB: 64, freeGiB: 50 }, gpus: [{ name: "NVIDIA GeForce RTX 4080", driver: "32.0.15.6614", driverDate: "2026-10-01", refreshHz: 60 }],
          browsers: { chrome: { version: "157.0.8103.39", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }, edge: { version: "157.0.3200.12", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" } },
          policies: {}, power: { battery: [], activeScheme: st.active, schemes: [...st.schemes], kitSchemeActive: st.active === KIT_SCHEME, overlayAc: null },
          session: { sessions: ["baptiste|console|1|Active|none|08/11/2026 20:00"], lockScreenUp: false }, disk: { drive: "C", freeGiB: 200 },
          kit: { tasks: [...st.tasks] }, cpuBusy: { otherPctOfOneCore: 3, top: [] }, ...overrides
        });
        case "stat": return reply({ action, path: arg(script, "Path"), exists: true, bytes: 1459978240 });
        case "snapshot":
          if (!st.snapshots[job]) st.snapshots[job] = { activeScheme: st.active, schemes: [...st.schemes], processor: structuredClone(proc), tasks: [...st.tasks] };
          return reply({ action, job, state: st.snapshots[job] });
        case "clamp":
          if (!st.snapshots[job]) return { status: 1, out: "", err: "no snapshot" };
          if (!st.schemes.includes(KIT_SCHEME)) st.schemes.push(KIT_SCHEME);
          st.active = KIT_SCHEME;
          return reply({ action, job, maxMhz: Number(arg(script, "MaxMhz") ?? 0) });
        case "start": st.tasks.push(job); return reply({ action, job, state: "running" });
        case "status": return reply({ action, job, state: "done", exit: 0, logTail: ["[dry-run] step done"] });
        case "restore": {
          const before = st.snapshots[job] ?? null;
          if (before) st.active = before.activeScheme;
          st.schemes = st.schemes.filter((s) => s !== KIT_SCHEME);
          st.tasks = st.tasks.filter((t) => t !== job);
          return reply({ action, job, before, after: { activeScheme: st.active, schemes: [...st.schemes], processor: structuredClone(proc), tasks: [...st.tasks], kitProcesses: [], jobProcesses: [], jobTmp: false }, killed: [], warnings: [] });
        }
        case "uninstall": return st.tasks.length || st.schemes.includes(KIT_SCHEME) ? { status: 1, out: "", err: "restore first" } : reply({ action, kitDir: KIT_DIR, removed: true });
        default: return { status: 0, out: "", err: "" }; // mkdir, expand, npm: nothing to answer
      }
    },
    put(local, remoteWin) { calls.push({ kind: "put", local, remote: remoteWin }); st.files.add(remoteWin); log(`[dry-run] scp ${local} -> ${scpPath(remoteWin)}`); },
    getDir(remoteWin, localParent) { calls.push({ kind: "get", remote: remoteWin, local: localParent }); log(`[dry-run] scp -r ${scpPath(remoteWin)} -> ${localParent}`); mkdirSync(path.join(localParent, path.win32.basename(remoteWin)), { recursive: true }); }
  };
}

// ---- PC operations
const kit = (t, action, params = {}) => {
  const r = t.ssh(kitCommand(action, params), { timeoutSec: action === "check" ? 180 : 120 });
  const j = parseKitJson(r.out);
  if (!j) throw new Error(`salon-pc.ps1 -Action ${action}: no result: ${(r.err || r.out).trim().slice(-600)}`);
  return j;
};
const ps = (t, script, opts) => t.ssh(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePs(script)}`, opts);

export function pushKitScript(t) {
  ps(t, `New-Item -ItemType Directory -Force -Path ${psQuote(KIT_DIR)}, ${psQuote(W(KIT_DIR, "jobs"))}, ${psQuote(W(KIT_DIR, "state"))}, ${psQuote(W(KIT_DIR, "films"))}, ${psQuote(W(KIT_DIR, "trees"))} | Out-Null`);
  t.put(path.join(HERE, "pc-win", "salon-pc.ps1"), W(KIT_DIR, "salon-pc.ps1"));
}

export function check(t, { iso = null, browsers = ["chrome", "msedge"], cores = CLASS_CORES } = {}) {
  pushKitScript(t);
  const c = kit(t, "check", { Cores: cores });
  if (iso) c.iso = kit(t, "stat", { Path: iso });
  return { check: c, preflight: preflight(c, { browsers, needIso: iso }) };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function fetchTo(url, file) {
  const r = spawnSync("curl", ["-sfL", "--retry", "2", "-o", file, url]);
  if (r.status !== 0) throw new Error(`download ${url}: curl exit ${r.status}`);
}

// The kit's tools on the PC: node (verified against nodejs.org's SHASUMS256),
// Playwright (driver only: it starts the installed Chrome or Edge), the
// harness tree (this checkout's HEAD) and the engine tree (--engine).
export function setup(t, { tmp, engine, dry }) {
  pushKitScript(t);
  const zip = `node-${NODE_VERSION}-win-x64.zip`;
  const nodeZip = path.join(tmp, zip);
  if (!dry) {
    if (!existsSync(nodeZip)) {
      const sums = path.join(tmp, `SHASUMS256-${NODE_VERSION}.txt`);
      fetchTo(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, sums);
      fetchTo(`https://nodejs.org/dist/${NODE_VERSION}/${zip}`, nodeZip);
      const want = readFileSync(sums, "utf8").split("\n").find((l) => l.endsWith(`  ${zip}`))?.split(/\s+/)[0];
      if (!want || want !== sha256(nodeZip)) throw new Error(`${zip}: sha256 does not match SHASUMS256.txt`);
    }
  }
  const have = ps(t, `$n = ${psQuote(W(KIT_DIR, "node", "node.exe"))}; if (Test-Path -LiteralPath $n) { & $n -v }`, { quiet: true }).out.trim();
  if (have !== NODE_VERSION) {
    t.put(nodeZip, W(KIT_DIR, zip));
    ps(t, [`$z = ${psQuote(W(KIT_DIR, zip))}; $d = ${psQuote(W(KIT_DIR, "node-tmp"))}`,
      `if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force }`,
      `Expand-Archive -LiteralPath $z -DestinationPath $d`,
      `if (Test-Path -LiteralPath ${psQuote(W(KIT_DIR, "node"))}) { Remove-Item -LiteralPath ${psQuote(W(KIT_DIR, "node"))} -Recurse -Force }`,
      `Move-Item -LiteralPath (Join-Path $d ${psQuote(`node-${NODE_VERSION}-win-x64`)}) -Destination ${psQuote(W(KIT_DIR, "node"))}`,
      `Remove-Item -LiteralPath $d -Recurse -Force; Remove-Item -LiteralPath $z -Force`].join("; "));
  }
  const pwHave = ps(t, `$p = ${psQuote(W(KIT_DIR, "pw", "node_modules", "playwright", "package.json"))}; if (Test-Path -LiteralPath $p) { (Get-Content -Raw $p | ConvertFrom-Json).version }`, { quiet: true }).out.trim();
  if (pwHave !== PLAYWRIGHT_VERSION) {
    const tgz = [`playwright-core-${PLAYWRIGHT_VERSION}.tgz`, `playwright-${PLAYWRIGHT_VERSION}.tgz`];
    if (!dry && tgz.some((f) => !existsSync(path.join(tmp, f)))) execFileSync("npm", ["pack", `playwright-core@${PLAYWRIGHT_VERSION}`, `playwright@${PLAYWRIGHT_VERSION}`, "--silent"], { cwd: tmp, stdio: ["ignore", "ignore", "inherit"] });
    for (const f of tgz) t.put(path.join(tmp, f), W(KIT_DIR, f));
    ps(t, [`$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'; $env:Path = ${psQuote(W(KIT_DIR, "node"))} + ';' + $env:Path`,
      `$env:npm_config_cache = ${psQuote(W(KIT_DIR, "npm-cache"))}; $env:TEMP = ${psQuote(W(KIT_DIR, "npm-tmp"))}; $env:TMP = $env:TEMP; New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null`,
      `New-Item -ItemType Directory -Force -Path ${psQuote(W(KIT_DIR, "pw"))} | Out-Null`,
      `& ${psQuote(W(KIT_DIR, "node", "npm.cmd"))} install --prefix ${psQuote(W(KIT_DIR, "pw"))} --no-audit --no-fund --offline ${tgz.map((f) => psQuote(W(KIT_DIR, f))).join(" ")}`,
      `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`].join("; "));
  }
  const trees = {};
  for (const [name, ref] of [["harness", "HEAD"], ["engine", engine]]) {
    const sha = execFileSync("git", ["rev-parse", `${ref}^{commit}`], { cwd: REPO, encoding: "utf8" }).trim();
    const dest = W(KIT_DIR, "trees", sha.slice(0, 12));
    trees[name] = { ref, sha, dest };
    if (name === "engine" && trees.harness.sha === sha) continue;
    if (name === "harness" && execFileSync("git", ["status", "--porcelain", "--untracked-files=no", "harness"], { cwd: REPO, encoding: "utf8" }).trim()) t.log?.(`[pc-run] note: uncommitted harness changes are not sent (HEAD ${sha.slice(0, 12)} is)`);
    if (ps(t, `if (Test-Path -LiteralPath ${psQuote(W(dest, "package.json"))}) { 'present' }`, { quiet: true }).out.trim() === "present") continue;
    const tar = path.join(tmp, `tree-${sha.slice(0, 12)}.tar`);
    if (!dry && !existsSync(tar)) execFileSync("git", ["archive", "--format=tar", "-o", tar, sha], { cwd: REPO });
    t.put(tar, W(KIT_DIR, `tree-${sha.slice(0, 12)}.tar`));
    ps(t, [`$d = ${psQuote(dest)}; New-Item -ItemType Directory -Force -Path $d | Out-Null`,
      `tar.exe -xf ${psQuote(W(KIT_DIR, `tree-${sha.slice(0, 12)}.tar`))} -C $d; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
      `Remove-Item -LiteralPath ${psQuote(W(KIT_DIR, `tree-${sha.slice(0, 12)}.tar`))} -Force`].join("; "));
  }
  return { node: NODE_VERSION, playwright: PLAYWRIGHT_VERSION, trees };
}

// The engine Salon pins (its engine.lock), else origin/main.
export function defaultEngineRef(repo = REPO) {
  const lock = path.join(repo, "..", "salon", "engine.lock");
  try { return JSON.parse(readFileSync(lock, "utf8")).commit; } catch { return "origin/main"; }
}

// A job's spec (salon-pc.ps1 inner reads it): steps of node runs, the env,
// the class affinity, restoreAtEnd.
export function jobSpec({ harnessDir, steps, affinity, env = {} }) {
  return {
    cwd: harnessDir, affinity: affinity ?? null, restoreAtEnd: true,
    env: { HARNESS_DISPLAY: "windows", PLAYWRIGHT_MODULE: W(KIT_DIR, "pw", "node_modules", "playwright", "index.mjs"), ...env },
    steps: steps.map((s) => ({ name: s.name, args: s.args, env: s.env ?? {}, continueOnError: Boolean(s.continueOnError) }))
  };
}
const channelOf = (b) => ({ chrome: "chrome", edge: "msedge", msedge: "msedge" })[b] ?? (() => { throw new Error(`--browser ${b}: chrome or msedge`); })();
// The bench runs on the game's origin (http://127.0.0.1:JOB_PORT, the engine
// tree served): Edge's enhanced security is decided per site.
const benchStep = (name, browser, jobDir, extra = {}) => ({ name, env: { HARNESS_BROWSER_CHANNEL: channelOf(browser), ...(extra.env ?? {}) }, continueOnError: extra.continueOnError, args: ["harness/probes/pc-bench.mjs", "--runs", "3", "--port", String(JOB_PORT), ...(extra.root ? ["--root", extra.root] : []), "--out", W(jobDir, `${name}.json`)] });
// The benches of a job's start (or end): every browser, plus Chrome with the
// optimizer off, the Liftoff reference classifyJit needs.
export const benchSteps = (prefix, browsers, jobDir, root = null) => [
  ...browsers.map((b) => benchStep(`${prefix}-${channelOf(b)}`, b, jobDir, { continueOnError: true, root })),
  benchStep(`${prefix}-chrome-liftoff`, "chrome", jobDir, { continueOnError: true, root, env: { HARNESS_CHROME_ARGS: LIFTOFF_FLAGS } })
];
// A job's benches read together: score, the hold against the target, the
// JIT verdict of each against its group's Chrome and Liftoff references.
export function benchFindings(benches, target) {
  const groups = new Map();
  for (const [name, b] of Object.entries(benches)) {
    const m = /^(.*)-(chrome-liftoff|chrome|msedge)$/.exec(name);
    if (!m) continue;
    const g = groups.get(m[1]) ?? {};
    g[m[2]] = { name, b };
    groups.set(m[1], g);
  }
  const out = [];
  for (const g of groups.values()) {
    for (const key of ["chrome", "msedge"]) {
      if (!g[key]) continue;
      const { name, b } = g[key];
      const jit = classifyJit(b, { reference: g.chrome?.b, liftoff: g["chrome-liftoff"]?.b });
      // Chrome against itself: "jit" when its Liftoff reference is far
      // slower; else its optimizer is off (a policy) or the kernel cannot tell
      const chromeJit = key === "chrome" ? { ...jit, verdict: jit.gap >= LIFTOFF_GAP ? "jit" : jit.gap == null ? "unknown" : "liftoff-only?" } : jit;
      const st = b?.perRun?.[0]?.state ?? null;
      const page = st ? { visible: st.visibility === "visible", focus: st.focus, rafP50: st.rafMs?.p50 ?? null } : null;
      out.push({ name, browser: key, score: b?.score ?? null, hold: target ? benchHold(b?.score, target) : null, jit: chromeJit, page });
    }
  }
  return out;
}

// The parcours steps: one run per call, interleaved run by run over the
// browsers and the scenes (a drift touches every cell alike, as J1a did).
// The origin every page of a job is served from (Edge decides enhanced
// security per site: the bench must run where the game runs).
export const JOB_PORT = 8301;
// A parcours run's ceiling (parcours --max-sec) and the task's (salon-pc.ps1
// $TaskHours): a job that could outlast it is refused before it starts.
export const PARCOURS_MAX_SEC = 1200;
export const TASK_HOURS = 8;
export const stepCeilingSec = (step) => (/^parcours-/.test(step.name) ? PARCOURS_MAX_SEC + 180 : /calibrate/.test(step.name) ? 1800 : 300);
export function assertFitsTask(steps, hours = TASK_HOURS) {
  const sec = steps.reduce((a, st) => a + stepCeilingSec(st), 0);
  if (sec > hours * 3600 * 0.9) throw new Error(`${steps.length} steps could last ${Math.round(sec / 60)} min, over the task's ${hours} h: split the series (fewer --runs per job)`);
  return sec;
}
// One run per call; each round visits every browser and scene, and the
// order flips round by round (A B / B A), browsers and scenes alike, so a
// drift or a warm-up touches every cell alike.
export function parcoursSteps({ jobDir, iso, films, browsers, runs, query, engineDir }) {
  const steps = [];
  for (let i = 1; i <= runs; i += 1) {
    const flip = (xs) => (i % 2 ? xs : [...xs].reverse());
    for (const b of flip(browsers)) {
      for (const [scene, film] of flip(Object.entries(films))) {
        steps.push({
          name: `parcours-${scene}-${channelOf(b)}-${i}`, continueOnError: true, env: { HARNESS_BROWSER_CHANNEL: channelOf(b) },
          args: ["harness/probes/parcours.mjs", "--iso", iso, "--film", film, "--port", String(JOB_PORT), "--runs", "1", "--no-lock", "--max-sec", String(PARCOURS_MAX_SEC), "--candidate", engineDir, "--query", query, "--sampler-rows", "--out", W(jobDir, `parcours-${scene}-${channelOf(b)}-${i}`)]
        });
      }
    }
  }
  return steps;
}

// A job's life: snapshot, clamp, spec, the task, polling, fetch, restore
// and the check that the machine is as before. Always restores.
// Status polls that may fail in a row (a network blip) before the job is
// given up, and restored (which stops it first).
export const POLL_FAILURES_MAX = 10;
// The job whose restore a Ctrl-C or a SIGTERM must run.
let liveJob = null;
export function installSignalRestore(t, log = console.error) {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(sig, () => {
      if (liveJob) {
        log(`[pc-run] ${sig}: stopping and restoring job ${liveJob}`);
        try { const r = kit(t, "restore", { Job: liveJob }); const d = restoreDiff(r.before, r.after, liveJob); log(d.length ? `[pc-run] RESTORE DIFFERS: ${d.join("; ")}` : "[pc-run] machine restored"); } catch (e) { log(`[pc-run] restore failed (${e.message}): run pc-run.mjs restore --job ${liveJob}; the PC also restores at its next logon`); }
      }
      process.exit(130);
    });
  }
}
export async function runJob(t, { job, steps, affinity, clamp, outDir, env = {}, harnessDir, poll = POLL_SEC, sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)), log = console.error }) {
  const jobDir = W(KIT_DIR, "jobs", job);
  const local = path.join(outDir, job);
  mkdirSync(local, { recursive: true });
  const record = { job, started: new Date().toISOString(), clamp: clamp ?? null, affinity, ceilingSec: assertFitsTask(steps) };
  let restore = null;
  liveJob = job;
  try {
    record.snapshot = kit(t, "snapshot", { Job: job }).state;
    if (clamp) record.clamped = kit(t, "clamp", { Job: job, MaxMhz: clamp.maxMhz ?? 0, StatePct: clamp.statePct ?? 0, BoostMode: clamp.boostMode ?? -1 });
    const spec = jobSpec({ harnessDir, steps, affinity, env });
    writeFileSync(path.join(local, "spec.json"), JSON.stringify(spec, null, 1) + "\n");
    ps(t, `New-Item -ItemType Directory -Force -Path ${psQuote(jobDir)} | Out-Null`);
    t.put(path.join(local, "spec.json"), W(jobDir, "spec.json"));
    record.start = kit(t, "start", { Job: job });
    const shown = new Set();
    let failures = 0;
    const deadline = Date.now() + (record.ceilingSec + 600) * 1000;
    for (;;) {
      let s;
      try {
        s = kit(t, "status", { Job: job });
        failures = 0;
      } catch (e) {
        failures += 1;
        log(`[pc-run] status failed (${failures}/${POLL_FAILURES_MAX}): ${e.message}`);
        if (failures >= POLL_FAILURES_MAX) throw new Error(`job ${job}: no status for ${failures} polls in a row`);
        await sleep(poll);
        continue;
      }
      for (const l of s.logTail ?? []) if (!shown.has(l)) { shown.add(l); log(`[pc] ${l}`); }
      if (s.state === "done") { record.exit = s.exit; break; }
      if (s.state === "missing") throw new Error(`job ${job}: the task is gone and left no exit`);
      if (s.state === "dead") throw new Error(`job ${job}: the task stopped without an exit (time limit, logoff, crash)`);
      if (Date.now() > deadline) throw new Error(`job ${job}: past its ceiling of ${Math.round(record.ceilingSec / 60)} min`);
      await sleep(poll);
    }
    t.getDir(jobDir, outDir);
  } finally {
    liveJob = null;
    try {
      restore = kit(t, "restore", { Job: job });
    } catch (e) {
      log(`[pc-run] RESTORE FAILED (${e.message}): run pc-run.mjs restore --job ${job} as soon as the PC answers; the PC restores this job itself at its next logon`);
      throw e;
    }
    record.restore = { after: restore.after, warnings: restore.warnings, killed: restore.killed, diff: restoreDiff(restore.before, restore.after, job) };
    writeFileSync(path.join(local, "kit-record.json"), JSON.stringify(record, null, 1) + "\n");
    if (record.restore.diff.length) log(`[pc-run] RESTORE DIFFERS: ${record.restore.diff.join("; ")}`);
    else log("[pc-run] machine restored (power scheme, schemes, processor settings, tasks as before)");
  }
  return record;
}

// The clamp to measure with: a calibration file's choice, --clamp-mhz, or none.
export function clampOf(values) {
  if (values["no-clamp"]) return null;
  if (values["clamp-mhz"]) return { maxMhz: Number(values["clamp-mhz"]) };
  if (values.calibration) {
    const c = JSON.parse(readFileSync(values.calibration, "utf8"));
    if (!c.chosen) throw new Error(`${values.calibration}: no usable clamp (${c.why})`);
    return { ...c.chosen, target: c.target, calibration: path.basename(path.dirname(path.resolve(values.calibration))) };
  }
  throw new Error("say which clamp: --calibration FILE (pc-run calibrate), --clamp-mhz N, or --no-clamp (the host's own speed)");
}

// The local report of a fetched job: preflight, the clamp, the sampler and
// for parcours jobs the J1b table.
export function jobReport(local, { check = null } = {}) {
  const lines = [`# PC kit job ${path.basename(local)}`, ""];
  if (check) lines.push("## Preflight", "", preflightMarkdown(check.preflight), "");
  const read = (f) => (existsSync(path.join(local, f)) ? readFileSync(path.join(local, f), "utf8").replace(/^\uFEFF/, "") : null);
  const rec = read("kit-record.json") ? JSON.parse(read("kit-record.json")) : null;
  if (rec) lines.push("## Clamp and restore", "", `clamp ${JSON.stringify(rec.clamp)}, affinity ${rec.affinity ?? "none"}, exit ${rec.exit ?? "?"}; restore: ${rec.restore?.diff?.length ? `DIFFERS (${rec.restore.diff.join("; ")})` : "as before"}`, "");
  const rows = (read("sampler.jsonl") ?? "").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l.replace(/^\uFEFF/, "")));
  const opts = { affinity: rec?.affinity ?? null, scheme: rec?.clamp ? KIT_SCHEME : null };
  const sv = samplerVerdict(rows, opts);
  const eff = rows.map((r) => r.maxEffMhz).filter(Number.isFinite).sort((a, b) => a - b);
  lines.push("## Machine during the job", "", `${sv.rows} samples, other processes median ${sv.otherMedian ?? "?"} % / p95 ${sv.otherP95 ?? "?"} % of a core; busiest core's effective clock median ${eff.length ? eff[eff.length >> 1] : "?"} MHz, max ${eff.at(-1) ?? "?"} MHz; ${sv.contaminated ? `contaminated somewhere: ${sv.reasons.join("; ")}` : "clean"}`, "");
  const windows = stepWindows(read("log") ?? "");
  // protocol §2 and §5: the clamp held at both ends of the series, and
  // which compiler each browser ran
  const target = rec?.clamp?.target ?? null;
  const benches = Object.fromEntries(Object.keys(windows).filter((n) => /^bench-/.test(n)).map((n) => [n, read(`${n}.json`) ? JSON.parse(read(`${n}.json`)) : null]));
  const seriesInvalid = [];
  const findings = benchFindings(benches, target);
  if (findings.length) {
    lines.push("## Bench (clamp held, JIT)", "");
    for (const f of findings) {
      lines.push(`- ${f.name}: score ${f.score ?? "none"}${f.hold ? `, ${f.hold.offPct} % from the target ${target}${f.hold.ok ? "" : " (OUTSIDE ±3 %)"}` : ""}; JIT ${f.jit.verdict} (hot core x${f.jit.factor ?? "?"} Chrome's, Liftoff reference x${f.jit.gap ?? "?"})`);
      if (/^bench-(pre|post)-/.test(f.name) && f.hold && !f.hold.ok) seriesInvalid.push(`${f.name} ${f.hold.offPct} % from the target`);
      if (f.browser === "chrome" && f.jit.verdict === "liftoff-only?") seriesInvalid.push(`${f.name}: Chrome no faster than its Liftoff reference (optimizer off?)`);
      if (f.page) lines.push(`  page ${f.page.visible ? "visible" : "HIDDEN"}, focus ${f.page.focus}, rAF p50 ${f.page.rafP50} ms`);
      if (/^bench-(pre|post)-/.test(f.name) && f.page && (!f.page.visible || f.page.rafP50 >= 25)) seriesInvalid.push(`${f.name}: page ${f.page.visible ? "at 30 Hz" : "hidden"}`);
    }
    lines.push("");
  }
  const cells = new Map(), excluded = [];
  for (const d of readdirSync(local).filter((x) => /^parcours-[^-]+-[^-]+-\d+$/.test(x)).sort()) {
    const f = path.join(local, d, "summary.json");
    const [, scene, browser] = /^parcours-([^-]+)-([^-]+)-\d+$/.exec(d);
    const label = `${scene} / ${browser}`;
    const c = cells.get(label) ?? { label, summary: { runs: [] } };
    cells.set(label, c);
    if (!existsSync(f)) { excluded.push(`${d}: no summary (exit ${windows[d]?.exit ?? "?"})`); continue; }
    const w = windows[d];
    const v = w ? samplerVerdict(rowsIn(rows, w), opts) : { contaminated: true, reasons: ["no window in the log"] };
    for (const r of JSON.parse(readFileSync(f, "utf8")).runs ?? []) {
      const run = { ...r, run: c.summary.runs.length + 1, step: d };
      if (v.contaminated) { excluded.push(`${d}: ${v.reasons.join("; ")}`); run.kitExcluded = true; }
      c.summary.runs.push(run);
    }
  }
  if (cells.size) {
    for (const c of cells.values()) for (const r of versionOutliers(c.summary.runs.filter((x) => !x.kitExcluded))) { excluded.push(`${r.step}: browser ${r.browserVersion}, not the cell's version`); r.kitExcluded = true; }
    for (const c of cells.values()) c.summary.runs = c.summary.runs.filter((r) => !r.kitExcluded);
    lines.push("## J1b (research/pc-windows-protocol.md)", "");
    if (seriesInvalid.length) lines.push(`**Series invalid (protocol §5): ${seriesInvalid.join("; ")}.**`, "");
    lines.push(j1bMarkdown(j1bTable([...cells.values()])), "", `Excluded (protocol §5): ${excluded.length ? excluded.join("; ") : "none"}.`, "");
  }
  writeFileSync(path.join(local, "report.md"), lines.join("\n"));
  return lines.join("\n");
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: "string" }, job: { type: "string" }, out: { type: "string" }, "dry-run": { type: "boolean", default: false },
      iso: { type: "string" }, film: { type: "string", multiple: true }, browser: { type: "string", default: "chrome,msedge" }, runs: { type: "string", default: "3" },
      query: { type: "string", default: J1_QUERY }, engine: { type: "string" }, calibration: { type: "string" }, "clamp-mhz": { type: "string" }, "no-clamp": { type: "boolean", default: false },
      "host-gb6": { type: "string" }, homebrew: { type: "string" }, "js-flags": { type: "string" }, cores: { type: "string", default: String(CLASS_CORES) }
    }
  });
  const cmd = positionals[0];
  const cmds = ["check", "setup", "smoke", "calibrate", "bench", "run", "all", "status", "fetch", "restore", "uninstall"];
  if (!cmds.includes(cmd) || !values.host) throw new Error(`usage: pc-run.mjs <${cmds.join("|")}> --host <ssh host> [options] (header of this file)`);
  const log = (m) => console.error(m);
  const dry = values["dry-run"];
  const t = dry ? simulatedPc({ log }) : sshTransport(values.host, { log });
  installSignalRestore(t, log);
  const jobBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, "pc-kit") : path.join(REPO, "..", "measures", "pc-kit");
  const outDir = path.resolve(values.out ?? jobBase);
  const tmp = path.join(outDir, "cache");
  mkdirSync(tmp, { recursive: true });
  const browsers = values.browser.split(",").map((b) => b.trim()).filter(Boolean);
  const job = values.job ?? newJobId(cmd);
  if (!JOB_ID.test(job)) throw new Error(`--job ${job}: letters, digits, . _ -`);
  // the arguments, before any connection
  if (values.iso && !/^[A-Za-z]:\\/.test(values.iso)) throw new Error(`--iso ${values.iso}: a Windows path on the PC (the kit never sends a disc)`);
  if ((cmd === "run" || cmd === "all") && (!values.iso || !values.film?.length)) throw new Error("run: --iso <path ON the PC> and --film scene=film.json (one per scene)");

  if (cmd === "status") return console.log(JSON.stringify(kit(t, "status", { Job: job }), null, 1));
  if (cmd === "restore") { const r = kit(t, "restore", { Job: job }); const d = restoreDiff(r.before, r.after, job); console.log(d.length ? `restore differs: ${d.join("; ")}` : "restored"); return void (process.exitCode = d.length ? 1 : 0); }
  if (cmd === "uninstall") { console.log(JSON.stringify(kit(t, "uninstall"))); return; }
  if (cmd === "fetch") { t.getDir(W(KIT_DIR, "jobs", job), outDir); console.log(jobReport(path.join(outDir, job))); return; }

  const pre = check(t, { iso: values.iso ?? null, browsers: browsers.map(channelOf), cores: Number(values.cores) });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `check-${job}.json`), JSON.stringify(pre.check, null, 1) + "\n");
  log(preflightMarkdown(pre.preflight));
  if (pre.preflight.blocked.length) { log(`[pc-run] blocked: ${pre.preflight.blocked.map((b) => b.id).join(", ")}`); process.exitCode = 1; return; }
  if (pre.check.kit?.tasks?.length) throw new Error(`a kit task is still registered (${pre.check.kit.tasks.join(", ")}): pc-run.mjs restore --job <it>`);
  if (cmd === "check") return;

  const engine = values.engine ?? defaultEngineRef();
  const st = setup(t, { tmp, engine, dry });
  log(`[pc-run] setup: node ${st.node}, playwright ${st.playwright}, harness ${st.trees.harness.sha.slice(0, 12)}, engine ${st.trees.engine.sha.slice(0, 12)} (${engine})`);
  if (cmd === "setup") return;

  const harnessDir = st.trees.harness.dest;
  const affinity = pre.check.classAffinity?.mask ?? null;
  const env = values["js-flags"] ? { HARNESS_CHROME_ARGS: `--js-flags=${values["js-flags"]}` } : {};
  const jobDir = (j) => W(KIT_DIR, "jobs", j);
  const go = (j, steps, clamp) => runJob(t, { job: j, steps, affinity, clamp, outDir, env, harnessDir, poll: dry ? 0 : POLL_SEC, log }).then((r) => { log(jobReport(path.join(outDir, j), { check: pre })); return r; });

  if (cmd === "smoke") {
    const steps = [
      { name: "webgpu-adapter", continueOnError: true, args: ["harness/probes/webgpu-adapter.mjs", "--port", String(JOB_PORT), "--no-unsafe-webgpu", "--expect", "adapter", "--out", W(jobDir(job), "webgpu-adapter.json")] },
      ...benchSteps("bench", browsers, jobDir(job), st.trees.engine.dest)
    ];
    if (values.homebrew) {
      assertSendable(path.resolve(values.homebrew), { homebrewDirs: [path.join(REPO, "harness", "homebrew", "out")] });
      t.put(path.resolve(values.homebrew), W(KIT_DIR, "films", path.basename(values.homebrew)));
      steps.push({ name: "presenter-homebrew", continueOnError: true, args: ["harness/probes/presenter-check.mjs", "--iso", W(KIT_DIR, "films", path.basename(values.homebrew)), "--port", String(JOB_PORT), "--query", "core=upstream&video=wgpu&presenter=webgpu&cpu=dual&speed=1", "--out", W(jobDir(job), "presenter-homebrew.json")] });
    }
    await go(job, steps, null);
    return;
  }
  if (cmd === "bench") return void (await go(job, benchSteps("bench", browsers, jobDir(job), st.trees.engine.dest), clampOf(values)));

  const calibrateJob = async (j) => {
    const hostGb6 = values["host-gb6"] ?? (gb6Of(pre.check.cpu?.name ?? "") ? null : (() => { throw new Error(`${pre.check.cpu?.name}: not in the public table, pass --host-gb6 N (with its source)`); })());
    await go(j, [{ name: "calibrate", env: { HARNESS_BROWSER_CHANNEL: channelOf(browsers[0]) }, args: ["harness/remote/pc-win/pc-calibrate.mjs", "--job", j, "--port", String(JOB_PORT), "--root", st.trees.engine.dest, "--out", W(jobDir(j), "calibration.json"), ...(hostGb6 ? ["--host-gb6", String(hostGb6)] : [])] }], { maxMhz: 0 });
    return path.join(outDir, j, "calibration.json");
  };
  if (cmd === "calibrate") return void (await calibrateJob(job));

  // run / all
  const films = {};
  for (const f of values.film) {
    const [scene, file] = f.includes("=") ? f.split(/=(.*)/s) : [path.basename(f, ".json"), f];
    assertSendable(file);
    const sum = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
    const remote = W(KIT_DIR, "films", `${path.basename(file, ".json")}-${sum}.json`);
    t.put(path.resolve(file), remote);
    films[scene] = remote;
  }
  const clamp = cmd === "all" && !values.calibration && !values["clamp-mhz"] && !values["no-clamp"]
    ? clampOf({ calibration: await calibrateJob(`${job}-cal`) })
    : clampOf(values);
  const steps = [
    ...benchSteps("bench-pre", browsers, jobDir(job), st.trees.engine.dest),
    ...parcoursSteps({ jobDir: jobDir(job), iso: values.iso, films, browsers, runs: Number(values.runs), query: values.query, engineDir: st.trees.engine.dest }),
    ...benchSteps("bench-post", browsers, jobDir(job), st.trees.engine.dest)
  ];
  await go(job, steps, clamp);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
