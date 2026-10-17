// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Matrix spec → ordered list of runs, URL building, and per-cell summaries.
import { describe, finite, mean, median, percentile } from "./stats.mjs";

const minOf = (v) => (finite(v).length ? Math.min(...finite(v)) : null);
const maxOf = (v) => (finite(v).length ? Math.max(...finite(v)) : null);

// Named URL configs. "rec" is the repo's recommended playable preset as
// quoted in REPORT.md; the others are the variants the evaluation compared.
export const PRESETS = Object.freeze({
  rec: "core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1&pacing=tick&fastsw=1",
  "rec-nojit": "core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=0&oc=1&pacing=tick&fastsw=1",
  wgpu: "core=upstream&video=wgpu&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1",
  "wgpu-nojit": "core=upstream&video=wgpu&presenter=webgpu&cpu=dual&speed=1&wasmjit=0&oc=1",
  "sw-fast-jit": "core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=120&forcejit=1&fastsw=1",
  "sw-interp": "core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=0&fastsw=1",
  unlimited: "core=upstream&video=null&speed=unlimited&wasmjit=0&jitwarmup=700"
});

// Fields sampled from window.__lastFrameInfo (key in output → key in frame info).
export const FRAME_FIELDS = Object.freeze({
  frame: "frame",
  speed: "gameSpeed",
  pres: "presentationFps",
  vis: "visualChangeFps",
  core: "coreFps",
  jitc: "ppcWasmBlockCompileCount",
  jitr: "ppcWasmBlockRunCount",
  long: "presentationLongFrameCount",
  p95: "presentationP95IntervalMs",
  max: "presentationMaxIntervalMs",
  pc: "ppcPc"
});

export const SUMMARY_FIELDS = Object.freeze(["speed", "pres", "vis", "core", "p95", "max", "cpuTotal", "cpuRenderer", "cpuGpu"]);

export function resolveQuery(config) {
  const raw = config.preset ? PRESETS[config.preset] : config.query;
  if (raw == null) throw new Error(`config ${config.id}: unknown preset ${config.preset}`);
  const params = new URLSearchParams(raw);
  for (const [k, v] of Object.entries(config.set ?? {})) params.set(k, String(v));
  if (!params.has("metrics")) params.set("metrics", "1");
  return params.toString();
}

export function buildUrl(baseUrl, config) {
  const url = new URL(baseUrl);
  url.search = resolveQuery(config);
  return url.toString();
}

export function expandEnv(value, env = process.env) {
  return String(value).replace(/\$\{(\w+)\}/g, (_, name) => {
    if (env[name] == null || env[name] === "") throw new Error(`environment variable ${name} is not set`);
    return env[name];
  });
}

// Runs are interleaved (run 1 of every cell, then run 2, ...) so slow drift in
// machine load spreads across cells instead of biasing the last one.
export function expandMatrix(spec, { env = process.env } = {}) {
  const runs = Number(spec.runs ?? 3);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("runs must be a positive integer");
  if (!spec.games?.length || !spec.configs?.length) throw new Error("matrix needs games and configs");
  const ci = Boolean(env.CI);
  const out = [];
  for (let run = 1; run <= runs; run += 1) {
    for (const game of spec.games) {
      if (game.localOnly && ci) throw new Error(`game ${game.id} is local-only and must never run in CI`);
      for (const config of spec.configs) {
        out.push({
          run,
          game: { ...game, iso: expandEnv(game.iso, env) },
          config,
          query: resolveQuery(config),
          label: `${game.id}__${config.id}__r${run}`
        });
      }
    }
  }
  return out;
}

// Reduce one run's 1 Hz samples to scalar metrics.
export function summarizeRun(samples, cpuSamples = []) {
  const pick = (k) => samples.map((s) => s[k]);
  const last = samples.at(-1) ?? {};
  const first = samples[0] ?? {};
  return {
    speed: mean(pick("speed")),
    speedMin: minOf(pick("speed")),
    pres: mean(pick("pres")),
    vis: mean(pick("vis")),
    core: mean(pick("core")),
    p95: mean(pick("p95")),
    max: maxOf(pick("max")),
    frameAdvance: Number.isFinite(last.frame) && Number.isFinite(first.frame) ? last.frame - first.frame : null,
    jitc: last.jitc ?? null,
    cpuTotal: median(cpuSamples.map((c) => c.total)),
    cpuRenderer: median(cpuSamples.map((c) => c.rendererMax)),
    cpuGpu: median(cpuSamples.map((c) => c.gpu)),
    cpuTotalP90: percentile(cpuSamples.map((c) => c.total), 90),
    // presentationFps stayed 0 while the core advanced. Usually a frozen
    // picture; check the capture, the counter also misses some wgpu XFB paths.
    zeroPresents: samples.length > 0 && pick("pres").every((p) => !p) && (last.frame ?? 0) > (first.frame ?? 0)
  };
}

export function runFlags(record) {
  const flags = [];
  if (record.crashed || record.errors?.length) flags.push("crash");
  if (record.summary?.zeroPresents) flags.push("zero-presents");
  return flags;
}

// Group per-run summaries by (game, config) → median/stdev across runs.
export function summarizeMatrix(results) {
  const cells = new Map();
  for (const r of results) {
    const key = `${r.game}\u0000${r.config}`;
    if (!cells.has(key)) cells.set(key, { game: r.game, config: r.config, url: r.url, runs: [] });
    cells.get(key).runs.push(r);
  }
  return [...cells.values()].map((cell) => {
    const metrics = {};
    for (const f of SUMMARY_FIELDS) metrics[f] = describe(cell.runs.map((r) => r.summary?.[f]));
    return {
      game: cell.game,
      config: cell.config,
      url: cell.url,
      runs: cell.runs.length,
      failedRuns: cell.runs.filter((r) => runFlags(r).length).length,
      flags: [...new Set(cell.runs.flatMap(runFlags))],
      metrics
    };
  });
}

export function matrixMarkdown(cells, meta = {}) {
  const fmt = (d) => (d?.median == null ? "–" : d.n > 1 ? `${d.median} ±${d.stdev}` : `${d.median}`);
  const lines = [];
  if (meta.title) lines.push(`# ${meta.title}`, "");
  if (meta.machine) lines.push(`Machine: ${meta.machine}`, "");
  lines.push("| Game | Config | Runs | Speed % | Pres/s | Unique/s | p95 ms | CPU % (total / renderer / gpu) | Failed |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const c of cells) {
    const m = c.metrics;
    lines.push(`| ${c.game} | ${c.config} | ${c.runs} | ${fmt(m.speed)} | ${fmt(m.pres)} | ${fmt(m.vis)} | ${fmt(m.p95)} | ${fmt(m.cpuTotal)} / ${fmt(m.cpuRenderer)} / ${fmt(m.cpuGpu)} | ${c.failedRuns}${c.flags?.length ? ` (${c.flags.join(", ")})` : ""} |`);
  }
  lines.push("", "Values: median ± sample stdev across runs of the per-run mean (1 sample/s).");
  return lines.join("\n");
}
