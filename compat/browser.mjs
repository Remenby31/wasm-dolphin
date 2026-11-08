#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// The hwtests built for the GameCube (compat/homebrew/build.sh) on the whole
// emulated machine, in headless Chrome through the harness: each disc boots
// on the interpreter and on the JIT (software renderer at full resolution),
// and the report rows its XFB shows (compat/lib/report-rows.mjs) are read
// from exact captures until the program says it is done.
//
//   node compat/browser.mjs --dir <build out> --port N [--only cputest_cr,...]
//        [--timeout 120] [--budget 900] [--json f] [--md f]
//
// Every program × config must finish and match compat/machine-expected.json
// exactly (test and subtest counts, the first failures with their detail);
// the JIT config must have compiled and run JIT blocks, the interpreter
// config none. Exit 1 on any difference, 2 when nothing could be read.
// --timeout bounds one run, --budget all of them (later runs are "skipped",
// which is a difference too).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ensureServer, readFrameInfo } from "../harness/lib/browser.mjs";
import { captureInSession, openSession } from "../harness/lib/session.mjs";
import { decodeReport } from "./lib/report-rows.mjs";

// efbaccess=1: the per-disc EFBAccessEnable a test that pokes or peeks the
// EFB would get (off by default).
const BASE = "core=upstream&video=software&presenter=2d&cpu=dual&speed=0&fastsw=0&efbaccess=1&metrics=1";
export const CONFIGS = {
  interp: `${BASE}&wasmjit=0`,
  // jitwarmup=0: the JIT from the first frame. The warmup counts XFB frames;
  // with the default the short programs finished on the interpreter (the
  // gate caught it: 0 JIT blocks).
  jit: `${BASE}&wasmjit=1&jitwarmup=0&forcejit=1`
};

async function runOne(server, iso, query, timeoutSec) {
  const t0 = Date.now();
  const session = await openSession({ base: server.base, server, query, iso });
  let last = null, error = null, info = null;
  try {
    while ((Date.now() - t0) / 1000 < timeoutSec) {
      const capture = await captureInSession(session, { ahead: 120, timeoutMs: 60000 });
      if (capture.error) { error = capture.error; break; }
      const report = decodeReport(capture);
      if (report) last = report;
      if (report?.done) break;
    }
    info = await readFrameInfo(session.page).catch(() => null);
  } finally {
    await session.close();
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const status = last?.done ? "done" : error ? "error" : last ? "timeout" : "unreadable";
  return { status, seconds, error, report: last, jitBlocksCompiled: info?.jitc ?? null, jitBlocksRun: info?.jitr ?? null };
}

// The part of a report the expectations pin.
export const summarize = (rep) => ({
  tests: rep.tests, testsPassed: rep.testsPassed, subtests: rep.subtests, subtestsPassed: rep.subtestsPassed,
  failures: rep.failures.map((f) => [f.test, f.line, f.msgHash])
});

/** Differences between the results and the expectations, one line each. */
export function judgeMachine(results, expected) {
  const problems = [];
  const seen = new Set();
  for (const r of results) {
    const key = `${r.program} ${r.config}`;
    seen.add(key);
    const want = expected[r.program]?.[r.config];
    if (!want) { problems.push(`${key}: not in compat/machine-expected.json`); continue; }
    if (r.status !== "done") { problems.push(`${key}: ${r.status}${r.error ? ` (${r.error})` : ""}`); continue; }
    const got = summarize(r.report);
    if (JSON.stringify(got) !== JSON.stringify(want))
      problems.push(`${key}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    if (r.config === "jit" && !(r.jitBlocksCompiled > 0 && r.jitBlocksRun > 0))
      problems.push(`${key}: the JIT compiled ${r.jitBlocksCompiled} and ran ${r.jitBlocksRun} blocks`);
    if (r.config === "interp" && r.jitBlocksCompiled !== 0)
      problems.push(`${key}: the interpreter config compiled ${r.jitBlocksCompiled} JIT blocks`);
  }
  for (const [program, configs] of Object.entries(expected))
    for (const config of Object.keys(configs))
      if (!seen.has(`${program} ${config}`)) problems.push(`${program} ${config}: expected but not run`);
  return problems;
}

export function markdown(results, problems) {
  const lines = ["### hwtests on the whole machine (GameCube builds, software renderer)", "",
    "| program | config | status | tests | subtests passed | first failing lines | JIT blocks | s |",
    "|---|---|---|---:|---:|---|---:|---:|"];
  for (const r of results) {
    const rep = r.report;
    const fails = rep?.failures.map((f) => `${f.test}:${f.line}`).join(" ") ?? "";
    lines.push(`| ${r.program} | ${r.config} | ${r.status} | ${rep ? `${rep.testsPassed}/${rep.tests}` : "–"} | ` +
      `${rep ? `${rep.subtestsPassed}/${rep.subtests}` : "–"} | ${fails} | ${r.jitBlocksCompiled ?? "–"} | ${r.seconds} |`);
  }
  lines.push("", "Failing lines are `test:line` in the hwtests source at the pinned commit (first 10).", "");
  lines.push(problems.length ? `**${problems.length} difference(s) from compat/machine-expected.json:**` : "Matches compat/machine-expected.json.");
  for (const p of problems.slice(0, 40)) lines.push(`- ${p}`);
  return lines.join("\n") + "\n";
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" }, port: { type: "string" }, only: { type: "string" },
      timeout: { type: "string", default: "120" }, budget: { type: "string", default: "900" },
      json: { type: "string" }, md: { type: "string" }, configs: { type: "string", default: "interp,jit" }
    }
  });
  if (!values.dir || !values.port) throw new Error("usage: compat/browser.mjs --dir <out> --port N");
  const only = values.only ? new Set(values.only.split(",")) : null;
  const isos = readdirSync(values.dir).filter((f) => f.endsWith(".iso")).map((f) => f.slice(0, -4))
    .filter((n) => !only || only.has(n)).sort();
  let expected = JSON.parse(readFileSync(new URL("./machine-expected.json", import.meta.url), "utf8")).programs;
  if (only) expected = Object.fromEntries(Object.entries(expected).filter(([p]) => only.has(p)));
  const server = await ensureServer({ port: Number(values.port) });
  const results = [];
  const deadline = Date.now() + Number(values.budget) * 1000;
  for (const program of isos) {
    for (const config of values.configs.split(",")) {
      const left = (deadline - Date.now()) / 1000;
      if (left < 30) { results.push({ program, config, status: "skipped", seconds: 0, error: null, report: null }); continue; }
      const r = await runOne(server, path.resolve(values.dir, `${program}.iso`), CONFIGS[config], Math.min(Number(values.timeout), left));
      results.push({ program, config, ...r });
      const rep = r.report;
      console.error(`[compat] ${program} ${config}: ${r.status} ${rep ? `${rep.testsPassed}/${rep.tests} tests, ${rep.subtestsPassed}/${rep.subtests} subtests` : ""} (${r.seconds} s, JIT blocks ${r.jitBlocksCompiled})`);
    }
  }
  const problems = judgeMachine(results, expected);
  const md = markdown(results, problems);
  process.stdout.write(md);
  if (values.json) writeFileSync(values.json, JSON.stringify({ results, problems }, null, 1));
  if (values.md) writeFileSync(values.md, md);
  process.exit(!results.some((r) => r.report) ? 2 : problems.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) await main();
