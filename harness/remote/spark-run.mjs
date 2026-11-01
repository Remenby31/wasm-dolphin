#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// A race-perf pair on the DGX Spark bench, driven from the Mac: pushes the
// two sides (git refs or worktrees, with their cores) and this harness, runs
// harness/probes/race-perf.mjs there under the Spark's own perf lock, and
// brings the result back under ../measures/spark/<date>/<name>.
//
//   node harness/remote/spark-run.mjs --candidate <ref|dir> [--baseline <ref|dir>]
//     --state <local .sav> [--name n] [--runs 6] [--lane auto|a|b] [--host spark] [--detach]
//     [--keep-video] [--headed :2 [--xauth /run/salon-xorg/xauth] | --headless]
//     [--probe race-perf | drop-meter | replay-gates | parcours [--film <local film.json>]]
//     (the load gate: lib/bench-load.mjs; a --max-load given only caps it) [--noise <date>/<drop-meter A/A on the bench>]
//     (lane a only, cpus 10-19: since 2026-10-29 cpus 0-9 are Excalibur's, no --lane b, --screen or --multi)
//     [-- <the probe's options: --query, --warmup, --secs, --max-load, …>]
//   (--multi: refused since 2026-10-29, its arms ran on 5-9; an older one still comes back with --fetch)
//   node harness/remote/spark-run.mjs --fetch <date>/<name>   (a detached run)
//   node harness/remote/spark-run.mjs --queue                  (the bench's queue, waits and ETAs; exit 3 if a ticket starves)
//   node harness/remote/spark-run.mjs --build <ref>            (core built on the bench)
//
// - Relative only: Playwright's Chromium on Linux arm64 (no Google Chrome
//   there), another CPU and GPU. Every summary is stamped host=spark and
//   chromium=playwright, and kpi-report never reads it for trunk's absolute
//   rows (lib/kpi.mjs). Compare the two sides of one pair, nothing else.
// - What is pushed is what each side serves (lib/server.mjs snapshotTree),
//   stored under ~/salon-bench/trees/<snapshot hash>: pushed once, reused
//   by every later pair. A git ref is exported first (git archive), a
//   directory is taken as it is, local changes and cores included.
// - The disc is never pushed: race-perf reads the one already on the bench
//   (~/salon-bench/roms, the only copy, PROGRAM.md). --state is pushed there
//   (mode 600) when missing.
// - The run is detached on the Spark (setsid): a dropped ssh session does
//   not stop it, and --fetch brings it back later.
// - --build <ref> builds that commit's core on the bench (spark-build.mjs,
//   under the bench's perf lock; the commit must be on the fork), and
//   `spark:<ref>` then names that worktree as a side: a Linux build, the
//   same kind as CI's, never compared with a core built on this Mac.
// - --multi: a codegen change (JIT, regions, dispatch) measured by host
//   instructions per guest cycle, the official metric (PROGRAM.md,
//   2026-10-22): race-multi runs every arm at once, one lane of 3 big cores
//   each, in an emulated window, cpu=single, seeded regions, isolated boot,
//   --counters. Arms: base, candidate, base (an A/A control) with one
//   candidate; base and both with two. Every arm's commit must contain the
//   region layout fix (#71): an older core sometimes refuses all its
//   regions. Time is not this mode's metric: measure it with a pair.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { exportRef } from "../cli.mjs";
import { PRESETS, SCENE_PROTOCOLS, sceneProtocolCheck } from "../lib/matrix.mjs";
import { REPO_ROOT } from "../lib/browser.mjs";
import { IDENTITY_FILE, snapshotTree } from "../lib/server.mjs";
import { MAX_BUILDS_PER_OWNER, ownerBuilds } from "./spark-queue.mjs";
import { release } from "../lib/ownership.mjs";

export const BENCH = "salon-bench"; // under the Spark user's home
export const MEASURES = path.resolve(REPO_ROOT, "..", "measures", "spark");
// Never pushed by this script, whatever a tree holds.
const DISC = /\.(?:iso|gcm|rvz|ciso|wbfs|gcz)$/i;
// The harness itself, as the pair runs it (race-perf and what it imports).
const HARNESS_ROOTS = ["harness", "src", "package.json"];
const HARNESS_SKIP = /^harness\/(?:results|homebrew)(?:\/|$)/;

export const safeName = (s) => String(s).replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 80) || "run";
export const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Today's directory and a run name: given, or the two sides and the time.
export function runId({ name, candidate, baseline, now = new Date() }) {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const label = (spec) => (spec ? path.basename(String(spec)) : null);
  const auto = [label(candidate), baseline ? `vs-${label(baseline)}` : null, now.toISOString().slice(11, 16).replace(":", "")].filter(Boolean).join("-");
  return { date, name: safeName(name ?? auto) };
}

// The bench has no hardware WebGPU (headless Chromium on Linux arm64 only
// offers SwiftShader, where the wgpu device is lost), and the software
// renderer in dual core lets the CPU thread idle on it (speed capped at the
// limit). video=null keeps the race CPU-bound as wgpu does on the Mac
// (PROGRAM.md: video=null is no faster there): so every query's wgpu
// becomes null, its WebGPU presenter 2d; the rest of the query is kept.
export const BENCH_LOCK_WAIT = 4 * 3600;
// --multi (validated on multi-aba-emu-0087b: A/A +0.04 %, residual 0.03 %).
export const MULTI_LANES = "5,6,7;15,16,17;8,9,19";
export const MULTI_QUERY = "core=upstream&video=null&presenter=2d&cpu=single&speed=1&wasmjit=1&jitwarmup=60&oc=1&aot=1";
export const MULTI_ARGS = ["--counters", "--aot-seed", "--gate-sec", "60", "--isolated-boot", "--emulated-window", "10", "--emulated-warmup", "15"];
// The merge of #71 (region layout fix): every arm's commit descends from it.
export const LAYOUT_FIX = "109a4ce61a9599460761f7412440bf889ff00a54";

// The arms of a multi: three, one per lane.
// Two lanes (--multi-lanes with two core sets): baseline and candidate at
// once, the lanes swapped every run.
export function multiArms(baseline, candidates, { lanes = 3 } = {}) {
  if (!baseline) throw new Error("--multi needs --baseline");
  if (lanes === 2) {
    if (candidates.length !== 1) throw new Error(`--multi on two lanes: one --candidate (got ${candidates.length})`);
    return [baseline, candidates[0]];
  }
  if (candidates.length === 1) return [baseline, candidates[0], baseline];
  if (candidates.length === 2) return [baseline, ...candidates];
  throw new Error(`--multi: one or two --candidate (got ${candidates.length})`);
}

// race-multi's arguments; options after -- come last and win.
export function multiRaceArgs({ iso, state, runs, armDirs, lanes = MULTI_LANES, extra = [] }) {
  if (Number(runs) % armDirs.length) throw new Error(`--runs ${runs}: a multiple of ${armDirs.length} with --multi (each arm visits each lane equally)`);
  return ["--iso", iso, "--state", state, "--runs", String(runs), ...armDirs.flatMap((d) => ["--arm", d]), "--lanes", lanes, ...MULTI_ARGS, "--query", MULTI_QUERY, ...extra];
}

// Two lanes are for screening, not for a decision (A/A multi2-aa-5x5-c,
// 2026-10-28): the lane 5-9 ran 7 % slower than 15-19 in both arms, and
// after the lane correction the residual sigma was 1.05 % (sequential pairs
// on lane a: 0.7-0.85 %), enough for an effect of ~2 % in 6 runs. The bench
// log gives each cpu's kind ("cpus" lines, spark-cores.mjs topology).
// --multi-lanes "15,16,17,18,19;5,6,7,8,9": one Chromium core set per arm
// (race-multi wants as many lanes as arms; MULTI_LANES has three), each
// "n" or "n-m" items, disjoint, on the bench's 20 cores and off node's
// 10-14 (spark-multi.sh). The default: MULTI_LANES for three arms.
export const MULTI_NODE_CPUS = [10, 11, 12, 13, 14];
// The GB10's Cortex-X925 (3.9 GHz): 5-9 and 15-19; 0-4 and 10-14 are
// Cortex-A725 (2.8 GHz, sysfs read on 2026-10-28). Every lane on X925 cores:
// a lane on A725 against one on X925 measures the cores, not the arms.
export const MULTI_BIG_CPUS = [5, 6, 7, 8, 9, 15, 16, 17, 18, 19];
export function multiLanes(spec, arms) {
  if (spec == null) {
    if (arms !== MULTI_LANES.split(";").length) throw new Error(`--multi with ${arms} arms: --multi-lanes "<cpus>;<cpus>…" (one lane per arm; the default has ${MULTI_LANES.split(";").length})`);
    return MULTI_LANES;
  }
  const lanes = String(spec).split(";").map((lane) => lane.split(",").flatMap((item) => {
    const m = /^(\d+)(?:-(\d+))?$/.exec(item.trim());
    if (!m) throw new Error(`--multi-lanes ${spec}: cpus as n or n-m, comma-separated, lanes separated by ;`);
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    return Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => Math.min(a, b) + i);
  }));
  if (lanes.length !== arms) throw new Error(`--multi-lanes: ${lanes.length} lanes for ${arms} arms (one each)`);
  const all = lanes.flat();
  if (all.some((c) => c < 0 || c > 19)) throw new Error(`--multi-lanes ${spec}: the bench has cpus 0-19`);
  if (new Set(all).size !== all.length) throw new Error(`--multi-lanes ${spec}: the lanes share cpus`);
  if (all.some((c) => MULTI_NODE_CPUS.includes(c))) throw new Error(`--multi-lanes ${spec}: cpus 10-14 run node (spark-multi.sh)`);
  if (all.some((c) => !MULTI_BIG_CPUS.includes(c))) throw new Error(`--multi-lanes ${spec}: cpus 0-4 are Cortex-A725 (2.8 GHz); every lane on the X925 cores 5-9 and 15-19`);
  if (new Set(lanes.map((l) => l.length)).size !== 1) throw new Error(`--multi-lanes ${spec}: lanes of different sizes`);
  return lanes.map((l) => l.join(",")).join(";");
}

// A KPI scene's pinned protocol (matrix.mjs SCENE_PROTOCOLS) as race-multi
// options, put before the caller's own: the heavy intro measured with the
// race's 15 + 10 s and the key held left its ~9 s heavy phase, and the arms
// read different stretches (jit-0121b-heavy, 2026-10-23: A/A -1.48 %,
// residual 1-2 %, against 0.05 % with the protocol).
export function sceneMultiArgs(scene) {
  const p = SCENE_PROTOCOLS[scene];
  return p ? ["--emulated-window", String(p.emulatedWindow), "--emulated-warmup", String(p.warmup), ...(p.hold == null ? ["--hold", ""] : ["--hold", p.hold])] : [];
}

// The value race-multi will see for an option (its last occurrence).
const lastOpt = (args, name) => { const i = args.lastIndexOf(name); return i >= 0 ? args[i + 1] : undefined; };

// The final race-multi arguments against the scene's protocol: errors
// refuse the job, warnings are printed and kept in spark.json.
export function multiSceneCheck(scene, raceArgs) {
  return sceneProtocolCheck(scene, {
    warmup: Number(lastOpt(raceArgs, "--emulated-warmup")), window: Number(lastOpt(raceArgs, "--emulated-window")),
    emulated: raceArgs.includes("--emulated-window"), hold: lastOpt(raceArgs, "--hold") ?? "KeyX"
  });
}

// Refuses an arm whose commit predates the layout fix (unknown: refused).
export function checkLayoutFix(spec, commit, isAncestor) {
  if (!commit) throw new Error(`${spec}: no commit known, cannot check it contains the region layout fix (#71)`);
  if (!isAncestor(LAYOUT_FIX, commit)) throw new Error(`${spec} (${commit.slice(0, 12)}) predates the region layout fix (#71, ${LAYOUT_FIX.slice(0, 12)}): merge main into it first`);
}

const gitIsAncestor = (a, b) => spawnSync("git", ["-C", REPO_ROOT, "merge-base", "--is-ancestor", a, b]).status === 0;
export const RACE_QUERY = "core=upstream&video=wgpu&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=60&oc=1";
export function benchQuery(query) {
  const q = new URLSearchParams(PRESETS[query] ?? query);
  if (q.get("video") === "wgpu") q.set("video", "null");
  if (q.get("video") === "null" && (q.get("presenter") ?? "webgpu") === "webgpu") q.set("presenter", "2d");
  // The product (WebGPU) never decodes the XFB; video=null does unless told
  // (DolphinWeb_OnXfb: 5.9 % of the race's CPU thread, 6.9 % of the heavy
  // scene's on the bench, 2026-10-31). ?xfbdecode=1 keeps the decode.
  if (q.get("video") === "null" && !q.has("xfbdecode")) q.set("xfbdecode", "0");
  return q.toString();
}

// ?xfbdecode=0 (2026-10-27): under video=null the core skips the XFB's
// YUV->RGBA decode, 6.9 % of the CPU thread on the heavy scene that WebGPU
// never pays. Added by the bench to every video=null query since 2026-10-31
// (benchQuery; ?xfbdecode=1 keeps the decode). A side whose core predates
// the switch would ignore it and keep decoding, which would read as a ~7 %
// gain of the other side: every query that asks for it needs every side to
// know it (the core's glue carries the Module key in its EM_ASM), else the
// pair is refused before anything runs (requireXfbSwitch).
export const XFB_SWITCH_KEY = "dolphinXfbNoDecode";
// --opt=value as --opt value (node's parseArgs takes both forms), for the
// options spark-run itself reads or refuses only: an option whose value
// starts with "-" (--chrome-args=--flag) must keep its = form, which strict
// parseArgs reads as one value and the split form as an ambiguous option.
export const SPLIT_OPTIONS = new Set(["--query", "--config", "--baseline-query", "--emulated-window", "--emulated-warmup", "--hold",
  "--iso", "--state", "--out", "--port", "--runs", "--arm", "--lanes", "--lock"]);
export function splitEquals(args) {
  return args.flatMap((a) => {
    const at = a.indexOf("=");
    return at > 2 && a.startsWith("--") && SPLIT_OPTIONS.has(a.slice(0, at)) ? [a.slice(0, at), a.slice(at + 1)] : [a];
  });
}
export function asksNoXfbDecode(rawArgs) {
  const args = splitEquals(rawArgs);
  return args.some((a, i) => i > 0 && ["--query", "--baseline-query"].includes(args[i - 1]) && new URLSearchParams(a).get("xfbdecode") === "0");
}
export const xfbSwitchTest = (dest) => `grep -q ${XFB_SWITCH_KEY} ${dest}/cores/dolphin/dolphin-core-upstream.js && grep -q ${XFB_SWITCH_KEY} ${dest}/src/upstream-discio-worker.js`;
function requireXfbSwitch(host, args, sides) {
  if (!asksNoXfbDecode(args)) return;
  for (const side of sides) {
    if (ssh(host, xfbSwitchTest(side.dest), { quiet: true }).status !== 0) throw new Error(`${side.spec}: xfbdecode=0 asked but this side's core or worker predates the switch (it would keep decoding): merge main into it, or drop xfbdecode=0`);
  }
}

// race-perf's options after --, with every query made fit for the bench
// (--config becomes a --query).
export function benchRaceArgs(rawArgs, { keepVideo = false } = {}) {
  const args = splitEquals(rawArgs);
  const out = [], swaps = [];
  let hasQuery = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (["--query", "--config", "--baseline-query"].includes(a) && i + 1 < args.length) {
      const from = args[(i += 1)];
      // An empty query would boot on the app's defaults, not the bench's.
      if (!from.trim()) throw new Error(`${a} is empty`);
      const to = keepVideo ? (PRESETS[from] ?? from) : benchQuery(from);
      if (a !== "--baseline-query") hasQuery = true;
      out.push(a === "--config" ? "--query" : a, to);
      if (to !== from) swaps.push({ option: a, from, to });
    } else out.push(a);
  }
  // The bench queues pairs and builds of several agents: race-perf's 30 min
  // (one Mac slot) is not enough to wait for a turn there.
  if (!out.includes("--lock-wait")) out.push("--lock-wait", String(BENCH_LOCK_WAIT));
  if (!hasQuery) {
    const to = keepVideo ? RACE_QUERY : benchQuery(RACE_QUERY);
    out.push("--query", to);
    swaps.push({ option: "--query", from: `(default) ${RACE_QUERY}`, to });
  }
  return { args: out, swaps };
}

// The summary as the Mac keeps it: marked as measured on the bench, never
// on this Mac's stock Chrome (lib/kpi.mjs leaves it out of trunk's rows).
export function stampSummary(summary, bench) {
  return { ...summary, host: bench.host, chromium: "playwright", bench, ...(bench.screen ? { screen: bench.screen } : {}) };
}

// --headed :N: Chrome shown on the Spark's bare Xorg (salon-xorg.service, a
// fake 1920x1080 panel at 120 Hz, no desktop), the harness's x11 display
// mode (browser.mjs): a real BeginFrame source at the screen's rate for the
// display probes, where headless gives a synthetic 60 Hz. The variables go
// with the launch; spark-race.sh, spark-queue.mjs and chrome-pinned.sh pass
// them on as they are (exported, exec). WebGPU runs there on the GPU
// (Vulkan), so the query keeps video=wgpu. --headless: headless whatever
// HARNESS_DISPLAY the bench's environment holds.
export const BENCH_XAUTHORITY = "/run/salon-xorg/xauth";
export function headedEnv(display, xauth = BENCH_XAUTHORITY, { headless = false } = {}) {
  if (headless && display != null) throw new Error("--headed and --headless: one or the other");
  if (headless) return ["HARNESS_DISPLAY=headless"];
  if (display == null) return [];
  if (!/^:\d+$/.test(display)) throw new Error(`--headed ${display}: an X display as :N (the bench's bare Xorg is :2)`);
  return ["HARNESS_DISPLAY=x11", `DISPLAY=${sh(display)}`, `XAUTHORITY=${sh(xauth)}`];
}

// Lane b only for screening (--screen, 2026-10-28: the bench must never sit
// idle): two pairs at once disturb each other (A/A of 2026-10-21: σ 1.86 pt),
// so a lane b result is stamped as screening and never decides anything;
// the decisive pairs stay one at a time in lane a.
//
// Since 2026-10-29 (the user's decision) the Spark is shared: cpus 0-9 are
// Excalibur's evals, 10-19 Salon's. Lane b (Chromium 5-9, node 0-4), its
// screening runs and the multi (arms on 5-9) are gone: one pair at a time
// in lane a (Chromium 15-19, node 10-14), nothing else in parallel.
export const SALON_CPUS = "10-19";
export const LANE_B_GONE = "cpus 0-9 are Excalibur's since 2026-10-29 (Salon has 10-19): lane b, --screen and --multi are gone, pairs run one at a time in lane a";
export function checkLane(lane, { screen = false } = {}) {
  if (lane === "b" || screen) throw new Error(`--lane b / --screen: ${LANE_B_GONE}`);
  if (!["auto", "a"].includes(lane)) throw new Error(`--lane ${lane}: a or auto`);
}
export const SCREEN_NOTE = "screening in lane b, beside another pair: never a conclusion";
// A multi on two lanes (--multi-lanes with two core sets): screening too
// (residual sigma 1.05 %, an effect of ~2 % in 6 runs; decisive pairs are
// sequential in lane a).
export const MULTI_SCREEN_NOTE = "screening: a multi on two lanes (residual sigma ~1 %, effects of ~2 %), never a conclusion; decisive pairs run sequentially in lane a";
export const multiScreen = (lanes) => (String(lanes).split(";").length === 2 ? MULTI_SCREEN_NOTE : null);

// --noise <date>/<name>: drop-meter's A/A already on the bench, as that run's
// summary there (a Mac path after -- would not exist on the bench).
export function benchNoiseArgs(noise, resultsDir) {
  if (noise == null) return [];
  const [date, name, ...rest] = String(noise).split("/");
  if (!/^\d{8}$/.test(date ?? "") || !name || rest.length) throw new Error(`--noise ${noise}: a bench run as <yyyymmdd>/<name>`);
  return ["--noise", `${resultsDir}/${date}/${safeName(name)}/summary.json`];
}

// The Spark command that starts the pair detached and returns at once.
export const SPARK_PROBES = ["race-perf", "drop-meter", "replay-gates", "parcours"];
// drop-meter, replay-gates and parcours judge the presentation (?wgpureplayms is read
// by the wgpu path only): headless, the bench turns video=wgpu into
// video=null (benchQuery) and such a gate would pass without exercising
// anything. They need --headed, an explicit --query (no default: race-perf's
// is not the product's), and every final query, --extra's additions
// included, on video=wgpu.
export function checkPresentationProbe(probe, rawArgs, benchArgs, headed) {
  if (!headed) throw new Error(`--probe ${probe} needs --headed :N: headless, the bench renders video=null and the presentation is not exercised`);
  const raw = splitEquals(rawArgs);
  if (!raw.includes("--query")) throw new Error(`--probe ${probe} needs an explicit --query (the product's, e.g. drop-meter's PRODUCT_QUERY)`);
  for (let i = 0; i < benchArgs.length - 1; i += 1) {
    if (["--query", "--baseline-query"].includes(benchArgs[i]) && new URLSearchParams(benchArgs[i + 1]).get("video") !== "wgpu") throw new Error(`${benchArgs[i]} ${benchArgs[i + 1]}: video=wgpu needed for --probe ${probe}`);
  }
  const extra = raw.indexOf("--extra");
  if (extra >= 0 && new URLSearchParams(raw[extra + 1] ?? "").has("video")) throw new Error("--extra must not change video= (it escapes the bench's query check)");
}
// parcours plays a pad film from the boot (no savestate): the film is local
// data (never in the repo), pushed like a savestate (mode 600, named by its
// hash) next to the disc and passed as --film.
export function pushFilm(host, file) {
  const bytes = readFileSync(file);
  // a local file name may hold anything: a safe name, and quoted remotely
  const name = `${safeName(path.basename(file, ".json"))}-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.film.json`;
  const dest = `${BENCH}/roms/${name}`;
  if (ssh(host, `test -f ${sh(dest)}`, { quiet: true }).status !== 0) {
    ssh(host, `set -e; umask 077; cat > ${sh(`${dest}.tmp`)}; mv ${sh(`${dest}.tmp`)} ${sh(dest)}`, { input: bytes });
    console.log(`[spark-run] film pushed as roms/${name}`);
  }
  return dest;
}
// What each probe needs from the Mac: race-perf and replay-gates a
// savestate, parcours a film, drop-meter neither (its scenario from the boot).
export function checkProbeInputs(probe, { state, film }) {
  if (probe === "parcours") {
    if (!film) throw new Error("--probe parcours needs --film <local film.json> (lib/pad-film.mjs)");
    if (state) throw new Error("--probe parcours boots the disc: no --state");
    return;
  }
  if (film) throw new Error(`--film: --probe parcours only`);
  if (!state && probe !== "drop-meter") throw new Error("usage: spark-run.mjs --candidate <ref|dir> [--baseline <ref|dir>] --state <local .sav> [--name n] [--runs 6] [--detach] [--probe race-perf|drop-meter|replay-gates|parcours] [-- probe options]");
}
// --loaded: a correctness run (replay-gates: exact pictures, integrity,
// flicker) does not wait for the lane's cores to be free of other people's
// processes. Its verdicts do not depend on speed, and a loaded, late replay
// is where some glitches show (the judge, 2026-11-01). It still takes its
// turn and the lane's lock; spark.json says loaded. Speed probes refuse it.
export const LOADED_PROBES = Object.freeze(["replay-gates"]);
export const LOADED_NOTE = "lane cores not waited free of other processes (correctness run): no speed reading from it";

export function launchCommand({ harnessDir, outDir, lane = "auto", raceArgs, chromeCpus, nodeCpus, headed = null, headless = false, xauth = BENCH_XAUTHORITY, probe = "race-perf", loaded = false }) {
  if (!SPARK_PROBES.includes(probe)) throw new Error(`probe ${probe}: one of ${SPARK_PROBES.join(", ")}`);
  if (loaded && !LOADED_PROBES.includes(probe)) throw new Error(`loaded: correctness probes only, not ${probe}`);
  const env = [chromeCpus && `SPARK_CHROME_CPUS=${sh(chromeCpus)}`, nodeCpus && `SPARK_NODE_CPUS=${sh(nodeCpus)}`, probe !== "race-perf" && `SPARK_PROBE=${sh(probe)}`, loaded && "SPARK_LOADED=1", ...headedEnv(headed, xauth, { headless })].filter(Boolean).join(" ");
  return [
    `mkdir -p ${sh(path.posix.dirname(outDir))}`,
    // Two pairs never share a name (race-perf refuses an existing --out, the log would mix).
    `test ! -e ${sh(`${outDir}.log`)}`,
    `cd ${sh(harnessDir)}`,
    `{ ${env ? `${env} ` : ""}setsid nohup sh harness/remote/spark-race.sh ${sh(outDir)} ${sh(lane)} -- ${raceArgs.map(sh).join(" ")} </dev/null >/dev/null 2>&1 & }`,
    "echo started"
  ].join(" && ");
}

// The Spark command that starts a multi detached and returns at once.
export function multiLaunchCommand({ harnessDir, outDir, raceArgs }) {
  return [
    `mkdir -p ${sh(path.posix.dirname(outDir))}`,
    `test ! -e ${sh(`${outDir}.log`)}`,
    `cd ${sh(harnessDir)}`,
    `{ setsid nohup sh harness/remote/spark-multi.sh ${sh(outDir)} -- ${raceArgs.map(sh).join(" ")} </dev/null >/dev/null 2>&1 & }`,
    "echo started"
  ].join(" && ");
}

// Files under `roots` of `root`, relative and sorted, minus `skip`.
function listFiles(root, roots, skip = null) {
  const out = [];
  const walk = (rel) => {
    if (skip?.test(rel)) return;
    const abs = path.join(root, rel);
    if (!existsSync(abs)) return;
    const st = statSync(abs);
    if (st.isDirectory()) for (const n of readdirSync(abs).sort()) walk(path.posix.join(rel, n));
    else if (st.isFile()) out.push(rel);
  };
  for (const r of roots) walk(r);
  return out.sort();
}

export function contentKey(root, files) {
  const h = createHash("sha256");
  for (const f of files) h.update(`${f}\0${createHash("sha256").update(readFileSync(path.join(root, f))).digest("hex")}\n`);
  return h.digest("hex").slice(0, 24);
}

function ssh(host, command, { input, quiet = false } = {}) {
  const r = spawnSync("ssh", ["-o", "ServerAliveInterval=15", "-o", "ConnectTimeout=20", host, command], { input, maxBuffer: 1 << 30 });
  if (r.status !== 0 && !quiet) throw new Error(`ssh ${host}: ${command.slice(0, 120)}… exit ${r.status}: ${String(r.stderr ?? "").trim().slice(0, 400)}`);
  return { status: r.status, bytes: r.stdout, out: String(r.stdout ?? "") };
}

// Push `files` of `root` to ~/salon-bench/<kind>/<key> unless it is there.
// Extracted aside, then renamed: a half-pushed tree is never used, and of
// two agents pushing the same content at once, the second keeps the first's.
function pushTree(host, { root, files, kind, key, identity = null }) {
  const dest = `${BENCH}/${kind}/${key}`;
  if (ssh(host, `test -d ${dest}`, { quiet: true }).status === 0) return { dest, pushed: false };
  for (const f of files) if (DISC.test(f)) throw new Error(`${root}: refusing to push a disc image (${f})`);
  const tar = execFileSync("tar", ["--no-mac-metadata", "-L", "-c", "-C", root, "-T", "-"], { input: files.join("\n"), maxBuffer: 1 << 30, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const id = identity ? `printf %s ${sh(JSON.stringify(identity))} > "$t"/${IDENTITY_FILE} && ` : "";
  ssh(host, `set -e; mkdir -p ${BENCH}/${kind}; t=$(mktemp -d ${dest}.tmp-XXXXXX); tar -x -C "$t"; ${id}chmod 755 "$t"; mv -T "$t" ${dest} 2>/dev/null || { rm -rf "$t"; test -d ${dest}; }`, { input: tar });
  return { dest, pushed: true };
}

// The remote test that `dir` holds a core built on the bench: a tree
// spark-build exported (identity builtOn spark), or a per-commit worktree of
// an older spark-build whose cores/ --install changed. A wasm alone proves
// nothing: every checkout has the committed CI core (2026-10-22: four
// unbuilt worktrees passed for built).
export const builtOnBenchTest = (dir) =>
  `test -f ${dir}/cores/dolphin/dolphin-core-upstream.wasm && { grep -qs '"builtOn":"spark"' ${dir}/.harness-identity.json || { test -e ${dir}/.git && test -n "$(git -C ${dir} status --porcelain -- cores)"; }; }`;

// A worktree built on the bench (--build): spark:<ref>.
function benchSide(host, spec) {
  const commit = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", `${spec.slice("spark:".length)}^{commit}`], { encoding: "utf8" }).trim();
  const dest = `${BENCH}/build/wt/${commit}`;
  if (ssh(host, builtOnBenchTest(dest), { quiet: true }).status !== 0) throw new Error(`${spec}: no core built on the bench for ${commit}: run --build ${commit} first`);
  console.log(`[spark-run] ${spec}: core built on the bench (build/wt/${commit.slice(0, 12)})`);
  return { spec, dest, key: `build-${commit}`, source: { commit, builtOn: "spark" } };
}

// One side: the files it serves (and tools/serve.mjs, which the remote
// harness imports to resolve them), keyed by the snapshot hash.
async function pushSide(host, spec) {
  if (spec.startsWith("spark:")) return benchSide(host, spec);
  const isDir = existsSync(spec) && statSync(spec).isDirectory();
  const root = isDir ? path.resolve(spec) : exportRef(spec);
  try {
    const snap = await snapshotTree(root);
    const files = [...snap.files.keys()].map((k) => k.slice(1)).concat("tools/serve.mjs").sort();
    const identity = { ref: isDir ? root : spec, ...snap.source, host: "mac" };
    const key = snap.hash.slice(0, 24);
    const { dest, pushed } = pushTree(host, { root, files, kind: "trees", key, identity });
    console.log(`[spark-run] ${spec}: ${pushed ? "pushed" : "already there"} as trees/${key} (commit ${String(snap.source.commit ?? "?").slice(0, 8)}${snap.source.dirty ? ", local changes" : ""})`);
    return { spec, dest, key, snapshot: snap.hash, source: snap.source };
  } finally {
    if (!isDir) { release(root); rmSync(root, { recursive: true, force: true }); }
  }
}

// The savestate goes next to the disc, private, once per content.
function pushState(host, file) {
  const bytes = readFileSync(file);
  const name = `${path.basename(file, ".sav")}-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.sav`;
  const dest = `${BENCH}/roms/${name}`;
  if (ssh(host, `test -f ${dest}`, { quiet: true }).status !== 0) {
    ssh(host, `set -e; umask 077; cat > ${dest}.tmp; mv ${dest}.tmp ${dest}`, { input: bytes });
    console.log(`[spark-run] savestate pushed as roms/${name}`);
  }
  return dest;
}

// The one disc on the bench, unless named.
function benchDisc(host, name) {
  if (name) return `${BENCH}/roms/${path.basename(name)}`;
  const discs = ssh(host, `ls ${BENCH}/roms`).out.split("\n").filter((f) => DISC.test(f));
  if (discs.length !== 1) throw new Error(`${discs.length} discs on the bench: name one with --iso <file name in ~/${BENCH}/roms>`);
  return `${BENCH}/roms/${discs[0]}`;
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Print a detached job's log (<base>.log) until its exit file (<base>.exit)
// appears; its exit code.
async function followLog(host, base, { lost, pollSec = 20 }) {
  let shown = 0, misses = 0;
  for (;;) {
    const r = ssh(host, `cat ${base}.exit 2>/dev/null; echo ---; tail -n +${shown + 1} ${base}.log 2>/dev/null`, { quiet: true });
    if (r.status !== 0) {
      if (++misses > 30) throw new Error(`lost the Spark for ${misses} polls; ${lost}`);
    } else {
      misses = 0;
      const [code, log = ""] = r.out.split("---\n");
      const lines = log.split("\n").filter(Boolean);
      for (const l of lines) console.log(l);
      shown += lines.length;
      if (code.trim() !== "") return Number(code.trim());
    }
    await sleep(pollSec);
  }
}

// Follow the detached run until it ends, then bring the result back and stamp it.
async function follow(host, { date, name, meta = null }) {
  const exit = await followLog(host, `${BENCH}/results/${date}/${name}`, { lost: `the run goes on there: --fetch ${date}/${name}` });
  return fetchResult(host, { date, name, meta, exit });
}

// --build: the commit's core, built on the bench (spark-build.mjs).
async function build(host, ref) {
  const commit = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  const remotes = execFileSync("git", ["-C", REPO_ROOT, "branch", "-r", "--contains", commit], { encoding: "utf8" });
  if (!/^\s*origin\//m.test(remotes)) throw new Error(`${ref} (${commit.slice(0, 12)}) is not on origin: push it to the fork first, the bench fetches from there`);
  const harnessFiles = listFiles(REPO_ROOT, HARNESS_ROOTS, HARNESS_SKIP);
  const harness = pushTree(host, { root: REPO_ROOT, files: harnessFiles, kind: "harness", key: contentKey(REPO_ROOT, harnessFiles) });
  const base = `${BENCH}/build/wt/${commit}`;
  const done = ssh(host, `cat ${base}.exit 2>/dev/null || { test -e ${base}.log && echo running; }`, { quiet: true }).out.trim();
  if (done === "0" && ssh(host, builtOnBenchTest(base), { quiet: true }).status === 0) return console.log(`[spark-run] already built: --candidate spark:${commit}`), 0;
  // A build under way (queued or compiling): follow it rather than refuse.
  if (done === "running") {
    console.log(`[spark-run] a build of ${commit.slice(0, 12)} is under way: following it`);
    const exit = await followLog(host, base, { lost: `the build goes on there: ssh ${host} cat ~/${base}.log` });
    if (exit === 0) console.log(`[spark-run] built: --candidate spark:${commit}`);
    return exit;
  }
  if (done) throw new Error(`a build of ${commit.slice(0, 12)} ended with exit ${done}${done === "0" ? " but no core built on the bench is there" : ""} (~/${base}.log); remove its .log and .exit to build again`);
  // At most MAX_BUILDS_PER_OWNER builds of this agent (its worktree) in the queue.
  const owner = safeName(path.basename(REPO_ROOT)); // [\w.-] only: safe in the remote sh -c '…' 
  const tickets = JSON.parse(ssh(host, `cd ${harness.dest} && PATH="$HOME/${BENCH}/node/bin:$PATH" node harness/remote/spark-queue.mjs list --json`).out || "[]");
  const mine = ownerBuilds(tickets, owner);
  if (mine.length >= MAX_BUILDS_PER_OWNER) throw new Error(`${owner} already has ${mine.length} builds in the bench's queue (${mine.map((t) => t.name).join(", ")}), at most ${MAX_BUILDS_PER_OWNER}: wait for one of your builds to go through`);
  ssh(host, `mkdir -p ${BENCH}/build/wt && test ! -e ${base}.log && cd ${harness.dest} && { PATH="$HOME/${BENCH}/node/bin:$PATH" setsid nohup sh -c 'node harness/remote/spark-build.mjs ${commit} --owner ${owner} >> $HOME/${base}.log 2>&1; echo $? > $HOME/${base}.exit' </dev/null >/dev/null 2>&1 & }`);
  console.log(`[spark-run] building ${commit.slice(0, 12)} on ${host} (waits for the bench's perf lock; ~8 min, first build of a worktree more)`);
  const exit = await followLog(host, base, { lost: `the build goes on there: ssh ${host} cat ~/${base}.log` });
  if (exit === 0) console.log(`[spark-run] built: --candidate spark:${commit}`);
  return exit;
}

// --queue: the bench's tickets, oldest first, with the time each has waited
// and its estimated start (spark-queue.mjs list --eta). It changes no
// ticket's place, but it pushes this harness tree to the bench and the
// listing drops dead tickets as any queue read does. A ticket waiting past
// QUEUE_STARVED_MIN is flagged: the judge reorders (move); a held one (its
// lane's cores busy, stepped aside on its own) is not.
export const QUEUE_STARVED_MIN = 60;
export function queueRows(tickets, now = Date.now()) {
  return tickets.map((t) => {
    const waited = Math.round((now - Date.parse(t.at)) / 60000);
    const isHeld = !t.lane && t.holdUntil && Date.parse(t.holdUntil) > now;
    const state = t.lane && t.lane !== "none" ? `running in ${t.lane}` : isHeld ? "held (cores busy)" : "waiting";
    const starved = !t.lane && !isHeld && waited >= QUEUE_STARVED_MIN;
    return `${starved ? "STARVED " : ""}${t.kind} ${t.name}${t.owner ? ` (${t.owner})` : ""} [wants ${t.lanes ?? "?"}] ${state}, ${waited} min since queued` + (t.lane ? `, ends in ~${t.endsIn} min` : `, starts in ~${t.startsIn} min`);
  });
}

function queueView(host) {
  const harnessFiles = listFiles(REPO_ROOT, HARNESS_ROOTS, HARNESS_SKIP);
  const harness = pushTree(host, { root: REPO_ROOT, files: harnessFiles, kind: "harness", key: contentKey(REPO_ROOT, harnessFiles) });
  const tickets = JSON.parse(ssh(host, `cd ${harness.dest} && PATH="$HOME/${BENCH}/node/bin:$PATH" node harness/remote/spark-queue.mjs list --eta --json`).out || "[]");
  const rows = queueRows(tickets);
  console.log(rows.length ? rows.join("\n") : "the queue is empty");
  return rows.some((r) => r.startsWith("STARVED")) ? 3 : 0;
}

function fetchResult(host, { date, name, meta, exit }) {
  const local = path.join(MEASURES, date, name);
  mkdirSync(local, { recursive: true });
  const tar = ssh(host, `tar -c -C ${BENCH}/results/${date} ${name} ${name}.log ${name}.exit ${name}.lane ${name}.cores 2>/dev/null; true`).bytes;
  execFileSync("tar", ["-x", "-C", path.dirname(local)], { input: tar });
  // name.log / .exit / .lane / .cores land next to the directory: keep them inside.
  for (const ext of ["log", "exit", "lane", "cores"]) {
    const f = path.join(path.dirname(local), `${name}.${ext}`);
    if (existsSync(f)) { writeFileSync(path.join(local, `spark-run.${ext}`), readFileSync(f)); rmSync(f); }
  }
  const metaFile = path.join(local, "spark.json");
  const bench = meta ?? (existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : { host: "spark" });
  const laneFile = path.join(local, "spark-run.lane");
  const lane = existsSync(laneFile) ? readFileSync(laneFile, "utf8").trim() : null;
  writeFileSync(metaFile, JSON.stringify({ ...bench, lane, exit }, null, 1) + "\n");
  const summaryFile = path.join(local, "summary.json");
  if (existsSync(summaryFile)) {
    const summary = stampSummary(JSON.parse(readFileSync(summaryFile, "utf8")), bench);
    writeFileSync(summaryFile, JSON.stringify(summary, null, 1) + "\n");
    const c = summary.change;
    if (bench.screen) console.log(`[spark-run] ${bench.screen}`);
    if (summary.probe === "race-multi") {
      const show = (e) => (e ? e.arms.map((x) => `arm ${x.arm} ${x.laneCorrected} %`).join(", ") : `withheld (${summary.withheld})`);
      console.log(`[spark-run] host instructions per guest cycle vs arm 0 (lower is better): ${show(summary.counterEffects)}; residual ${summary.counterEffects?.residualSd ?? "-"} %${summary.discarded?.length ? `; ${summary.discarded.length} run(s) discarded` : ""} -> ${local}`);
      // Cycles decide when they part from the instructions beyond their noise (~0.5 %).
      if (summary.cycleEffects) console.log(`[spark-run] host CYCLES per guest cycle vs arm 0 (lower is better, decides when it parts from the instructions): ${show(summary.cycleEffects)}; residual ${summary.cycleEffects.residualSd} %`);
      return exit;
    }
    if (summary.probe === "replay-gates" || summary.probe === "drop-meter" || summary.probe === "parcours") {
      for (const l of summary.probe === "parcours" ? summary.human ?? [] : []) console.log(`[spark-run] ${l}`);
      console.log(`[spark-run] ${summary.probe ?? "summary"} -> ${local}`);
      return exit;
    }
    for (const [k, label] of [["counterChange", "host instructions per guest cycle"], ["cycleChange", "host cycles per guest cycle"]]) if (summary[k]) console.log(`[spark-run] ${label}: paired change ${summary[k].median ?? `withheld (${summary[k].withheld})`}${summary[k].median != null ? " %" : ""}`);
    if (summary.warmChange) console.log(`[spark-run] warm: ${Object.entries(summary.warmChange).map(([m, x]) => `${m} ${x.median ?? "withheld"}${x.median != null ? " %" : ""}`).join(", ")}`);
    console.log(`[spark-run] ${c ? `paired change ${c.median ?? `withheld (${c.withheld})`}${c.median != null ? " %" : ""}, per run ${c.perRun.join(" ")}` : `speed ${summary.candidate?.cold?.speed?.median} %`} -> ${local}`);
  } else console.log(`[spark-run] no summary (exit ${exit}), see ${path.join(local, "spark-run.log")}`);
  return exit;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      candidate: { type: "string", multiple: true, default: [] }, multi: { type: "boolean", default: false }, baseline: { type: "string" }, state: { type: "string" }, iso: { type: "string" },
      name: { type: "string" }, runs: { type: "string", default: "6" }, lane: { type: "string", default: "auto" },
      host: { type: "string", default: process.env.SPARK_HOST || "spark" },
      "chrome-cpus": { type: "string" }, "node-cpus": { type: "string" }, "keep-video": { type: "boolean", default: false },
      headed: { type: "string" }, headless: { type: "boolean", default: false }, xauth: { type: "string", default: BENCH_XAUTHORITY },
      detach: { type: "boolean", default: false }, fetch: { type: "string" }, build: { type: "string" },
      "multi-lanes": { type: "string" }, queue: { type: "boolean", default: false },
      probe: { type: "string", default: "race-perf" }, film: { type: "string" }, noise: { type: "string" }, screen: { type: "boolean", default: false },
      loaded: { type: "boolean", default: false }
    },
    allowPositionals: true
  });
  const host = values.host;
  if (values.queue) {
    process.exitCode = queueView(host);
    return;
  }
  if (values.build) {
    process.exitCode = await build(host, values.build);
    return;
  }
  if (values.fetch) {
    const [date, name] = values.fetch.split("/");
    process.exitCode = await follow(host, { date, name: safeName(name) });
    return;
  }
  // --multi: its arms run on 5-9 (MULTI_LANES, --multi-lanes), Excalibur's
  // cores now; an older multi's results still come back with --fetch.
  if (values.multi) throw new Error(`--multi: ${LANE_B_GONE}`);
  if (values.candidate.length > 1) throw new Error("several --candidate: only with --multi");
  // --probe: the probe the pair runs (same lane, lock, cores and options as race-perf's)
  if (!SPARK_PROBES.includes(values.probe)) throw new Error(`--probe ${values.probe}: one of ${SPARK_PROBES.join(", ")}`);
  if (values.loaded && !LOADED_PROBES.includes(values.probe)) throw new Error(`--loaded: correctness runs only (${LOADED_PROBES.join(", ")}); a speed measure keeps its load gate`);
  values.candidate = values.candidate[0];
  // drop-meter runs its full scenario from the boot without a savestate,
  // parcours its film
  if (!values.candidate) throw new Error("usage: spark-run.mjs --candidate <ref|dir> [--baseline <ref|dir>] --state <local .sav> [--name n] [--runs 6] [--detach] [--probe race-perf|drop-meter|replay-gates|parcours] [-- probe options]");
  checkProbeInputs(values.probe, { state: values.state, film: values.film });
  for (const f of ["--iso", "--state", "--film", "--out", "--port", "--runs", "--candidate", "--baseline", "--core-candidate", "--noise"]) {
    if (positionals.includes(f)) throw new Error(`${f} is set by spark-run, not after --`);
  }
  if (values.noise && values.probe !== "drop-meter") throw new Error("--noise: drop-meter's A/A, --probe drop-meter only");
  // the bench's lock is what keeps two pairs off one lane
  if (positionals.includes("--no-lock")) throw new Error("--no-lock: never on the bench (its perf lock keeps pairs apart)");
  checkLane(values.lane, { screen: values.screen });
  const { date, name } = runId(values);
  if (existsSync(path.join(MEASURES, date, name))) throw new Error(`${path.join(MEASURES, date, name)} exists: pick another --name`);

  const harnessFiles = listFiles(REPO_ROOT, HARNESS_ROOTS, HARNESS_SKIP);
  const harness = pushTree(host, { root: REPO_ROOT, files: harnessFiles, kind: "harness", key: contentKey(REPO_ROOT, harnessFiles) });
  const candidate = await pushSide(host, values.candidate);
  const baseline = values.baseline ? (values.baseline === values.candidate ? candidate : await pushSide(host, values.baseline)) : null;
  const state = values.state ? pushState(host, path.resolve(values.state)) : null;
  const film = values.film ? pushFilm(host, path.resolve(values.film)) : null;
  const iso = benchDisc(host, values.iso);
  const home = ssh(host, "printf %s \"$HOME\"").out;
  const abs = (p) => `${home}/${p}`;
  headedEnv(values.headed, values.xauth, { headless: values.headless }); // refuses a bad display before anything is pushed
  const bench = benchRaceArgs(positionals, { keepVideo: values["keep-video"] || Boolean(values.headed) });
  if (values.probe !== "race-perf") checkPresentationProbe(values.probe, positionals, bench.args, values.headed);
  // replay-gates serves both sides from --candidate: refused here, not after the queue
  if (values.probe === "replay-gates" && (values.baseline || splitEquals(positionals).includes("--baseline-query"))) throw new Error("--probe replay-gates: one tree (--candidate) serves both sides, --extra makes the candidate; no --baseline or --baseline-query");
  for (const s of bench.swaps) console.log(`[spark-run] ${s.option} on the bench: ${s.to} (was ${s.from})`);
  requireXfbSwitch(host, bench.args, [candidate, ...(baseline ? [baseline] : [])]);
  const raceArgs = [
    "--iso", abs(iso), ...(state ? ["--state", abs(state)] : []), ...(film ? ["--film", abs(film)] : []), "--runs", values.runs,
    "--candidate", abs(candidate.dest), ...(baseline ? ["--baseline", abs(baseline.dest)] : []),
    ...benchNoiseArgs(values.noise, abs(`${BENCH}/results`)), ...bench.args
  ];
  const outDir = abs(`${BENCH}/results/${date}/${name}`);
  const meta = {
    host: "spark", hostname: ssh(host, "hostname").out.trim(), at: new Date().toISOString(),
    chromiumVersion: ssh(host, `c=$(ls -d ${BENCH}/ms-playwright/chromium-*/chrome-linux*/chrome | sort -V | tail -1) && "$c" --version`).out.trim(),
    chromeCpus: values["chrome-cpus"] ?? "lane", nodeCpus: values["node-cpus"] ?? "lane",
    harness: { from: REPO_ROOT, key: path.basename(harness.dest) },
    sides: { candidate, ...(baseline ? { baseline } : {}) },
    querySwaps: bench.swaps,
    probe: values.probe, ...(values.screen ? { screen: SCREEN_NOTE } : {}),
    ...(values.loaded ? { loaded: LOADED_NOTE } : {}),
    headed: values.headed ?? null, headless: values.headless,
    raceArgs
  };
  ssh(host, launchCommand({ harnessDir: abs(harness.dest), outDir, lane: values.lane, raceArgs, chromeCpus: values["chrome-cpus"], nodeCpus: values["node-cpus"], headed: values.headed, headless: values.headless, xauth: values.xauth, probe: values.probe, loaded: values.loaded }));
  mkdirSync(path.join(MEASURES, date, name), { recursive: true });
  writeFileSync(path.join(MEASURES, date, name, "spark.json"), JSON.stringify(meta, null, 1) + "\n");
  console.log(`[spark-run] started on ${host}: ${date}/${name}, lane ${values.lane} (${values.probe} waits for its lane's perf lock)`);
  if (values.detach) {
    console.log(`[spark-run] detached; bring it back with: node harness/remote/spark-run.mjs --fetch ${date}/${name}`);
    return;
  }
  process.exitCode = await follow(host, { date, name, meta });
}

// --multi: race-multi on the whole bench, base and candidates at once.
async function multi(host, values, rawPositionals) {
  if (!values.state) throw new Error("--multi needs --state <local .sav>");
  // The = form normalized first: the refused options, the scene protocol's
  // checks (lastOpt) and the queries all read the split form.
  const positionals = splitEquals(rawPositionals);
  for (let i = 0; i < positionals.length; i += 1) {
    if (["--query", "--config", "--baseline-query"].includes(positionals[i]) && !String(positionals[i + 1] ?? "").trim()) throw new Error(`${positionals[i]} is empty`);
  }
  for (const f of ["--iso", "--state", "--out", "--port", "--runs", "--arm", "--lanes", "--lock"]) {
    if (positionals.includes(f)) throw new Error(`${f} is set by spark-run --multi, not after --`);
  }
  const specs = multiArms(values.baseline, values.candidate, { lanes: values["multi-lanes"] == null ? 3 : String(values["multi-lanes"]).split(";").length });
  const lanes = multiLanes(values["multi-lanes"], specs.length); // refused before anything is pushed
  const { date, name } = runId({ name: values.name, candidate: values.candidate.join("+"), baseline: values.baseline });
  if (existsSync(path.join(MEASURES, date, name))) throw new Error(`${path.join(MEASURES, date, name)} exists: pick another --name`);
  const harnessFiles = listFiles(REPO_ROOT, HARNESS_ROOTS, HARNESS_SKIP);
  const harness = pushTree(host, { root: REPO_ROOT, files: harnessFiles, kind: "harness", key: contentKey(REPO_ROOT, harnessFiles) });
  const pushed = new Map();
  for (const spec of new Set(specs)) {
    const side = await pushSide(host, spec);
    checkLayoutFix(spec, side.source?.commit, gitIsAncestor);
    pushed.set(spec, side);
  }
  const state = pushState(host, path.resolve(values.state));
  const iso = benchDisc(host, values.iso);
  const home = ssh(host, "printf %s \"$HOME\"").out;
  const abs = (p) => `${home}/${p}`;
  const scene = path.basename(values.state);
  const raceArgs = multiRaceArgs({ iso: abs(iso), state: abs(state), runs: values.runs, armDirs: specs.map((s) => abs(pushed.get(s).dest)), lanes, extra: [...sceneMultiArgs(scene), ...positionals] });
  requireXfbSwitch(host, raceArgs, [...pushed.values()]);
  const sceneCheck = multiSceneCheck(scene, raceArgs);
  if (sceneCheck.errors.length) throw new Error(`scene protocol: ${sceneCheck.errors.join("; ")}`);
  for (const w of sceneCheck.warnings) console.warn(`[spark-run] scene protocol: ${w}`);
  if (sceneCheck.protocol) console.log(`[spark-run] ${scene}: pinned protocol (${sceneCheck.protocol.why})`);
  const outDir = abs(`${BENCH}/results/${date}/${name}`);
  const meta = {
    host: "spark", mode: "multi", hostname: ssh(host, "hostname").out.trim(), at: new Date().toISOString(),
    harness: { from: REPO_ROOT, key: path.basename(harness.dest) },
    arms: specs.map((s) => ({ spec: s, dest: pushed.get(s).dest, source: pushed.get(s).source ?? null })),
    raceArgs, ...(multiScreen(lanes) ? { screen: multiScreen(lanes) } : {}),
    sceneProtocol: sceneCheck.protocol ? { scene, ...sceneCheck.protocol, warnings: sceneCheck.warnings } : null
  };
  ssh(host, multiLaunchCommand({ harnessDir: abs(harness.dest), outDir, raceArgs }));
  mkdirSync(path.join(MEASURES, date, name), { recursive: true });
  writeFileSync(path.join(MEASURES, date, name, "spark.json"), JSON.stringify(meta, null, 1) + "\n");
  console.log(`[spark-run] multi started on ${host}: ${date}/${name}, arms ${specs.map((s, i) => `${i}=${s}`).join(" ")} (waits for the whole bench in the queue)`);
  if (meta.screen) console.log(`[spark-run] ${meta.screen}`);
  if (values.detach) {
    console.log(`[spark-run] detached; bring it back with: node harness/remote/spark-run.mjs --fetch ${date}/${name}`);
    return 0;
  }
  return follow(host, { date, name, meta });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(`[spark-run] ${e.message}`); process.exitCode = 2; });
}
