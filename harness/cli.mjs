// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// QA harness entry point. Usage: harness/run <command> [options]; see harness/README.md.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ensureServer, pageCall, readCoreProgress, readFrameInfo, REPO_ROOT } from "./lib/browser.mjs";
import { analyzeDifferential, INTERP_QUERY, JIT_QUERY } from "./lib/fuzz.mjs";
import { releaseAll, setPad } from "./lib/gamepad-mock.mjs";
import { compareFrames, diffImage, identical } from "./lib/image-diff.mjs";
import { decodePadRow, decodeRows, hex } from "./lib/markers.mjs";
import { captureSourceOk, captureSupported, confirmationItems, expandEnv, expandMatrix, forCrossRenderer, matrixMarkdown, PRESETS, resolveQuery, runFlags, summarizeMatrix, summarizeRun } from "./lib/matrix.mjs";
import { runChecks } from "./lib/correctness.mjs";
import { browserInfo, isOverloaded, waitForLoad } from "./lib/env.mjs";
import { correctnessGate, crossCommitGate, decide, findingsGate, gateMarkdown, mergeGates, perfReport, runsByCell } from "./lib/gate.mjs";
import { renderChecks, renderVsBaseline } from "./lib/render-check.mjs";
import { IDENTITY_FILE } from "./lib/server.mjs";
import { mergeTimeline } from "./lib/timeline.mjs";
import { decodePng } from "./lib/png.mjs";
import { attachAudio, captureInSession, grabFrame, monitorSnapshot, openSession, readTimeline, sample, savePng, waitSeconds } from "./lib/session.mjs";
import { runSteps, validateSteps } from "./lib/steps.mjs";
import { machineSnapshot } from "./lib/system.mjs";
import { claim, deletable, removeIfDeletable } from "./lib/ownership.mjs";

const HOMEBREW_OUT = path.join(REPO_ROOT, "harness", "homebrew", "out");
// Campaign ids are unique per process, not per second: two runs started in
// the same second must never share (and clean up) one directory.
const stamp = () => `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${process.pid}-${randomBytes(3).toString("hex")}`;

const COMMON = {
  port: { type: "string", default: process.env.HARNESS_PORT || "8082" },
  out: { type: "string" },
  headless: { type: "boolean", default: false },
  "keep-profiles": { type: "boolean", default: false }
};

function parse(argv, options) {
  return parseArgs({ args: argv, options: { ...COMMON, ...options }, allowPositionals: true });
}

const RESULTS = path.join(REPO_ROOT, "harness", "results");
const KEEP_RESULTS = Number(process.env.HARNESS_KEEP_RESULTS || 8);

// Disk is shared and tight: keep only the newest finished result
// directories of this checkout. A campaign that is still running (live owner
// pid) or that another checkout made is never touched.
function rotateResults(dir = RESULTS, keep = KEEP_RESULTS) {
  if (!existsSync(dir)) return [];
  const finished = readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((p) => statSync(p).isDirectory())
    .map((p) => ({ p, d: deletable(p, REPO_ROOT) }))
    .filter((e) => e.d.ok)
    .sort((a, b) => b.d.startedAt - a.d.startedAt);
  const removed = finished.slice(keep).map((e) => e.p);
  for (const p of removed) rmSync(p, { recursive: true, force: true });
  return removed;
}

function outDir(values, name, { private: isPrivate = false } = {}) {
  rotateResults();
  const base = values.out
    ? path.resolve(values.out)
    : isPrivate
      // Results that may contain commercial-game captures never land in the repo.
      ? path.resolve(process.env.HARNESS_PRIVATE_OUT || path.join(REPO_ROOT, "..", "measures", "harness"), `${name}-${stamp()}`)
      : path.join(REPO_ROOT, "harness", "results", `${name}-${stamp()}`);
  mkdirSync(path.dirname(base), { recursive: true });
  // mkdir of the final component is atomic: an existing directory (another
  // run's, or an --out reused by mistake) is refused, never shared.
  try {
    mkdirSync(base);
  } catch (e) {
    if (e.code === "EEXIST") throw new Error(`${base} already exists; results never go into an existing directory`);
    throw e;
  }
  // Released when this process exits; until then rotation and clean skip it.
  claim(base, REPO_ROOT, "results");
  return base;
}

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return file;
}

function loadSteps(file, relativeTo = process.cwd()) {
  if (!file) return null;
  return validateSteps(JSON.parse(readFileSync(path.resolve(relativeTo, file), "utf8")));
}

function configFromArg(arg) {
  return PRESETS[arg] ? { id: arg, preset: arg } : { id: "custom", query: arg };
}

// `tree`: a checkout root, or { root, patches } (patched in memory).
async function withServer(values, fn, tree = REPO_ROOT) {
  const { root, patches = [] } = typeof tree === "string" ? { root: tree } : tree;
  const server = await ensureServer({ port: Number(values.port), root, patches });
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------- measure
// One run: boot, play steps, warm up, then over the measured window drain
// the complete timeline, sample the counters the timeline lacks, and finish
// with the exact capture the render check uses.
async function measureOne(server, values, { iso, query, label, warmup, secs, shotEvery, dir, steps, game = {}, spec = {}, statePath = null }) {
  const loadGate = await waitForLoad({
    maxLoad: Number(spec.maxLoad),
    waitSec: Number(spec.loadWaitSec ?? 60),
    log: (m) => console.log(`[harness] ${label}: ${m}`)
  });
  const routes = statePath ? { "**/__harness_state.sav": statePath } : {};
  const session = await openSession({ base: server.base, query, iso, headed: !values.headless, keepProfile: values["keep-profiles"], routes });
  try {
    // Games that boot deterministically (no scripted inputs, no savestate)
    // are captured at VI output N from boot, before anything else runs.
    const bootCapture = !statePath && !steps ? await renderCapture(session, { game, spec, query, statePath, dir, label }) : null;
    if (steps) await runSteps(session.page, steps);
    const audio = game.audio === false ? { attached: false, reason: "disabled in spec" } : await attachAudio(session);
    await waitSeconds(session, warmup);
    const env = await browserInfo(session.page).catch((e) => ({ error: e.message }));
    // Errors are never reset: startup and warmup errors count like the
    // others. The measured window start is recorded to classify them.
    const measureStartedAt = await session.page.evaluate(() => performance.now()).catch(() => null);
    const chunks = [];
    const start = await readTimeline(session.page); // discards the warmup
    const { samples, cpu, shots } = await sample(session, {
      seconds: secs, shotEvery, shotPrefix: path.join(dir, label),
      // Drain often enough that no ring can overflow between two reads.
      everySecond: async (i) => { if (i % 10 === 9) chunks.push(await readTimeline(session.page)); }
    });
    chunks.push(await readTimeline(session.page));
    const monitor = await monitorSnapshot(session);
    const progress = await readCoreProgress(session.page);
    const timeline = mergeTimeline(chunks);
    const finalShot = savePng(await grabFrame(session.page), path.join(dir, `${label}.png`));
    const capture = bootCapture ?? (await renderCapture(session, { game, spec, query, statePath, dir, label }));
    const fatal = session.watch.fatal();
    const record = {
      label,
      url: session.url,
      iso: path.resolve(iso),
      served: server.identity,
      steps,
      warmupSec: warmup,
      sampleSec: secs,
      env,
      loadGate,
      machineBefore: session.machineBefore,
      machineAfter: machineSnapshot(),
      audio,
      monitor: monitor && { errors: monitor.errors, transport: monitor.transport, audio: monitor.audio, audioTelemetry: monitor.audioTelemetry },
      measureStartedAt,
      summary: summarizeRun({
        samples, cpu, timeline, windowEnd: chunks.at(-1)?.now ?? null,
        ticksPerSecond: progress?.coreTicksPerSecond,
        monitor: monitor && { ...monitor, audioAttached: Boolean(audio?.attached) }
      }),
      timelineStart: start?.error ? { error: start.error } : { now: start?.now },
      ticksPerSecond: progress?.coreTicksPerSecond ?? null,
      windowEnd: chunks.at(-1)?.now ?? null,
      crashed: fatal.length > 0,
      errors: fatal,
      overloaded: !loadGate.ok || isOverloaded(cpu, Number(spec.maxLoad)),
      audioRequired: game.audio === true,
      capture,
      finalShot,
      screenshots: [...shots, finalShot],
      events: session.watch.events.slice(0, 50),
      samples,
      cpu,
      timeline
    };
    writeJson(path.join(dir, `${label}.json`), record);
    return record;
  } finally {
    await session.close();
  }
}

// Render evidence: VI output `renderFrame` after loading the game's
// savestate, or after boot for games without steps (homebrews boot
// deterministically). Anything else cannot be judged, and says why.
async function renderCapture(session, { game, spec, query, statePath, dir, label }) {
  const supported = captureSupported(query);
  if (!supported.ok) return { error: supported.why };
  if (!statePath && game.steps) return { error: "scripted inputs and no savestate: no exact frame to compare" };
  if (statePath) {
    await waitRunning(session.page);
    const loaded = await pageCall(session.page, "__loadStateFile", new URL("__harness_state.sav", session.url).href, 120000);
    if (!loaded?.loaded) return { error: `savestate load failed: ${JSON.stringify(loaded)}` };
  }
  const index = Number(spec.renderFrame ?? (statePath ? 120 : 300));
  const c = await captureInSession(session, { index, fromLoad: Boolean(statePath) });
  if (c.error) return { error: c.error };
  if (!captureSourceOk(query, c.source)) return { error: `capture source ${c.source} is not what this renderer shows` };
  const file = savePng(c, path.join(dir, `${label}-capture.png`));
  return { file, index: c.index, fromLoad: c.fromLoad, ticks: c.ticks, source: c.source };
}

function brief(r) {
  const s = r.summary;
  const f = (v) => (v == null ? "–" : Math.round(v));
  const flags = runFlags(r);
  return `${r.label}: speed ${f(s.speed)}% (p5 ${f(s.speedP5)}, ${s.speedSource}) unique ${f(s.vis)}/s frame p95 ${s.frameP95 == null ? "–" : s.frameP95.toFixed(1)}ms errors ${s.errorCount} cpu ${f(s.cpuTotal)}% load ${f(s.loadAvg)}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
}

// Records keep only what the summary and the gate need; each run's file
// has the rest.
const slimRecord = (item, r) => ({
  game: item.game.id, config: item.config.id, run: item.run, label: r.label, url: r.url, served: r.served,
  summary: r.summary, crashed: r.crashed, errors: r.errors, overloaded: r.overloaded, capture: r.capture,
  audioRequired: item.game.audio === true
});

// `tree`: { root, patches, discs } — discs maps a game's iso path to the one
// this side uses (the selftest's mutant discs).
export async function runPlan(plan, { values, spec, dir, specDir, tree = { root: REPO_ROOT }, log = console.log }) {
  const records = [];
  for (const item of plan) {
    const server = await ensureServer({ port: Number(values.port), root: tree.root, patches: tree.patches ?? [] });
    try {
      const r = await measureOne(server, values, {
        iso: path.resolve(REPO_ROOT, tree.discs?.[item.game.iso] ?? item.game.iso),
        query: item.query,
        label: item.label,
        warmup: Number(spec.warmupSec ?? 15),
        secs: Number(spec.sampleSec ?? 20),
        shotEvery: Number(spec.shotEverySec ?? 0),
        steps: loadSteps(item.game.steps, specDir),
        statePath: item.game.state ? path.resolve(specDir, expandEnv(item.game.state)) : null,
        game: item.game,
        spec,
        dir
      });
      log(`[harness] ${brief(r)}`);
      records.push(slimRecord(item, r));
    } finally {
      await server.stop();
    }
  }
  return records;
}

function finishRecords(records, spec) {
  renderChecks(records, spec.reference);
  for (const r of records) {
    r.checks = runChecks(r);
    r.flags = runFlags(r);
  }
  return records;
}

function envLines(records, dir) {
  const first = records[0] && JSON.parse(readFileSync(path.join(dir, `${records[0].label}.json`), "utf8"));
  if (!first) return [];
  const e = first.env ?? {};
  const loads = records.map((r) => r.summary?.loadAvg).filter(Number.isFinite);
  return [
    `Served snapshot ${first.served?.snapshot?.slice(0, 12) ?? "?"} (commit ${first.served?.commit?.slice(0, 10) ?? "?"}${first.served?.dirty ? ", local changes" : ""}) · Chrome ${e.chrome ?? "?"} · GPU ${e.gpu?.vendor ?? "?"} ${e.gpu?.architecture ?? ""}`,
    `Machine ${first.machineBefore.cpuModel}, ${first.machineBefore.cpus} CPUs, ${first.machineBefore.platform}; load during runs ${loads.length ? `${Math.min(...loads)}-${Math.max(...loads)}` : "?"} (limit ${first.loadGate?.limit ?? "?"})`
  ];
}

export function writeSummary(dir, { spec, records, title }) {
  const cells = summarizeMatrix(records, { games: spec.games });
  writeJson(path.join(dir, "summary.json"), { spec, machine: machineSnapshot(), cells, results: records });
  const md = matrixMarkdown(cells, { title: title ?? spec.name ?? "matrix", env: envLines(records, dir) });
  writeFileSync(path.join(dir, "summary.md"), md + "\n");
  return { cells, md };
}

function readSpec(file, values) {
  const spec = JSON.parse(readFileSync(file, "utf8"));
  if (values.runs) spec.runs = Number(values.runs);
  if (values["max-load"]) spec.maxLoad = Number(values["max-load"]);
  return spec;
}

async function cmdMatrix(argv) {
  const { values, positionals } = parse(argv, { runs: { type: "string" }, "max-load": { type: "string" } });
  if (!positionals[0]) throw new Error("usage: harness/run matrix <spec.json> [--runs N] [--max-load L] [--out dir]");
  const spec = readSpec(positionals[0], values);
  const plan = expandMatrix(spec);
  const dir = outDir(values, spec.name ?? path.basename(positionals[0], ".json"), { private: spec.games.some((g) => g.localOnly) });
  console.log(`[harness] ${plan.length} runs → ${dir}`);
  const records = finishRecords(await runPlan(plan, { values, spec, dir, specDir: path.dirname(path.resolve(positionals[0])) }), spec);
  const { cells, md } = writeSummary(dir, { spec, records });
  console.log("\n" + md);
  // Exit status reflects correctness only; performance is a report.
  return cells.some((c) => Object.values(c.checks).some((x) => x.status === "fail")) ? 1 : 0;
}

async function cmdMeasure(argv) {
  const { values } = parse(argv, {
    iso: { type: "string" },
    config: { type: "string", default: "rec" },
    warmup: { type: "string", default: "15" },
    secs: { type: "string", default: "20" },
    runs: { type: "string", default: "3" },
    label: { type: "string" }
  });
  if (!values.iso) throw new Error("usage: harness/run measure --iso disc.iso [--config rec|<query>] [--runs 3]");
  const game = { id: values.label ?? path.basename(values.iso).replace(/\.\w+$/, ""), iso: path.resolve(values.iso), localOnly: !values.iso.includes(HOMEBREW_OUT) };
  const spec = { name: `measure-${game.id}`, runs: Number(values.runs), warmupSec: Number(values.warmup), sampleSec: Number(values.secs), games: [game], configs: [configFromArg(values.config)] };
  const tmp = mkdtempSync(path.join(os.tmpdir(), "gc-harness-spec-"));
  const file = path.join(tmp, "spec.json");
  writeJson(file, spec);
  try {
    return await cmdMatrix([file, "--port", values.port, ...(values.out ? ["--out", values.out] : []), ...(values.headless ? ["--headless"] : [])]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- diff
async function waitRunning(page, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const p = await readCoreProgress(page);
    if ((p?.frame ?? 0) > 0) return; // frames only advance once Running
    await page.waitForTimeout(100);
  }
  throw new Error("core never reached Running");
}

async function captureScene(server, values, { iso, query, index, state, steps, label, dir }) {
  const supported = captureSupported(query);
  if (!supported.ok) throw new Error(`${label}: ${supported.why}`);
  const routes = state ? { "**/__harness_state.sav": path.resolve(state) } : {};
  const session = await openSession({ base: server.base, query, iso, headed: !values.headless, keepProfile: values["keep-profiles"], routes });
  try {
    if (steps) await runSteps(session.page, steps);
    if (state) {
      // A load sent before the core is Running is refused ("Starting").
      await waitRunning(session.page);
      const loaded = await pageCall(session.page, "__loadStateFile", new URL("__harness_state.sav", session.url).href, 120000);
      if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
    }
    const capture = await captureInSession(session, { index, fromLoad: Boolean(state) });
    if (capture.error) throw new Error(`${label}: ${capture.error}`);
    if (!captureSourceOk(query, capture.source)) throw new Error(`${label}: capture source ${capture.source} is not what this renderer shows`);
    savePng(capture, path.join(dir, `${label}.png`));
    return { label, url: session.url, capture, fatal: session.watch.fatal() };
  } finally {
    await session.close();
  }
}

async function cmdDiff(argv) {
  const { values } = parse(argv, {
    iso: { type: "string" },
    ref: { type: "string", default: "sw-interp" },
    cand: { type: "string", default: "sw-fast-jit" },
    frame: { type: "string", default: "300" },
    state: { type: "string" },
    steps: { type: "string" },
    "ref-png": { type: "string" },
    "cand-png": { type: "string" },
    "fail-on": { type: "string", default: "missing-detail,blank,geometry-mismatch,different" }
  });
  const isPrivate = Boolean(values.iso && !path.resolve(values.iso).startsWith(HOMEBREW_OUT));
  const dir = outDir(values, "diff", { private: isPrivate });
  let ref, cand, meta = {};
  if (values["ref-png"] && values["cand-png"]) {
    ref = decodePng(readFileSync(values["ref-png"]));
    cand = decodePng(readFileSync(values["cand-png"]));
    meta = { ref: values["ref-png"], cand: values["cand-png"] };
  } else {
    if (!values.iso) throw new Error("usage: harness/run diff --iso disc.iso [--ref q] [--cand q] [--frame N] [--state file.sav] | --ref-png a --cand-png b");
    const opts = { iso: values.iso, index: Number(values.frame), state: values.state, steps: loadSteps(values.steps), dir };
    let refQuery = resolveQuery(configFromArg(values.ref)), candQuery = resolveQuery(configFromArg(values.cand));
    const video = (q) => new URLSearchParams(q).get("video") ?? "software";
    if (video(refQuery) !== video(candQuery)) {
      refQuery = forCrossRenderer(refQuery);
      candQuery = forCrossRenderer(candQuery);
      console.log("[diff] different renderers: both run with cpu=single so VI output N is the same emulated frame");
    }
    const shots = await withServer(values, async (server) => [
      await captureScene(server, values, { ...opts, query: refQuery, label: "ref" }),
      await captureScene(server, values, { ...opts, query: candQuery, label: "cand" })
    ]);
    [ref, cand] = shots.map((s) => s.capture);
    meta = Object.fromEntries(shots.map((s) => [s.label, { url: s.url, viOutput: s.capture.index, fromLoad: s.capture.fromLoad, ticks: s.capture.ticks, fatal: s.fatal }]));
    // The core counted the outputs: same index from the same start is the
    // same emulated frame. Ticks are recorded for information only.
    if (meta.ref.viOutput !== meta.cand.viOutput || meta.ref.fromLoad !== meta.cand.fromLoad) throw new Error("captures are not the same VI output");
  }
  const result = identical(ref, cand) ? { ...compareFrames(ref, cand), verdict: "identical" } : compareFrames(ref, cand);
  savePng(diffImage(ref, cand, result), path.join(dir, "diff.png"));
  const { blockMap, ...score } = result;
  writeJson(path.join(dir, "diff.json"), { ...meta, machine: machineSnapshot(), score, blockMap });
  console.log(JSON.stringify({ dir, ...score }, null, 2));
  return values["fail-on"].split(",").includes(result.verdict) ? 1 : 0;
}

// ---------------------------------------------------------------- fuzz
// Run a disc to VI output `index` and capture that exact output.
async function observe(server, values, iso, query, dir, label, index) {
  const session = await openSession({ base: server.base, query, iso, headed: !values.headless, keepProfile: values["keep-profiles"] });
  try {
    const capture = await captureInSession(session, { index, timeoutMs: Number(values.timeout ?? 90) * 1000 });
    const info = await readFrameInfo(session.page).catch(() => null);
    if (!capture.error) savePng(capture, path.join(dir, `${label}.png`));
    return { url: session.url, capture, info, fatal: session.watch.fatal() };
  } finally {
    await session.close();
  }
}

// build.sh writes <name>.symbols.json next to each cpufuzz image (PC → program mapping).
const symbolsFor = (iso) => {
  const file = iso.replace(/\.\w+$/, ".symbols.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
};

async function runFuzz(server, values, { isos, names = null, dir, frame = 1700, interp = INTERP_QUERY, jit = JIT_QUERY }) {
  for (const iso of isos) if (!existsSync(iso)) throw new Error(`${iso} missing: run harness/run build-iso first`);
  const report = { machine: machineSnapshot(), served: server.identity, frame, interpQuery: interp, jitQuery: jit, results: [] };
  for (const [i, iso] of isos.entries()) {
    const name = names?.[i] ?? path.basename(iso).replace(/\.\w+$/, "");
    const a = await observe(server, values, iso, interp, dir, `${name}-interp`, frame);
    const b = await observe(server, values, iso, jit, dir, `${name}-jit`, frame);
    const verdict = analyzeDifferential({ interp: a, jit: b, symbols: symbolsFor(iso) });
    const slim = (r) => ({ url: r.url, capture: r.capture.error ? { error: r.capture.error } : { viOutput: r.capture.index, ticks: r.capture.ticks }, jitc: r.info?.jitc, jitr: r.info?.jitr, pc: hex(r.info?.pc ?? 0), fatal: r.fatal?.slice(0, 3) });
    report.results.push({ iso: name, ...verdict, interp: slim(a), jit: slim(b) });
    console.log(`[fuzz] ${name}: ${verdict.ok ? "OK" : "FAIL"} ${verdict.findings.map((f) => `${f.kind}${f.program != null ? ` (program ${f.program} word ${f.word}, ${f.group})` : ""}${f.error ? `: ${f.error}` : ""}`).join("; ")}`);
  }
  writeJson(path.join(dir, "fuzz.json"), report);
  return report;
}

async function cmdFuzz(argv) {
  const { values, positionals } = parse(argv, {
    timeout: { type: "string", default: "90" },
    // Every homebrew here freezes its output by VI output 1600 (cpufuzz's
    // DONE_FRAME is 1500 iterations of one VI each).
    frame: { type: "string", default: "1700" },
    interp: { type: "string", default: INTERP_QUERY },
    jit: { type: "string", default: JIT_QUERY }
  });
  const isos = positionals.length ? positionals : ["cpufuzz", "cpufuzz-nomcrf", "consoletest", "padtest"].map((n) => path.join(HOMEBREW_OUT, `${n}.iso`));
  const dir = outDir(values, "fuzz");
  const report = await withServer(values, (server) => runFuzz(server, values, { isos, dir, frame: Number(values.frame), interp: values.interp, jit: values.jit }));
  console.log(`[fuzz] report: ${path.join(dir, "fuzz.json")}`);
  return report.results.every((r) => r.ok) ? 0 : 1;
}

// ---------------------------------------------------------------- pads
const PAD_SCENARIO = [
  { pressed: ["A"], stick: [1, 0] },
  { pressed: ["B", "START"] },
  { pressed: ["X", "D_UP"], cstick: [-1, 0] },
  { pressed: ["Y", "Z"], stick: [0, 1] }
];
const EXPECTED_BITS = (s) => {
  const out = [...(s.pressed ?? [])];
  if (s.stick?.[0] > 0) out.push("STICK_RIGHT");
  if (s.stick?.[1] > 0) out.push("STICK_UP");
  if (s.cstick?.[0] < 0) out.push("C_STICK_LEFT");
  return out.sort();
};

// padtest crashes the WASM JIT today (see `fuzz`), so pads run interpreted.
const PADS_QUERY = "core=upstream&video=software&cpu=dual&speed=1&wasmjit=0&metrics=1";

async function runPads(server, values, { iso, query, dir }) {
  const session = await openSession({ base: server.base, query, iso, headed: !values.headless, gamepads: { count: 4 }, keepProfile: values["keep-profiles"] });
  let report;
  try {
    // Inputs reach the game within a few frames; 30 VI outputs later the
    // picture reflects them. The checksum row makes a misread impossible.
    const read = async (label) => {
      const capture = await captureInSession(session, { ahead: 30 });
      if (capture.error) throw new Error(`${label}: ${capture.error}`);
      savePng(capture, path.join(dir, `pads-${label}.png`));
      const decoded = decodeRows(capture);
      if (!decoded.ok) throw new Error(`${label}: padtest rows unreadable (checksum mismatch)`);
      return decoded.rows.map((v) => decodePadRow(v));
    };
    try {
      const warm = await captureInSession(session, { index: 120 });
      if (warm.error) throw new Error(warm.error);
      const ports = [];
      for (let i = 0; i < 4; i += 1) await setPad(session.page, i, PAD_SCENARIO[i]);
      const seen = await read("four-pads");
      for (let i = 0; i < 4; i += 1) {
        const expected = EXPECTED_BITS(PAD_SCENARIO[i]);
        const got = (seen[i]?.pressed ?? []).filter((b) => !b.endsWith("_ANALOG")).sort();
        ports.push({ port: i + 1, expected, got, ok: JSON.stringify(expected) === JSON.stringify(got) });
      }
      await releaseAll(session.page);
      const idle = await read("released");
      const released = idle.every((p) => p && p.pressed.length === 0);
      // Keyboard drives port 1 (X → A).
      await session.page.keyboard.down("KeyX");
      const kb = await read("keyboard-x");
      await session.page.keyboard.up("KeyX");
      report = { url: session.url, served: server.identity, ports, released, keyboardP1A: Boolean(kb[0]?.pressed.includes("A")), fatal: session.watch.fatal() };
    } catch (e) {
      // Not judgeable is a result too, never a silent pass.
      report = { url: session.url, served: server.identity, error: e.message, fatal: session.watch.fatal() };
    }
  } finally {
    await session.close();
  }
  writeJson(path.join(dir, "pads.json"), { machine: machineSnapshot(), ...report });
  return report;
}

// pads report → findings, for the gate.
export function padFindings(report) {
  // A crash is reported as a crash (with its signature), never hidden behind
  // "could not be judged".
  const crash = report.fatal?.length ? [{ kind: "crash", error: report.fatal.find((e) => e.text !== "ErrorEvent")?.text ?? report.fatal[0].text }] : [];
  if (report.error) return crash.length ? crash : [{ kind: "unjudged", error: report.error }];
  return [
    ...report.ports.filter((p) => !p.ok).map((p) => ({ kind: `port-${p.port}`, error: `expected [${p.expected}] got [${p.got}]` })),
    ...(report.released ? [] : [{ kind: "release" }]),
    ...(report.keyboardP1A ? [] : [{ kind: "keyboard-p1" }]),
    ...crash
  ];
}

async function cmdPads(argv) {
  const { values } = parse(argv, {
    iso: { type: "string", default: path.join(HOMEBREW_OUT, "padtest.iso") },
    query: { type: "string", default: PADS_QUERY }
  });
  const dir = outDir(values, "pads");
  const report = await withServer(values, (server) => runPads(server, values, { iso: values.iso, query: values.query, dir }));
  if (report.error) {
    console.log(`[pads] not judged: ${report.error}`);
    return 2;
  }
  for (const p of report.ports) console.log(`[pads] P${p.port}: ${p.ok ? "OK" : "KO"} expected [${p.expected}] got [${p.got}]`);
  console.log(`[pads] released → all neutral: ${report.released}; keyboard X → P1 A: ${report.keyboardP1A}; report ${dir}`);
  return padFindings(report).length ? 1 : 0;
}

// ---------------------------------------------------------------- savestate
async function cmdSavestate(argv) {
  const { values } = parse(argv, {
    iso: { type: "string" },
    config: { type: "string", default: "rec" },
    steps: { type: "string" },
    wait: { type: "string", default: "5" },
    to: { type: "string" }
  });
  if (!values.iso || !values.to) throw new Error("usage: harness/run savestate --iso disc.iso --to out.sav [--config rec] [--steps steps.json] [--wait 5]");
  return withServer(values, async (server) => {
    const session = await openSession({ base: server.base, query: resolveQuery(configFromArg(values.config)), iso: values.iso, headed: !values.headless, keepProfile: values["keep-profiles"] });
    try {
      if (values.steps) await runSteps(session.page, loadSteps(values.steps));
      await waitSeconds(session, Number(values.wait));
      const r = await pageCall(session.page, "__saveStateFile", undefined, 120000);
      if (!r?.saved || !r.b64) throw new Error(`save failed: ${JSON.stringify({ ...r, b64: undefined })}`);
      mkdirSync(path.dirname(path.resolve(values.to)), { recursive: true });
      writeFileSync(values.to, Buffer.from(r.b64, "base64"));
      const shot = savePng(await grabFrame(session.page), values.to.replace(/\.\w+$/, "") + ".png");
      console.log(`[harness] ${values.to}: ${r.size} bytes from ${session.url} (frame ${shot})`);
      return 0;
    } finally {
      await session.close();
    }
  });
}

// ---------------------------------------------------------------- report
function loadRunFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !["summary.json", "spec.json", "gate.json"].includes(f))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")))
    .filter((r) => r.samples && r.label)
    .map((r) => {
      const [game, config, run] = r.label.split("__");
      const monitor = r.monitor && { ...r.monitor, audioAttached: Boolean(r.audio?.attached) };
      return {
        game, config, run: Number(run?.slice(1)), label: r.label, url: r.url, served: r.served,
        summary: summarizeRun({ samples: r.samples, cpu: r.cpu, monitor, timeline: r.timeline, ticksPerSecond: r.ticksPerSecond, windowEnd: r.windowEnd }),
        crashed: r.crashed, errors: r.errors, overloaded: r.overloaded ?? false, capture: r.capture, audioRequired: r.audioRequired ?? false
      };
    });
}

// Rebuild summary.json/summary.md from the per-run JSON files of a result dir.
function cmdReport(argv) {
  const { positionals } = parse(argv, {});
  const dir = positionals[0];
  if (!dir) throw new Error("usage: harness/run report <result-dir>");
  const old = existsSync(path.join(dir, "summary.json")) ? JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8")) : {};
  const spec = old.spec ?? { games: [] };
  const { md } = writeSummary(dir, { spec, records: finishRecords(loadRunFiles(dir), spec), title: spec.name ?? path.basename(dir) });
  console.log(md);
  return 0;
}

// ---------------------------------------------------------------- gate / ab
// Export the served part of a git ref (page, app, core, server) to a temp dir.
function exportRef(ref) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gc-harness-baseline-"));
  claim(dir, REPO_ROOT, "baseline-export");
  const commit = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", ref], { encoding: "utf8" }).trim();
  const tar = execFileSync("git", ["-C", REPO_ROOT, "archive", commit, "index.html", "src", "cores", "tools"], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  writeFileSync(path.join(dir, IDENTITY_FILE), JSON.stringify({ ref, commit, dirty: false }));
  return dir;
}

// The gate, from persisted results only, so `harness/run gate` on the same
// directories always decides what `ab` decided.
// Failures main is known to have (harness/known-failures.json), read from
// the checkout running the gate.
function knownFailures() {
  const file = path.join(REPO_ROOT, "harness", "known-failures.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}

function gateFromDirs(baseDir, candDir, { accept = [] } = {}) {
  const read = (d) => JSON.parse(readFileSync(path.join(d, "summary.json"), "utf8"));
  const optional = (d, f) => (existsSync(path.join(d, f)) ? JSON.parse(readFileSync(path.join(d, f), "utf8")) : null);
  const base = read(baseDir), cand = read(candDir);
  const gates = [correctnessGate(base.cells, cand.cells), crossCommitGate(renderVsBaseline(base.results, cand.results, { accept, known: knownFailures() }))];
  for (const [name, file, pick] of [["fuzz", "fuzz.json", (r) => r.results.flatMap((x) => x.findings.map((f) => ({ ...f, iso: x.iso })))], ["pads", "pads.json", (r) => padFindings(r)]]) {
    const b = optional(baseDir, file), c = optional(candDir, file);
    if (b || c) gates.push(findingsGate(name, b ? pick(b) : [], c ? pick(c) : null));
  }
  const correctness = mergeGates(...gates);
  const perf = perfReport(runsByCell(base.results), runsByCell(cand.results), { initialRuns: Number(cand.spec?.runs ?? base.spec?.runs ?? 3) });
  return { correctness, perf, decision: decide({ correctness, perf }) };
}

function cmdGate(argv) {
  const { values } = parse(argv, { baseline: { type: "string" }, candidate: { type: "string" }, accept: { type: "string", multiple: true, default: [] } });
  if (!values.baseline || !values.candidate) throw new Error("usage: harness/run gate --baseline <dir> --candidate <dir> [--accept game/config …]");
  const g = gateFromDirs(values.baseline, values.candidate, { accept: values.accept });
  console.log(gateMarkdown(g));
  return g.decision.ok ? 0 : 1;
}

// A/B of two trees on one spec: the matrix A/B alternated run by run, plus
// the spec's fuzz discs and pads on both sides, everything persisted to
// <dir>/baseline and <dir>/candidate. Cells whose performance got worse by
// the threshold are replayed (both sides and the reference config, `confirm`
// more pairs) before the gate decides. Returns the gate (also gate.json).
export async function abCompare({ spec, specDir, values, dir, baseline, candidate, accept = [] }) {
  const plan = expandMatrix(spec);
  const sides = { baseline: { tree: baseline, records: [] }, candidate: { tree: candidate, records: [] } };
  for (const side of Object.keys(sides)) mkdirSync(path.join(dir, side));
  const play = async (items) => {
    for (const item of items) {
      // Alternate which side goes first so slow drift does not favour one.
      const order = item.run % 2 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      for (const side of order) {
        const [r] = await runPlan([item], { values, spec, dir: path.join(dir, side), specDir, tree: sides[side].tree, log: (m) => console.log(m.replace("[harness]", `[${side}]`)) });
        sides[side].records.push(r);
      }
    }
  };
  const persist = () => {
    for (const [side, { records }] of Object.entries(sides)) writeSummary(path.join(dir, side), { spec, records: finishRecords(records, spec), title: `${spec.name ?? "matrix"} (${side})` });
  };
  await play(plan);
  for (const [side, { tree }] of Object.entries(sides)) {
    const disc = (p) => path.resolve(REPO_ROOT, tree.discs?.[p] ?? p);
    if (spec.fuzz?.length) await withServer(values, (server) => runFuzz(server, values, { isos: spec.fuzz.map(disc), names: spec.fuzz.map((f) => path.basename(f).replace(/\.\w+$/, "")), dir: path.join(dir, side) }), tree);
    if (spec.pads) await withServer(values, (server) => runPads(server, values, { iso: disc("harness/homebrew/out/padtest.iso"), query: PADS_QUERY, dir: path.join(dir, side) }), tree);
  }
  persist();
  let g = gateFromDirs(path.join(dir, "baseline"), path.join(dir, "candidate"), { accept });
  const flagged = g.perf.filter((r) => r.worse);
  if (flagged.length && Number(values.confirm ?? 2) > 0) {
    const extra = confirmationItems(plan, flagged, { rounds: Number(values.confirm ?? 2), reference: spec.reference });
    console.log(`[harness] performance worse in ${new Set(flagged.map((r) => `${r.game}/${r.config}`)).size} cell(s), confirming with ${extra.length} more A/B pairs`);
    await play(extra);
    persist();
    g = gateFromDirs(path.join(dir, "baseline"), path.join(dir, "candidate"), { accept });
  }
  writeJson(path.join(dir, "gate.json"), g);
  writeFileSync(path.join(dir, "gate.md"), gateMarkdown(g) + "\n");
  return g;
}

// Baseline (a git ref, default origin/main) vs this tree. `harness/run gate`
// on the two result directories reproduces the decision.
async function cmdAb(argv) {
  const { values, positionals } = parse(argv, { runs: { type: "string" }, "max-load": { type: "string" }, confirm: { type: "string", default: "2" }, "baseline-ref": { type: "string", default: "origin/main" }, accept: { type: "string", multiple: true, default: [] } });
  if (!positionals[0]) throw new Error("usage: harness/run ab <spec.json> [--baseline-ref origin/main] [--runs N] [--max-load L] [--confirm N] [--accept game/config …]");
  const spec = readSpec(positionals[0], values);
  const dir = outDir(values, `ab-${spec.name ?? "matrix"}`, { private: spec.games.some((g) => g.localOnly) });
  const baseRoot = exportRef(values["baseline-ref"]);
  console.log(`[harness] A/B ${values["baseline-ref"]} vs working tree → ${dir}`);
  try {
    const g = await abCompare({ spec, specDir: path.dirname(path.resolve(positionals[0])), values, dir, baseline: { root: baseRoot }, candidate: { root: REPO_ROOT }, accept: values.accept });
    console.log(gateMarkdown(g));
    return g.decision.ok ? 0 : 1;
  } finally {
    rmSync(baseRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- clean
function cmdClean(argv) {
  const { values } = parse(argv, { keep: { type: "string", default: "0" }, all: { type: "boolean", default: false } });
  const removed = rotateResults(RESULTS, Number(values.keep));
  // Temp dirs of runs that died before cleaning up after themselves. Only
  // those this checkout made and whose owner process is gone: other agents
  // share the temp dir, and a live run must keep its profile.
  const skipped = [];
  for (const name of readdirSync(os.tmpdir())) {
    if (!name.startsWith("gc-harness-")) continue;
    const dir = path.join(os.tmpdir(), name);
    const d = removeIfDeletable(dir, REPO_ROOT);
    if (d.ok) removed.push(dir);
    else skipped.push(`${dir} (${d.why})`);
  }
  if (values.all) {
    rmSync(HOMEBREW_OUT, { recursive: true, force: true });
    removed.push(HOMEBREW_OUT);
  }
  try {
    // Only stopped containers that this checkout's build.sh labelled; never
    // images, volumes, or other projects' containers.
    const label = `gc-harness.root=${path.join(REPO_ROOT, "harness", "homebrew")}`;
    const ids = execFileSync("docker", ["ps", "-aq", "--filter", `label=${label}`, "--filter", "status=exited"], { encoding: "utf8" }).split("\n").filter(Boolean);
    if (ids.length) execFileSync("docker", ["rm", ...ids]);
    removed.push(...ids.map((id) => `container ${id}`));
  } catch {}
  for (const p of skipped) console.log(`[clean] kept ${p}`);
  for (const p of removed) console.log(`[clean] removed ${p}`);
  console.log(`[clean] ${removed.length} item(s)`);
  return 0;
}

// ---------------------------------------------------------------- build-iso
function cmdBuildIso() {
  execFileSync("sh", [path.join(REPO_ROOT, "harness", "homebrew", "build.sh")], { stdio: "inherit" });
  return 0;
}

const COMMANDS = { matrix: cmdMatrix, measure: cmdMeasure, diff: cmdDiff, fuzz: cmdFuzz, pads: cmdPads, savestate: cmdSavestate, report: cmdReport, gate: cmdGate, ab: cmdAb, clean: cmdClean, "build-iso": cmdBuildIso };

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!COMMANDS[command]) {
    console.error(`usage: harness/run <${Object.keys(COMMANDS).join("|")}> [options]  (see harness/README.md)`);
    process.exit(2);
  }
  try {
    process.exitCode = await COMMANDS[command](rest);
  } catch (error) {
    console.error(`[harness] ${error.stack || error.message}`);
    process.exitCode = 2;
  }
}

// Importable (the selftest uses abCompare) without running a command.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
