#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Where each launch puts the emulated RAM, and what the tab costs in memory:
// two trees (each served with its own core), launched alternately N times on
// one scene. Per launch, after --warmup: the RAM and L1 bases from the core
// (validationReadJitRegionStats → layout, patch 0078's layout words) and the
// phys_footprint of the profile's Chrome processes (footprint(1), macOS; what
// the system charges, compressed pages included). Patch 0106 (static RAM
// views) should give one RAM base per core, whatever the launch, and ~64 MiB
// less footprint (no MEMFS copy of the RAM).
//
//   node harness/probes/layout-footprint.mjs --iso disc.iso --state scene.sav --port N
//     --baseline <dir> --candidate <dir> [--runs 4] [--warmup 25] [--query "..."]
//     [--lock-wait 14400] [--out dir]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, loadHarnessState, REPO_ROOT, workerRequest } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { openSession } from "../lib/session.mjs";
import { median } from "../lib/stats.mjs";

const STATE_ROUTE = "**/__harness_state.sav";

// phys_footprint of every Chrome process of this profile (MB), and of the
// largest renderer (the tab and its workers).
export function footprintOf(profileDir) {
  const ps = execFileSync("ps", ["-A", "-o", "pid=,rss=,command="], { encoding: "utf8", maxBuffer: 32 << 20 });
  const pids = [];
  let rendererPid = null, rendererRss = -1;
  for (const line of ps.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || !m[3].includes(profileDir)) continue;
    pids.push(m[1]);
    if (m[3].includes("--type=renderer") && Number(m[2]) > rendererRss) { rendererRss = Number(m[2]); rendererPid = m[1]; }
  }
  if (!pids.length) return { error: "no Chrome process for this profile" };
  const fp = execFileSync("footprint", [...pids.flatMap((p) => ["-p", p]), "-f", "bytes"], { encoding: "utf8", maxBuffer: 32 << 20 });
  const per = [...fp.matchAll(/^.*\[(\d+)\]: \S+\s+Footprint: (\d+) B/gm)].map((m) => ({ pid: m[1], bytes: Number(m[2]) }));
  const mb = (b) => Math.round(b / 1048576);
  return { totalMB: mb(per.reduce((n, x) => n + x.bytes, 0)), rendererMB: mb(per.find((x) => x.pid === rendererPid)?.bytes ?? 0) };
}

async function launch(side, o) {
  const server = await ensureServer({ port: o.port, root: side.root });
  try {
    const session = await openSession({ base: server.base, server, query: o.query, iso: o.iso, routes: { [STATE_ROUTE]: o.state } });
    try {
      const loaded = await loadHarnessState(session.page, session.url);
      if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
      await session.page.waitForTimeout(o.warmup * 1000);
      const stats = await workerRequest(session.page, "validationReadJitRegionStats", {}, 10000);
      const layout = stats?.layout ?? null;
      return { core: session.core?.sha256 ?? session.core ?? null, layout, footprint: footprintOf(session.profileDir) };
    } finally {
      await session.close();
    }
  } finally {
    await server.stop();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      iso: { type: "string" }, state: { type: "string" }, port: { type: "string", default: process.env.HARNESS_PORT },
      baseline: { type: "string" }, candidate: { type: "string" }, runs: { type: "string", default: "4" },
      warmup: { type: "string", default: "25" }, query: { type: "string" }, "lock-wait": { type: "string", default: "14400" }, out: { type: "string" }
    }
  });
  if (!values.iso || !values.state || !values.port || !values.baseline || !values.candidate) {
    throw new Error("usage: layout-footprint.mjs --iso disc.iso --state scene.sav --port N --baseline <dir> --candidate <dir> [--runs 4] [--warmup 25]");
  }
  const o = {
    iso: path.resolve(values.iso), state: path.resolve(values.state), port: Number(values.port), runs: Number(values.runs),
    warmup: Number(values.warmup), query: `${values.query ?? PRESETS.wgpu}&metrics=1`
  };
  const sides = { baseline: { root: path.resolve(values.baseline) }, candidate: { root: path.resolve(values.candidate) } };
  const release = await acquirePerfLock({ name: `harness layout-footprint (${REPO_ROOT})`, waitSec: Number(values["lock-wait"]), log: (m) => console.log(`[layout-footprint] ${m}`) });
  const runs = [];
  try {
    for (let run = 1; run <= o.runs; run += 1) {
      for (const name of run % 2 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
        const r = await launch(sides[name], o).catch((e) => ({ error: String(e?.message || e).slice(0, 300) }));
        runs.push({ run, side: name, ...r });
        console.log(`[layout-footprint] run ${run} ${name}: ${r.error ?? `ram 0x${(r.layout?.ramBase ?? 0).toString(16)} l1 0x${(r.layout?.l1Base ?? 0).toString(16)} footprint ${r.footprint?.totalMB} MB (renderer ${r.footprint?.rendererMB} MB)`}`);
      }
    }
  } finally {
    release();
  }
  const side = (name) => {
    const ok = runs.filter((r) => r.side === name && !r.error);
    return {
      launches: ok.length, ramBases: [...new Set(ok.map((r) => r.layout?.ramBase))], l1Bases: [...new Set(ok.map((r) => r.layout?.l1Base))],
      footprintMB: median(ok.map((r) => r.footprint?.totalMB).filter(Number.isFinite)), rendererMB: median(ok.map((r) => r.footprint?.rendererMB).filter(Number.isFinite))
    };
  };
  const summary = { probe: "layout-footprint", at: new Date().toISOString(), query: o.query, warmupSec: o.warmup, sides: { baseline: sides.baseline.root, candidate: sides.candidate.root }, baseline: side("baseline"), candidate: side("candidate"), runs };
  if (values.out) { mkdirSync(values.out, { recursive: true }); writeFileSync(path.join(values.out, "summary.json"), JSON.stringify(summary, null, 1) + "\n"); }
  console.log(`[layout-footprint] baseline: ${JSON.stringify(summary.baseline)}\n[layout-footprint] candidate: ${JSON.stringify(summary.candidate)}`);
}

await main();
