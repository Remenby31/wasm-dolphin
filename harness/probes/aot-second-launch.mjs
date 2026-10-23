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
//        [--min-frames 3000] [--cap-mb 6144] [--out dir] [--heap-shift-mb 64]
//
// --heap-shift-mb N: N MiB taken from the core's heap before the boot
// (validationEnableHarness heapShiftMb), so the emulated RAM sits elsewhere
// than in the seed's session: a pass then also needs every cached region
// patched for this heap (heapPatched > 0, 0084) and none refused for its layout.
// Where the RAM cannot move (GameCube since 0106: static RAM and L1), nothing
// is patched and nothing refused: the run is "not-applicable", not a failure
// (lib/second-launch-verdict.mjs).
//
// Same port as the seed: the cache, OPFS and IndexedDB are per origin. Each
// run boots an APFS clone of the seeded profile, plays the steps, waits
// --sec, and records every console line (repeated "Invalid read" counted, not
// kept), the RSS of the profile's Chrome processes by type each second (the
// run stops above --cap-mb) and the core's frame. Verdicts:
// - pass: modules loaded from the region cache (P7's install events, before
//   the boot and after the first image; not live translations), regions installed, 0 "Invalid read", more
//   than --min-frames, under the cap;
// - refused-layout: the heap moved, every cached region refused for its
//   layout, and the game still correct (0 "Invalid read", frames): the guard
//   working, counted apart (no regions this launch);
// - fail: anything else, including a launch that had no region cache at all.
// The seeded profile must carry the measure's origin (harness/lib/seed-origin.mjs).
// Exit 1 when a run fails.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { bootIso, launchChrome, workerRequest } from "../lib/browser.mjs";
import { decodeRegionStats } from "../lib/jit-region-stats.mjs";
import { secondLaunchVerdict } from "../lib/second-launch-verdict.mjs";
import { seedOriginCheck } from "../lib/seed-origin.mjs";
import { ensureServer } from "../lib/server.mjs";
import { aotLaunchInfo } from "../lib/ttff.mjs";
import { runSteps } from "../lib/steps.mjs";

const { values } = parseArgs({ options: {
  "seed-profile": { type: "string" }, iso: { type: "string" }, steps: { type: "string" }, query: { type: "string" },
  port: { type: "string", default: process.env.HARNESS_PORT || "8086" }, runs: { type: "string", default: "2" },
  sec: { type: "string", default: "45" }, "min-frames": { type: "string", default: "3000" },
  "cap-mb": { type: "string", default: "6144" }, out: { type: "string" },
  // MiB taken from the core's heap before the boot: the RAM sits elsewhere
  // than in the seed's session, so every cached region must be patched (0084).
  "heap-shift-mb": { type: "string" }
} });
if (!values["seed-profile"] || !values.iso || !values.steps || !values.query) {
  console.error("usage: aot-second-launch.mjs --seed-profile DIR --iso disc.iso --steps s.json --query '...&aot=1' [--port N]");
  process.exit(2);
}
const log = (m) => console.log(`[aot-second-launch] ${m}`);
const origin = seedOriginCheck(values["seed-profile"], values.port);
if (origin.error) {
  console.error(`[aot-second-launch] ${origin.error}`);
  process.exit(2);
}
if (origin.warning) log(`warning: ${origin.warning}`);

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
        const heapShiftMb = Number(values["heap-shift-mb"] ?? 0);
        await bootIso(page, { url: `${server.base}?${values.query}`, iso: values.iso, timeoutMs: 120000, ...(heapShiftMb > 0 ? { harness: { heapShiftMb } } : {}) });
        await runSteps(page, JSON.parse(readFileSync(values.steps, "utf8")));
        await page.waitForTimeout(Number(values.sec) * 1000);
        // The core publishes its derived counters (the boot window's worst
        // install slice, fallbacks) only once the stats are on: a counters-only
        // request (sampleEvery 0) turns them on, a slice publishes them.
        await workerRequest(page, "validationReadJitRegionStats", { sampleEvery: 0 }, 10000).catch(() => null);
        await page.waitForTimeout(1000);
        const r = await workerRequest(page, "validationReadJitRegionStats", {}, 10000).catch(() => null);
        result.regions = r?.bytes ? decodeRegionStats(r.bytes).diagnostics ?? null : null;
        result.layoutRefused = Number.isInteger(r?.layoutRefused) ? r.layoutRefused : null;
        result.heapPatched = Number.isInteger(r?.heapPatched) ? r.heapPatched : null;
        result.layout = r?.layout ?? null; // where the RAM sits (a static RAM, 0106, does not move with a heap shift)
        result.regionSleep = r?.regionSleep ?? null; // 0107: sleep installs, worst lateness
        // The session's first installs, one sample each: host ms, bytes, path
        // (0 first attempt, 1 after the ready byte, 2 cold); a sleep install is
        // one of them too, so the worst one bounds the worst slice from above.
        const samples = Array.isArray(r?.installSamples) ? r.installSamples : [];
        const ms = samples.map((x) => x[0]).sort((a, b) => a - b);
        result.installSamples = { count: ms.length, p95Ms: ms.length ? ms[Math.min(ms.length - 1, Math.ceil(0.95 * ms.length) - 1)] : null, worstMs: ms.at(-1) ?? null, over3Ms: ms.filter((x) => x > 3).length };
        result.aot = aotLaunchInfo(await workerRequest(page, "validationReadAotProgress", {}, 10000).catch(() => null));
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

// A launch without regions because the heap moved (all refused for their
// layout) is told apart from one whose cache was empty.

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
  // Before the boot (the boot set) and after the first image (the rest).
  const beforeBoot = r.aot?.install?.loaded ?? 0;
  const fromCache = beforeBoot + (r.aot?.afterFirstImage?.loaded ?? 0);
  const { verdict, why } = secondLaunchVerdict(r, { frames, fromCache, installed, heapShift: Boolean(values["heap-shift-mb"]), minFrames: Number(values["min-frames"]) });
  log(`run ${run}: ${verdict === "fail" ? `FAIL (${why.join("; ")})` : verdict === "not-applicable" ? `not-applicable (heap shifted, but the RAM did not move: static RAM, 0106; ram base ${r.layout?.ramBase ?? "?"})` : verdict}; frames ${frames}, peak ${peak} MB, from cache ${fromCache} (${beforeBoot} before the boot), regions ${JSON.stringify(r.regions && { installed, refused: r.regions.regionsRefused, layoutRefused: r.layoutRefused, heapPatched: r.heapPatched, dropped: r.regions.regionsDropped, installMaxSliceMs: r.regions.installMaxSliceMs, installBootMaxSliceMs: r.regions.installBootMaxSliceMs })}${r.regionSleep ? `, sleep ${JSON.stringify(r.regionSleep)}` : ""}, install samples ${JSON.stringify(r.installSamples ?? null)}`);
  if (verdict === "fail") failed += 1;
  if (outDir) writeFileSync(path.join(outDir, `run${run}.json`), JSON.stringify({ ...r, frames, peak, fromCache, beforeBoot, verdict, why }, null, 1));
}
process.exit(failed ? 1 : 0);
