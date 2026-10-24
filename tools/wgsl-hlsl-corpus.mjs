#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Offline check of Chrome's Windows shader path on a WGSL corpus
// (harness/probes/wgsl-corpus.mjs): every module goes through Tint -> HLSL
// and then DXC, with the Tint and DXC of the Dawn branch Chrome ships
// (built from dawn chromium/<build>, DAWN_USE_BUILT_DXC). Reports the
// modules that fail either step and the time each step takes, per module:
//   parse   tint -f none           (process start + WGSL parse)
//   hlsl    tint -f hlsl           (minus parse: the HLSL translation)
//   dxc     tint -f hlsl --dxc     (minus hlsl: the DXC compile)
// Median of --reps runs each. Times are this machine's (an Apple core), not a
// Windows PC's, and DXC runs with Tint's validation flags, not necessarily
// the exact flags Dawn passes: an order of magnitude, not a promise.
//
//   node tools/wgsl-hlsl-corpus.mjs --tint path/tint --dxc path/libdxcompiler.dylib
//     [--sm 6.0] [--reps 3] [--out report.json] corpus-dir...
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tint: { type: "string" }, dxc: { type: "string" }, sm: { type: "string", default: "6.0" },
    reps: { type: "string", default: "3" }, out: { type: "string" },
  },
});
if (!values.tint || !values.dxc || !positionals.length) throw new Error("usage: wgsl-hlsl-corpus.mjs --tint tint --dxc libdxcompiler.dylib corpus-dir...");
const reps = Number(values.reps);

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}
export function percentile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * q) - 1)] : null;
}

function timed(args) {
  const ms = [];
  let last = null;
  for (let i = 0; i < reps; i += 1) {
    const t0 = process.hrtime.bigint();
    last = spawnSync(values.tint, args, { encoding: "utf8" });
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return { ms: median(ms), ok: last.status === 0, err: last.status === 0 ? null : (last.stderr || last.stdout || "").split("\n").slice(0, 4).join("\n") };
}

const modules = [];
const seen = new Set(); // one module per hash across the corpus dirs
for (const dir of positionals) {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".wgsl")).sort()) {
    if (seen.has(f)) continue;
    seen.add(f);
    const file = path.join(dir, f);
    const stage = Number(f.match(/\.s(\d)\.wgsl$/)?.[1] ?? -1);
    const parse = timed(["-f", "none", file]);
    const hlsl = timed(["-f", "hlsl", "--hlsl-shader-model", values.sm, file, "-o", "/dev/null"]);
    const dxc = hlsl.ok ? timed(["-f", "hlsl", "--hlsl-shader-model", values.sm, "--dxc", values.dxc, file, "-o", "/dev/null"]) : { ms: null, ok: false, err: "not run (HLSL failed)" };
    modules.push({
      corpus: path.basename(dir), file: f, stage,
      hlslOk: hlsl.ok, dxcOk: dxc.ok,
      hlslMs: hlsl.ok && parse.ms != null ? Math.max(0, hlsl.ms - parse.ms) : null,
      dxcMs: dxc.ok ? Math.max(0, dxc.ms - hlsl.ms) : null,
      error: hlsl.err ?? dxc.err,
    });
  }
}
const summarize = (rows, key) => {
  const xs = rows.map((r) => r[key]).filter((x) => x != null);
  return { n: xs.length, p50: median(xs), p95: percentile(xs, 0.95), max: xs.length ? Math.max(...xs) : null, total: xs.reduce((a, b) => a + b, 0) };
};
const report = {
  tool: "wgsl-hlsl-corpus", sm: values.sm, reps, modules: modules.length,
  hlslFailures: modules.filter((m) => !m.hlslOk).length,
  dxcFailures: modules.filter((m) => m.hlslOk && !m.dxcOk).length,
  hlslMs: summarize(modules, "hlslMs"), dxcMs: summarize(modules, "dxcMs"),
  byStage: Object.fromEntries([...new Set(modules.map((m) => m.stage))].map((s) => [s, { hlslMs: summarize(modules.filter((m) => m.stage === s), "hlslMs"), dxcMs: summarize(modules.filter((m) => m.stage === s), "dxcMs") }])),
  failures: modules.filter((m) => m.error).map(({ corpus, file, error }) => ({ corpus, file, error })),
  rows: modules,
};
if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 1));
const r1 = (x) => (x == null ? "–" : x.toFixed(1));
console.log(`[wgsl-hlsl] ${report.modules} modules, SM ${values.sm}: HLSL failures ${report.hlslFailures}, DXC failures ${report.dxcFailures}`);
console.log(`[wgsl-hlsl] HLSL ms p50 ${r1(report.hlslMs.p50)} p95 ${r1(report.hlslMs.p95)} max ${r1(report.hlslMs.max)}; DXC ms p50 ${r1(report.dxcMs.p50)} p95 ${r1(report.dxcMs.p95)} max ${r1(report.dxcMs.max)} total ${r1(report.dxcMs.total)}`);
for (const f of report.failures.slice(0, 10)) console.log(`  ${f.corpus}/${f.file}: ${f.error.split("\n")[0]}`);
