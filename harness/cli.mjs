// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// QA harness entry point. Usage: harness/run <command> [options]; see harness/README.md.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ensureServer, pageCall, readCoreProgress, REPO_ROOT, waitForCoreFrame } from "./lib/browser.mjs";
import { analyzeDifferential, INTERP_QUERY, JIT_QUERY } from "./lib/fuzz.mjs";
import { releaseAll, setPad } from "./lib/gamepad-mock.mjs";
import { compareFrames, diffImage } from "./lib/image-diff.mjs";
import { decodeMarkers, decodePadRow, hex } from "./lib/markers.mjs";
import { expandMatrix, matrixMarkdown, PRESETS, resolveQuery, runFlags, summarizeMatrix, summarizeRun } from "./lib/matrix.mjs";
import { decodePng } from "./lib/png.mjs";
import { grabFrame, openSession, runUntilDone, sample, savePng, setCorePaused, waitSeconds } from "./lib/session.mjs";
import { runSteps, validateSteps } from "./lib/steps.mjs";
import { machineSnapshot } from "./lib/system.mjs";
import { claim, deletable, removeIfDeletable } from "./lib/ownership.mjs";

const HOMEBREW_OUT = path.join(REPO_ROOT, "harness", "homebrew", "out");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

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
  mkdirSync(base, { recursive: true });
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

async function withServer(values, fn) {
  const server = await ensureServer({ port: Number(values.port) });
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------- measure
async function measureOne(server, values, { iso, query, label, warmup, secs, shotEvery, dir, steps }) {
  const session = await openSession({ base: server.base, query, iso, headed: !values.headless, keepProfile: values["keep-profiles"] });
  try {
    if (steps) await runSteps(session.page, steps);
    await waitSeconds(session, warmup);
    const { samples, cpu, shots } = await sample(session, { seconds: secs, shotEvery, shotPrefix: path.join(dir, label) });
    const finalShot = savePng(await grabFrame(session.page), path.join(dir, `${label}.png`));
    const fatal = session.watch.fatal();
    const record = {
      label,
      url: session.url,
      iso: path.resolve(iso),
      steps,
      warmupSec: warmup,
      sampleSec: secs,
      machineBefore: session.machineBefore,
      machineAfter: machineSnapshot(),
      summary: summarizeRun(samples, cpu),
      crashed: fatal.length > 0,
      errors: fatal,
      events: session.watch.events.slice(0, 50),
      screenshots: [...shots, finalShot],
      samples,
      cpu
    };
    writeJson(path.join(dir, `${label}.json`), record);
    return record;
  } finally {
    await session.close();
  }
}

function brief(r) {
  const s = r.summary;
  const f = (v) => (v == null ? "–" : Math.round(v));
  const flags = runFlags(r);
  return `${r.label}: speed ${f(s.speed)}% pres ${f(s.pres)} vis ${f(s.vis)} p95 ${s.p95?.toFixed?.(1) ?? "–"}ms cpu ${f(s.cpuTotal)}% jitc ${s.jitc ?? "–"} load ${r.machineBefore.loadavg[0]}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
}

async function cmdMatrix(argv) {
  const { values, positionals } = parse(argv, { runs: { type: "string" } });
  if (!positionals[0]) throw new Error("usage: harness/run matrix <spec.json> [--runs N] [--out dir]");
  const spec = JSON.parse(readFileSync(positionals[0], "utf8"));
  if (values.runs) spec.runs = Number(values.runs);
  const plan = expandMatrix(spec);
  const isPrivate = spec.games.some((g) => g.localOnly);
  const dir = outDir(values, spec.name ?? path.basename(positionals[0], ".json"), { private: isPrivate });
  console.log(`[harness] ${plan.length} runs → ${dir}`);
  const machine = machineSnapshot();
  const results = await withServer(values, async (server) => {
    const out = [];
    for (const item of plan) {
      const r = await measureOne(server, values, {
        iso: path.resolve(REPO_ROOT, item.game.iso),
        query: item.query,
        label: item.label,
        warmup: Number(spec.warmupSec ?? 15),
        secs: Number(spec.sampleSec ?? 20),
        shotEvery: Number(spec.shotEverySec ?? 0),
        steps: loadSteps(item.game.steps, path.dirname(path.resolve(positionals[0]))),
        dir
      });
      console.log(`[harness] ${brief(r)}`);
      out.push({ game: item.game.id, config: item.config.id, run: item.run, url: r.url, summary: r.summary, crashed: r.crashed, errors: r.errors });
    }
    return out;
  });
  const cells = summarizeMatrix(results);
  writeJson(path.join(dir, "summary.json"), { spec, machine, machineAfter: machineSnapshot(), cells, results });
  const md = matrixMarkdown(cells, { title: spec.name ?? "matrix", machine: `${machine.cpuModel}, ${machine.cpus} CPUs, ${machine.platform}; ${machine.uptime}` });
  writeFileSync(path.join(dir, "summary.md"), md + "\n");
  console.log("\n" + md);
  return 0;
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
  const file = path.join(outDir(values, "spec", { private: game.localOnly }), "spec.json");
  writeJson(file, spec);
  return cmdMatrix([file, "--out", path.dirname(file), "--port", values.port, ...(values.headless ? ["--headless"] : [])]);
}

// ---------------------------------------------------------------- diff
async function captureScene(server, values, { iso, query, frame, settle, pause, state, steps, label, dir }) {
  const routes = state ? { "**/__harness_state.sav": path.resolve(state) } : {};
  const session = await openSession({ base: server.base, query, iso, headed: !values.headless, keepProfile: values["keep-profiles"], routes });
  try {
    if (steps) await runSteps(session.page, steps);
    let progress = await waitForCoreFrame(session.page, state ? 60 : frame, 120000);
    if (state) {
      const loaded = await pageCall(session.page, "__loadStateFile", new URL("__harness_state.sav", session.url).href, 120000);
      if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
      progress = await waitForCoreFrame(session.page, (progress.frame ?? 0) + frame, 60000);
    }
    // Pause as soon as frame N is reached, then let the picture settle; without
    // --pause the core keeps running through the settle time.
    if (pause) await setCorePaused(session.page, true);
    await session.page.waitForTimeout(settle * 1000);
    const atGrab = await readCoreProgress(session.page);
    const image = await grabFrame(session.page);
    savePng(image, path.join(dir, `${label}.png`));
    return { label, url: session.url, requestedFrame: frame, progress: atGrab, source: image.source, image, fatal: session.watch.fatal() };
  } finally {
    await session.close();
  }
}

async function cmdDiff(argv) {
  const { values } = parse(argv, {
    iso: { type: "string" },
    ref: { type: "string", default: "sw-interp" },
    cand: { type: "string", default: "core=upstream&video=wgpu&presenter=webgpu&cpu=dual&speed=1&wasmjit=0" },
    frame: { type: "string", default: "300" },
    settle: { type: "string", default: "1" },
    pause: { type: "boolean", default: false },
    state: { type: "string" },
    steps: { type: "string" },
    "ref-png": { type: "string" },
    "cand-png": { type: "string" },
    "fail-on": { type: "string", default: "missing-detail,blank,geometry-mismatch,different,frames-differ" }
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
    const opts = { iso: values.iso, frame: Number(values.frame), settle: Number(values.settle), pause: values.pause, state: values.state, steps: loadSteps(values.steps), dir };
    const shots = await withServer(values, async (server) => [
      await captureScene(server, values, { ...opts, query: resolveQuery(configFromArg(values.ref)), label: "ref" }),
      await captureScene(server, values, { ...opts, query: resolveQuery(configFromArg(values.cand)), label: "cand" })
    ]);
    [ref, cand] = shots.map((s) => s.image);
    meta = Object.fromEntries(shots.map((s) => [s.label, { url: s.url, requestedFrame: s.requestedFrame, frame: s.progress?.frame ?? null, source: s.source, fatal: s.fatal }]));
    // The frame actually captured, not the one asked for: a gap means the two
    // pictures may show different moments of an animated scene.
    meta.frameGap = Math.abs((meta.ref.frame ?? NaN) - (meta.cand.frame ?? NaN));
    if (!(meta.frameGap <= 2)) console.warn(`[diff] captured frames differ (ref ${meta.ref.frame}, cand ${meta.cand.frame}); use --pause or --state for animated scenes`);
  }
  const result = compareFrames(ref, cand);
  // Two different moments of an animated scene are not a rendering verdict.
  if (meta.frameGap > 2 && result.verdict !== "match") result.verdict = "frames-differ";
  savePng(diffImage(ref, cand, result), path.join(dir, "diff.png"));
  const { blockMap, ...score } = result;
  writeJson(path.join(dir, "diff.json"), { ...meta, machine: machineSnapshot(), score, blockMap });
  console.log(JSON.stringify({ dir, ...score }, null, 2));
  return values["fail-on"].split(",").includes(result.verdict) ? 1 : 0;
}

// ---------------------------------------------------------------- fuzz
async function observe(server, values, iso, query, dir, label, timeoutSec) {
  const session = await openSession({ base: server.base, query, iso, headed: !values.headless, keepProfile: values["keep-profiles"] });
  try {
    const r = await runUntilDone(session, { timeoutSec });
    if (r.frame) savePng(r.frame, path.join(dir, `${label}.png`));
    return { ...r, url: session.url };
  } finally {
    await session.close();
  }
}

async function cmdFuzz(argv) {
  const { values, positionals } = parse(argv, {
    timeout: { type: "string", default: "90" },
    interp: { type: "string", default: INTERP_QUERY },
    jit: { type: "string", default: JIT_QUERY }
  });
  const isos = positionals.length ? positionals : ["cpufuzz", "cpufuzz-nomcrf", "consoletest", "padtest"].map((n) => path.join(HOMEBREW_OUT, `${n}.iso`));
  for (const iso of isos) if (!existsSync(iso)) throw new Error(`${iso} missing: run harness/run build-iso first`);
  // build.sh writes <name>.symbols.json next to each cpufuzz image (PC → program mapping).
  const symbolsFor = (iso) => {
    const file = iso.replace(/\.\w+$/, ".symbols.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  };
  const dir = outDir(values, "fuzz");
  const report = { machine: machineSnapshot(), interpQuery: values.interp, jitQuery: values.jit, results: [] };
  await withServer(values, async (server) => {
    for (const iso of isos) {
      const name = path.basename(iso).replace(/\.\w+$/, "");
      const interp = await observe(server, values, iso, values.interp, dir, `${name}-interp`, Number(values.timeout));
      const jit = await observe(server, values, iso, values.jit, dir, `${name}-jit`, Number(values.timeout));
      const verdict = analyzeDifferential({ interp, jit, symbols: symbolsFor(iso) });
      const slim = (r) => ({ url: r.url, outcome: r.outcome, frame: r.info?.frame, jitc: r.info?.jitc, jitr: r.info?.jitr, pc: hex(r.info?.pc ?? 0), status: r.markers?.status, rows: r.markers?.rows?.map(hex), fatal: r.fatal?.slice(0, 3) });
      report.results.push({ iso: name, ...verdict, interp: slim(interp), jit: slim(jit) });
      console.log(`[fuzz] ${name}: ${verdict.ok ? "OK" : "FAIL"} ${verdict.findings.map((f) => `${f.kind}${f.program != null ? ` (program ${f.program} word ${f.word}, ${f.group})` : ""}${f.error ? `: ${f.error}` : ""}`).join("; ")}`);
    }
  });
  writeJson(path.join(dir, "fuzz.json"), report);
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

async function cmdPads(argv) {
  const { values } = parse(argv, {
    iso: { type: "string", default: path.join(HOMEBREW_OUT, "padtest.iso") },
    // padtest crashes the WASM JIT today (see `fuzz`), so pads run interpreted.
    query: { type: "string", default: "core=upstream&video=software&cpu=dual&speed=1&wasmjit=0&metrics=1" }
  });
  const dir = outDir(values, "pads");
  const report = await withServer(values, async (server) => {
    const session = await openSession({ base: server.base, query: values.query, iso: values.iso, headed: !values.headless, gamepads: { count: 4 }, keepProfile: values["keep-profiles"] });
    try {
      await waitForCoreFrame(session.page, 120, 60000);
      const read = async (label) => {
        await session.page.waitForTimeout(700);
        const frame = await grabFrame(session.page);
        savePng(frame, path.join(dir, `${label}.png`));
        const m = decodeMarkers(frame);
        return m.rows.map((v) => decodePadRow(v));
      };
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
      return { url: session.url, ports, released, keyboardP1A: Boolean(kb[0]?.pressed.includes("A")), fatal: session.watch.fatal() };
    } finally {
      await session.close();
    }
  });
  writeJson(path.join(dir, "pads.json"), { machine: machineSnapshot(), ...report });
  for (const p of report.ports) console.log(`[pads] P${p.port}: ${p.ok ? "OK" : "KO"} expected [${p.expected}] got [${p.got}]`);
  console.log(`[pads] released → all neutral: ${report.released}; keyboard X → P1 A: ${report.keyboardP1A}; report ${dir}`);
  return report.ports.every((p) => p.ok) && report.released && report.keyboardP1A ? 0 : 1;
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
// Rebuild summary.json/summary.md from the per-run JSON files of a result dir.
function cmdReport(argv) {
  const { positionals } = parse(argv, {});
  const dir = positionals[0];
  if (!dir) throw new Error("usage: harness/run report <result-dir>");
  const old = existsSync(path.join(dir, "summary.json")) ? JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8")) : {};
  const results = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "summary.json" && f !== "spec.json")
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")))
    .filter((r) => r.samples && r.label)
    .map((r) => {
      const [game, config, run] = r.label.split("__");
      return { game, config, run: Number(run?.slice(1)), url: r.url, summary: summarizeRun(r.samples, r.cpu), crashed: r.crashed, errors: r.errors };
    });
  const cells = summarizeMatrix(results);
  const machine = old.machine ?? results[0]?.machineBefore;
  writeJson(path.join(dir, "summary.json"), { ...old, cells, results });
  const md = matrixMarkdown(cells, { title: old.spec?.name ?? path.basename(dir), machine: machine ? `${machine.cpuModel}, ${machine.cpus} CPUs, ${machine.platform}; ${machine.uptime}` : undefined });
  writeFileSync(path.join(dir, "summary.md"), md + "\n");
  console.log(md);
  return 0;
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

const COMMANDS = { matrix: cmdMatrix, measure: cmdMeasure, diff: cmdDiff, fuzz: cmdFuzz, pads: cmdPads, savestate: cmdSavestate, report: cmdReport, clean: cmdClean, "build-iso": cmdBuildIso };

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
