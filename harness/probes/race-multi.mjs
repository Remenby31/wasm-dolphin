#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Several sides of one scene measured AT THE SAME TIME, one Chromium per
// lane (a set of identical cores), the lanes rotated between runs (Latin
// square). Shared noise (machine load, temperature, memory bandwidth) hits
// every arm of a run alike, so each run compares the arms with each other;
// the rotation makes the lanes' own differences estimable, and they are
// taken out (log speed = run + lane + arm). One run = N-1 comparisons.
//
//   node harness/probes/race-multi.mjs --iso disc.iso --state scene.sav --port N
//     --arm <dir> --arm <dir> [--arm <dir> …]      (the first is the baseline)
//     --lanes "5,6,7;15,16,17;8,9,19" [--query …] [--runs 6] [--warmup 25] [--secs 20]
//     [--max-load L] [--lock <dir/.perf-lock> …] [--counters] [--aot-seed [--seed-sec 600]] [--out dir]
//
// - Each arm is a tree served as is (race-perf's sides), on its own port
//   (port + arm index), its Chromium pinned through HARNESS_CHROME_PATH's
//   SPARK_CHROME_CPUS (harness/remote/chrome-pinned.sh).
// - Every session boots first; the warmups and windows then start together
//   (race-perf's measure(), unchanged: no page call in the window).
// - --runs a multiple of the arms, so each arm visits each lane equally.
// - --max-load: the machine runs N emulators at once; the limit is the
//   machine's (default N × a quarter of the cores).
// - --counters (Linux, perf_event_paranoid ≤ 2): during each window, `perf
//   stat` counts the user-mode instructions and cycles of each arm's busiest
//   renderer thread (the emulated CPU thread), on both core types' PMUs, and
//   gives host instructions per guest cycle: a metric that contention does
//   not change, for codegen changes.
// - --aot-seed (aot=1 queries): which regions are installed when the window
//   opens decides which code runs (two levels of host instructions per guest
//   cycle, 6 % apart, on one core: 2026-10-22). So each arm first boots once
//   on its own port (the region cache is per origin and per core) until the
//   first-launch optimisation is done, and keeps that profile; every run
//   starts from a copy of it (warm cache, the same for all runs of the arm).
//   Before each window, every arm waits until its core has no region pending
//   (queued = installed + refused + dropped) and its installed count holds
//   for 3 reads, then all arms open their windows together; the counts are
//   recorded per arm (regionGate) and compared (regionCountsEqual).
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { ensureServer, REPO_ROOT } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { openSession } from "../lib/session.mjs";
import { median, round } from "../lib/stats.mjs";
import { measure, num } from "./race-perf.mjs";
import { workerRequest } from "../lib/browser.mjs";
import { decodeRegionStats } from "../lib/jit-region-stats.mjs";
import { checkPerfAccess, instructionsPerGuestCycle, perfCounters } from "../lib/perf-counters.mjs";

export { GUEST_HZ, instructionsPerGuestCycle, parsePerfCsv } from "../lib/perf-counters.mjs";

const STATE_ROUTE = "**/__harness_state.sav";
// Lane of arm `arm` in run `run` (1-based runs): a cyclic Latin square.
export const laneOf = (arm, run, lanes) => (arm + run - 1) % lanes;
// The order the arms boot in, rotated each run: each arm boots first,
// second… equally often (over runs a multiple of the arms). Arm a's rank is
// a - (run - 1) and its lane a + (run - 1): for an odd number of arms the
// two Latin squares are orthogonal, every (lane, rank) pair occurs, so the
// boot order does not stand in for the lane.
export const bootOrder = (run, arms) => Array.from({ length: arms }, (_, k) => (k + run - 1) % arms);

const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

// Region pipeline of one core, read without touching the counters (the
// diagnostics are readable with the stats off).
async function regionPipeline(page) {
  const reply = await workerRequest(page, "validationReadJitRegionStats", {}, 10000);
  const d = reply?.bytes ? decodeRegionStats(reply.bytes)?.diagnostics : null;
  if (!d) return null;
  const { regionsQueued: queued = 0, regionsInstalled: installed = 0, regionsRefused: refused = 0, regionsDropped: dropped = 0 } = d;
  // Regions installed from the cache at boot never pass through the queue:
  // pending can be negative, which means none left.
  return {
    queued, installed, refused, dropped, pending: Math.max(0, queued - installed - refused - dropped),
    // layoutRefused: the core's refusals plus discio's skips before queueing
    // (0078); heapPatched: modules patched to a moved heap (0084, #71).
    layoutRefused: Number.isInteger(reply.layoutRefused) ? reply.layoutRefused : null,
    heapPatched: Number.isInteger(reply.heapPatched) ? reply.heapPatched : null
  };
}

// Wait until no region is pending and the installed count holds for
// `stableReads` reads `everyMs` apart (bounded by `timeoutMs`).
export async function waitRegionsQuiescent(read, { everyMs = 1000, stableReads = 3, timeoutMs = 120000, target = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const t0 = Date.now();
  let last = null, stable = 0, p = null;
  for (;;) {
    p = await read();
    if (!p) return { quiescent: false, why: "no region pipeline in this core", ms: Date.now() - t0 };
    stable = p.pending === 0 && last && p.installed === last.installed ? stable + 1 : 0;
    // With a target (the seed's count), a stable count below it is not done:
    // the regions may still come (or never will: the timeout says so).
    const reached = target == null || p.installed >= target;
    if (stable >= stableReads - 1 && p.pending === 0 && reached) return { quiescent: true, ...p, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { quiescent: false, why: p.pending ? `still ${p.pending} pending after ${timeoutMs} ms` : `${p.installed} installed, ${target} expected, after ${timeoutMs} ms`, ...p, ms: Date.now() - t0 };
    last = p;
    await sleep(everyMs);
  }
}

// Lines of the profile's chrome.log (--enable-logging) about regions, the
// first-launch optimisation and the JIT cache: what the page said at boot.
export function chromeLogLines(profileDir, re = /aot|region|cache size|jit-cache|layout/i, max = 40) {
  try {
    return readFileSync(path.join(profileDir, "chrome.log"), "utf8").split("\n").filter((l) => /CONSOLE/.test(l) && re.test(l)).slice(-max).map((l) => l.slice(0, 400));
  } catch {
    return [];
  }
}

// A barrier for `n` arms, released when all arrived or after `timeoutMs`.
export function barrier(n, timeoutMs = 180000) {
  let arrived = 0, open;
  const all = new Promise((r) => { open = r; });
  const timer = setTimeout(() => open(false), timeoutMs);
  return () => { arrived += 1; if (arrived === n) { clearTimeout(timer); open(true); } return all; };
}

// Arm effects from speeds[run][arm] and lanes[run][arm]: log speed =
// run + lane + arm, fitted by alternating means (exact for a complete Latin
// square). Returns, for each arm against arm 0, the raw per-run changes and
// the lane-corrected change, in %.
export function armEffects(speeds, laneIdx) {
  const R = speeds.length, A = speeds[0].length;
  const y = speeds.map((row) => row.map((s) => Math.log(s)));
  const run = new Array(R).fill(0), lane = new Array(A).fill(0), arm = new Array(A).fill(0);
  for (let it = 0; it < 200; it += 1) {
    for (let r = 0; r < R; r += 1) run[r] = y[r].reduce((s, v, a) => s + v - lane[laneIdx[r][a]] - arm[a], 0) / A;
    for (let l = 0; l < A; l += 1) {
      const cells = [];
      for (let r = 0; r < R; r += 1) for (let a = 0; a < A; a += 1) if (laneIdx[r][a] === l) cells.push(y[r][a] - run[r] - arm[a]);
      lane[l] = cells.reduce((s, v) => s + v, 0) / cells.length;
    }
    for (let a = 0; a < A; a += 1) arm[a] = y.reduce((s, row, r) => s + row[a] - run[r] - lane[laneIdx[r][a]], 0) / R;
  }
  const residuals = [];
  for (let r = 0; r < R; r += 1) for (let a = 0; a < A; a += 1) residuals.push(y[r][a] - run[r] - lane[laneIdx[r][a]] - arm[a]);
  const pct = (x) => round((Math.exp(x) - 1) * 100, 2);
  return {
    arms: arm.slice(1).map((v, i) => {
      const raw = speeds.map((row) => (row[i + 1] / row[0] - 1) * 100);
      return { arm: i + 1, perRun: raw.map((x) => round(x, 2)), median: round(median(raw), 2), sd: round(sd(raw), 2), laneCorrected: pct(v - arm[0]) };
    }),
    lanes: lane.map((v) => pct(v - lane[0])),
    residualSd: round(sd(residuals) * 100, 2)
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, state: { type: "string" }, port: { type: "string", default: process.env.HARNESS_PORT },
      arm: { type: "string", multiple: true, default: [] }, lanes: { type: "string" },
      config: { type: "string", default: "wgpu" }, query: { type: "string" },
      runs: { type: "string", default: "6" }, warmup: { type: "string", default: "25" }, secs: { type: "string", default: "20" },
      hold: { type: "string", default: "KeyX" }, "max-load": { type: "string" },
      lock: { type: "string", multiple: true, default: [] }, "lock-wait": { type: "string", default: "14400" }, out: { type: "string" },
      counters: { type: "boolean", default: false }, "aot-seed": { type: "boolean", default: false }, "seed-sec": { type: "string", default: "600" },
      "gate-sec": { type: "string", default: "120" }
    }
  });
  const lanes = String(values.lanes ?? "").split(";").map((l) => l.trim()).filter(Boolean);
  const arms = values.arm.map((a) => path.resolve(a));
  if (!values.iso || !values.state || !values.port || arms.length < 2 || lanes.length !== arms.length) {
    throw new Error("usage: race-multi.mjs --iso … --state … --port N --arm <dir> --arm <dir> [...] --lanes \"cpus;cpus;…\" (one lane per arm)");
  }
  const runs = num(values, "runs", { min: 1, int: true });
  if (runs % arms.length) throw new Error(`--runs ${runs}: a multiple of the ${arms.length} arms, so each arm visits each lane equally`);
  const o = {
    query: `${values.query ?? PRESETS[values.config] ?? values.config}&metrics=1`,
    warmup: num(values, "warmup", { min: 0 }), secs: num(values, "secs", { min: 2, int: true }), hold: values.hold || null,
    maxLoad: values["max-load"] ? num(values, "max-load", { min: 0.1 }) : arms.length * Math.max(2, os.cpus().length / 4)
  };
  const port = num(values, "port", { min: 1, int: true });
  const releases = [];
  for (const dir of values.lock) releases.push(await acquirePerfLock({ dir, name: `race-multi (${REPO_ROOT})`, waitSec: num(values, "lock-wait", { min: 0 }), log: (m) => console.log(`[race-multi] ${m}`) }));
  const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "..", "measures", "harness", `race-multi-${Date.now()}-${randomBytes(3).toString("hex")}`));
  mkdirSync(outDir, { recursive: true });
  const counters = values.counters ? (checkPerfAccess(), perfCounters(outDir)) : null;
  // Per run (--aot-seed): each arm's region gate, and the barrier they share.
  const gates = new Map();
  let arrive = null;
  o.onWindow = async (phase, session) => {
    if (phase === "start" && values["aot-seed"]) {
      const gate = await waitRegionsQuiescent(() => regionPipeline(session.page), { target: seedRegions.get(session.seedOf) ?? null, timeoutMs: num(values, "gate-sec", { min: 1 }) * 1000 });
      // What the boot of this arm said about its regions (for the region robustness work).
      const progress = await workerRequest(session.page, "validationReadAotProgress", { drain: true }, 15000);
      gate.aot = { state: progress?.state ?? null, events: (progress?.events ?? []).filter((e) => e.type !== "progress").slice(-12) };
      gate.log = chromeLogLines(session.profileDir);
      gate.together = await arrive();
      gates.set(session, gate);
    }
    return counters ? counters(phase, session) : undefined;
  };
  const servers = [];
  const records = [];
  const seeds = [];
  const seedRegions = new Map();
  try {
    for (let a = 0; a < arms.length; a += 1) servers.push(await ensureServer({ port: port + a, root: arms[a] }));
    if (values["aot-seed"]) {
      // One warm profile per arm, on its own origin (port), in parallel, one lane each.
      const seedSec = num(values, "seed-sec", { min: 30 });
      const seeded = await Promise.all(arms.map(async (_, a) => {
        process.env.SPARK_CHROME_CPUS = lanes[a];
        const s = await openSession({ base: servers[a].base, server: servers[a], query: o.query, iso: path.resolve(values.iso), keepProfile: true });
        try {
          const end = Date.now() + seedSec * 1000;
          for (;;) {
            const reply = await workerRequest(s.page, "validationReadAotProgress", { drain: true }, 15000);
            if ((reply?.events ?? []).some((e) => e.type === "done")) {
              // The region count the seed reached: what each run's gate waits for.
              await new Promise((r) => setTimeout(r, 3000));
              return { profile: s.profileDir, ok: true, regions: await regionPipeline(s.page) };
            }
            if ((reply?.events ?? []).some((e) => e.type === "error" && e.fatal) || Date.now() > end) return { profile: s.profileDir, ok: false, why: reply?.error ?? "no done within the seed time" };
            await new Promise((r) => setTimeout(r, 1000));
          }
        } finally {
          await s.close().catch(() => {});
        }
      }));
      seeded.forEach((x, a) => console.log(`[race-multi] seed arm ${a}: ${x.ok ? `first-launch optimisation done, ${x.regions?.installed ?? "?"} regions installed` : `FAILED (${x.why})`} -> ${x.profile}`));
      seeded.forEach((x, a) => seedRegions.set(a, x.regions?.installed ?? null));
      if (!seeded.every((x) => x.ok)) throw new Error("--aot-seed: an arm's first launch did not finish its optimisation");
      seeds.push(...seeded.map((x) => x.profile));
    }
    for (let r = 1; r <= runs; r += 1) {
      const sessions = [];
      const record = { run: r, arms: [] };
      try {
        // Boot every arm on its lane (the pinning is read when Chromium
        // starts), in an order rotated too: the first arm booted once came
        // out ~1.5 % ahead of the others (2026-10-22 A/A).
        sessions.length = arms.length;
        record.arms = new Array(arms.length);
        gates.clear();
        arrive = barrier(arms.length, (num(values, "gate-sec", { min: 1 }) + 60) * 1000);
        const runStart = Date.now();
        for (const a of bootOrder(r, arms.length)) {
          const lane = laneOf(a, r, lanes.length);
          process.env.SPARK_CHROME_CPUS = lanes[lane];
          const bootStart = Date.now();
          sessions[a] = await openSession({ base: servers[a].base, server: servers[a], query: o.query, iso: path.resolve(values.iso), routes: { [STATE_ROUTE]: path.resolve(values.state) }, seedProfile: seeds[a] ?? null });
          sessions[a].seedOf = a;
          record.arms[a] = { arm: a, lane, cpus: lanes[lane], bootRank: bootOrder(r, arms.length).indexOf(a), boot: { startMs: bootStart - runStart, ms: Date.now() - bootStart }, url: sessions[a].url, served: servers[a].identity, core: sessions[a].core };
        }
        // The windows together.
        const results = await Promise.allSettled(sessions.map((s) => measure(s, o)));
        results.forEach((res, a) => { if (res.status === "fulfilled") record.arms[a].cold = res.value; else record.arms[a].error = String(res.reason?.message ?? res.reason).slice(0, 300); });
      } finally {
        for (const s of sessions) await s?.close().catch(() => {});
      }
      for (const x of record.arms) if (x.cold) x.cold.instructionsPerGuestCycle = instructionsPerGuestCycle(x.cold);
      if (values["aot-seed"]) {
        record.arms.forEach((x, a) => { x.regionGate = gates.get(sessions[a]) ?? null; });
        const counts = record.arms.map((x) => x.regionGate?.installed);
        record.regionCountsEqual = counts.every((c) => Number.isInteger(c) && c === counts[0]);
        console.log(`[race-multi] run ${r} regions installed per arm: ${counts.join(" / ")}${record.regionCountsEqual ? "" : " (NOT EQUAL)"}; layoutRefused ${record.arms.map((x) => x.regionGate?.layoutRefused ?? "-").join(" / ")}; heapPatched ${record.arms.map((x) => x.regionGate?.heapPatched ?? "-").join(" / ")}; boot rank ${record.arms.map((x) => x.bootRank).join(" / ")}; quiescent ${record.arms.map((x) => (x.regionGate?.quiescent ? `${x.regionGate.ms} ms` : x.regionGate?.why ?? "?")).join(" / ")}`);
      }
      console.log(`[race-multi] run ${r}: ${record.arms.map((x) => `arm${x.arm}@lane${x.lane} ${x.error ?? `${x.cold.speed} %${x.cold.instructionsPerGuestCycle ? ` ${round(x.cold.instructionsPerGuestCycle, 3)} insn/guest cycle` : ""}${x.cold.overloaded ? " OVERLOADED" : ""}`}`).join(" | ")}`);
      writeFileSync(path.join(outDir, `run${r}.json`), JSON.stringify(record, null, 1) + "\n");
      records.push(record);
    }
  } finally {
    for (const dir of seeds) rmSync(dir, { recursive: true, force: true });
    for (const s of servers) await s.stop().catch(() => {});
    for (const release of releases) release();
  }
  const good = records.filter((r) => r.arms.every((x) => x.cold && !x.cold.overloaded));
  const full = good.length === records.length;
  const effects = full ? armEffects(good.map((r) => r.arms.map((x) => x.cold.speed)), good.map((r) => r.arms.map((x) => x.lane))) : null;
  // The same analysis on host instructions per guest cycle (lower is better).
  const ipg = good.map((r) => r.arms.map((x) => x.cold.instructionsPerGuestCycle));
  const counterEffects = full && values.counters && ipg.every((row) => row.every((v) => v > 0)) ? armEffects(ipg, good.map((r) => r.arms.map((x) => x.lane))) : null;
  const summary = {
    probe: "race-multi", at: new Date().toISOString(), query: o.query, warmupSec: o.warmup, secs: o.secs, maxLoad: o.maxLoad,
    arms, lanes, runs: records.length, validRuns: good.length,
    // A lane estimate needs every run (the Latin square incomplete otherwise).
    // --aot-seed: installed regions per run and arm, and whether every run had them equal.
    regionCounts: values["aot-seed"] ? records.map((r) => r.arms.map((x) => x.regionGate?.installed ?? null)) : null,
    regionCountsEqual: values["aot-seed"] ? records.every((r) => r.regionCountsEqual) : null,
    effects, counterEffects, withheld: full ? null : `${records.length - good.length} run(s) with a failed or overloaded arm: the Latin square is incomplete`
  };
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  if (effects) for (const e of effects.arms) console.log(`[race-multi] arm ${e.arm} vs arm 0: median ${e.median} % (sd ${e.sd}, per run ${e.perRun.join(" ")}), lane-corrected ${e.laneCorrected} %`);
  if (counterEffects) for (const e of counterEffects.arms) console.log(`[race-multi] arm ${e.arm} vs arm 0, host instructions per guest cycle: median ${e.median} % (sd ${e.sd}, per run ${e.perRun.join(" ")}), lane-corrected ${e.laneCorrected} %`);
  console.log(`[race-multi] lanes vs lane 0: ${effects ? effects.lanes.join(" / ") : "-"} %, residual sd ${effects?.residualSd ?? "-"} % -> ${outDir}`);
  process.exitCode = full ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
