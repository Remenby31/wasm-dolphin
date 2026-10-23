#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The CI bench's reading of one job (.github/workflows/bench.yml), A/A or A/B:
//
//   node harness/remote/bench-aa.mjs <race-perf out dir> <machine.json> > bench.md
//
// race-perf alternates which side goes first (odd runs baseline first: AB,
// even runs BA). Kept pairs:
//   - not the first AB+BA block (runs 1-2): the job's first Chrome sessions
//     read low on every runner (CI pilot, 2026-10-23); dropping the block
//     keeps both orders equal;
//   - both sides on the same CPU model, and the pinned thread of each a
//     DedicatedWorker at least 80 % busy (else another thread was pinned);
//   - with aot=1 (region stats read: race-perf --region-sample), both sides
//     with regions installed (a side without any does not measure regions);
//   - then as many AB as BA pairs (the latest extra ones of the larger
//     order are set aside), so a drift does not favour one side.
// Per kept pair: lr = 100·ln(candidate / baseline) (symmetric; ≈ % for small
// changes). Reported:
//   armSigmaPct  σ of the speeds of each arm over its mean (the noise of one
//                run; the effect of an A/B is not in it), runSigmaPct the
//                larger of the two;
//   change       median lr with a bootstrap 95 % CI of the median, and the
//                verdict: faster / slower when the CI excludes 0, else none;
//   lrSigmaPct   σ of lr; pairsFor2Pct the pairs a 2 % change needs at 2 σ
//                (4·σ²/d²);
//   drift        mean speed of the first and the last third of the pairs.
// Writes bench.json next to the summary; prints Markdown for the job summary.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { mean, median, round, stdev } from "../lib/stats.mjs";

const goodPin = (p) => !p || (p.thread === "DedicatedWorker" && !(p.busyPct < 80));
const order = (run) => (run % 2 === 1 ? "AB" : "BA"); // race-perf's sideOrder: odd runs baseline first

// Median of `lrs` with a bootstrap 95 % CI (deterministic resampling) and
// the verdict. Shared with bench-report.mjs (pairs pooled per model).
export function logRatioChange(lrs, { resamples = 2000, seed = 0x9e3779b9 } = {}) {
  const n = lrs.length;
  if (!n) return { pairs: 0, medianPct: null, ci95Pct: null, verdict: "no pairs" };
  let x = seed >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const meds = [];
  for (let b = 0; b < resamples; b += 1) meds.push(median(Array.from({ length: n }, () => lrs[Math.floor(rnd() * n)])));
  meds.sort((a, c) => a - c);
  const lo = meds[Math.floor(0.025 * resamples)], hi = meds[Math.ceil(0.975 * resamples) - 1];
  const verdict = n < 4 ? "too few pairs" : lo > 0 ? "candidate faster" : hi < 0 ? "candidate slower" : "no change detected";
  return { pairs: n, medianPct: round(median(lrs), 2), ci95Pct: [round(lo, 2), round(hi, 2)], verdict };
}

export function benchAA(runs, machine = {}) {
  const all = runs
    .map((r) => ({ run: r.run, a: r.baseline?.cold?.speed, b: r.candidate?.cold?.speed, pins: [r.baseline?.cold?.pinned, r.candidate?.cold?.pinned], models: [r.baseline?.cold?.cpuModel, r.candidate?.cold?.cpuModel],
      // Regions installed and their share of guest cycles (outside idle), when read.
      regions: [r.baseline?.cold, r.candidate?.cold].map((c) => (c?.p4Raw ? { installed: c.p4Raw.diagnostics?.regionsInstalled ?? null, cycleShare: c.p4?.regionCycleShare ?? null } : null)) }))
    .filter((p) => Number.isFinite(p.a) && Number.isFinite(p.b) && p.a > 0 && p.b > 0);
  const first = Math.min(...all.map((p) => p.run));
  const sameModel = (p) => !p.models[0] || !p.models[1] || p.models[0] === p.models[1];
  const why = (p) => p.run <= first + 1 ? "warm-up block (runs 1-2)"
    : !sameModel(p) ? `CPU model changed: ${p.models.join(" / ")}`
    : !p.pins.every(goodPin) ? `pinned ${p.pins.map((x) => `${x?.thread ?? "?"} ${x?.busyPct ?? "?"} %`).join(" / ")}`
    : p.regions.some((x) => x && x.installed === 0) ? `no region installed (${p.regions.map((x) => x?.installed ?? "?").join(" / ")})`
    : null;
  const setAside = all.filter((p) => why(p)).map((p) => ({ run: p.run, why: why(p) }));
  let pairs = all.filter((p) => !why(p));
  // As many AB as BA: the latest extra pairs of the larger order go.
  for (;;) {
    const ab = pairs.filter((p) => order(p.run) === "AB"), ba = pairs.filter((p) => order(p.run) === "BA");
    if (ab.length === ba.length) break;
    const extra = (ab.length > ba.length ? ab : ba).at(-1);
    setAside.push({ run: extra.run, why: `order balance (${ab.length} AB, ${ba.length} BA)` });
    pairs = pairs.filter((p) => p !== extra);
  }
  const lrs = pairs.map((p) => 100 * Math.log(p.b / p.a));
  const armSigma = (k) => { const v = pairs.map((p) => p[k]); const m = mean(v); return m ? round((stdev(v) / m) * 100, 2) : null; };
  const armSigmaPct = { baseline: armSigma("a"), candidate: armSigma("b") };
  const finite = [armSigmaPct.baseline, armSigmaPct.candidate].filter(Number.isFinite);
  const lrSigma = stdev(lrs);
  const third = Math.max(1, Math.floor(pairs.length / 3));
  return {
    cpuModel: machine.cpuModel ?? null, runner: machine.runner ?? null, arch: machine.arch ?? null, pmu: machine.pmu ?? null,
    pairs: pairs.length,
    meanSpeed: { baseline: round(mean(pairs.map((p) => p.a)), 2), candidate: round(mean(pairs.map((p) => p.b)), 2) },
    armSigmaPct,
    runSigmaPct: finite.length ? Math.max(...finite) : null,
    change: logRatioChange(lrs),
    // With region stats: per arm, the median regions installed and region cycle share.
    regions: pairs.some((p) => p.regions.some(Boolean)) ? Object.fromEntries(["baseline", "candidate"].map((arm, i) => [arm, {
      installed: median(pairs.map((p) => p.regions[i]?.installed).filter(Number.isFinite)),
      cycleShare: round(median(pairs.map((p) => p.regions[i]?.cycleShare).filter(Number.isFinite)), 4)
    }])) : null,
    lrSigmaPct: round(lrSigma, 2),
    pairsFor2Pct: lrSigma == null ? null : Math.max(1, Math.ceil((4 * lrSigma * lrSigma) / 4)),
    drift: { firstThird: round(mean(pairs.slice(0, third).flatMap((p) => [p.a, p.b])), 2), lastThird: round(mean(pairs.slice(-third).flatMap((p) => [p.a, p.b])), 2) },
    // Each kept pair with its model and lr: the per-model report pools them.
    perPair: pairs.map((p, i) => ({ run: p.run, order: order(p.run), model: p.models[1] ?? p.models[0] ?? machine.cpuModel ?? null, lrPct: round(lrs[i], 3), speeds: [p.a, p.b] })),
    setAside: setAside.sort((x, y) => x.run - y.run),
    pinnedThreads: [...new Set(all.flatMap((p) => p.pins.map((x) => x?.thread)).filter(Boolean))]
  };
}

export function benchMarkdown(b) {
  const c = b.change;
  return [
    `### ${b.runner ?? "?"} (${b.arch ?? "?"}): ${b.cpuModel ?? "unknown CPU"}`,
    "",
    "| pairs | mean speed A / B | σ per run A / B | change: median ln(B/A), 95 % CI | verdict | σ of ln(B/A) | pairs for a 2 % change | drift | PMU |",
    "|---|---|---|---|---|---|---|---|---|",
    `| ${b.pairs} | ${b.meanSpeed.baseline} / ${b.meanSpeed.candidate} % | ${b.armSigmaPct.baseline} / ${b.armSigmaPct.candidate} % | ${c.medianPct} % [${c.ci95Pct?.join(", ") ?? "?"}] | ${c.verdict} | ${b.lrSigmaPct} % | ${b.pairsFor2Pct ?? "?"} | ${b.drift.firstThird} → ${b.drift.lastThird} % | ${b.pmu ?? "?"} |`,
    "",
    ...(b.regions ? [`Regions (median per arm): A ${b.regions.baseline.installed} installed, ${b.regions.baseline.cycleShare} of guest cycles; B ${b.regions.candidate.installed} installed, ${b.regions.candidate.cycleShare}`] : []),
    `Per kept pair (100·ln(B/A)): ${b.perPair.map((p) => `${p.lrPct} (${p.order})`).join(", ")}`,
    `Set aside: ${b.setAside.map((x) => `run ${x.run} (${x.why})`).join(", ") || "none"}`,
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
