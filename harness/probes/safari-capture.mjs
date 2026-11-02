#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The real Safari's frames at given VIs after a savestate load: what
// replay-gates --exact --webkit-frames compares against the Chrome reference
// (harness/README.md, "Replay gates under WebKit"). macOS only.
//   node harness/probes/safari-capture.mjs --iso game.iso --state scene.sav \
//     --port 8306 --out out/safari-cap --query 'core=upstream&video=wgpu&cpu=single&ir=2' \
//     [--vi 240,600] [--runs 2]
// Each run is a fresh Safari (lib/safari-page.mjs: off screen, stopped by
// its pid, the disc and the state by HTTP on 127.0.0.1 to the harness origin
// only): boot the disc, load the state, capture each VI counted from the
// load (validationCaptureAtVi), out/run<k>.vi<VI>.png, and summary.json
// (browser version, sizes, sha256 of the raw RGBA per run and VI). The same
// query, VIs and internal resolution as the gate's (cpu=single, video=wgpu);
// Safari holds the scale to its adapter's ceiling, so the sizes are written
// and the gate refuses a size that differs from its reference's.
//   then: replay-gates --exact --query <same> --vi <same> \
//     --webkit-frames 'out/safari-cap/run1.vi{vi}.png,out/safari-cap/run2.vi{vi}.png'
// Holds the perf lock (requireMains); a watchdog after it; always exits.
// Exit 1 when a run or a VI has no picture.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { captureAtVi, ensureServer, pageCall, waitRunning } from "../lib/browser.mjs";
import { oracleQueryError } from "../lib/glitch-oracle.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { bootRemoteDisc, launchSafariPage, startDiscServer } from "../lib/safari-page.mjs";
import { savePng } from "../lib/session.mjs";

const { values: o } = parseArgs({ options: {
  iso: { type: "string" }, state: { type: "string" }, port: { type: "string" }, out: { type: "string" }, query: { type: "string" },
  vi: { type: "string", default: "240,600" }, runs: { type: "string", default: "2" }, "lock-wait": { type: "string", default: "14400" }
}, strict: true });
// checked before the lock and the browser: a bad call never runs
for (const k of ["iso", "state", "port", "out", "query"]) if (!o[k]) throw new Error(`--${k} is required`);
const why = oracleQueryError(o.query);
if (why) throw new Error(why);
const VIS = o.vi.split(",").map(Number);
if (!VIS.length || VIS.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error("--vi: VI numbers after the load (240,600)");
const runs = Number(o.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 8) throw new Error("--runs: 1 to 8");
const port = Number(o.port);
if (!Number.isInteger(port) || port < 1024 || port > 65532) throw new Error("--port: the harness page's; the next three are safaridriver, the disc and the state");
for (const f of [o.iso, o.state]) if (!existsSync(f)) throw new Error(`${f} is missing`);
if (existsSync(o.out)) throw new Error(`${o.out} exists`);
// the platform last: the arguments are checked the same everywhere (CI)
if (process.platform !== "darwin") throw new Error("safari-capture runs on macOS only");

const log = (m) => console.log(`[safari-capture] ${m}`);
const release = await acquirePerfLock({ name: `safari-capture ${o.query}`, requireMains: true, waitSec: Number(o["lock-wait"]), log });
const watchdog = setTimeout(() => { console.error("watchdog: 20 min under the lock"); release(); process.exit(2); }, 20 * 60 * 1000);
const origin = `http://127.0.0.1:${port}`;
const summary = { probe: "safari-capture", query: o.query, vi: VIS, runs: [] };
let failed = false;
let disc = null, state = null;
try {
  const server = await ensureServer({ port });
  disc = await startDiscServer(o.iso, { port: port + 2, origin });
  state = await startDiscServer(o.state, { port: port + 3, origin, wholeMax: statSync(o.state).size });
  mkdirSync(o.out, { recursive: true });
  for (let k = 1; k <= runs; k += 1) {
    const run = { run: k, frames: {} };
    summary.runs.push(run);
    let safari = null;
    try {
      safari = await launchSafariPage({ port: port + 1, log });
      run.browserVersion = safari.browserVersion;
      await bootRemoteDisc(safari.page, { url: `${server.base}?${o.query}`, descriptor: disc.descriptor, timeoutMs: 120000 });
      await safari.assertInvisible("after boot");
      await waitRunning(safari.page);
      const loaded = await pageCall(safari.page, "__loadStateFile", state.descriptor.remoteDisc, 120000);
      if (!loaded?.loaded) throw new Error(`savestate not loaded: ${JSON.stringify(loaded).slice(0, 300)}`);
      for (const vi of VIS) {
        const f = await captureAtVi(safari.page, { index: vi, fromLoad: true, timeoutMs: 60000 });
        if (f.error) {
          run.frames[vi] = { error: f.error };
          failed = true;
          log(`run ${k} VI ${vi}: ${f.error}`);
          continue;
        }
        const file = path.join(o.out, `run${k}.vi${vi}.png`);
        savePng({ width: f.width, height: f.height, data: f.data }, file);
        run.frames[vi] = { file, width: f.width, height: f.height, sha256: createHash("sha256").update(f.data).digest("hex") };
        log(`run ${k} VI ${vi}: ${f.width}x${f.height} ${run.frames[vi].sha256.slice(0, 12)}`);
      }
    } catch (e) {
      run.error = String(e?.message || e).slice(0, 400);
      failed = true;
      log(`run ${k}: ${run.error}`);
    } finally {
      if (safari) await safari.close().catch(() => {});
    }
  }
} finally {
  disc?.close();
  state?.close();
  clearTimeout(watchdog);
  release();
}
if (existsSync(o.out)) writeFileSync(path.join(o.out, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
log(failed ? "FAILED: a run or a VI without a picture" : `${runs} run(s) x ${VIS.length} VI captured`);
process.exit(failed ? 1 : 0);
