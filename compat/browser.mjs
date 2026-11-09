#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// The hwtests built for the GameCube (compat/homebrew/build.sh) on the whole
// emulated machine, in headless Chrome through the harness: each disc boots
// on the interpreter and on the JIT (software renderer at full resolution),
// and the report rows its XFB shows (compat/lib/report-rows.mjs) are read
// from exact captures until the program says it is done.
//
//   node compat/browser.mjs --dir <build out> --port N [--only gxtest_tev,...]
//        [--timeout 240] [--budget 900] [--json f] [--md f]
// --timeout bounds one run, --budget all of them (later runs are "skipped").
//
// Report only: exit 0 unless no disc could be read at all (exit 2).

import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ensureServer } from "../harness/lib/browser.mjs";
import { captureInSession, openSession } from "../harness/lib/session.mjs";
import { decodeReport } from "./lib/report-rows.mjs";

// efbaccess=1: gxtest pokes and peeks the EFB (EFBAccessEnable, a per-disc
// setting off by default; off, every peek reads 0).
const BASE = "core=upstream&video=software&presenter=2d&cpu=dual&speed=0&fastsw=0&efbaccess=1&efbcopyram=1&metrics=1";
export const CONFIGS = {
  interp: `${BASE}&wasmjit=0`,
  jit: `${BASE}&wasmjit=1&jitwarmup=0&forcejit=1`
};

// Cheapest first, so the budget cuts the long GX sweeps (millions of
// subtests: their partial counts are still reported). gxtest checks the GPU:
// the JIT config only (the shipped engine); the CPU tests run on both tiers.
const ORDER = ["efbpoke", "battest", "cardtest", "vitest", "cputest_", "gxtest_bitfield", "gxtest_clipping", "gxtest_rasterization",
  "gxtest_tev", "gxtest_lighting", "gxtest_intensity", "gxtest_copyfilter"];
const rank = (name) => { const i = ORDER.findIndex((p) => name.startsWith(p)); return i < 0 ? ORDER.length : i; };
export const configsFor = (program, configs) => (program.startsWith("gxtest_") ? configs.filter((c) => c === "jit") : configs);

async function runOne(server, iso, query, timeoutSec) {
  const t0 = Date.now();
  const session = await openSession({ base: server.base, server, query, iso });
  let last = null, captures = 0, error = null;
  try {
    while ((Date.now() - t0) / 1000 < timeoutSec) {
      const capture = await captureInSession(session, { ahead: 120, timeoutMs: 60000 });
      if (capture.error) { error = capture.error; break; }
      captures++;
      const report = decodeReport(capture);
      if (report) last = { ...report, viOutput: capture.index };
      if (report?.done) break;
    }
  } finally {
    await session.close();
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const status = last?.done ? "done" : error ? "error" : last ? "timeout" : "unreadable";
  return { status, seconds, captures, error, report: last };
}

export function markdown(results) {
  const lines = ["### hwtests on the whole machine (GameCube builds, software renderer)", "",
    "| program | config | status | tests | subtests passed | first failing lines | s |", "|---|---|---|---:|---:|---|---:|"];
  for (const r of results) {
    const rep = r.report;
    const fails = rep?.failures.map((f) => `${f.test}:${f.line}`).join(" ") ?? "";
    lines.push(`| ${r.program} | ${r.config} | ${r.status}${r.error ? ` (${r.error.slice(0, 60)})` : ""} | ` +
      `${rep ? `${rep.testsPassed}/${rep.tests}` : "–"} | ${rep ? `${rep.subtestsPassed}/${rep.subtests}` : "–"} | ${fails} | ${r.seconds} |`);
  }
  lines.push("", "Failing lines are `test:line` in the hwtests source at the pinned commit (first 10).");
  return lines.join("\n") + "\n";
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" }, port: { type: "string" }, only: { type: "string" },
      timeout: { type: "string", default: "240" }, budget: { type: "string", default: "900" }, json: { type: "string" }, md: { type: "string" },
      configs: { type: "string", default: "interp,jit" }
    }
  });
  if (!values.dir || !values.port) throw new Error("usage: compat/browser.mjs --dir <out> --port N");
  const only = values.only ? new Set(values.only.split(",")) : null;
  const isos = readdirSync(values.dir).filter((f) => f.endsWith(".iso")).map((f) => f.slice(0, -4))
    .filter((n) => !only || only.has(n)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const server = await ensureServer({ port: Number(values.port) });
  const results = [];
  const deadline = Date.now() + Number(values.budget) * 1000;
  for (const program of isos) {
    for (const config of configsFor(program, values.configs.split(","))) {
      const left = (deadline - Date.now()) / 1000;
      if (left < 30) { results.push({ program, config, status: "skipped", seconds: 0, captures: 0, error: null, report: null }); continue; }
      const r = await runOne(server, path.resolve(values.dir, `${program}.iso`), CONFIGS[config], Math.min(Number(values.timeout), left));
      results.push({ program, config, ...r });
      const rep = r.report;
      console.error(`[compat] ${program} ${config}: ${r.status} ${rep ? `${rep.testsPassed}/${rep.tests} tests, ${rep.subtestsPassed}/${rep.subtests} subtests` : ""} (${r.seconds} s)`);
    }
  }
  const md = markdown(results);
  process.stdout.write(md);
  if (values.json) writeFileSync(values.json, JSON.stringify(results, null, 1));
  if (values.md) writeFileSync(values.md, md);
  process.exit(results.some((r) => r.report) ? 0 : 2);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) await main();
