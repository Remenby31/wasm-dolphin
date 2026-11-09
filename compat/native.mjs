#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Runs files (.dol, .elf, our homebrew .iso) on a native Dolphin build with
// the software renderer, dumping every frame as PNG, and reads the report
// rows of compat/homebrew/report.h from the dumped frames. For an unpatched
// upstream Dolphin (workflow native-dolphin.yml, under xvfb on Linux): what
// our core's results would be without our patches.
//
//   node compat/native.mjs --bin <dolphin-emu-nogui> --dir <files> [--only a,b]
//        [--cores interp,jit] [--timeout 120] [--platform x11] [--config K=V ...]
//        [--json f] [--md f] [--logs dir] [--keep-user dir]
//
// Each run keeps Dolphin's stdout/stderr (--logs). Exit 1 when a run dumped
// no frame (the setup is broken), 0 otherwise: the table is the result.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { decodePng } from "../harness/lib/png.mjs";
import { decodeReport } from "./lib/report-rows.mjs";

// Dolphin's CPUCore values: 0 interpreter, 1 x86-64 JIT, 4 ARM64 JIT.
const JIT_CORE = os.arch() === "arm64" ? 4 : 1;
const CORES = { interp: 0, jit: JIT_CORE };

function latestFrames(dir) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".png")).map((f) => path.join(dir, f)); } catch { return []; }
  return files.map((f) => [f, statSync(f).mtimeMs]).sort((a, b) => a[1] - b[1]).map(([f]) => f);
}

async function runOne({ bin, file, core, timeoutSec, platform, configs, logFile, keepUser }) {
  const user = keepUser ?? mkdtempSync(path.join(os.tmpdir(), "native-dolphin-"));
  mkdirSync(path.join(user, "Config"), { recursive: true });
  // The logger reads its own file at start-up (a -C value comes too late).
  writeFileSync(path.join(user, "Config", "Logger.ini"), "[Options]\nWriteToFile = True\nWriteToConsole = True\nVerbosity = 4\n[Logs]\n" +
    ["BOOT", "CORE", "VIDEO", "COMMON", "FRAMEDUMP", "OSREPORT", "VIDEOINTERFACE", "HOST_GPU", "MASTER"].map((t) => `${t} = True\n`).join(""));
  const args = ["-u", user, "-p", platform, "-v", "Software Renderer", "-e", file,
    "-C", `Dolphin.Core.CPUCore=${core}`, "-C", "Dolphin.Core.EmulationSpeed=0",
    "-C", "Dolphin.Movie.DumpFrames=True", "-C", "GFX.Settings.DumpFramesAsImages=True",
    "-C", "GFX.Hacks.EFBAccessEnable=True", "-C", "GFX.Hacks.EFBToTextureEnable=False",
    // Our programs draw the XFB with the CPU and never swap it: every VI is a
    // "duplicate", which Dolphin skips presenting (and dumping) by default.
    "-C", "GFX.Hacks.SkipDuplicateXFBs=False",
    "-C", "Dolphin.DSP.Backend=No Audio Output", "-C", "Dolphin.Interface.ConfirmStop=False",
    ...configs.flatMap((c) => ["-C", c])];
  const log = openSync(logFile, "w");
  const child = spawn(bin, args, { stdio: ["ignore", log, log] });
  let exited = null;
  child.on("exit", (code, signal) => { exited = { code, signal }; });
  const t0 = Date.now();
  let report = null, frame = null, frames = 0;
  while ((Date.now() - t0) / 1000 < timeoutSec && !exited) {
    await new Promise((r) => setTimeout(r, 2000));
    const list = latestFrames(path.join(user, "Dump", "Frames"));
    frames = list.length;
    if (list.length < 2) continue;
    try {
      const img = decodePng(readFileSync(list[list.length - 2])); // the last one may still be written
      frame = { width: img.width, height: img.height };
      report = decodeReport(img) ?? report;
    } catch {}
    if (report?.done) break;
  }
  if (!exited) child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  if (!keepUser) rmSync(user, { recursive: true, force: true }); // the mkdtemp directory above
  return { done: !!report?.done, seconds: Math.round((Date.now() - t0) / 1000), frames, frame, exited, report };
}

export function markdown(results) {
  const lines = ["### Native Dolphin (software renderer)", "",
    "| program | core | status | tests | subtests passed | fingerprint | first failing lines | frames | s |",
    "|---|---|---|---:|---:|---|---|---:|---:|"];
  for (const r of results) {
    const rep = r.report;
    const status = r.done ? "done" : r.frames === 0 ? "no frame" : rep ? "timeout" : "unreadable";
    lines.push(`| ${r.program} | ${r.core} | ${status} | ${rep ? `${rep.testsPassed}/${rep.tests}` : "–"} | ` +
      `${rep ? `${rep.subtestsPassed}/${rep.subtests}` : "–"} | ${rep?.fingerprint ?? "–"} | ` +
      `${rep?.failures.map((f) => `${f.test}:${f.line}`).join(" ") ?? ""} | ${r.frames} | ${r.seconds} |`);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const { values } = parseArgs({
    options: {
      bin: { type: "string" }, dir: { type: "string" }, only: { type: "string" },
      cores: { type: "string", default: "interp,jit" }, timeout: { type: "string", default: "120" },
      platform: { type: "string", default: "x11" }, config: { type: "string", multiple: true, default: [] },
      json: { type: "string" }, md: { type: "string" }, logs: { type: "string", default: "native-logs" },
      "keep-user": { type: "string" }
    }
  });
  if (!values.bin || !values.dir) throw new Error("usage: compat/native.mjs --bin <dolphin-emu-nogui> --dir <files>");
  const only = values.only ? new Set(values.only.split(",")) : null;
  const files = readdirSync(values.dir).filter((f) => /\.(dol|elf|iso)$/.test(f))
    .filter((f) => !only || only.has(f.replace(/\.\w+$/, ""))).sort();
  mkdirSync(values.logs, { recursive: true });
  const results = [];
  for (const f of files) {
    const program = f.replace(/\.\w+$/, "");
    for (const core of values.cores.split(",")) {
      const logFile = path.join(values.logs, `${program}-${core}.log`);
      const r = await runOne({ bin: values.bin, file: path.resolve(values.dir, f), core: CORES[core], timeoutSec: Number(values.timeout),
        platform: values.platform, configs: values.config, logFile,
        keepUser: values["keep-user"] ? path.resolve(values["keep-user"], `${program}-${core}`) : undefined });
      results.push({ program, core, ...r });
      const rep = r.report;
      console.error(`[native] ${program} ${core}: ${r.done ? "done" : "not done"}, ${r.frames} frames${rep ? `, ${rep.testsPassed}/${rep.tests} tests, ${rep.subtestsPassed}/${rep.subtests} subtests, fp ${rep.fingerprint}` : ""} (${r.seconds} s)`);
    }
  }
  const md = markdown(results);
  process.stdout.write(md);
  if (values.json) writeFileSync(values.json, JSON.stringify(results, null, 1));
  if (values.md) writeFileSync(values.md, md);
  process.exit(results.some((r) => r.frames === 0) ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
