#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Where the hardware renderer's stalls come from. Boots a disc headless on
// video=wgpu, loads a savestate (the scene change that creates most render
// pipelines), and records a Chrome trace (gpu.dawn and friends, every
// process) while it plays. Writes the trace and a summary: every pipeline
// creation in the GPU process with its duration, the GPU process's long
// tasks, the worker's long tasks, and which worker stalls overlap a
// pipeline compile.
//
//   node harness/probes/wgpu-pipeline-trace.mjs --iso disc.iso --state x.sav --port N
//     [--secs 30] [--query "...video=wgpu..."] [--out dir] [--launches 2]
//
// --launches 2 boots the disc again in the same profile: the second launch
// finds the pipeline list the first saved (src/wgpu-pipeline-prewarm.js).
//
// No speed is measured here (a trace costs speed): no perf lock.
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createGzip } from "node:zlib";

import { ensureServer, launchChrome, loadHarnessState, readTimeline, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { openSession, rebootSession } from "../lib/session.mjs";

const CATEGORIES = [
  "gpu", "gpu.dawn", "disabled-by-default-gpu.dawn", "gpu.service", "gpu.capture",
  "toplevel", "blink.worker", "__metadata"
];
const LONG_MS = 50;

const { values } = parseArgs({
  options: {
    iso: { type: "string" }, state: { type: "string" },
    secs: { type: "string", default: "30" },
    config: { type: "string", default: "wgpu" }, query: { type: "string" },
    port: { type: "string", default: process.env.HARNESS_PORT },
    out: { type: "string" },
    launches: { type: "string", default: "1" },
    relaunch: { type: "boolean", default: false },
    "metal-cache": { type: "string" },
    "chrome-args": { type: "string" }
  }
});
if (!values.iso || !values.state || !values.port) throw new Error("usage: wgpu-pipeline-trace.mjs --iso disc.iso --state x.sav --port N [--secs 30]");
const query = `${values.query ?? PRESETS[values.config]}&metrics=1`;
if (new URLSearchParams(query).get("video") !== "wgpu") throw new Error(`this probe is for video=wgpu, got: ${query}`);
const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "..", "measures", "harness", `wgpu-pipeline-trace-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`));
mkdirSync(outDir, { recursive: true });

// Trace events -> the summary. Complete events (X) carry dur; B/E pairs are
// matched per thread.
export function summarize(events) {
  const names = new Map();
  for (const e of events) {
    if (e.ph === "M" && e.name === "process_name") names.set(`p${e.pid}`, e.args?.name);
    if (e.ph === "M" && e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, e.args?.name);
  }
  const spans = [];
  const open = new Map();
  for (const e of events) {
    if (e.ph === "X") spans.push({ name: e.name, cat: e.cat, pid: e.pid, tid: e.tid, ts: e.ts, dur: e.dur ?? 0 });
    else if (e.ph === "B") (open.get(`${e.pid}:${e.tid}`) ?? open.set(`${e.pid}:${e.tid}`, []).get(`${e.pid}:${e.tid}`)).push(e);
    else if (e.ph === "E") {
      const b = open.get(`${e.pid}:${e.tid}`)?.pop();
      if (b) spans.push({ name: b.name, cat: b.cat, pid: b.pid, tid: b.tid, ts: b.ts, dur: e.ts - b.ts });
    }
  }
  const proc = (s) => names.get(`p${s.pid}`) ?? `pid ${s.pid}`;
  const thread = (s) => names.get(`${s.pid}:${s.tid}`) ?? `tid ${s.tid}`;
  const ms = (us) => Math.round(us / 10) / 100;
  const pipelines = spans.filter((s) => /CreateRenderPipeline|CreateComputePipeline/.test(s.name));
  const isWorker = (s) => /DedicatedWorker/i.test(thread(s));
  const isGpu = (s) => /GPU Process/i.test(proc(s));
  const tasks = spans.filter((s) => s.name === "ThreadControllerImpl::RunTask" || s.name === "RunTask");
  const workerLong = tasks.filter((s) => isWorker(s) && s.dur >= LONG_MS * 1000);
  const gpuLong = tasks.filter((s) => isGpu(s) && s.dur >= LONG_MS * 1000);
  const waits = spans.filter((s) => /WaitForToken|WaitForGetOffset|RingBuffer|WaitForAvailableEntries/.test(s.name));
  const overlaps = (a, b) => a.ts < b.ts + b.dur && b.ts < a.ts + a.dur;
  const byName = {};
  for (const p of pipelines) {
    const k = `${p.name} [${thread(p)}]`;
    const o = (byName[k] ??= { count: 0, totalMs: 0, maxMs: 0, over16: 0 });
    o.count += 1; o.totalMs += p.dur / 1000; o.maxMs = Math.max(o.maxMs, p.dur / 1000); if (p.dur > 16000) o.over16 += 1;
  }
  for (const o of Object.values(byName)) o.totalMs = Math.round(o.totalMs);
  return {
    pipelines: byName,
    workerLongTasks: workerLong.map((t) => ({
      ms: ms(t.dur), thread: thread(t),
      pipelineMsInside: ms(pipelines.filter((p) => overlaps(p, t)).reduce((a, p) => a + p.dur, 0)),
      pipelinesInside: pipelines.filter((p) => overlaps(p, t)).length,
      waitsInside: waits.filter((w) => overlaps(w, t)).map((w) => `${w.name} ${ms(w.dur)}ms`).slice(0, 4)
    })),
    gpuLongTasks: gpuLong.map((t) => ({
      ms: ms(t.dur), thread: thread(t),
      pipelineMsInside: ms(pipelines.filter((p) => overlaps(p, t) && p.pid === t.pid).reduce((a, p) => a + p.dur, 0))
    })),
    waits: Object.entries(waits.reduce((acc, w) => { const o = (acc[w.name] ??= { count: 0, maxMs: 0, totalMs: 0 }); o.count += 1; o.maxMs = Math.max(o.maxMs, ms(w.dur)); o.totalMs += w.dur / 1000; return acc; }, {}))
      .map(([name, o]) => ({ name, ...o, totalMs: Math.round(o.totalMs) }))
  };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const server = await ensureServer({ port: values.port });
  // One profile for every launch: a later launch finds what the first saved
  // (OPFS). --relaunch starts a new browser (a new GPU process) for each.
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-pipeline-trace-profile-"));
  const open = () => openSession({
    base: server.base, server, query, iso: path.resolve(values.iso),
    routes: { "**/__harness_state.sav": path.resolve(values.state) },
    chromeArgs: (values["chrome-args"] ?? "").split(/\s+/).filter(Boolean),
    launch: (opts) => launchChrome({ ...opts, profileDir })
  });
  // --metal-cache: the OS's Metal shader cache of the browser under test,
  // emptied before each launch so every compile is cold. Only for a browser
  // of its own (HARNESS_CHROME_PATH), never the user's Chrome.
  const metalCache = values["metal-cache"] ? path.resolve(values["metal-cache"]) : null;
  if (metalCache && /com\.google\.Chrome/.test(metalCache)) throw new Error("--metal-cache must not be Google Chrome's cache");
  let session = null;
  const launches = [];
  try {
    for (let launch = 1; launch <= Number(values.launches); launch += 1) {
      if (metalCache && (launch === 1 || values.relaunch)) rmSync(metalCache, { recursive: true, force: true });
      if (!session) session = await open();
      else await rebootSession(session, server);
      const { page } = session;
      const cdp = await page.context().newCDPSession(page);
      const chunks = [];
      cdp.on("Tracing.dataCollected", (m) => { for (const e of m.value) chunks.push(e); });
      const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
      await cdp.send("Tracing.start", { traceConfig: { includedCategories: CATEGORIES, recordMode: "recordContinuously" }, transferMode: "ReportEvents" });
      const loaded = await loadHarnessState(page, session.url);
      if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
      await readTimeline(page); // presents from here on
      await page.keyboard.down("KeyX");
      await page.waitForTimeout(Number(values.secs) * 1000);
      await page.keyboard.up("KeyX");
      // The longest wait between two presents the player saw.
      const timeline = await readTimeline(page);
      const shown = timeline?.presents?.t ?? [];
      const vi = timeline?.vi?.t ?? [];
      const gaps = shown.slice(1).map((t, i) => t - shown[i]).sort((a, b) => b - a);
      const viGaps = vi.slice(1).map((t, i) => t - vi[i]).sort((a, b) => b - a);
      const presentGaps = { vi: vi.length, viMaxMs: Math.round(viGaps[0] ?? 0), viOver50: viGaps.filter((g) => g > 50).length, presentsLost: timeline?.presents?.lost ?? null, timelineError: timeline?.error ?? null, presents: shown.length, maxMs: Math.round(gaps[0] ?? 0), over50: gaps.filter((g) => g > 50).length, top: gaps.slice(0, 5).map(Math.round) };
      const prewarm = await workerRequest(page, "validationReadPipelinePrewarm", {}, 10000).catch((e) => ({ error: String(e.message || e) }));
      await cdp.send("Tracing.end");
      await complete;
      await cdp.detach().catch(() => {});
      // Event by event: a whole trace overflows one JS string.
      const gz = createGzip();
      const done = new Promise((resolve, reject) => gz.pipe(createWriteStream(path.join(outDir, `trace-${launch}.json.gz`))).on("finish", resolve).on("error", reject));
      gz.write("{\"traceEvents\":[");
      chunks.forEach((e, i) => gz.write((i ? ",\n" : "") + JSON.stringify(e)));
      gz.end("]}");
      await done;
      launches.push({ launch, events: chunks.length, prewarm, presentGaps, ...summarize(chunks) });
      console.log(JSON.stringify(launches.at(-1), null, 2).slice(0, 3000));
      if (values.relaunch && launch < Number(values.launches)) {
        await session.close();
        session = await new Promise((r) => setTimeout(() => r(null), 2000));
      }
    }
    const adapter = await session.page.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter();
      return a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, description: a.info?.description } : null;
    });
    writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ url: session.url, query, adapter, chrome: process.env.HARNESS_CHROME_PATH ?? "chrome", relaunch: values.relaunch, metalCache, secs: Number(values.secs), launches }, null, 2));
    console.log(`[wgpu-pipeline-trace] ${outDir}`);
  } finally {
    await session?.close?.();
    rmSync(profileDir, { recursive: true, force: true });
  }
  // The harness server keeps node alive.
  process.exit(0);
}
