#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The CI bench's report over all jobs of a run (.github/workflows/bench.yml),
// stratified by CPU model (judge, 2026-10-23):
//
//   node harness/remote/bench-report.mjs <bench.json>… > report.md
//
// Each job's bench.json (bench-aa.mjs) lists its kept pairs with their model;
// grouped by workload (machine.workload) and model.
// Per model: the jobs, their σ per run (speeds are only comparable inside a
// job: another host, another level), and the pair ratios pooled across jobs
// (relative, so poolable): mean, σ, and the pairs a 2 % change needs at 2 σ
// (4·σ²/d² on the pair ratios: their σ already holds both runs' noise).
// A model is in the decision set when its median σ per run is under
// DECISION_MAX_RUN_SIGMA_PCT; otherwise it is recorded but not counted.
// Writes report.json in the current directory.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { mean, median, round, stdev } from "../lib/stats.mjs";

export const DECISION_MAX_RUN_SIGMA_PCT = 3;

export function benchReport(benches) {
  const byModel = new Map();
  for (const b of benches) {
    for (const p of b.perPair ?? []) {
      const model = p.model ?? b.cpuModel ?? "unknown";
      const workload = b.machine?.workload ?? null;
      const key = `${workload ?? ""}|${model}`;
      const m = byModel.get(key) ?? { model, workload, arch: b.arch ?? null, jobs: new Map(), ratios: [] };
      m.ratios.push(p.ratioPct);
      const job = `${b.machine?.runner ?? b.runner ?? "?"}#${b.machine?.job ?? "?"}`;
      m.jobs.set(job, b.runSigmaPct);
      byModel.set(key, m);
    }
  }
  const models = [...byModel.values()].map((m) => {
    const runSigma = [...m.jobs.values()].filter(Number.isFinite);
    const pairSigma = stdev(m.ratios);
    const medianRunSigma = median(runSigma);
    return {
      model: m.model, workload: m.workload, arch: m.arch, jobs: [...m.jobs.keys()], runSigmaPctByJob: runSigma, medianRunSigmaPct: round(medianRunSigma, 2),
      pairs: m.ratios.length, pairMeanPct: round(mean(m.ratios), 2), pairSigmaPct: round(pairSigma, 2),
      pairsFor2Pct: pairSigma == null ? null : Math.max(1, Math.ceil((4 * pairSigma * pairSigma) / 4)),
      inDecisionSet: medianRunSigma != null && medianRunSigma < DECISION_MAX_RUN_SIGMA_PCT
    };
  }).sort((a, b) => b.pairs - a.pairs);
  return { decisionMaxRunSigmaPct: DECISION_MAX_RUN_SIGMA_PCT, models };
}

export function reportMarkdown(r) {
  return [
    "## Bench, per workload and CPU model (pairs only count within one model)",
    "",
    "| workload | model | arch | jobs | σ per run (median; per job) | pairs | pair ratio mean / σ | pairs for a 2 % change | decision set |",
    "|---|---|---|---|---|---|---|---|---|",
    ...r.models.map((m) => `| ${m.workload ?? "?"} | ${m.model} | ${m.arch ?? "?"} | ${m.jobs.length} | ${m.medianRunSigmaPct} % (${m.runSigmaPctByJob.join(", ")}) | ${m.pairs} | ${m.pairMeanPct} / ${m.pairSigmaPct} % | ${m.pairsFor2Pct ?? "?"} | ${m.inDecisionSet ? "yes" : `no (σ per run ≥ ${r.decisionMaxRunSigmaPct} %)`} |`),
    ""
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error("usage: bench-report.mjs <bench.json>…");
  const r = benchReport(files.map((f) => JSON.parse(readFileSync(f, "utf8"))));
  writeFileSync("report.json", JSON.stringify(r, null, 1) + "\n");
  process.stdout.write(reportMarkdown(r));
}
