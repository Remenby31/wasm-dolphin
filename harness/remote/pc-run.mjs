#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The PC kit, Mac side (research/pc-windows-kit.md): drives a Windows PC
// over ssh (OpenSSH Server, Tailscale) with two identities:
//   --host        the kit's STANDARD account (e.g. salonkit@pc): everything
//                 (files, node, Playwright, the jobs in that account's own
//                 desktop session, cleanup, reading the power state), via
//                 harness/remote/pc-win/salon-pc.ps1; never elevated;
//   --admin-host  an administrator (e.g. baptiste@pc): ONLY the closed list
//                 of lib/pc-kit.mjs ADMIN (powercfg.exe / schtasks.exe by
//                 absolute path, constant or regex-checked GUID arguments),
//                 every line checked by assertAdmin before it is sent.
//
//   node harness/remote/pc-run.mjs check --host salonkit@pc [--admin-host baptiste@pc] [--iso C:\\discs\\game.iso]
//   node harness/remote/pc-run.mjs setup --host salonkit@pc [--engine REF]
//   node harness/remote/pc-run.mjs smoke --host salonkit@pc [--homebrew harness/homebrew/out/gxscene.iso]
//   node harness/remote/pc-run.mjs calibrate --host salonkit@pc --admin-host baptiste@pc [--browser chrome] [--host-gb6 N]
//   node harness/remote/pc-run.mjs bench --host ... [--admin-host ...] [--browser msedge] [--calibration FILE | --clamp-mhz N | --no-clamp]
//   node harness/remote/pc-run.mjs run --host ... --admin-host ... --iso C:\\discs\\game.iso --film 1p=route1.json --film 2p=route2.json
//       [--browser chrome,msedge] [--runs 3] [--calibration FILE | --clamp-mhz N | --no-clamp] [--query Q]
//   node harness/remote/pc-run.mjs all ... (check, setup, calibrate, run)
//   node harness/remote/pc-run.mjs status|fetch|restore|uninstall --host ... [--admin-host ...] [--job ID]
//   any command with --dry-run: no connection; every ssh/scp printed, a
//   simulated PC answers (the commands' shape and the flow, checked offline)
//
//   --allow-elevated-host (opt-in): the --host account may be an administrator (the PC's own logged-in user); the
//   standard-account check then warns instead of blocking. Default off: the kit's account is salonkit.
//
// What it changes on the PC: the kit's power scheme (a copy of the active
// one, carrying the clamp) and the boot task SalonKitRestore (SYSTEM, at
// startup: puts the snapshot's scheme back and deletes itself; the kit's
// scheme then stays, inactive, until restore), both by the admin list and
// both undone by restore (at the end of every job, on Ctrl-C/SIGTERM); in the kit account: one scheduled task per
// job and files under its %USERPROFILE%\\salon-kit. It never installs a
// browser or a driver, never edits a user scheme, never copies a disc (the
// PC reads its own, --iso is a path ON the PC).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { classifyJit, LIFTOFF_FLAGS, LIFTOFF_GAP } from "../probes/pc-bench.mjs";
import { calibrate } from "./pc-win/pc-calibrate.mjs";
import { ADMIN, assertAdmin, origFromGetActive, sshdShellOk, assertSendable, BALANCED, benchHold, MAX_TURBO_MHZ, CLASS_CORES, encodePs, gb6Of, j1bMarkdown, j1bTable, JOB_ID, KIT_DIR, KIT_SCHEME, kitCommand, newJobId, parseKitJson, POWERCFG, POWERSHELL, preflight, preflightMarkdown, psQuote, restoreDiff, rowsIn, samplerVerdict, SCHTASKS, SETTINGS, setKitDir, stepWindows, versionOutliers } from "../lib/pc-kit.mjs";

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

// A simulated PC for --dry-run and the tests: salon-pc.ps1's answers (the
// standard account), the admin list's effects on the power state, jobs
// finishing at once. One object serves as both transports.
export function simulatedPc({ cpu = "13th Gen Intel(R) Core(TM) i9-13900K", log = console.error, overrides = {} } = {}) {
  const st = { active: BALANCED, schemes: [BALANCED, "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c", "a1841308-3541-4fab-bc81-f71556f20b4a"], tasks: [], snapshots: {}, files: new Set(), bootTask: false, maxMhz: 0, statePct: 0, admin: [] };
  const proc = { PROCFREQMAX: { ac: 0, dc: 0 }, PROCFREQMAX1: { ac: 0, dc: 0 }, PROCTHROTTLEMAX: { ac: 100, dc: 100 }, PROCTHROTTLEMAX1: { ac: 100, dc: 100 }, PERFBOOSTMODE: { ac: 2, dc: 2 } };
  const calls = [];
  const decode = (command) => {
    const m = /-EncodedCommand (\S+)/.exec(command);
    return m ? Buffer.from(m[1], "base64").toString("utf16le") : command;
  };
  const arg = (s, k) => (new RegExp(`-${k} '([^']*)'`).exec(s) ?? new RegExp(`-${k} (-?\\d+)`).exec(s))?.[1] ?? null;
  const reply = (o) => ({ status: 0, out: `SALONKIT-JSON ${JSON.stringify(o)}\n`, err: "" });
  const power = () => ({ activeScheme: st.active, schemes: [...st.schemes], processor: structuredClone(proc), kitScheme: st.schemes.includes(KIT_SCHEME) ? { PROCFREQMAX: { ac: st.maxMhz, dc: st.maxMhz } } : null });
  const adminLine = (line) => {
    st.admin.push(line);
    let m;
    // schtasks first: the boot task's /tr itself holds powercfg lines
    if (line.startsWith(SCHTASKS)) {
      if (/^\S+ \/create /.test(line)) st.bootTask = true;
      else if (/^\S+ \/query /.test(line)) return { status: st.bootTask ? 0 : 1, out: "", err: "" };
      else if (/^\S+ \/delete /.test(line)) { if (!st.bootTask) return { status: 1, out: "", err: "no task" }; st.bootTask = false; }
      return { status: 0, out: "", err: "" };
    }
    if ((m = /\/duplicatescheme \S+ (\S+)$/.exec(line))) { if (!st.schemes.includes(m[1])) st.schemes.push(m[1]); }
    else if ((m = /\/set(ac|dc)valueindex \S+ \S+ (\S+) (\d+)$/.exec(line))) {
      if (m[2] === SETTINGS.PROCFREQMAX) st.maxMhz = Number(m[3]);
      if (m[2] === SETTINGS.PROCTHROTTLEMAX) st.statePct = Number(m[3]) === 100 ? 0 : Number(m[3]);
    } else if ((m = /\/setactive (\S+)$/.exec(line))) st.active = m[1];
    else if (/powercfg\.exe \/delete /.test(line)) { st.schemes = st.schemes.filter((x) => x !== KIT_SCHEME); st.maxMhz = 0; st.statePct = 0; }
    else if (/\/getactivescheme$/.test(line)) return { status: 0, out: `Power Scheme GUID: ${st.active}  (x)`, err: "" };
    return { status: 0, out: "", err: "" };
  };
  return {
    dry: true, calls, state: st, log,
    ssh(command) {
      if (command.startsWith(POWERCFG) || command.startsWith(SCHTASKS)) {
        calls.push({ kind: "admin", command, script: command });
        log(`[dry-run] admin: ${command}`);
        return adminLine(command);
      }
      if (command === "echo %USERPROFILE%") return { status: 0, out: "C:\\Users\\salonkit\r\n", err: "" };
      const script = decode(command);
      calls.push({ kind: "ssh", command, script });
      log(`[dry-run] ssh: ${script}`);
      const action = arg(script, "Action");
      const job = arg(script, "Job");
      switch (action) {
        case "check": return reply({
          action, os: { caption: "Microsoft Windows 11 Pro", build: "26100" }, cpu: { name: cpu, cores: 24, logical: 32 },
          classAffinity: { mask: "0xfff", cores: 6, threads: 12, efficiencyClass: 1, hybrid: true },
          memory: { totalGiB: 64, freeGiB: 50 }, gpus: [{ name: "NVIDIA GeForce RTX 4080", driver: "32.0.15.6614", driverDate: "2026-10-01", present: true, started: true, refreshHz: null }], display: [{ target: "00", width: 3840, height: 2160, refreshHz: 60 }],
          browsers: { chrome: { version: "157.0.8103.39", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }, edge: { version: "157.0.3200.12", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" } },
          policies: {}, power: { battery: [], activeScheme: st.active, schemes: [...st.schemes], kitSchemeActive: st.active === KIT_SCHEME, overlayAc: null },
          session: { sessions: ["salonkit|console|1|Active|none|08/11/2026 20:00"], lockScreenUp: false, elevated: false, user: "salonkit" }, disk: { drive: "C", freeGiB: 200 },
          sshd: { defaultShell: "C:\\Windows\\System32\\cmd.exe", defaultShellCommandOption: "/d /c" },
          kit: { tasks: [...st.tasks] }, cpuBusy: { otherPctOfOneCore: 3, top: [] }, ...overrides
        });
        case "stat": return reply({ action, path: arg(script, "Path"), exists: true, bytes: 1459978240 });
        case "snapshot":
          if (!st.snapshots[job]) st.snapshots[job] = { activeScheme: st.active, schemes: [...st.schemes], processor: structuredClone(proc), tasks: [...st.tasks], kitProcesses: [] };
          return reply({ action, job, state: st.snapshots[job] });
        case "power": return reply({ action, power: power(), tasks: [...st.tasks] });
        case "sshd": return reply({ action, sshd: st.sshd ?? { defaultShell: "C:\\Windows\\System32\\cmd.exe", defaultShellCommandOption: "/d /c" } });
        case "cleanup": st.tasks = st.tasks.filter((x) => x !== job); return reply({ action, job, killed: [], jobProcesses: [], jobTmp: false, warnings: [], power: power(), tasks: [...st.tasks], kitProcesses: [] });
        case "start": st.tasks.push(job); return reply({ action, job, state: "running" });
        case "status": return reply({ action, job, state: "done", exit: 0, logTail: ["[dry-run] step done"] });
        case "uninstall": return st.tasks.length || st.schemes.includes(KIT_SCHEME) ? { status: 1, out: "", err: "restore first" } : reply({ action, kitDir: KIT_DIR, removed: true });
        default: return { status: 0, out: "", err: "" }; // mkdir, expand, npm: nothing to answer
      }
    },
    put(local, remoteWin) { calls.push({ kind: "put", local, remote: remoteWin }); st.files.add(remoteWin); log(`[dry-run] scp ${local} -> ${scpPath(remoteWin)}`); },
    getDir(remoteWin, localParent) {
      calls.push({ kind: "get", remote: remoteWin, local: localParent });
      log(`[dry-run] scp -r ${scpPath(remoteWin)} -> ${localParent}`);
      const dir = path.join(localParent, path.win32.basename(remoteWin));
      mkdirSync(dir, { recursive: true });
      // a calibration probe: a bench whose score follows the clamp (a model
      // CPU: 5800 MHz turbo, score proportional to the clock)
      if (/-b\d+$/.test(dir)) {
        const clock = Math.min(5800, st.maxMhz || 5800) * (st.statePct ? st.statePct / 100 : 1);
        writeFileSync(path.join(dir, "bench.json"), JSON.stringify({ score: Math.round(clock * 0.02 * 1000) / 1000, perRun: [{ state: { visibility: "visible", focus: true, rafMs: { p50: 16.7 } } }] }));
      }
    }
  };
}

// ---- PC operations
// The Mac's copy of salon-pc.ps1: every call checks the PC's against it.
export const KIT_SHA256 = createHash("sha256").update(readFileSync(path.join(HERE, "pc-win", "salon-pc.ps1"))).digest("hex");
// One salon-pc.ps1 action, as the kit's standard account.
const kit = (t, action, params = {}) => {
  const r = t.ssh(kitCommand(action, params, { sha256: KIT_SHA256 }), { timeoutSec: action === "check" ? 180 : 120 });
  const j = parseKitJson(r.out);
  if (!j) throw new Error(`salon-pc.ps1 -Action ${action}: no result: ${(r.err || r.out).trim().slice(-600)}`);
  return j;
};
// One line of the closed admin list, as the administrator. Anything else is
// refused here, before it leaves the Mac. Before the FIRST admin line of a
// transport (whatever the command: run, restore, Ctrl-C), the standard
// account re-reads OpenSSH's shell: cmd.exe with exactly "/d /c", else
// HKCU AutoRun would run as the admin before the line.
export function adminTransport(t, ssh) {
  if (!ssh) return null;
  return { ssh, kitTransport: t, shellChecked: false };
}
export function admin(a, line, { quiet = false } = {}) {
  if (!a) throw new Error("this needs --admin-host (an administrator): the clamp is the kit's only elevated operation");
  const checked = assertAdmin(line);
  if (!a.shellChecked) {
    const sh = kit(a.kitTransport, "sshd").sshd;
    if (!sshdShellOk(sh)) throw new Error(`refused: OpenSSH's shell is ${sh?.defaultShell ?? "unset"} ${sh?.defaultShellCommandOption ?? ""}, not cmd.exe /d /c (HKCU AutoRun would run as the admin)`);
    a.shellChecked = true;
  }
  return a.ssh.ssh(checked, { quiet, timeoutSec: 60 });
}
const ps = (t, script, opts) => t.ssh(`${POWERSHELL} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePs(script)}`, opts);

// The kit's folder: the standard account's %USERPROFILE%\salon-kit.
export function initKitDir(t) {
  const home = t.ssh("echo %USERPROFILE%", { timeoutSec: 30 }).out.trim();
  setKitDir(`${home}\\salon-kit`);
  return KIT_DIR;
}
export function pushKitScript(t) {
  ps(t, `New-Item -ItemType Directory -Force -Path ${[KIT_DIR, W(KIT_DIR, "jobs"), W(KIT_DIR, "state"), W(KIT_DIR, "films"), W(KIT_DIR, "trees")].map(psQuote).join(", ")} | Out-Null`);
  t.put(path.join(HERE, "pc-win", "salon-pc.ps1"), W(KIT_DIR, "salon-pc.ps1"));
}

// ---- the clamp, by the admin list only
// The kit's scheme (created from the snapshot's), its processor caps, the
// boot task (the way back, before anything is activated), then activated;
// read back as the standard account.
export function applyClamp(t, a, { orig, maxMhz = 0, statePct = 0, boostMode = -1 }) {
  if (!orig || orig === KIT_SCHEME) throw new Error("applyClamp: the way back must be a scheme other than the kit's (read by the admin's /getactivescheme)");
  const p = kit(t, "power").power;
  if (!p.schemes.includes(KIT_SCHEME)) { admin(a, ADMIN.duplicate(orig)); admin(a, ADMIN.rename()); }
  const set = (name, v) => { for (const acdc of ["ac", "dc"]) admin(a, ADMIN.setIndex(acdc, name, v), { quiet: /1$/.test(name) }); };
  set("PROCFREQMAX", maxMhz); set("PROCFREQMAX1", maxMhz);
  set("PROCTHROTTLEMAX", statePct || 100); set("PROCTHROTTLEMAX1", statePct || 100);
  if (boostMode >= 0) set("PERFBOOSTMODE", boostMode);
  // delete then create: never overwrite a task someone else may have made
  if (admin(a, ADMIN.queryBootTask(), { quiet: true }).status === 0) admin(a, ADMIN.deleteBootTask());
  admin(a, ADMIN.bootTask(orig));
  admin(a, ADMIN.activateKit());
  const after = kit(t, "power").power;
  if (after.activeScheme !== KIT_SCHEME) throw new Error(`the kit's scheme did not become active (active ${after.activeScheme})`);
  return after.kitScheme;
}
// The way back as the administrator reads it (never the standard account's
// snapshot file), kept on the Mac.
export function adminOrig(a) {
  return origFromGetActive(admin(a, ADMIN.getActive()).out);
}
// Back: the snapshot's scheme (Balanced if it is gone), the kit's scheme
// deleted, the boot task deleted. Idempotent. Returns whether the boot task
// still exists.
export function restorePower(t, a, before) {
  const p = kit(t, "power").power;
  const want = before?.adminOrig ?? before?.activeScheme;
  const target = want && p.schemes.includes(want) && want !== KIT_SCHEME ? want : BALANCED;
  if (p.activeScheme !== target || p.activeScheme === KIT_SCHEME) admin(a, ADMIN.activate(target));
  if (p.schemes.includes(KIT_SCHEME)) admin(a, ADMIN.deleteKit());
  if (admin(a, ADMIN.queryBootTask(), { quiet: true }).status === 0) admin(a, ADMIN.deleteBootTask());
  return { bootTask: admin(a, ADMIN.queryBootTask(), { quiet: true }).status === 0 };
}
// A job stopped (standard account) and the power put back (admin list):
// the after-state restoreDiff compares with the snapshot.
export function restoreJob(t, a, job, before) {
  const c = kit(t, "cleanup", { Job: job });
  const r = a ? restorePower(t, a, before) : { bootTask: null };
  const p = kit(t, "power");
  return { after: { power: p.power, tasks: p.tasks, kitProcesses: c.kitProcesses, jobProcesses: c.jobProcesses, jobTmp: c.jobTmp, bootTask: r.bootTask }, warnings: c.warnings ?? [], killed: c.killed ?? [] };
}

export function check(t, { a = null, iso = null, browsers = ["chrome", "msedge"], cores = CLASS_CORES, allowElevated = false } = {}) {
  initKitDir(t);
  pushKitScript(t);
  const c = kit(t, "check", { Cores: cores });
  if (iso) c.iso = kit(t, "stat", { Path: iso });
  const p = preflight(c, { browsers, needIso: iso, allowElevated });
  // the admin channel, only once its shell is known safe (cmd /d): one
  // read-only line of the list
  if (a && !p.blocked.some((b) => b.id === "sshd-shell")) {
    const r = admin(a, ADMIN.getActive(), { quiet: true });
    c.adminChannel = { ok: r.status === 0 && /[0-9a-f]{8}-/.test(r.out), out: r.out.trim().slice(0, 120) };
    p.items.push({ id: "admin-channel", level: c.adminChannel.ok ? "ok" : "block", seen: c.adminChannel.out || r.err.trim().slice(0, 120), ...(c.adminChannel.ok ? {} : { fix: "--admin-host must reach an administrator by key (C:\\ProgramData\\ssh\\administrators_authorized_keys)" }) });
    p.blocked = p.items.filter((i) => i.level === "block");
  }
  return { check: c, preflight: p };
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
  // node.exe runs only if its hash is the official zip's (read here from
  // the verified zip): present = same hash, else replaced
  const nodeSha = dry ? "0".repeat(64) : createHash("sha256").update(execFileSync("unzip", ["-p", nodeZip, `node-${NODE_VERSION}-win-x64/node.exe`], { maxBuffer: 1 << 28 })).digest("hex");
  const nodeExe = W(KIT_DIR, "node", "node.exe");
  const nodeCheck = `if ((Get-FileHash -LiteralPath ${psQuote(nodeExe)} -Algorithm SHA256).Hash -ne ${psQuote(nodeSha.toUpperCase())}) { throw 'node.exe differs from the official zip: refused' }`;
  const have = ps(t, `$n = ${psQuote(nodeExe)}; if ((Test-Path -LiteralPath $n) -and (Get-FileHash -LiteralPath $n -Algorithm SHA256).Hash -eq ${psQuote(nodeSha.toUpperCase())}) { 'present' }`, { quiet: true }).out.trim();
  if (have !== "present") {
    t.put(nodeZip, W(KIT_DIR, zip));
    ps(t, [`$z = ${psQuote(W(KIT_DIR, zip))}; $d = ${psQuote(W(KIT_DIR, "node-tmp"))}`,
      `if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force }`,
      `Expand-Archive -LiteralPath $z -DestinationPath $d`,
      `if (Test-Path -LiteralPath ${psQuote(W(KIT_DIR, "node"))}) { Remove-Item -LiteralPath ${psQuote(W(KIT_DIR, "node"))} -Recurse -Force }`,
      `Move-Item -LiteralPath (Join-Path $d ${psQuote(`node-${NODE_VERSION}-win-x64`)}) -Destination ${psQuote(W(KIT_DIR, "node"))}`,
      `Remove-Item -LiteralPath $d -Recurse -Force; Remove-Item -LiteralPath $z -Force`].join("; "));
    if (!dry) ps(t, nodeCheck);
  }
  const pwHave = ps(t, `$p = ${psQuote(W(KIT_DIR, "pw", "node_modules", "playwright", "package.json"))}; if (Test-Path -LiteralPath $p) { (Get-Content -Raw $p | ConvertFrom-Json).version }`, { quiet: true }).out.trim();
  if (pwHave !== PLAYWRIGHT_VERSION) {
    const tgz = [`playwright-core-${PLAYWRIGHT_VERSION}.tgz`, `playwright-${PLAYWRIGHT_VERSION}.tgz`];
    if (!dry && tgz.some((f) => !existsSync(path.join(tmp, f)))) execFileSync("npm", ["pack", `playwright-core@${PLAYWRIGHT_VERSION}`, `playwright@${PLAYWRIGHT_VERSION}`, "--silent"], { cwd: tmp, stdio: ["ignore", "ignore", "inherit"] });
    for (const f of tgz) t.put(path.join(tmp, f), W(KIT_DIR, f));
    ps(t, [`$ErrorActionPreference = 'Stop'`, ...(dry ? [] : [nodeCheck]),
      `$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'; $env:Path = ${psQuote(W(KIT_DIR, "node"))} + ';' + $env:Path`,
      `$env:npm_config_cache = ${psQuote(W(KIT_DIR, "npm-cache"))}; $env:TEMP = ${psQuote(W(KIT_DIR, "npm-tmp"))}; $env:TMP = $env:TEMP; New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null`,
      `New-Item -ItemType Directory -Force -Path ${psQuote(W(KIT_DIR, "pw"))} | Out-Null`,
      `& ${psQuote(W(KIT_DIR, "node", "npm.cmd"))} install --prefix ${psQuote(W(KIT_DIR, "pw"))} --no-audit --no-fund --offline --ignore-scripts ${tgz.map((f) => psQuote(W(KIT_DIR, f))).join(" ")}`,
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
// the class affinity.
export function jobSpec({ harnessDir, steps, affinity, env = {} }) {
  return {
    cwd: harnessDir, affinity: affinity ?? null,
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
// The job whose restore a Ctrl-C or a SIGTERM must run, and its snapshot.
let live = null;
export function installSignalRestore(t, a, log = console.error) {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(sig, () => {
      if (live) {
        log(`[pc-run] ${sig}: stopping job ${live.job} and putting the power back`);
        try { const r = restoreJob(t, a, live.job, live.before); const d = restoreDiff(live.before, r.after, live.job); log(d.length ? `[pc-run] RESTORE DIFFERS: ${d.join("; ")}` : "[pc-run] machine restored"); } catch (e) { log(`[pc-run] restore failed (${e.message}): run pc-run.mjs restore --job ${live.job}; the boot task restores the scheme at the next startup`); }
      }
      process.exit(130);
    });
  }
}
// A job's life: snapshot (standard account), clamp (admin list), the steps,
// then the job stopped and the power put back, compared with the snapshot.
// Always restores.
export async function runJob(t, { a = null, job, steps, affinity, clamp, outDir, env = {}, harnessDir, poll = POLL_SEC, sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)), log = console.error }) {
  const local = path.join(outDir, job);
  mkdirSync(local, { recursive: true });
  const record = { job, started: new Date().toISOString(), clamp: clamp ?? null, affinity, ceilingSec: assertFitsTask(steps) };
  if (clamp && !a) throw new Error("a clamp needs --admin-host");
  record.snapshot = kit(t, "snapshot", { Job: job }).state;
  if (clamp) {
    record.snapshot.adminOrig = adminOrig(a);
    writeFileSync(path.join(local, "orig.json"), JSON.stringify({ job, adminOrig: record.snapshot.adminOrig }) + "\n");
  }
  live = { job, before: record.snapshot };
  try {
    if (clamp) record.clamped = applyClamp(t, a, { orig: record.snapshot.adminOrig, ...clamp });
    record.exit = await runSteps(t, { job, steps, affinity, outDir, env, harnessDir, poll, sleep, log, ceilingSec: record.ceilingSec });
  } finally {
    live = null;
    let r;
    try {
      r = restoreJob(t, a, job, record.snapshot);
    } catch (e) {
      log(`[pc-run] RESTORE FAILED (${e.message}): run pc-run.mjs restore --job ${job} as soon as the PC answers; the boot task restores the scheme at the next startup`);
      throw e;
    }
    record.restore = { after: r.after, warnings: r.warnings, killed: r.killed, diff: a || !clamp ? restoreDiff(record.snapshot, r.after, job) : ["power not restored (no --admin-host)"] };
    writeFileSync(path.join(local, "kit-record.json"), JSON.stringify(record, null, 1) + "\n");
    if (record.restore.diff.length) log(`[pc-run] RESTORE DIFFERS: ${record.restore.diff.join("; ")}`);
    else log("[pc-run] machine restored (power scheme, schemes, processor settings, tasks, boot task as before)");
  }
  return record;
}

// A job's steps through its task, power untouched: the job's folder (the
// only one the user may write), spec, start, polling, fetch. Its task
// and processes are stopped in the end, whatever happened (cleanup; the
// power is the caller's: runJob's restore, or the calibration's).
export async function runSteps(t, { job, steps, affinity, outDir, env = {}, harnessDir, poll = POLL_SEC, sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)), log = console.error, ceilingSec = assertFitsTask(steps) }) {
  const jobDir = W(KIT_DIR, "jobs", job);
  const local = path.join(outDir, job);
  mkdirSync(local, { recursive: true });
  let exit = null;
  try {
    const spec = jobSpec({ harnessDir, steps, affinity, env });
    writeFileSync(path.join(local, "spec.json"), JSON.stringify(spec, null, 1) + "\n");
    ps(t, `$j = ${psQuote(jobDir)}; if (Test-Path -LiteralPath $j) { throw "$j exists already: a job id is used once" }; New-Item -ItemType Directory -Path $j | Out-Null`);
    t.put(path.join(local, "spec.json"), W(jobDir, "spec.json"));
    kit(t, "start", { Job: job });
    const shown = new Set();
    let failures = 0;
    const deadline = Date.now() + (ceilingSec + 600) * 1000;
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
      if (s.state === "done") { exit = s.exit; break; }
      if (s.state === "missing") throw new Error(`job ${job}: the task is gone and left no exit`);
      if (s.state === "dead") throw new Error(`job ${job}: the task stopped without an exit (time limit, logoff, crash)`);
      if (Date.now() > deadline) throw new Error(`job ${job}: past its ceiling of ${Math.round(ceilingSec / 60)} min`);
      await sleep(poll);
    }
    t.getDir(jobDir, outDir);
  } finally {
    try { kit(t, "cleanup", { Job: job }); } catch (e) { log(`[pc-run] cleanup of ${job} failed (${e.message})`); }
  }
  return exit;
}

// The calibration, driven from here: one snapshot, the clamp by the admin
// list between probes, each probe a bench sub-job <job>-bN (the standard
// account) on the game's origin under the clamp just set. Restored in the
// end, whatever happened.
export async function calibrateFromMac(t, { a, job, browser, engineDir, hostGb6, turboMhz, affinity, outDir, harnessDir, runs = 3, poll = POLL_SEC, sleep, log = console.error }) {
  const local = path.join(outDir, job);
  mkdirSync(local, { recursive: true });
  let n = 0, result = null;
  const before = kit(t, "snapshot", { Job: job }).state;
  before.adminOrig = adminOrig(a);
  writeFileSync(path.join(local, "orig.json"), JSON.stringify({ job, adminOrig: before.adminOrig }) + "\n");
  live = { job, before };
  try {
    const bench = async () => {
      n += 1;
      const sub = `${job}-b${n}`;
      const step = { ...benchStep("bench", browser, W(KIT_DIR, "jobs", sub), { root: engineDir }) };
      step.args = step.args.map((a, i, xs) => (xs[i - 1] === "--runs" ? String(runs) : a));
      await runSteps(t, { job: sub, steps: [step], affinity, outDir: local, harnessDir, poll, sleep, log });
      const f = path.join(local, sub, "bench.json");
      const b = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
      const st = b?.perRun?.[0]?.state;
      if (!(b?.score > 0)) throw new Error(`${sub}: no bench score`);
      if (st && (st.visibility !== "visible" || (st.rafMs?.p50 ?? 0) >= 25)) throw new Error(`${sub}: page ${st.visibility}, rAF ${st.rafMs?.p50} ms: see the preflight`);
      return b.score;
    };
    const clamp = (o) => applyClamp(t, a, { orig: before.adminOrig, ...o });
    result = await calibrate({ bench, clamp, hostGb6, turboMhz, log: (m) => log(`[calibrate] ${m}`) });
  } finally {
    live = null;
    const r = restoreJob(t, a, job, before);
    const diff = restoreDiff(before, r.after, job);
    log(diff.length ? `[pc-run] RESTORE DIFFERS: ${diff.join("; ")}` : "[pc-run] machine restored after the calibration");
  }
  const report = { probe: "pc-calibrate", at: new Date().toISOString(), browser, probes: n, ...result };
  writeFileSync(path.join(local, "calibration.json"), JSON.stringify(report, null, 1) + "\n");
  return path.join(local, "calibration.json");
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
      host: { type: "string" }, "admin-host": { type: "string" }, job: { type: "string" }, out: { type: "string" }, "dry-run": { type: "boolean", default: false },
      iso: { type: "string" }, film: { type: "string", multiple: true }, browser: { type: "string", default: "chrome,msedge" }, runs: { type: "string", default: "3" },
      query: { type: "string", default: J1_QUERY }, engine: { type: "string" }, calibration: { type: "string" }, "clamp-mhz": { type: "string" }, "no-clamp": { type: "boolean", default: false },
      "host-gb6": { type: "string" }, "allow-elevated-host": { type: "boolean", default: false }, homebrew: { type: "string" }, "js-flags": { type: "string" }, cores: { type: "string", default: String(CLASS_CORES) }
    }
  });
  const cmd = positionals[0];
  const cmds = ["check", "setup", "smoke", "calibrate", "bench", "run", "all", "status", "fetch", "restore", "uninstall"];
  if (!cmds.includes(cmd) || !values.host) throw new Error(`usage: pc-run.mjs <${cmds.join("|")}> --host <kit account@pc> [--admin-host <admin@pc>] [options] (header of this file)`);
  const log = (m) => console.error(m);
  const dry = values["dry-run"];
  const t = dry ? simulatedPc({ log }) : sshTransport(values.host, { log });
  const a = adminTransport(t, values["admin-host"] ? (dry ? t : sshTransport(values["admin-host"], { log })) : null);
  installSignalRestore(t, a, log);
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

  const needsAdmin = cmd === "calibrate" || cmd === "all" || cmd === "restore" || ((cmd === "run" || cmd === "bench") && !values["no-clamp"]);
  if (needsAdmin && !a) throw new Error(`${cmd} needs --admin-host <admin@pc> (the clamp's closed command list), or --no-clamp`);
  if (["status", "restore", "uninstall", "fetch"].includes(cmd)) initKitDir(t);
  if (cmd === "status") return console.log(JSON.stringify(kit(t, "status", { Job: job }), null, 1));
  if (cmd === "restore") {
    // the job's own snapshot (the first one taken; a new one if none)
    const before = kit(t, "snapshot", { Job: job }).state;
    // the way back the admin read at clamp time, kept on this Mac
    const origFile = path.join(outDir, job, "orig.json");
    if (existsSync(origFile)) before.adminOrig = JSON.parse(readFileSync(origFile, "utf8")).adminOrig;
    const r = restoreJob(t, a, job, before);
    const d = restoreDiff(before, r.after, job);
    console.log(d.length ? `restore differs: ${d.join("; ")}` : "restored");
    return void (process.exitCode = d.length ? 1 : 0);
  }
  if (cmd === "uninstall") { console.log(JSON.stringify(kit(t, "uninstall"))); return; }
  if (cmd === "fetch") { t.getDir(W(KIT_DIR, "jobs", job), outDir); console.log(jobReport(path.join(outDir, job))); return; }

  const pre = check(t, { a, iso: values.iso ?? null, browsers: browsers.map(channelOf), cores: Number(values.cores), allowElevated: values["allow-elevated-host"] });
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
  const go = (j, steps, clamp) => runJob(t, { a, job: j, steps, affinity, clamp, outDir, env, harnessDir, poll: dry ? 0 : POLL_SEC, log }).then((r) => { log(jobReport(path.join(outDir, j), { check: pre })); return r; });

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
    const known = gb6Of(pre.check.cpu?.name ?? "");
    const hostGb6 = values["host-gb6"] ? Number(values["host-gb6"]) : known?.gb6;
    if (!(hostGb6 > 0)) throw new Error(`${pre.check.cpu?.name}: not in the public table, pass --host-gb6 N (with its source)`);
    const f = await calibrateFromMac(t, { a, job: j, browser: browsers[0], engineDir: st.trees.engine.dest, hostGb6, turboMhz: known ? MAX_TURBO_MHZ[known.name] ?? null : null, affinity, outDir, harnessDir, poll: dry ? 0 : POLL_SEC, log });
    const c = JSON.parse(readFileSync(f, "utf8"));
    log(`[pc-run] calibration: chosen ${JSON.stringify(c.chosen)} (${c.why}${c.errPct != null ? `, ${c.errPct} % off` : ""}): ${f}`);
    return f;
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
