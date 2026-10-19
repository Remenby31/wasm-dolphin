#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Upscaling study (docs/upscaling-study.md): for each configuration, load a
// savestate, hold a key, settle, then over a window read the GPU pass times
// (?gputime=1), the GPU utilisation and allocation (ioreg, whole machine),
// the memory of this Chrome's GPU and renderer processes, and capture the
// frame twice: the core's exact VI capture (the XFB at internal resolution)
// and the canvas as shown (after any presentation upscaler).
//
//   node harness/probes/upscale-study.mjs --iso disc.iso --state scene.sav --port N
//     --configs "ir=1;ir=2;ir=3;upscale=easu" [--base-query "..."] [--runs 3]
//     [--warmup 25] [--secs 20] [--hold KeyX] [--lock] [--out dir]
//
// Not a speed probe: speed comes from race-perf.mjs. --lock takes the perf
// lock anyway (GPU times are perf numbers); the captures alone do not need it.
// Captures of a commercial disc go to --out, which must be outside the repo.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, loadHarnessState, workerRequest, REPO_ROOT } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { captureAtVi, grabFrame, openSession } from "../lib/session.mjs";
import { encodePng } from "../lib/png.mjs";

const STATE_ROUTE = "**/__harness_state.sav";

function ioregGpu() {
  try {
    const t = execFileSync("ioreg", ["-r", "-c", "IOAccelerator", "-d", "1", "-w", "0"], { encoding: "utf8", maxBuffer: 8 << 20 });
    const n = (k) => Number(new RegExp(`"${k}"=(\\d+)`).exec(t)?.[1] ?? NaN);
    return { util: n("Device Utilization %"), inUseMB: n("In use system memory") / 1048576, allocMB: n("Alloc system memory") / 1048576 };
  } catch {
    return null;
  }
}

// RSS and physical footprint (MB) of this profile's GPU and renderer processes.
function chromeMemory(profileDir) {
  const out = {};
  try {
    const ps = execFileSync("ps", ["-A", "-o", "pid=,rss=,command="], { encoding: "utf8", maxBuffer: 32 << 20 });
    for (const line of ps.split("\n")) {
      if (!line.includes(profileDir)) continue;
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const type = /--type=([\w-]+)/.exec(m[3])?.[1] ?? "browser";
      if (!["gpu-process", "renderer", "browser"].includes(type)) continue;
      let footprintMB = null;
      try {
        const f = execFileSync("footprint", ["-p", m[1]], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const fm = /phys_footprint:\s*([\d.]+)\s*([KMG])B/.exec(f);
        if (fm) footprintMB = Number(fm[1]) * { K: 1 / 1024, M: 1, G: 1024 }[fm[2]];
      } catch {}
      const prev = out[type];
      const rssMB = Number(m[2]) / 1024;
      // Several renderers: keep the biggest (the page's).
      if (!prev || rssMB > prev.rssMB) out[type] = { pid: Number(m[1]), rssMB: Math.round(rssMB), footprintMB: footprintMB && Math.round(footprintMB) };
    }
  } catch {}
  return out;
}

const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

async function runConfig(o, server, config, run) {
  const query = `${o.baseQuery}&${config}&gputime=1&metrics=1`;
  // One retry: on this loaded Mac a launch occasionally dies before the
  // page is up (and its profile cleanup then races Chrome's last writes).
  const open = () => openSession({ base: server.base, server, query, iso: o.iso, routes: o.state ? { [STATE_ROUTE]: o.state } : {} });
  let session;
  try {
    session = await open();
  } catch (e) {
    console.log(`[upscale-study] ${config} run${run}: launch failed (${String(e?.message || e).slice(0, 120)}), retrying`);
    await new Promise((r) => setTimeout(r, 3000));
    session = await open();
  }
  const rec = { config, run, url: session.url };
  try {
    // No --state: a homebrew that boots straight into its scene.
    if (o.state) {
      const loaded = await loadHarnessState(session.page, session.url);
      if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
    }
    if (o.hold) await session.page.keyboard.down(o.hold);
    await session.page.waitForTimeout(o.warmup * 1000);
    await workerRequest(session.page, "upscaleStudyStats", { reset: true }, 10000);
    const gpu = [], loads = [];
    let mem = null;
    for (let s = 0; s < o.secs; s++) {
      await new Promise((r) => setTimeout(r, 1000));
      gpu.push(ioregGpu());
      loads.push(os.loadavg()[0]);
      if (s === Math.floor(o.secs / 2)) mem = chromeMemory(session.profileDir);
    }
    const stats = await workerRequest(session.page, "upscaleStudyStats", {}, 10000);
    rec.load1Median = median(loads);
    rec.gpuUtilMedian = median(gpu.map((g) => g?.util));
    rec.gpuInUseMBMedian = median(gpu.map((g) => g?.inUseMB));
    rec.memory = mem;
    rec.study = stats;
    if (o.capture) {
      const tag = `${config.replace(/[^\w=]+/g, "_")}-run${run}`;
      const exact = await captureAtVi(session.page, { ahead: 30, timeoutMs: 30000 });
      if (!exact.error) {
        writeFileSync(path.join(o.out, `${tag}-xfb.png`), encodePng(exact));
        rec.exact = { width: exact.width, height: exact.height, source: exact.source };
      } else rec.exact = { error: exact.error };
      const shown = await grabFrame(session.page);
      if (!shown.error) {
        writeFileSync(path.join(o.out, `${tag}-canvas.png`), encodePng(shown));
        rec.canvas = { width: shown.width, height: shown.height, source: shown.source };
      } else rec.canvas = { error: shown.error };
    }
    if (o.hold) await session.page.keyboard.up(o.hold).catch(() => {});
  } catch (e) {
    rec.error = String(e?.message || e).slice(0, 300);
  }
  rec.fatal = session.watch.fatal();
  await session.close();
  return rec;
}

// Under heavy load, playwright's pipe transport sometimes receives empty CDP
// frames and throws "Unexpected end of JSON input" from a setImmediate,
// which would kill the probe; the session itself goes on (checked: the
// captures and stats of such a run are complete). Only that error is let
// through.
process.on("uncaughtException", (e) => {
  if (/Unexpected end of JSON input/.test(String(e?.message))) return;
  console.error(e);
  process.exit(1);
});

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, state: { type: "string" }, port: { type: "string", default: process.env.HARNESS_PORT },
      configs: { type: "string", default: "ir=1;ir=2;ir=3" }, "base-query": { type: "string" },
      runs: { type: "string", default: "3" }, warmup: { type: "string", default: "25" }, secs: { type: "string", default: "20" },
      hold: { type: "string", default: "KeyX" }, lock: { type: "boolean", default: false },
      capture: { type: "boolean", default: true }, "no-capture": { type: "boolean", default: false },
      out: { type: "string" }, "repo-out": { type: "boolean", default: false }
    }
  });
  if (!values.iso || !values.port || !values.out) throw new Error("usage: upscale-study.mjs --iso disc.iso [--state scene.sav] --port N --out dir [--configs a;b] [--runs 3] [--lock] [--repo-out]");
  const out = path.resolve(values.out);
  // --repo-out: a homebrew's captures may go into the repo (docs/images).
  if (out.startsWith(REPO_ROOT + path.sep) && !values["repo-out"]) throw new Error(`--out ${out} is inside the repo: captures of a commercial disc stay outside (--repo-out for a homebrew)`);
  mkdirSync(out, { recursive: true });
  const o = {
    iso: path.resolve(values.iso), state: values.state ? path.resolve(values.state) : null, port: Number(values.port), out,
    baseQuery: values["base-query"] ?? PRESETS.wgpu, runs: Number(values.runs), warmup: Number(values.warmup),
    secs: Number(values.secs), hold: values.hold, capture: values.capture && !values["no-capture"]
  };
  const configs = values.configs.split(";").map((c) => c.trim()).filter(Boolean);
  const release = values.lock ? await acquirePerfLock({ name: "upscale-study", waitSec: 1800, log: console.log }) : null;
  const records = [];
  try {
    const before = ioregGpu();
    const server = await ensureServer({ port: o.port, root: REPO_ROOT });
    try {
      // Interleaved: run i measures every configuration once, so drift on
      // the machine hits them alike.
      for (let run = 1; run <= o.runs; run++) {
        for (const config of configs) {
          const rec = await runConfig(o, server, config, run);
          records.push(rec);
          const t = rec.study?.timer;
          console.log(`[upscale-study] ${config} run${run}: gpu p50 ${t?.totalMs?.p50?.toFixed?.(2)} ms (post ${t?.postMs?.p50?.toFixed?.(2)}), ` +
            `util ${rec.gpuUtilMedian} %, gpu-proc ${rec.memory?.["gpu-process"]?.footprintMB ?? "?"} MB, load ${rec.load1Median?.toFixed?.(1)}` +
            `${rec.error ? ` ERROR ${rec.error}` : ""}`);
          writeFileSync(path.join(out, "records.json"), JSON.stringify({ before, records }, null, 1) + "\n");
        }
      }
    } finally {
      await server.stop();
    }
  } finally {
    release?.();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
