#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The worker's stream track, as a streaming host would encode it, with the
// local display at the same time (presentvsync v3, 2026-10-25):
//
//   node harness/probes/stream-track.mjs --iso disc.iso --state s.sav --query "..."
//     [--port N] [--runs 1] [--warmup 15] [--secs 20] [--hold KeyX]
//     [--lock-wait 1800 | --no-lock] [--out dir]
//
// Each run boots the page, loads the savestate, attaches the worker's stream
// (window.__host.captureVideoTrack()) and reads it in the page through a
// MediaStreamTrackProcessor, closing each frame at once. After --warmup s it
// records --secs s: the stream's frames (lib/stream-track.mjs), the core's VI
// intervals, the presents and what the screen got (--display counter), and
// the presentvsync counters. A timing measure: it takes the shared perf lock.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ensureServer, loadHarnessState, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { openSession } from "../lib/session.mjs";
import { distribution, streamTrackStats } from "../lib/stream-track.mjs";

const { values } = parseArgs({
  options: {
    iso: { type: "string" }, state: { type: "string" }, query: { type: "string" },
    port: { type: "string", default: process.env.HARNESS_PORT ?? "8100" }, runs: { type: "string", default: "1" },
    warmup: { type: "string", default: "15" }, secs: { type: "string", default: "20" }, hold: { type: "string", default: "KeyX" },
    "lock-wait": { type: "string", default: "1800" }, "no-lock": { type: "boolean", default: false }, out: { type: "string" }
  }
});
if (!values.iso || !values.state || !values.query) throw new Error("--iso, --state and --query are required");
const runs = Number(values.runs), warmupMs = Number(values.warmup) * 1000, secs = Number(values.secs);
// A run that never ends would hold the lock: each run has a watchdog.
const runTimeoutMs = warmupMs + secs * 1000 + 180_000;

async function measure(server) {
  const s = await openSession({ base: server.base, server, query: `${values.query}&metrics=1`, iso: values.iso, routes: { "**/__harness_state.sav": values.state }, harness: { displayed: true } });
  try {
    const loaded = await loadHarnessState(s.page, s.url);
    if (!loaded?.loaded) return { error: "state load failed" };
    if (values.hold) await s.page.keyboard.down(values.hold);
    const attached = await s.page.evaluate(() => {
      const track = window.__host?.captureVideoTrack?.();
      if (!track) return false;
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      window.__streamFrames = [];
      window.__streamRecording = false;
      (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          if (window.__streamRecording) window.__streamFrames.push([value.timestamp / 1000, performance.now()]);
          value.close();
        }
      })();
      return true;
    });
    if (!attached) return { error: "no stream track (captureVideoTrack returned null)" };
    await s.page.waitForTimeout(warmupMs);
    await readTimeline(s.page);
    await s.page.evaluate(() => { window.__streamFrames = []; window.__streamRecording = true; });
    await s.page.waitForTimeout(secs * 1000);
    const tl = await readTimeline(s.page);
    const frames = await s.page.evaluate(() => { window.__streamRecording = false; return window.__streamFrames; });
    const presentVsync = await workerRequest(s.page, "validationReadPresentVsync", {}).catch((e) => ({ error: String(e.message || e) }));
    const intervals = (t) => t.slice(1).map((x, i) => x - t[i]);
    const d = tl.displayed;
    return {
      stream: streamTrackStats(frames, secs),
      viInterval: distribution(intervals(tl.vi.t)),
      presentInterval: distribution(intervals(tl.presents.t)),
      display: { beginFrames: d.t.length, shown: d.submits.filter((n) => n > 0).length, with2plus: d.submits.filter((n) => n > 1).length },
      presentVsync
    };
  } finally {
    await s.close();
  }
}

const release = values["no-lock"] ? null : await acquirePerfLock({ name: `harness stream-track (${REPO_ROOT})`, waitSec: Number(values["lock-wait"]), log: (m) => console.log(`[stream-track] ${m}`) });
const server = await ensureServer({ port: Number(values.port), root: REPO_ROOT });
const records = [];
for (let run = 1; run <= runs; run += 1) {
  let timer;
  const record = await Promise.race([
    measure(server),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ error: `run timed out (${runTimeoutMs / 1000} s)` }), runTimeoutMs); })
  ]).catch((e) => ({ error: String(e.message || e) }));
  clearTimeout(timer);
  records.push({ run, ...record });
  console.log(`[stream-track] run ${run}: ${record.error ?? `stream ${record.stream.fps} fps, capture p99 ${record.stream.captureInterval.p99} ms, gaps ${record.stream.gaps}; display 2+ ${record.display.with2plus}/${record.display.beginFrames}`}`);
}
const result = { probe: "stream-track", at: new Date().toISOString(), query: values.query, state: path.basename(values.state), secs, locked: !values["no-lock"], runs: records };
if (values.out) {
  mkdirSync(values.out, { recursive: true });
  writeFileSync(path.join(values.out, "stream-track.json"), JSON.stringify(result, null, 1) + "\n");
}
console.log(JSON.stringify(result));
release?.();
process.exit(records.some((r) => r.error) ? 1 : 0);
