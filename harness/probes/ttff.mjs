#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Time to first frame (KPI, target < 10 s), headless only:
//
//   node harness/probes/ttff.mjs --iso disc.iso --port N
//     [--config wgpu | --query "..."] [--runs 3] [--timeout 60]
//     [--max-load L] [--load-wait 300] [--lock-wait 1800 | --no-lock] [--out dir]
//
// Each run opens a new Chrome profile (cold: no HTTP cache, no V8 code
// cache, no JIT cache), loads the engine page, then hands the disc to it as
// the Play click does (the file input): that instant is t0. It polls the
// presentation ring until the first present of a core frame (the KPI; the
// worker's earlier presents of the empty boot frames are recorded apart), and also records when
// the adapter reports the core loaded and when the page first shows a picture
// (lib/ttff.mjs, indicative). Then it closes Chrome and opens it again on
// the same profile for the warm launch, the player's second visit.
// It is a timing measure: it takes the shared perf lock (MESURE slots only)
// and waits for the machine load like race-perf.
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { ensureServer, launchChrome, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { waitForLoad } from "../lib/env.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { claim } from "../lib/ownership.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { isLocalOnly, probeOutDir } from "../lib/probe-out.mjs";
import { machineSnapshot } from "../lib/system.mjs";
import { installContentWatcher, launchTtff, summarizeTtff } from "../lib/ttff.mjs";
import { num } from "./race-perf.mjs";

const epochNow = (page) => page.evaluate(() => performance.timeOrigin + performance.now());

// One launch on `profileDir`: page, hand-over, first present.
async function launch({ base, query, iso, profileDir, timeoutSec }) {
  const context = await launchChrome({ profileDir });
  try {
    await context.assertInvisible("after launch");
    await context.addInitScript(installContentWatcher);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${base}?${query}`, { waitUntil: "domcontentloaded" });
    await page.locator("#romInput").waitFor({ state: "attached", timeout: 30000 });
    await page.waitForFunction(() => window.__host?.adapter, null, { timeout: 30000 });
    await page.evaluate(() => window.__ttffArm());
    const clickAt = await epochNow(page);
    await page.locator("#romInput").setInputFiles(iso);
    await page.waitForFunction(() => Boolean(window.__host?.adapter?.worker), null, { timeout: timeoutSec * 1000 });
    const enabled = await workerRequest(page, "validationEnableHarness", {}, 30000);
    if (enabled?.error) throw new Error(`harness hooks: ${enabled.error}`);
    const presents = [];
    let loadedAt = null;
    const end = Date.now() + timeoutSec * 1000;
    while (Date.now() < end) {
      const chunk = await readTimeline(page);
      if (!chunk?.error) chunk.presents.t.forEach((t, i) => presents.push({ t, vi: chunk.presents.vi[i] }));
      if (loadedAt == null && (await page.evaluate(() => window.__host?.adapter?.loaded === true))) loadedAt = await epochNow(page);
      const changes = await page.evaluate(() => window.__ttff?.changes ?? []);
      // Wait for both: the KPI (first core frame) and a picture after it, bounded.
      const core = presents.find((p) => p.t >= clickAt && p.vi !== 0);
      if (core && (changes.some((t) => t >= core.t) || Date.now() > end - (timeoutSec * 1000) / 2)) break;
      await page.waitForTimeout(100);
    }
    await context.assertInvisible("after boot");
    const watcher = await page.evaluate(() => window.__ttff);
    const result = launchTtff({ clickAt, presents, loadedAt, contentTimes: watcher?.changes ?? [] });
    if (result.firstPresentMs == null) result.error = `no presentation within ${timeoutSec} s`;
    return { ...result, contentWatcherError: watcher?.error ?? null };
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, config: { type: "string", default: "wgpu" }, query: { type: "string" },
      runs: { type: "string", default: "3" }, timeout: { type: "string", default: "60" },
      "max-load": { type: "string" }, "load-wait": { type: "string", default: "300" }, "lock-wait": { type: "string", default: "1800" }, "no-lock": { type: "boolean", default: false },
      port: { type: "string", default: process.env.HARNESS_PORT }, out: { type: "string" }
    }
  });
  if (!values.iso || !values.port) throw new Error("usage: ttff.mjs --iso disc.iso --port N (or HARNESS_PORT) [--runs 3] [--config wgpu]");
  const iso = path.resolve(values.iso);
  if (isLocalOnly(iso) && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
  const query = `${values.query ?? PRESETS[values.config] ?? values.config}&metrics=1`;
  const runs = num(values, "runs", { min: 1, int: true });
  const timeoutSec = num(values, "timeout", { min: 5 });
  const maxLoad = values["max-load"] ? num(values, "max-load", { min: 0.1 }) : Math.max(2, os.cpus().length / 4);
  const loadWait = num(values, "load-wait", { min: 0 });
  const port = num(values, "port", { min: 1, int: true });
  const log = (m) => console.log(`[ttff] ${m}`);

  // --no-lock: a plumbing check in a CORRECTION slot; its numbers are not
  // a measure and kpi-report ignores them.
  const releaseLock = values["no-lock"] ? () => {} : await acquirePerfLock({ name: `harness ttff (${REPO_ROOT})`, waitSec: num(values, "lock-wait", { min: 0 }), log });
  const outDir = probeOutDir("ttff", iso, values.out);
  const server = await ensureServer({ port, root: REPO_ROOT });
  const records = [];
  try {
    for (let run = 1; run <= runs; run += 1) {
      const loadGate = await waitForLoad({ maxLoad, waitSec: loadWait, log });
      const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-harness-ttff-"));
      const releaseProfile = claim(profileDir, REPO_ROOT, "chrome-profile");
      const record = { run, loadGate, load1Before: os.loadavg()[0] };
      try {
        for (const phase of ["cold", "warm"]) {
          try {
            record[phase] = await launch({ base: server.base, query, iso, profileDir, timeoutSec });
          } catch (error) {
            record[phase] = { error: String(error?.message || error).slice(0, 300) };
          }
          log(`run ${run} ${phase}: ${record[phase].error ?? `first present ${record[phase].firstPresentMs} ms, core loaded ${record[phase].coreLoadedMs} ms, picture ${record[phase].firstContentMs ?? "n/a"} ms`}`);
        }
      } finally {
        releaseProfile();
        rmSync(profileDir, { recursive: true, force: true });
      }
      record.load1After = os.loadavg()[0];
      writeFileSync(path.join(outDir, `run${run}.json`), JSON.stringify(record, null, 1) + "\n");
      records.push(record);
    }
  } finally {
    await server.stop();
    releaseLock();
  }
  const summary = {
    probe: "ttff", at: new Date().toISOString(), locked: !values["no-lock"], machine: machineSnapshot(),
    iso: path.basename(iso), query, url: `${server.base}?${query}`, runs: records.length,
    definition: "t0 = disc handed to the engine page (the Play click); KPI = first presentation after t0. cold = new profile, warm = same profile relaunched.",
    ...summarizeTtff(records)
  };
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  log(`cold ${summary.cold?.firstPresentMs?.median ?? "-"} ms, warm ${summary.warm?.firstPresentMs?.median ?? "-"} ms (target < ${summary.targetMs} ms) -> ${outDir}`);
  process.exitCode = summary.cold ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
