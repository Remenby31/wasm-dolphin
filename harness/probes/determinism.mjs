#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Does one emulated CPU thread repeat a boot exactly? Boots a disc N times in
// cpu=single with the CoreTiming trace on (patch 0081), optionally with the
// host's CPUs busy, and compares the runs: the hash of every CoreTiming event
// (name, emulated time, lateness) and of emulated RAM at each VI output, and
// the picture at --vi. Exit 1 on any difference, naming the first one and the
// events around it.
//
//   node harness/probes/determinism.mjs --port N [--iso disc.iso] [--runs 3]
//     [--vi 120] [--stress 8] [--query "..."] [--query-b "..."] [--host-clock]
//
// --query-b: even runs boot with this query instead (same fixed clock), and
// must still match run 1 exactly: a switch that claims to change nothing the
// guest can see (e.g. idleff=1, patch 0089) is checked event by event.
//
// Exit 0: identical runs on the fixed clock, or differing runs on the host
// clock (--host-clock). Exit 1 otherwise.
//
// The trace exists only in a trace build of the core (DOLPHIN_WEB_DET_TRACE=1
// at configure time; pass it with coreid= in --query): the committed core,
// like a player's, has none of it, and the probe says so.
//
// The harness runs cpu=single on a fixed console clock (?rtc=, matrix.mjs) and
// the probe expects identical runs. --host-clock runs on the host's clock, as
// the app does for players, and expects the opposite: the clock sets the time
// base at boot and formats the memory cards, so RAM differs from the first
// frames. Identical runs there mean the probe no longer sees what it checks.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";

import { ensureServer, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { isSingleCore } from "../lib/matrix.mjs";
import { captureInSession, openSession } from "../lib/session.mjs";
import { decodeIdleStats } from "../lib/idle-stats.mjs";

const { values } = parseArgs({
  options: {
    iso: { type: "string", default: path.join(REPO_ROOT, "harness", "homebrew", "out", "gxscene.iso") },
    runs: { type: "string", default: "3" },
    vi: { type: "string", default: "120" },
    stress: { type: "string", default: "0" },
    query: { type: "string", default: "core=upstream&video=software&presenter=webgpu&cpu=single&speed=1&oc=1&fastsw=1&wasmjit=0&metrics=1" },
    "query-b": { type: "string" },
    "host-clock": { type: "boolean", default: false },
    port: { type: "string", default: process.env.HARNESS_PORT },
  },
});
if (!values.port) throw new Error("usage: determinism.mjs --port N [--iso disc.iso] [--runs 3] [--vi 120] [--stress 8] [--host-clock]");
const iso = path.resolve(values.iso);
if (!existsSync(iso)) throw new Error(`disc image not found: ${iso}`);
if (!isSingleCore(values.query)) throw new Error("determinism is only defined for one emulated CPU thread (cpu=single, or cpu=auto without OGL)");
const hostClock = values["host-clock"];
const params = new URLSearchParams(values.query);
if (hostClock) params.set("rtc", "host");
const query = params.toString();
const queryB = values["query-b"] ? (() => {
  if (!isSingleCore(values["query-b"])) throw new Error("--query-b must run one emulated CPU thread too");
  const b = new URLSearchParams(values["query-b"]);
  if (hostClock) b.set("rtc", "host");
  return b.toString();
})() : null;
if (queryB && hostClock) throw new Error("--query-b compares two switches on the fixed clock: no --host-clock");

// Busy host CPUs, so host timing has every chance to leak in.
const stress = Array.from({ length: Number(values.stress) }, () => new Worker("let x = 0; for (;;) x = (x * 1103515245 + 12345) | 0;", { eval: true }));
const server = await ensureServer({ port: Number(values.port) });
const runs = [];
try {
  for (let run = 1; run <= Number(values.runs); run += 1) {
    const session = await openSession({ base: server.base, server, query: queryB && run % 2 === 0 ? queryB : query, iso, harness: { detTrace: true } });
    try {
      // Idle-skip counters from the boot on (patch 0089; absent from older
      // cores): a --query-b run with a fast-forward that never skipped would
      // prove nothing.
      const idleReset = await workerRequest(session.page, "validationReadIdleStats", { reset: true }, 10000).catch((e) => ({ error: String(e) }));
      const capture = await captureInSession(session, { index: Number(values.vi), timeoutMs: 180000 });
      if (capture.error) throw new Error(`capture: ${capture.error}`);
      const trace = await workerRequest(session.page, "validationReadDetTrace", { fromLog: 0, maxLog: 1 << 18 }, 120000);
      if (!trace?.supported) throw new Error(`no determinism trace: ${trace?.why ?? trace?.error}`);
      if (trace.startVi !== 0) throw new Error(`the trace started at VI ${trace.startVi}, after the boot began`);
      if (hostClock ? session.clock?.fixed : !session.clock?.fixed) throw new Error(`clock: expected the ${hostClock ? "host" : "fixed"} clock, got ${JSON.stringify(session.clock)}`);
      const idleReply = idleReset?.error ? idleReset : await workerRequest(session.page, "validationReadIdleStats", {}, 10000).catch((e) => ({ error: String(e) }));
      const idle = idleReply.error ? { error: idleReply.error } : decodeIdleStats(idleReply.bytes);
      runs.push({ run, url: session.url, clock: session.clock, picture: createHash("sha256").update(capture.data).digest("hex").slice(0, 12), idle, ...trace });
      const idleNote = idle.error ? `idle stats: ${idle.error}` : `${idle.idleCalls} Idle() calls, ${idle.ffSkips} iterations fast-forwarded`;
      console.log(`[determinism] run ${run}${queryB ? ` (query ${run % 2 === 0 ? "b" : "a"})` : ""}: picture ${runs.at(-1).picture}, ${trace.checkpoints.length} checkpoints, ${idleNote}`);
    } finally {
      await session.close();
    }
  }
} finally {
  await server.stop();
  await Promise.all(stress.map((w) => w.terminate()));
}

// Compare every run with the first, up to the VI output both reached.
const ref = runs[0];
let differs = false;
for (const r of runs.slice(1)) {
  const n = Math.min(r.checkpoints.length, ref.checkpoints.length, Number(values.vi));
  const at = (k) => r.checkpoints.slice(0, n).findIndex((c, i) => c[k] !== ref.checkpoints[i][k] && (k !== 1 || c[1] !== "0"));
  const events = at(0), ram = at(1);
  const picture = r.picture !== ref.picture;
  if (events < 0 && ram < 0 && !picture) {
    console.log(`[determinism] run ${r.run} = run 1`);
    continue;
  }
  differs = true;
  console.log(`[determinism] run ${r.run} differs from run 1: events from VI ${events < 0 ? "-" : events + 1}, RAM from VI ${ram < 0 ? "-" : ram + 1}, picture ${picture ? "different" : "same"}`);
  if (events >= 0) {
    // The CPU thread's events only: another thread's scheduling lands at a
    // host-timed place in the log by nature (kind 2, OffThread).
    const from = events > 0 ? ref.checkpoints[events - 1][4] : 0;
    const cpu = (log) => log.slice(from).filter((e) => e[3] !== 2);
    const a = cpu(ref.log), b = cpu(r.log);
    let k = 0;
    while (k < Math.min(a.length, b.length) && JSON.stringify(a[k]) === JSON.stringify(b[k])) k += 1;
    console.log(`  first differing CPU-thread event (${k} after VI ${events}) [time, late, name, kind]: run 1 ${JSON.stringify(a[k])} | run ${r.run} ${JSON.stringify(b[k])}`);
    // The events just before it (kind 0 run, 1 scheduled, 2 off-thread …).
    for (let j = Math.max(0, k - 8); j < k; j += 1) console.log(`    ${JSON.stringify(a[j])}`);
  }
  if (ram >= 0 && r.ramChunks?.length) {
    const chunks = r.ramChunks.map((h, i) => (h !== ref.ramChunks[i] ? `0x${(0x80000000 + i * 65536).toString(16)}` : null)).filter(Boolean);
    console.log(`  RAM at VI 30 differs in 64 KiB chunks: ${chunks.join(" ") || "none (later)"}`);
  }
}
console.log(`[determinism] ${differs ? "NOT deterministic" : `${runs.length} identical runs`} (${hostClock ? "host clock" : "fixed clock"}, stress ${values.stress}) on ${path.basename(iso)}`);
// Fixed clock: identical runs pass. Host clock: the divergence must show.
const ok = hostClock ? differs : !differs;
if (!ok) console.log(`[determinism] FAIL: expected ${hostClock ? "runs to differ on the host clock" : "identical runs on the fixed clock"}`);
process.exitCode = ok ? 0 : 1;
