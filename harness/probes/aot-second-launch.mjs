#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Second launch with aot=1 (plan P4/P7, lane 11). Headless only. The region
// cache only runs during the boot on a second launch: a first launch installs
// regions after its optimisation, past the boot. The 2026-10-21 P0 (cached
// regions written for another heap layout, the game diverging and logging
// "Invalid read" a million times) only showed there.
//
//   node harness/probes/aot-warm-launch.mjs seed --tree . --iso disc.iso \
//        --steps harness/probes/local-race-steps.json --profile DIR/profile --query "...&aot=1" --port N
//   node harness/probes/aot-second-launch.mjs --seed-profile DIR/profile --iso disc.iso \
//        --steps harness/probes/local-race-steps.json --query "...&aot=1" --port N [--runs 2] [--sec 45]
//        [--min-frames 3000] [--cap-mb 6144] [--out dir]
//
// Same port as the seed: the cache, OPFS and IndexedDB are per origin. Each
// run boots an APFS clone of the seeded profile, plays the steps, waits
// --sec, and records every console line (repeated "Invalid read" counted, not
// kept), the RSS of the profile's Chrome processes by type each second (the
// run stops above --cap-mb) and the core's frame. Pass: regions installed
// from the cache, 0 "Invalid read", more than --min-frames, under the cap.
// Exit 1 when a run fails.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { bootIso, launchChrome, workerRequest } from "../lib/browser.mjs";
import { decodeRegionStats } from "../lib/jit-region-stats.mjs";
import { ensureServer } from "../lib/server.mjs";
import { runSteps } from "../lib/steps.mjs";

const { values } = parseArgs({ options: {
  "seed-profile": { type: "string" }, iso: { type: "string" }, steps: { type: "string" }, query: { type: "string" },
  port: { type: "string", default: process.env.HARNESS_PORT || "8086" }, runs: { type: "string", default: "2" },
  sec: { type: "string", default: "45" }, "min-frames": { type: "string", default: "3000" },
  "cap-mb": { type: "string", default: "6144" }, out: { type: "string" }
} });
if (!values["seed-profile"] || !values.iso || !values.steps || !values.query) {
  console.error("usage: aot-second-launch.mjs --seed-profile DIR --iso disc.iso --steps s.json --query '...&aot=1' [--port N]");
  process.exit(2);
}
const log = (m) => console.log(`[aot-second-launch] ${m}`);

// RSS (MB) of the Chrome processes of this profile, by process type.
function rss(profileDir) {
  const out = execFileSync("ps", ["-A", "-o", "pid=,rss=,command="], { encoding: "utf8", maxBuffer: 32 << 20 });
  const byType = {};
  let total = 0;
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || !m[3].includes(profileDir)) continue;
    const type = (m[3].match(/--type=(\S+)/) ?? [, "browser"])[1];
    byType[type] = (byType[type] ?? 0) + Math.round(Number(m[2]) / 1024);
    total += Number(m[2]);
  }
  return { totalMB: Math.round(total / 1024), byType };
}

async function launchOnce(profileDir) {
  const result = { invalidReads: 0, samples: [], firstLines: [], capped: null, regions: null, error: null };
  const server = await ensureServer({ port: Number(values.port), root: process.cwd() });
  const context = await launchChrome({ profileDir });
  const page = context.pages()[0] ?? (await context.newPage());
  const t0 = Date.now();
  const note = (text) => {
    const t = String(text);
    if (t.includes("Invalid read")) result.invalidReads += 1;
    else if (result.firstLines.length < 400) result.firstLines.push({ t: Date.now() - t0, text: t.slice(0, 300) });
  };
  page.on("console", (m) => note(m.text()));
  page.on("worker", (w) => w.on?.("console", (m) => note(m.text())));
  let stop = false;
  const watch = (async () => {
    while (!stop) {
      const r = rss(profileDir);
      const p = await workerRequest(page, "validationReadCoreProgress", {}, 3000).catch(() => null);
      result.samples.push({ t: Date.now() - t0, ...r, frame: p?.frame ?? null });
      if (r.totalMB > Number(values["cap-mb"])) { result.capped = r; stop = true; break; }
      await new Promise((res) => setTimeout(res, 1000));
    }
  })();
  try {
    await Promise.race([
      (async () => {
        await bootIso(page, { url: `${server.base}?${values.query}`, iso: values.iso, timeoutMs: 120000 });
        await runSteps(page, JSON.parse(readFileSync(values.steps, "utf8")));
        await page.waitForTimeout(Number(values.sec) * 1000);
        const r = await workerRequest(page, "validationReadJitRegionStats", {}, 10000).catch(() => null);
        result.regions = r?.bytes ? decodeRegionStats(r.bytes).diagnostics ?? null : null;
      })(),
      (async () => { while (!stop) await new Promise((res) => setTimeout(res, 500)); throw new Error(`over ${values["cap-mb"]} MB`); })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("4 min limit")), 240000))
    ]);
  } catch (e) {
    result.error = String(e.message || e);
  } finally {
    stop = true;
    await watch.catch(() => {});
    await context.close().catch(() => {});
    await server.stop();
  }
  return result;
}

const outDir = values.out ?? null;
if (outDir) mkdirSync(outDir, { recursive: true });
let failed = 0;
for (let run = 1; run <= Number(values.runs); run += 1) {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-aot-second-"));
  rmSync(profileDir, { recursive: true, force: true });
  execFileSync("cp", ["-c", "-R", values["seed-profile"], profileDir]);
  const r = await launchOnce(profileDir);
  rmSync(profileDir, { recursive: true, force: true });
  const frames = Math.max(0, ...r.samples.map((s) => s.frame ?? 0));
  const peak = Math.max(0, ...r.samples.map((s) => s.totalMB));
  const installed = r.regions?.regionsInstalled ?? 0;
  const why = [
    r.error && `error: ${r.error}`,
    r.capped && `memory cap (${r.capped.totalMB} MB: ${JSON.stringify(r.capped.byType)})`,
    r.invalidReads > 0 && `${r.invalidReads} "Invalid read"`,
    frames < Number(values["min-frames"]) && `${frames} frames < ${values["min-frames"]}`,
    !(installed > 0) && "no region installed from the cache"
  ].filter(Boolean);
  log(`run ${run}: ${why.length ? `FAIL (${why.join("; ")})` : "pass"}; frames ${frames}, peak ${peak} MB, regions ${JSON.stringify(r.regions && { queued: r.regions.regionsQueued, installed, refused: r.regions.regionsRefused, dropped: r.regions.regionsDropped })}`);
  if (why.length) failed += 1;
  if (outDir) writeFileSync(path.join(outDir, `run${run}.json`), JSON.stringify({ ...r, frames, peak, verdict: why.length ? "fail" : "pass", why }, null, 1));
}
process.exit(failed ? 1 : 0);
