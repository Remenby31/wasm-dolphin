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
  audioUnderruns: "causalTelemetry.audio.underrunCount",
  // Patch 0208: new XFBs on the canvas, per second (the worker's 500 ms
  // window) and since boot; null without frame tags (an older core).
  newFps: "newFramesPerSec",
  // new XFBs the core produced per second (0208; null with video=null: the
  // tag rides on the WebGPU present only)
  newProduced: "newFramesProducedPerSec",
  newShown: "newFramesShown"
});

// New frames shown per second between two readFrameInfo readings: the
// smoothness reference (a duplicate VI swap is not a new picture, unlike a
// present; visualChangeFps stays the diagnostic). null when either reading
// has no frame tags or a boot came between them.
export function newFramesRate(start, end) {
  const n = end?.newShown - start?.newShown;
  const secs = (end?.t - start?.t) / 1000;
  if (start?.newShown == null || end?.newShown == null || !(n >= 0) || !(secs > 0)) return null;
  return Math.round((n / secs) * 10) / 10;
}

export const SUMMARY_FIELDS = Object.freeze([
  "speed", "speedP5", "speedMin", "vis", "pres", "frameP50", "frameP95", "frameP99", "frameMax",
  "hitchesPerMin", "audioUnderrunsPerMin", "audioPeak", "errorCount", "cpuTotal", "cpuRenderer", "cpuGpu", "loadAvg"
]);

// Each KPI scene's native game frames per VI (judge, 2026-10-23): measured on
// a coupled reference (wgpu, emulated time tied to the rendering), never
// guessed. The product KPI's target is 95 % of the scene's native rate, so a
// scene the game renders at 30 frames/s is not held to 60.
export const SCENE_NATIVE_FRAMES_PER_VI = Object.freeze({
  "race-after.sav": { framesPerVi: 1.0, measured: "measures/headroom/20261022/headroom-wgpu-aot-vs-off: wgpu + aot=1 at 100 %, xfbCopiesPerVi 0.9992 (6 runs)" },
  "heavy-intro-13s.sav": { framesPerVi: 1.0, measured: "measures/headroom/20261023/heavy-headroom-wgpu-aot-vs-off: wgpu, xfbCopiesPerVi 1.00 at 60-62 % (coupled: per VI, not per second)" }
});
export const VI_PER_SECOND = 60;

// ?xfbdecode=0 under video=null (#299): the core no longer decodes the XFB,
// so nothing visual exists to read (game fps 0, no input-to-image latency,
// no unique frames, no displayed frames). A visual probe refuses it.
export function xfbDecodeOff(query) {
  const q = new URLSearchParams(PRESETS[query] ?? query ?? "");
  return q.get("video") === "null" && q.get("xfbdecode") === "0";
}
export function visualProbeCheck(queries, uses) {
  const off = queries.filter(Boolean).filter(xfbDecodeOff);
  const used = Object.entries(uses).filter(([, on]) => on).map(([name]) => name);
  return off.length && used.length ? `${used.join(", ")} read the decoded XFB, which video=null&xfbdecode=0 turns off (${off[0]})` : null;
}

// Measurement protocol pinned per KPI scene (judge, 2026-10-23). The heavy
// intro is a short phase: from this state, ~9 guest seconds of the heavy
// part, then the scene moves on. A 20 s window dilutes it (an ew20 read
// 100 % / headroom 1.16 / regionCycleShare 0.92 where 6 s read 57-62 % /
// 0.56), so its window, its warmup and its region stats are fixed: region
// stats on the same span as the window (regionStatsInWindow), not after it.
export const SCENE_PROTOCOLS = Object.freeze({
  "heavy-intro-13s.sav": {
    warmup: 1, emulatedWindow: 6, maxWindowSec: 8, regionStatsInWindow: true, hold: null,
    why: "heavy phase of ~9 guest s after this state: warmup 1, emulated window 6 (8 at most), region stats over the same span, no key held"
  }
});

// What a run's settings break of its scene's protocol: errors refuse the run,
// warnings are printed and recorded. window: the guest seconds of an
// emulated window, or the host seconds of a host-time one.
export function sceneProtocolCheck(state, { warmup, window, emulated, hold, regionSample, regionStatsInWindow }) {
  const p = SCENE_PROTOCOLS[state];
  if (!p) return { protocol: null, errors: [], warnings: [] };
  const errors = [], warnings = [];
  if (window > p.maxWindowSec) errors.push(`${state}: a ${window} s window leaves the heavy phase (at most ${p.maxWindowSec}; protocol: --emulated-window ${p.emulatedWindow})`);
  if (!emulated) warnings.push(`${state}: host-time window; the protocol is --emulated-window ${p.emulatedWindow} --emulated-warmup ${p.warmup}`);
  if (warmup > p.warmup * 2) warnings.push(`${state}: warmup ${warmup} s eats into the heavy phase (protocol ${p.warmup})`);
  if (p.hold === null && hold) warnings.push(`${state}: key ${hold} held; the protocol holds none (--hold "")`);
  if (regionSample != null && p.regionStatsInWindow && !regionStatsInWindow) warnings.push(`${state}: region stats after the window would read another phase`);
  return { protocol: p, errors, warnings };
}

// The useful-frames target of a scene (images per host second), or null
// when the scene has no measured reference.
export function gameFpsTarget(state, share = 0.95) {
  const ref = SCENE_NATIVE_FRAMES_PER_VI[state];
  return ref ? Math.round(share * VI_PER_SECOND * ref.framesPerVi * 10) / 10 : null;
}

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
          // A game's own `set` (e.g. a feature only it exercises) applies
          // to every config it runs under.
          query: resolveQuery(game.set ? { ...config, set: { ...config.set, ...game.set } } : config),
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
  lines.push("## Correctness (what the gate judges)", "", "| Game | Config | Runs | Crash | Errors | Core freeze | Render | Audio |", "|---|---|---|---|---|---|---|---|");
  for (const c of cells) lines.push(`| ${c.game} | ${c.config} | ${c.runs} | ${mark(c.checks.crash)} | ${mark(c.checks.errors)} | ${mark(c.checks.coreFreeze)} | ${mark(c.checks.render)} | ${mark(c.checks.audio)} |`);
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
// One emulated CPU thread repeats a run exactly only on a fixed clock: the
// console's real-time clock otherwise comes from the host, sets the time base
// at boot and formats the memory cards, so two boots of one disc part from the
// first frames (patch 0081, ?rtc=). 2001-09-09: any fixed value works.
export const HARNESS_RTC = 1000000000;
// One emulated CPU thread, as the page decides it (core-host.js
// requestedCpuThread): cpu=single, or cpu=auto with any renderer but OGL.
export function isSingleCore(query) {
  const p = new URLSearchParams(query);
  const cpu = p.get("cpu");
  return cpu === "single" || (cpu === "auto" && p.get("video") !== "ogl");
}
export function withDeterministicClock(query) {
  const p = new URLSearchParams(query);
  if (!isSingleCore(query) || p.has("rtc")) return query;
  p.set("rtc", String(HARNESS_RTC));
  return p.toString();
}
// The clock a run asked for and what the core reports, from
// validationReadCoreProgress: an error when a fixed clock was asked for and
// the core does not run on it (a missing export, a refused value, or a clock
// that is not the requested start plus emulated seconds).
export function clockCheck(query, progress) {
  const raw = new URLSearchParams(query).get("rtc");
  const wanted = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  if (wanted === null) return { fixed: false };
  const status = progress?.customRtc;
  if (!status?.applied) return { fixed: true, error: `rtc not applied: ${status?.why ?? "the worker does not report the clock"}` };
  if (!(progress.coreTicksPerSecond > 0) || progress.emulatedRtc == null) return { fixed: true, error: "rtc not verifiable: the core does not report its clock" };
  const expected = wanted + Math.floor(progress.coreTicks / progress.coreTicksPerSecond);
  // The two reads are not atomic: one second either way is the same clock.
  if (Math.abs(progress.emulatedRtc - expected) > 1) return { fixed: true, error: `rtc not followed: the core reads ${progress.emulatedRtc}, expected ${expected}` };
  return { fixed: true, rtc: wanted, emulatedRtc: progress.emulatedRtc };
}

export function forCrossRenderer(query) {
  const p = new URLSearchParams(query);
  p.set("cpu", "single");
  return p.toString();
}

// Extra A/B items to confirm flagged cells, and the reference config of the
// same games (render checks pair runs by index), numbered after the last
// planned run so every pair stays distinct.
export function confirmationItems(plan, flagged, { rounds = 2, reference = null } = {}) {
  const wanted = new Set(flagged.map((r) => `${r.game}\u0000${r.config}`));
  if (reference) for (const r of flagged) wanted.add(`${r.game}\u0000${reference}`);
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
