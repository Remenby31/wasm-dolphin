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
// presentation ring and the screen canvas until the first non-uniform
// picture after the first present of a core frame: the KPI (lib/ttff.mjs).
// The worker's earlier presents of the empty boot frames, the first core
// frame and the core's load are recorded too. A launch without that picture
// within --timeout fails and the phase does not pass. Then it closes Chrome
// and opens it again on the same profile for the warm launch, the player's
// second visit.
// It is a timing measure: it takes the shared perf lock (MESURE slots only)
// and waits for the machine load like race-perf.
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { ensureServer, launchChrome, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { waitForLoad } from "../lib/env.mjs";
import { PRESETS, withDeterministicClock } from "../lib/matrix.mjs";
import { claim } from "../lib/ownership.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { chromeInfo, isLocalOnly, probeOutDir } from "../lib/probe-out.mjs";
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
    // The fixed clock of single-core runs, as every harness boot (bootIso).
    await page.goto(`${base}?${withDeterministicClock(query)}`, { waitUntil: "domcontentloaded" });
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
      // Until the KPI: a picture after the first core frame.
      const core = presents.find((p) => p.t >= clickAt && p.vi > 0);
      if (core && changes.some((t) => t >= core.t)) break;
      await page.waitForTimeout(100);
    }
    await context.assertInvisible("after boot");
    const watcher = await page.evaluate(() => window.__ttff);
    return launchTtff({ clickAt, presents, loadedAt, contentTimes: watcher?.changes ?? [], watcherError: watcher?.error ?? null, timeoutSec });
  } catch (error) {
    // The harness lost Chrome (CDP pipe fault, lib/browser.mjs): infra, left out.
    if (context.pipeFault) return { infraCrash: context.pipeFault.message, error: null };
    throw error;
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
          log(`run ${run} ${phase}: ${record[phase].error ?? `picture ${record[phase].firstContentMs} ms (first core frame ${record[phase].firstPresentMs} ms, core loaded ${record[phase].coreLoadedMs} ms)`}`);
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
    chrome: chromeInfo(), served: server.identity,
    iso: path.basename(iso), query, url: `${server.base}?${withDeterministicClock(query)}`, runs: records.length,
    definition: "t0 = disc handed to the engine page (the Play click); KPI = first non-uniform picture after the first present of a core frame (vi > 0). cold = new profile, warm = same profile relaunched. A launch without it fails.",
    ...summarizeTtff(records)
  };
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  const phaseLog = (p) => `${p?.firstContentMs?.median ?? "-"} ms${p?.failed?.length ? ` (${p.failed.length} of ${p.runs} failed)` : ""}`;
  log(`cold ${phaseLog(summary.cold)}, warm ${phaseLog(summary.warm)} (target < ${summary.targetMs} ms)${summary.overloadedRuns.length ? `, overloaded runs left out: ${summary.overloadedRuns.join(", ")}` : ""} -> ${outDir}`);
  process.exitCode = summary.pass == null || summary.cold?.failed.length || summary.warm?.failed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
