// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Matrix spec → ordered list of runs, URL building, and per-cell summaries.
import { cellChecks, runChecks } from "./correctness.mjs";
import { describe } from "./stats.mjs";
import { classify } from "./verdict.mjs";

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
  pc: "ppcPc",
  audioUnderruns: "causalTelemetry.audio.underrunCount"
});

export const SUMMARY_FIELDS = Object.freeze([
  "speed", "speedP5", "speedMin", "vis", "pres", "frameP50", "frameP95", "frameP99", "frameMax",
  "hitchesPerMin", "audioUnderrunsPerMin", "audioPeak", "errorCount", "cpuTotal", "cpuRenderer", "cpuGpu", "loadAvg"
]);

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

export { summarizeRun } from "./metrics.mjs";

export function runFlags(record) {
  const flags = [];
  const checks = record.checks ?? runChecks(record);
  for (const [k, c] of Object.entries(checks)) if (c.status === "fail") flags.push(`fail:${k}`);
  if (record.summary?.presentFreezes?.length) flags.push("present-freeze");
  if (record.overloaded) flags.push("overloaded");
  return flags;
}

// Group per-run records by (game, config): correctness checks (what the gate
// judges), performance medians ± stdev and IQR across runs (a report), and
// the §1 classification (a report).
export function summarizeMatrix(results, { games = [] } = {}) {
  const cells = new Map();
  for (const r of results) {
    const key = `${r.game}\u0000${r.config}`;
    if (!cells.has(key)) cells.set(key, { game: r.game, config: r.config, url: r.url, runs: [] });
    cells.get(key).runs.push(r);
  }
  const byGame = new Map(games.map((g) => [g.id, g]));
  return [...cells.values()].map((cell) => {
    const metrics = {};
    for (const f of SUMMARY_FIELDS) metrics[f] = describe(cell.runs.map((r) => r.summary?.[f]));
    const checks = cellChecks(cell.runs);
    return {
      game: cell.game,
      config: cell.config,
      url: cell.url,
      runs: cell.runs.length,
      overloadedRuns: cell.runs.filter((r) => r.overloaded).length,
      checks,
      classification: classify({ runs: cell.runs, checks, game: byGame.get(cell.game) ?? {} }),
      flags: [...new Set(cell.runs.flatMap(runFlags))],
      metrics
    };
  });
}

export function matrixMarkdown(cells, meta = {}) {
  const fmt = (d, digits = 1) => {
    if (d?.median == null) return "–";
    const r = (v) => Math.round(v * 10 ** digits) / 10 ** digits;
    return d.n > 1 ? `${r(d.median)} ±${r(d.stdev)}` : `${r(d.median)}`;
  };
  const mark = (c) => ({ pass: "ok", fail: "FAIL", unjudged: "?" })[c?.status] ?? "?";
  const lines = [];
  if (meta.title) lines.push(`# ${meta.title}`, "");
  for (const line of meta.env ?? []) lines.push(line);
  if (meta.env?.length) lines.push("");
  lines.push("## Correctness (what the gate judges)", "", "| Game | Config | Runs | Crash | Errors | Core freeze | Render |", "|---|---|---|---|---|---|---|");
  for (const c of cells) lines.push(`| ${c.game} | ${c.config} | ${c.runs} | ${mark(c.checks.crash)} | ${mark(c.checks.errors)} | ${mark(c.checks.coreFreeze)} | ${mark(c.checks.render)} |`);
  lines.push("", "## Performance (report)", "", "| Game | Config | Class | Speed % (p5) | Unique/s | Frame p95/p99 ms | Hitches/min | Underruns/min | CPU % | Load | Flags |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of cells) {
    const m = c.metrics;
    lines.push(`| ${c.game} | ${c.config} | ${c.classification.verdict} | ${fmt(m.speed)} (${fmt(m.speedP5)}) | ${fmt(m.vis)} | ${fmt(m.frameP95)} / ${fmt(m.frameP99)} | ${fmt(m.hitchesPerMin)} | ${fmt(m.audioUnderrunsPerMin)} | ${fmt(m.cpuTotal, 0)} | ${fmt(m.loadAvg, 0)} | ${c.flags.join(", ") || "–"} |`);
  }
  lines.push("", "Medians ± sample stdev across runs. Unjudged checks and classes:", "");
  for (const c of cells) {
    const notes = [
      ...Object.entries(c.checks).filter(([, x]) => x.status !== "pass").map(([k, x]) => `${k} ${x.status}: ${typeof x.detail === "string" ? x.detail : JSON.stringify(x.detail)}`),
      ...c.classification.reasons
    ];
    if (notes.length) lines.push(`- **${c.game} / ${c.config}**: ${notes.join("; ")}`);
  }
  return lines.join("\n");
}

// Exact captures come from the core (guest XFB, software renderer) or, for
// video=wgpu, from the worker's GPU readback of the present tagged with the
// VI output (source "wgpu-present"). A hardware renderer that answers with
// the guest XFB would be judged on a picture it does not show: rejected.
// OGL has no exact capture.
export function captureSupported(query) {
  const video = new URLSearchParams(query).get("video") ?? "software";
  if (video === "ogl") return { ok: false, why: "video=ogl: no exact capture (OGL does not report VI outputs)" };
  return { ok: true };
}

export function captureSourceOk(query, source) {
  const video = new URLSearchParams(query).get("video") ?? "software";
  if (video === "software" || video === "null") return source === "guest-xfb";
  if (video === "wgpu") return source === "wgpu-present";
  return false;
}

// Across renderers, the same VI output is only the same emulated frame with
// a single CPU thread: in dual core, a slower GPU thread makes each frame
// consume more emulated time, so poses differ at equal VI index.
export function forCrossRenderer(query) {
  const p = new URLSearchParams(query);
  p.set("cpu", "single");
  return p.toString();
}

// Extra A/B items to confirm flagged cells, numbered after the last planned
// run so every pair stays distinct.
export function confirmationItems(plan, flagged, { rounds = 2 } = {}) {
  const wanted = new Set(flagged.map((r) => `${r.game}\u0000${r.config}`));
  const lastRun = Math.max(...plan.map((p) => p.run));
  const extra = [];
  for (let k = 1; k <= rounds; k += 1) {
    for (const item of plan.filter((p) => p.run === 1 && wanted.has(`${p.game.id}\u0000${p.config.id}`))) {
      const run = lastRun + k;
      extra.push({ ...item, run, label: `${item.game.id}__${item.config.id}__r${run}` });
    }
  }
  return extra;
}
