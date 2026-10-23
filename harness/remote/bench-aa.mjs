#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The CI bench's A/A reading (.github/workflows/bench.yml), one job:
//
//   node harness/remote/bench-aa.mjs <race-perf out dir> <machine.json> > bench.md
//
// Both sides served the same tree, in ABBA order (race-perf alternates which
// side goes first). Per run: the emulated speed of each side; per pair: the
// ratio candidate / baseline - 1. Reports the CPU model (lscpu) with:
//   runSigmaPct  σ of one run's speed relative to the mean, both sides pooled
//                (the s of research/deep-x64-ci-bench.md §3.3);
//   pairSigmaPct σ of the pair ratios, and their mean (≈ 0 for an A/A);
//   drift        the first and the last third of the runs (slow host drift);
//   pairsFor2Pct pairs needed to resolve a 2 % change at 2 σ: 8·s²/d².
// Writes bench.json next to the summary; prints Markdown for the job summary.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { mean, median, round, stdev } from "../lib/stats.mjs";

export function benchAA(runs, machine = {}) {
  const pairs = runs
    .map((r) => ({ run: r.run, a: r.baseline?.cold?.speed, b: r.candidate?.cold?.speed, cpu: r.candidate?.cold?.counters ?? null, pinned: r.candidate?.cold?.pinned ?? null }))
    .filter((p) => Number.isFinite(p.a) && Number.isFinite(p.b) && p.a > 0);
  const speeds = pairs.flatMap((p) => [p.a, p.b]);
  const m = mean(speeds);
  const ratios = pairs.map((p) => (p.b / p.a - 1) * 100);
  const third = Math.max(1, Math.floor(pairs.length / 3));
  const s = m ? (stdev(speeds) / m) * 100 : null;
  return {
    cpuModel: machine.cpuModel ?? null, runner: machine.runner ?? null, arch: machine.arch ?? null, pmu: machine.pmu ?? null,
    pairs: pairs.length,
    meanSpeed: round(m, 2),
    runSigmaPct: round(s, 2),
    pairMeanPct: round(mean(ratios), 2),
    pairMedianPct: round(median(ratios), 2),
    pairSigmaPct: round(stdev(ratios), 2),
    perPairPct: ratios.map((x) => round(x, 2)),
    drift: { firstThird: round(mean(pairs.slice(0, third).flatMap((p) => [p.a, p.b])), 2), lastThird: round(mean(pairs.slice(-third).flatMap((p) => [p.a, p.b])), 2) },
    pairsFor2Pct: s == null ? null : Math.max(1, Math.ceil((8 * s * s) / 4)),
    pinnedThreads: [...new Set(pairs.map((p) => p.pinned?.thread).filter(Boolean))]
  };
}

export function benchMarkdown(b) {
  return [
    `### A/A ${b.runner ?? "?"} (${b.arch ?? "?"}): ${b.cpuModel ?? "unknown CPU"}`,
    "",
    `| pairs | mean speed | σ per run | pair ratio mean / median / σ | drift (first → last third) | pairs for a 2 % change | PMU |`,
    `|---|---|---|---|---|---|---|`,
    `| ${b.pairs} | ${b.meanSpeed} % | ${b.runSigmaPct} % | ${b.pairMeanPct} / ${b.pairMedianPct} / ${b.pairSigmaPct} % | ${b.drift.firstThird} → ${b.drift.lastThird} % | ${b.pairsFor2Pct ?? "?"} | ${b.pmu ?? "?"} |`,
    "",
    `Per pair (candidate / baseline - 1, %): ${b.perPairPct.join(", ")}`,
    ""
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, machineFile] = process.argv.slice(2);
  if (!dir) throw new Error("usage: bench-aa.mjs <race-perf out dir> [machine.json]");
  const runs = readdirSync(dir).filter((f) => /^run\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"))).sort((x, y) => x.run - y.run);
  const machine = machineFile ? JSON.parse(readFileSync(machineFile, "utf8")) : {};
  const b = benchAA(runs, machine);
  writeFileSync(path.join(dir, "bench.json"), JSON.stringify({ ...b, machine }, null, 1) + "\n");
  process.stdout.write(benchMarkdown(b));
}
