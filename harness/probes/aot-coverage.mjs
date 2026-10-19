#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Coverage of ahead-of-time discovery (docs/aot-plan.md): which share of the
// guest code a scene runs was already in the plan.
//
//   record: boot a disc headless, optionally load a savestate and hold a key,
//           then sample the emulated PC for --secs seconds.
//     node harness/probes/aot-coverage.mjs record --iso disc.iso --port N --out samples.json
//       [--state scene.sav] [--warmup 25] [--secs 20] [--hold KeyX] [--query "..."]
//   report: coverage of recorded samples by the static plan, then by the plan
//           built with a profile made of other recordings (other scenes).
//     node harness/probes/aot-coverage.mjs report --iso disc.iso --samples a.json [--profile b.json ...]
//
// Sampling uses the harness's guest-PC sampler (src/harness-pc-sampler.js) at
// its densest. It sees the PC where the core stores it, at block dispatch: the
// unit that counts is the distinct PC (an entry into compiled code). Sample
// shares are reported too but are dominated by hot and idle loops. PCs outside
// main RAM (real-mode exception vectors) are only counted (`outside`).
import { openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { blocksFromPcSamples } from "../../src/aot-profile.js";
import { planDisc } from "../../src/aot-recomp.js";

const isMain = import.meta.url === `file://${process.argv[1]}`;
const [mode, ...rest] = isMain ? process.argv.slice(2) : [];
const values = isMain ? parseArgs({
  args: rest,
  options: {
    iso: { type: "string" },
    port: { type: "string", default: process.env.HARNESS_PORT },
    out: { type: "string" },
    state: { type: "string" },
    warmup: { type: "string", default: "25" },
    secs: { type: "string", default: "20" },
    hold: { type: "string", default: "" },
    query: { type: "string" },
    samples: { type: "string" },
    profile: { type: "string", multiple: true, default: [] }
  }
}).values : {};

async function record() {
  const { ensureServer, pageCall, readCoreProgress, workerRequest, REPO_ROOT } = await import("../lib/browser.mjs");
  const { PRESETS } = await import("../lib/matrix.mjs");
  const { openSession } = await import("../lib/session.mjs");
  if (!values.iso || !values.port || !values.out) throw new Error("record: --iso, --port and --out are required");
  const iso = path.resolve(values.iso), out = path.resolve(values.out);
  const homebrew = iso.startsWith(path.join(REPO_ROOT, "harness", "homebrew"));
  if (!homebrew && (out + path.sep).startsWith(REPO_ROOT + path.sep)) throw new Error("samples of a non-homebrew disc stay outside the repository");
  if (!homebrew && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
  const query = values.query ?? PRESETS.wgpu;
  const server = await ensureServer({ port: Number(values.port) });
  const routes = values.state ? { "**/__harness_state.sav": path.resolve(values.state) } : {};
  const session = await openSession({ base: server.base, query, iso, routes });
  try {
    const { page } = session;
    for (let end = Date.now() + 60000; ((await readCoreProgress(page))?.frame ?? 0) === 0;) {
      if (Date.now() > end) throw new Error("core never reached Running");
      await page.waitForTimeout(100);
    }
    if (values.state) {
      let loaded;
      for (let tries = 0; tries < 60; tries++) {
        loaded = await pageCall(page, "__loadStateFile", new URL("__harness_state.sav", session.url).href, 120000);
        if (loaded?.loaded || loaded?.beforeState !== "Starting") break;
        await page.waitForTimeout(1000);
      }
      if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
    }
    if (values.hold) await page.keyboard.down(values.hold);
    await page.waitForTimeout(Number(values.warmup) * 1000);
    const start = await workerRequest(page, "validationPcSampler", { action: "start", periodMs: 0.001 }, 10000);
    if (start?.error) throw new Error(`pc sampler: ${start.error}`);
    await page.waitForTimeout(Number(values.secs) * 1000);
    const result = await workerRequest(page, "validationPcSampler", { action: "stop" }, 30000);
    if (values.hold) await page.keyboard.up(values.hold).catch(() => {});
    const record = { url: session.url, state: values.state ? path.basename(values.state) : null, warmupSec: Number(values.warmup), secs: Number(values.secs),
      samples: result.n, outside: result.outside, ms: result.ms, pcs: result.counts };
    writeFileSync(out, JSON.stringify(record) + "\n");
    console.log(`[aot-coverage] ${result.n} samples, ${result.counts.length} distinct PCs, ${result.outside} outside main RAM -> ${out}`);
  } finally {
    await session.close();
    await server.stop();
  }
}

// Share of recorded PCs ([pc, samples]) that fall in a block of the plan or
// one of its dynamic ranges.
export function coverage(plan, pcs) {
  const ranges = [];
  for (const m of plan.modules) m.blocks.start.forEach((s, i) => ranges.push([s, m.blocks.end[i]]));
  for (const d of plan.dynamic) ranges.push([d.start, d.end]);
  ranges.sort((a, b) => a[0] - b[0]);
  const hit = (pc) => {
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (pc < ranges[m][0]) hi = m - 1; else if (pc >= ranges[m][1]) lo = m + 1; else return true;
    }
    return false;
  };
  let d = 0, dc = 0, t = 0, tc = 0;
  const missed = [];
  for (const [pc, n] of pcs) {
    d++; t += n;
    if (hit(pc)) { dc++; tc += n; } else missed.push(pc);
  }
  const pct = (a, b) => (b ? Math.round((100000 * a) / b) / 1000 : null);
  return { distinct: d, distinctPct: pct(dc, d), samplesPct: pct(tc, t), missed: missed.length };
}

async function report() {
  if (!values.iso || !values.samples) throw new Error("report: --iso and --samples are required");
  const fd = openSync(path.resolve(values.iso), "r");
  const read = (o, n) => { const b = new Uint8Array(n); return b.subarray(0, readSync(fd, b, 0, n, o)); };
  const samples = JSON.parse(readFileSync(values.samples, "utf8"));
  const result = { samples: path.basename(values.samples), outside: samples.outside ?? null, static: coverage(await planDisc(read), samples.pcs) };
  if (values.profile.length) {
    const pcs = values.profile.flatMap((f) => JSON.parse(readFileSync(f, "utf8")).pcs.map(([pc]) => pc));
    const plan = await planDisc(read, { profile: { sessions: values.profile.length, blocks: blocksFromPcSamples(pcs) } });
    result.profileFrom = values.profile.map((f) => path.basename(f));
    result.withProfile = coverage(plan, samples.pcs);
  }
  console.log(JSON.stringify(result));
}

if (isMain) {
  if (mode === "record") await record();
  else if (mode === "report") await report();
  else throw new Error("usage: aot-coverage.mjs record|report ...");
}
