#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Savestate cycles: boots a disc (headless), loads a savestate, then runs N
// cycles of "load the state again" or "save, then load what was saved",
// and checks after each load, the first one included, that the game goes on: the GPU makes EFB-to-XFB
// copies (headroom counters, patch 0113) and the pixel engine signals
// DrawDone (GPU-sync counters, patch 0080). A load that lands while the GPU
// thread is still decoding the FIFO used to leave the CP FIFO empty with
// commands pending (patch 0116): the guest ran at speed and drew nothing.
// The first load right after boot, while the GPU still decodes the boot's
// backlog, is where it struck (main, 4 boots of 4); --boots repeats it.
//
//   node harness/probes/savestate-cycles.mjs --iso disc.iso --state scene.sav --port N
//     [--query "...video=wgpu..."] [--cycles 20] [--mode load|save-load|both]
//     [--boots 1] [--settle 3] [--hold KeyX] [--out dir]
//
// Exit status 1 when a cycle stalls. The disc and the state stay where they
// are: a local disc never writes into the repo (results under the job's
// --out, or harness/results for our homebrews).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, loadHarnessState, pageCall, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { consistentHeadroomRead, decodeHeadroomStats } from "../lib/headroom.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { openSession } from "../lib/session.mjs";

const STATE_ROUTE = "**/__harness_state.sav";
const HOMEBREW_OUT = path.join(REPO_ROOT, "harness", "homebrew", "out");

const { values } = parseArgs({
  options: {
    iso: { type: "string" }, state: { type: "string" }, port: { type: "string", default: process.env.HARNESS_PORT },
    query: { type: "string" }, cycles: { type: "string", default: "20" }, mode: { type: "string", default: "both" },
    boots: { type: "string", default: "1" }, settle: { type: "string", default: "3" }, hold: { type: "string" }, out: { type: "string" },
  },
});
if (!values.iso || !values.state || !values.port) {
  throw new Error("usage: savestate-cycles.mjs --iso disc.iso --state scene.sav --port N [--cycles 20] [--mode load|save-load|both]");
}
if (!["load", "save-load", "both"].includes(values.mode)) throw new Error(`--mode: load, save-load or both, got ${values.mode}`);
const iso = path.resolve(values.iso), state = path.resolve(values.state);
for (const f of [iso, state]) if (!existsSync(f)) throw new Error(`not found: ${f}`);
const query = `${values.query ?? PRESETS["wgpu-nojit"]}&metrics=1`;
const cycles = Number(values.cycles), settleMs = Number(values.settle) * 1000;
const local = !iso.startsWith(HOMEBREW_OUT);
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${process.pid}-${randomBytes(3).toString("hex")}`;
const outDir = values.out ? path.resolve(values.out) : local ? null : path.join(REPO_ROOT, "harness", "results", `savestate-cycles-${stamp}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (page, type, payload = {}, ms = 10000) => workerRequest(page, type, payload, ms).catch((e) => ({ error: String(e.message || e) }));

async function headroom(page, reset) {
  const r = await req(page, "validationReadHeadroomStats", { reset });
  if (r?.error) return { error: r.error };
  const s = consistentHeadroomRead(decodeHeadroomStats(r.bytes), decodeHeadroomStats(r.again));
  return s.error ? { error: s.error } : s;
}

async function gpuSync(page) {
  const s = await req(page, "validationReadWgpuReplayState");
  return s?.gpuSync ?? null;
}

// The game goes on after a load: XFB copies and DrawDone signals within
// the settle window (the counters reset at the next VI after the request).
async function progress(page) {
  await headroom(page, 0);
  const before = await gpuSync(page);
  await sleep(settleMs);
  const hr = await headroom(page, -1);
  const after = await gpuSync(page);
  const finish = (after?.counters?.finishSignalled ?? 0) - (before?.counters?.finishSignalled ?? 0);
  const chunks = (after?.counters?.fifoChunks ?? 0) - (before?.counters?.fifoChunks ?? 0);
  const xfbCopies = hr.error ? null : hr.xfbCopies;
  // pause: the GPU-loop pause of the last DoState (patch 0116; absent before).
  return { ok: Boolean(xfbCopies > 0 && finish > 0), xfbCopies, finish, chunks, headroomError: hr.error ?? null, fifo: after?.fifo ?? null, pause: after?.savestatePause ?? null };
}

const record = { probe: "savestate-cycles", iso: path.basename(iso), state: path.basename(state), query, mode: values.mode, boots: [], at: new Date().toISOString() };
const server = await ensureServer({ port: values.port });
let failed = 0, total = 0;
for (let b = 1; b <= Number(values.boots); b += 1) {
  const boot = { boot: b, cycles: [] };
  record.boots.push(boot);
  const session = await openSession({ base: server.base, server, query, iso, routes: { [STATE_ROUTE]: state } });
  const { page } = session;
  const check = (cycle) => {
    total += 1;
    if (!cycle.loaded || !cycle.ok) failed += 1;
    console.log(`[savestate-cycles] boot ${b} ${cycle.i}/${cycles} ${cycle.kind}: ${cycle.loaded && cycle.ok ? "ok" : "STALL"} xfbCopies ${cycle.xfbCopies} finish +${cycle.finish} chunks +${cycle.chunks}` +
      (cycle.ok ? "" : ` fifo ${JSON.stringify(cycle.fifo)}${cycle.loadError ? ` (${cycle.loadError})` : ""}`));
  };
  try {
    await req(page, "validationEnableGpuSyncDiag", { enabled: true });
    const t0 = Date.now();
    const first = await loadHarnessState(page, session.url);
    if (values.hold) await page.keyboard.down(values.hold);
    boot.first = { i: 0, kind: "first-load", loaded: Boolean(first?.loaded), loadError: first?.error ?? null, ms: Date.now() - t0, ...(await progress(page)) };
    check(boot.first);
    for (let i = 1; i <= cycles; i += 1) {
      const kind = values.mode === "both" ? (i % 2 ? "load" : "save-load") : values.mode;
      const t1 = Date.now();
      let step;
      if (kind === "load") {
        step = await loadHarnessState(page, session.url);
      } else {
        const saved = await pageCall(page, "__saveStateFile", undefined, 60000);
        step = saved?.saved ? await pageCall(page, "__loadStateFileFs", "/savestate_out.sav", 120000) : { loaded: false, error: saved?.error ?? "save failed" };
      }
      const cycle = { i, kind, loaded: Boolean(step?.loaded), loadError: step?.error ?? null, ms: Date.now() - t1, ...(await progress(page)) };
      boot.cycles.push(cycle);
      check(cycle);
    }
  } finally {
    if (values.hold) await page.keyboard.up(values.hold).catch(() => {});
    await session.close();
  }
}
record.failed = failed;
// How long a load waited for the GPU loop (patch 0116), first loads apart.
const pauses = (rows) => {
  const us = rows.map((c) => c.pause?.lastUs).filter(Number.isFinite).sort((a, b) => a - b);
  if (!us.length) return null;
  const at = (q) => us[Math.min(us.length - 1, Math.ceil(us.length * q) - 1)];
  return { n: us.length, p50Ms: at(0.5) / 1000, p95Ms: at(0.95) / 1000, maxMs: us.at(-1) / 1000 };
};
// count/busy are cumulative per boot: the last reading of each boot says how
// many pauses (saves and loads) found the GPU loop still running.
const lastPause = (b) => [b.first, ...b.cycles].filter((c) => c?.pause).at(-1)?.pause ?? null;
record.pause = {
  firstLoad: pauses(record.boots.map((b) => b.first).filter(Boolean)),
  cycles: pauses(record.boots.flatMap((b) => b.cycles)),
  busyPerBoot: record.boots.map((b) => { const p = lastPause(b); return p ? `${p.busy}/${p.count}` : null; })
};
if (record.pause.firstLoad || record.pause.cycles) console.log(`[savestate-cycles] GPU-loop pause: first load ${JSON.stringify(record.pause.firstLoad)}, cycles ${JSON.stringify(record.pause.cycles)}`);
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "savestate-cycles.json"), JSON.stringify(record, null, 1));
}
console.log(`[savestate-cycles] ${total - failed}/${total} loads went on${outDir ? ` -> ${outDir}` : ""}`);
process.exit(failed ? 1 : 0);
