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
//     [--max-load L] [--lock <dir/.perf-lock> …] [--out dir]
//
// - Each arm is a tree served as is (race-perf's sides), on its own port
//   (port + arm index), its Chromium pinned through HARNESS_CHROME_PATH's
//   SPARK_CHROME_CPUS (harness/remote/chrome-pinned.sh).
// - Every session boots first; the warmups and windows then start together
//   (race-perf's measure(), unchanged: no page call in the window).
// - --runs a multiple of the arms, so each arm visits each lane equally.
// - --max-load: the machine runs N emulators at once; the limit is the
//   machine's (default N × a quarter of the cores).
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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

const STATE_ROUTE = "**/__harness_state.sav";

// Lane of arm `arm` in run `run` (1-based runs): a cyclic Latin square.
export const laneOf = (arm, run, lanes) => (arm + run - 1) % lanes;

const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

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
      lock: { type: "string", multiple: true, default: [] }, "lock-wait": { type: "string", default: "14400" }, out: { type: "string" }
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
  const servers = [];
  const records = [];
  try {
    for (let a = 0; a < arms.length; a += 1) servers.push(await ensureServer({ port: port + a, root: arms[a] }));
    for (let r = 1; r <= runs; r += 1) {
      const sessions = [];
      const record = { run: r, arms: [] };
      try {
        // Boot every arm on its lane (the pinning is read when Chromium starts).
        for (let a = 0; a < arms.length; a += 1) {
          const lane = laneOf(a, r, lanes.length);
          process.env.SPARK_CHROME_CPUS = lanes[lane];
          const s = await openSession({ base: servers[a].base, server: servers[a], query: o.query, iso: path.resolve(values.iso), routes: { [STATE_ROUTE]: path.resolve(values.state) } });
          sessions.push(s);
          record.arms.push({ arm: a, lane, cpus: lanes[lane], url: s.url, served: servers[a].identity, core: s.core });
        }
        // The windows together.
        const results = await Promise.allSettled(sessions.map((s) => measure(s, o)));
        results.forEach((res, a) => { if (res.status === "fulfilled") record.arms[a].cold = res.value; else record.arms[a].error = String(res.reason?.message ?? res.reason).slice(0, 300); });
      } finally {
        for (const s of sessions) await s.close().catch(() => {});
      }
      console.log(`[race-multi] run ${r}: ${record.arms.map((x) => `arm${x.arm}@lane${x.lane} ${x.error ?? `${x.cold.speed} %${x.cold.overloaded ? " OVERLOADED" : ""}`}`).join(" | ")}`);
      writeFileSync(path.join(outDir, `run${r}.json`), JSON.stringify(record, null, 1) + "\n");
      records.push(record);
    }
  } finally {
    for (const s of servers) await s.stop().catch(() => {});
    for (const release of releases) release();
  }
  const good = records.filter((r) => r.arms.every((x) => x.cold && !x.cold.overloaded));
  const full = good.length === records.length;
  const effects = full ? armEffects(good.map((r) => r.arms.map((x) => x.cold.speed)), good.map((r) => r.arms.map((x) => x.lane))) : null;
  const summary = {
    probe: "race-multi", at: new Date().toISOString(), query: o.query, warmupSec: o.warmup, secs: o.secs, maxLoad: o.maxLoad,
    arms, lanes, runs: records.length, validRuns: good.length,
    // A lane estimate needs every run (the Latin square incomplete otherwise).
    effects, withheld: full ? null : `${records.length - good.length} run(s) with a failed or overloaded arm: the Latin square is incomplete`
  };
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  if (effects) for (const e of effects.arms) console.log(`[race-multi] arm ${e.arm} vs arm 0: median ${e.median} % (sd ${e.sd}, per run ${e.perRun.join(" ")}), lane-corrected ${e.laneCorrected} %`);
  console.log(`[race-multi] lanes vs lane 0: ${effects ? effects.lanes.join(" / ") : "-"} %, residual sd ${effects?.residualSd ?? "-"} % -> ${outDir}`);
  process.exitCode = full ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
