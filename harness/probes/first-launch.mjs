#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Duration of the first-launch optimisation (P7, KPI target < 60 s) and
// "0 region recompiled on the second launch", headless only:
//
//   node harness/probes/first-launch.mjs --iso disc.iso --port N
//     [--config wgpu | --query "..."] [--runs 3] [--timeout 600] [--second-sec 30]
//     [--max-load L] [--load-wait 300] [--lock-wait 1800 | --no-lock] [--out dir]
//
// Each run opens a new Chrome profile and boots the disc with aot=1, which
// starts the optimisation (contract in lib/aot-progress.mjs). It drains the
// progress events and the timeline until "done" (or an error, or --timeout):
// duration, progress shape, and the emulated speed while it ran. Then it
// relaunches Chrome on the same profile and boots again: the "install" event
// and the "done" event's compiled count (0 expected), within --second-sec.
// Every run counts: a launch without "done" (or a second one without its
// compiled count) is a failure with its reason, and p7 does not pass.
// An engine without P7 (no validationReadAotProgress and no
// window.__aotProgressLog, or state "unsupported") gives p7: null and n/a,
// exit 0: nothing is measured, nothing fails.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { bootIso, ensureServer, launchChrome, readCoreProgress, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { waitForLoad } from "../lib/env.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { claim } from "../lib/ownership.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { chromeInfo, isLocalOnly, probeOutDir } from "../lib/probe-out.mjs";
import { machineSnapshot } from "../lib/system.mjs";
import { coreStats, mergeTimeline, windowOf } from "../lib/timeline.mjs";
import { summarizeLaunch, summarizeP7, unavailable } from "../lib/aot-progress.mjs";
import { num } from "./race-perf.mjs";

async function readProgress(page) {
  const reply = await workerRequest(page, "validationReadAotProgress", { drain: true }, 15000);
  const pageLog = await page.evaluate(() => (Array.isArray(window.__aotProgressLog) ? window.__aotProgressLog.splice(0) : null)).catch(() => null);
  return { reply, pageLog };
}

// Boot once on `profileDir` and follow the progress for up to `sec` seconds,
// until "done" or a fatal error.
async function launch({ base, query, iso, profileDir, sec }) {
  const context = await launchChrome({ profileDir });
  try {
    await context.assertInvisible("after launch");
    const page = context.pages()[0] ?? (await context.newPage());
    await bootIso(page, { url: `${base}?${query}`, iso });
    const events = [], chunks = [];
    let why = null, state = null;
    const end = Date.now() + sec * 1000;
    // Worker and page both report: worker events win, the page log fills in
    // only when the worker has no harness message.
    let source = null;
    while (Date.now() < end) {
      const { reply, pageLog } = await readProgress(page);
      why = unavailable(reply, pageLog);
      if (why) break;
      source ??= reply && !reply.error ? "worker" : "page";
      state = reply?.state ?? state;
      events.push(...(source === "worker" ? reply.events ?? [] : pageLog ?? []));
      chunks.push(await readTimeline(page));
      if (events.some((e) => e.type === "done" || (e.type === "error" && e.fatal))) break;
      await page.waitForTimeout(500);
    }
    await context.assertInvisible("after boot");
    if (why) return { unavailable: why };
    const progress = await readCoreProgress(page);
    const summary = summarizeLaunch(events);
    const timeline = mergeTimeline(chunks);
    if (summary.window) {
      const core = coreStats(windowOf(timeline, summary.window.from, summary.window.to), { ticksPerSecond: progress?.coreTicksPerSecond });
      summary.speedDuring = Number.isFinite(core.speed) ? Math.round(core.speed * 10) / 10 : null;
    }
    return { source, state, ...summary, timedOut: !summary.finished && !summary.errors.some((e) => e.fatal), events: events.length };
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, config: { type: "string", default: "wgpu" }, query: { type: "string" },
      runs: { type: "string", default: "3" }, timeout: { type: "string", default: "600" }, "second-sec": { type: "string", default: "30" },
      "max-load": { type: "string" }, "load-wait": { type: "string", default: "300" }, "lock-wait": { type: "string", default: "1800" }, "no-lock": { type: "boolean", default: false },
      port: { type: "string", default: process.env.HARNESS_PORT }, out: { type: "string" }
    }
  });
  if (!values.iso || !values.port) throw new Error("usage: first-launch.mjs --iso disc.iso --port N (or HARNESS_PORT) [--runs 3] [--timeout 600]");
  const iso = path.resolve(values.iso);
  if (isLocalOnly(iso) && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
  const query = `${values.query ?? PRESETS[values.config] ?? values.config}&aot=1&metrics=1`;
  const runs = num(values, "runs", { min: 1, int: true });
  const timeoutSec = num(values, "timeout", { min: 10 });
  const secondSec = num(values, "second-sec", { min: 5 });
  const maxLoad = values["max-load"] ? num(values, "max-load", { min: 0.1 }) : Math.max(2, os.cpus().length / 4);
  const port = num(values, "port", { min: 1, int: true });
  const log = (m) => console.log(`[first-launch] ${m}`);

  // --no-lock: a plumbing check in a CORRECTION slot; its numbers are not
  // a measure and kpi-report ignores them.
  const releaseLock = values["no-lock"] ? () => {} : await acquirePerfLock({ name: `harness first-launch (${REPO_ROOT})`, waitSec: num(values, "lock-wait", { min: 0 }), log });
  const outDir = probeOutDir("first-launch", iso, values.out);
  const server = await ensureServer({ port, root: REPO_ROOT });
  const records = [];
  let na = null;
  try {
    for (let run = 1; run <= runs && !na; run += 1) {
      const loadGate = await waitForLoad({ maxLoad, waitSec: num(values, "load-wait", { min: 0 }), log });
      const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-harness-first-launch-"));
      const releaseProfile = claim(profileDir, REPO_ROOT, "chrome-profile");
      const record = { run, loadGate };
      try {
        record.first = await launch({ base: server.base, query, iso, profileDir, sec: timeoutSec });
        if (record.first.unavailable) {
          na = record.first.unavailable;
        } else {
          log(`run ${run} first launch: ${record.first.finished ? `done in ${record.first.durationMs} ms, ${record.first.total} regions, speed ${record.first.speedDuring} %` : record.first.timedOut ? `not done after ${timeoutSec} s` : `stopped: ${JSON.stringify(record.first.errors)}`}`);
          record.second = await launch({ base: server.base, query, iso, profileDir, sec: secondSec });
          log(`run ${run} second launch: installed ${record.second.install?.loaded ?? "?"}, recompiled ${record.second.compiled ?? "?"}`);
        }
      } catch (error) {
        record.error = String(error?.message || error).slice(0, 300);
        log(`run ${run}: ${record.error}`);
      } finally {
        releaseProfile();
        rmSync(profileDir, { recursive: true, force: true });
      }
      writeFileSync(path.join(outDir, `run${run}.json`), JSON.stringify(record, null, 1) + "\n");
      records.push(record);
    }
  } finally {
    await server.stop();
    releaseLock();
  }
  const p7 = na ? null : summarizeP7(records);
  const summary = {
    probe: "first-launch", at: new Date().toISOString(), locked: !values["no-lock"], machine: machineSnapshot(),
    chrome: chromeInfo(), served: server.identity,
    iso: path.basename(iso), query, url: `${server.base}?${query}`, runs: records.length,
    p7, p7Why: na ?? (p7 ? null : "every run started on an overloaded machine")
  };
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  const failures = p7 ? [...p7.failedFirst, ...p7.failedSecond] : [];
  log(na ? `n/a: ${na} -> ${outDir}` : `optimisation ${p7?.durationMs ?? "-"} ms (target < ${p7?.targetMs ?? 60000} ms), recompiled on 2nd launch ${p7?.secondLaunchCompiled ?? "-"}${failures.length ? `; failed: ${failures.map((f) => `r${f.run} ${f.why}`).join("; ")}` : ""} -> ${outDir}`);
  // n/a is not a failure; a run that did not finish is.
  process.exitCode = na ? 0 : p7 && !failures.length ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
