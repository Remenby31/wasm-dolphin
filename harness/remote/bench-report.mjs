#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The CI bench's report over all jobs of a run (.github/workflows/bench.yml),
// per workload and CPU model (judge, 2026-10-23):
//
//   node harness/remote/bench-report.mjs <bench.json>… > report.md
//
// Each job's bench.json (bench-aa.mjs) lists its kept pairs with their model
// and 100·ln(B/A); grouped by workload (machine.workload) and model. Per
// group: the jobs and their σ per run (per arm, the larger: an A/B effect is
// not noise; speeds are only comparable inside a job), and the pairs' lr
// pooled across jobs (relative, so poolable): median with a bootstrap 95 %
// CI and the verdict (bench-aa.mjs logRatioChange), σ, and the pairs a 2 %
// change needs. A model is in the decision set when its median σ per run is
// under DECISION_MAX_RUN_SIGMA_PCT; otherwise it is recorded, not counted.
// Writes report.json in the current directory.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { median, round, stdev } from "../lib/stats.mjs";
import { logRatioChange } from "./bench-aa.mjs";

export const DECISION_MAX_RUN_SIGMA_PCT = 3;

export function benchReport(benches) {
  const groups = new Map();
  for (const b of benches) {
    for (const p of b.perPair ?? []) {
      const model = p.model ?? b.cpuModel ?? "unknown";
      const workload = b.machine?.workload ?? null;
      const key = `${workload ?? ""}|${model}`;
      const g = groups.get(key) ?? { model, workload, arch: b.arch ?? null, jobs: new Map(), lrs: [] };
      g.lrs.push(p.lrPct);
      g.jobs.set(`${b.machine?.runner ?? b.runner ?? "?"}#${b.machine?.job ?? "?"}`, b.runSigmaPct);
      groups.set(key, g);
    }
  }
  const models = [...groups.values()].map((g) => {
    const runSigma = [...g.jobs.values()].filter(Number.isFinite);
    const medianRunSigma = median(runSigma);
    const lrSigma = stdev(g.lrs);
    return {
      model: g.model, workload: g.workload, arch: g.arch, jobs: [...g.jobs.keys()], runSigmaPctByJob: runSigma, medianRunSigmaPct: round(medianRunSigma, 2),
      change: logRatioChange(g.lrs), lrSigmaPct: round(lrSigma, 2),
      pairsFor2Pct: lrSigma == null ? null : Math.max(1, Math.ceil((4 * lrSigma * lrSigma) / 4)),
      inDecisionSet: medianRunSigma != null && medianRunSigma < DECISION_MAX_RUN_SIGMA_PCT
    };
  }).sort((a, b) => b.change.pairs - a.change.pairs);
  return { decisionMaxRunSigmaPct: DECISION_MAX_RUN_SIGMA_PCT, models };
}

export function reportMarkdown(r) {
  return [
    "## Bench, per workload and CPU model (pairs only count within one model)",
    "",
    "| workload | model | arch | jobs | σ per run (median; per job) | pairs | median ln(B/A), 95 % CI | verdict | pairs for a 2 % change | decision set |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...r.models.map((m) => `| ${m.workload ?? "?"} | ${m.model} | ${m.arch ?? "?"} | ${m.jobs.length} | ${m.medianRunSigmaPct} % (${m.runSigmaPctByJob.join(", ")}) | ${m.change.pairs} | ${m.change.medianPct} % [${m.change.ci95Pct?.join(", ") ?? "?"}] | ${m.change.verdict} | ${m.pairsFor2Pct ?? "?"} | ${m.inDecisionSet ? "yes" : `no (σ per run ≥ ${r.decisionMaxRunSigmaPct} %)`} |`),
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
