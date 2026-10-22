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
//     [--keep-video] [-- <race-perf options: --query, --warmup, --secs, --max-load, …>]
//   node harness/remote/spark-run.mjs --fetch <date>/<name>   (a detached run)
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
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { exportRef } from "../cli.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { REPO_ROOT } from "../lib/browser.mjs";
import { IDENTITY_FILE, snapshotTree } from "../lib/server.mjs";
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
export const RACE_QUERY = "core=upstream&video=wgpu&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=60&oc=1";
export function benchQuery(query) {
  const q = new URLSearchParams(PRESETS[query] ?? query);
  if (q.get("video") === "wgpu") q.set("video", "null");
  if (q.get("video") === "null" && (q.get("presenter") ?? "webgpu") === "webgpu") q.set("presenter", "2d");
  return q.toString();
}

// race-perf's options after --, with every query made fit for the bench
// (--config becomes a --query).
export function benchRaceArgs(args, { keepVideo = false } = {}) {
  const out = [], swaps = [];
  let hasQuery = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (["--query", "--config", "--baseline-query"].includes(a) && i + 1 < args.length) {
      const from = args[(i += 1)];
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
  return { ...summary, host: bench.host, chromium: "playwright", bench };
}

// The Spark command that starts the pair detached and returns at once.
export function launchCommand({ harnessDir, outDir, lane = "auto", raceArgs, chromeCpus, nodeCpus }) {
  const env = [chromeCpus && `SPARK_CHROME_CPUS=${sh(chromeCpus)}`, nodeCpus && `SPARK_NODE_CPUS=${sh(nodeCpus)}`].filter(Boolean).join(" ");
  return [
    `mkdir -p ${sh(path.posix.dirname(outDir))}`,
    // Two pairs never share a name (race-perf refuses an existing --out, the log would mix).
    `test ! -e ${sh(`${outDir}.log`)}`,
    `cd ${sh(harnessDir)}`,
    `{ ${env ? `${env} ` : ""}setsid nohup sh harness/remote/spark-race.sh ${sh(outDir)} ${sh(lane)} -- ${raceArgs.map(sh).join(" ")} </dev/null >/dev/null 2>&1 & }`,
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
  ssh(host, `mkdir -p ${BENCH}/build/wt && test ! -e ${base}.log && cd ${harness.dest} && { PATH="$HOME/${BENCH}/node/bin:$PATH" setsid nohup sh -c 'node harness/remote/spark-build.mjs ${commit} >> $HOME/${base}.log 2>&1; echo $? > $HOME/${base}.exit' </dev/null >/dev/null 2>&1 & }`);
  console.log(`[spark-run] building ${commit.slice(0, 12)} on ${host} (waits for the bench's perf lock; ~8 min, first build of a worktree more)`);
  const exit = await followLog(host, base, { lost: `the build goes on there: ssh ${host} cat ~/${base}.log` });
  if (exit === 0) console.log(`[spark-run] built: --candidate spark:${commit}`);
  return exit;
}

function fetchResult(host, { date, name, meta, exit }) {
  const local = path.join(MEASURES, date, name);
  mkdirSync(local, { recursive: true });
  const tar = ssh(host, `tar -c -C ${BENCH}/results/${date} ${name} ${name}.log ${name}.exit ${name}.lane 2>/dev/null; true`).bytes;
  execFileSync("tar", ["-x", "-C", path.dirname(local)], { input: tar });
  // name.log / .exit / .lane land next to the directory: keep them inside.
  for (const ext of ["log", "exit", "lane"]) {
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
    console.log(`[spark-run] ${c ? `paired change ${c.median ?? `withheld (${c.withheld})`}${c.median != null ? " %" : ""}, per run ${c.perRun.join(" ")}` : `speed ${summary.candidate?.cold?.speed?.median} %`} -> ${local}`);
  } else console.log(`[spark-run] no summary (exit ${exit}), see ${path.join(local, "spark-run.log")}`);
  return exit;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      candidate: { type: "string" }, baseline: { type: "string" }, state: { type: "string" }, iso: { type: "string" },
      name: { type: "string" }, runs: { type: "string", default: "6" }, lane: { type: "string", default: "auto" },
      host: { type: "string", default: process.env.SPARK_HOST || "spark" },
      "chrome-cpus": { type: "string" }, "node-cpus": { type: "string" }, "keep-video": { type: "boolean", default: false },
      detach: { type: "boolean", default: false }, fetch: { type: "string" }, build: { type: "string" }
    },
    allowPositionals: true
  });
  const host = values.host;
  if (values.build) {
    process.exitCode = await build(host, values.build);
    return;
  }
  if (values.fetch) {
    const [date, name] = values.fetch.split("/");
    process.exitCode = await follow(host, { date, name: safeName(name) });
    return;
  }
  if (!values.candidate || !values.state) throw new Error("usage: spark-run.mjs --candidate <ref|dir> [--baseline <ref|dir>] --state <local .sav> [--name n] [--runs 6] [--detach] [-- race-perf options]");
  for (const f of ["--iso", "--state", "--out", "--port", "--runs", "--candidate", "--baseline", "--core-candidate"]) {
    if (positionals.includes(f)) throw new Error(`${f} is set by spark-run, not after --`);
  }
  if (values.lane === "b") throw new Error("--lane b: two pairs at once disturb each other on the Spark (A/A of 2026-10-21: σ 1.86 pt), pairs run one at a time in lane a");
  if (!["auto", "a"].includes(values.lane)) throw new Error(`--lane ${values.lane}: a or auto`);
  const { date, name } = runId(values);
  if (existsSync(path.join(MEASURES, date, name))) throw new Error(`${path.join(MEASURES, date, name)} exists: pick another --name`);

  const harnessFiles = listFiles(REPO_ROOT, HARNESS_ROOTS, HARNESS_SKIP);
  const harness = pushTree(host, { root: REPO_ROOT, files: harnessFiles, kind: "harness", key: contentKey(REPO_ROOT, harnessFiles) });
  const candidate = await pushSide(host, values.candidate);
  const baseline = values.baseline ? (values.baseline === values.candidate ? candidate : await pushSide(host, values.baseline)) : null;
  const state = pushState(host, path.resolve(values.state));
  const iso = benchDisc(host, values.iso);
  const home = ssh(host, "printf %s \"$HOME\"").out;
  const abs = (p) => `${home}/${p}`;
  const bench = benchRaceArgs(positionals, { keepVideo: values["keep-video"] });
  for (const s of bench.swaps) console.log(`[spark-run] ${s.option} on the bench: ${s.to} (was ${s.from})`);
  const raceArgs = [
    "--iso", abs(iso), "--state", abs(state), "--runs", values.runs,
    "--candidate", abs(candidate.dest), ...(baseline ? ["--baseline", abs(baseline.dest)] : []),
    ...bench.args
  ];
  const outDir = abs(`${BENCH}/results/${date}/${name}`);
  const meta = {
    host: "spark", hostname: ssh(host, "hostname").out.trim(), at: new Date().toISOString(),
    chromiumVersion: ssh(host, `c=$(ls -d ${BENCH}/ms-playwright/chromium-*/chrome-linux*/chrome | sort -V | tail -1) && "$c" --version`).out.trim(),
    chromeCpus: values["chrome-cpus"] ?? "lane", nodeCpus: values["node-cpus"] ?? "lane",
    harness: { from: REPO_ROOT, key: path.basename(harness.dest) },
    sides: { candidate, ...(baseline ? { baseline } : {}) },
    querySwaps: bench.swaps,
    raceArgs
  };
  ssh(host, launchCommand({ harnessDir: abs(harness.dest), outDir, lane: values.lane, raceArgs, chromeCpus: values["chrome-cpus"], nodeCpus: values["node-cpus"] }));
  mkdirSync(path.join(MEASURES, date, name), { recursive: true });
  writeFileSync(path.join(MEASURES, date, name, "spark.json"), JSON.stringify(meta, null, 1) + "\n");
  console.log(`[spark-run] started on ${host}: ${date}/${name}, lane ${values.lane} (race-perf waits for its lane's perf lock)`);
  if (values.detach) {
    console.log(`[spark-run] detached; bring it back with: node harness/remote/spark-run.mjs --fetch ${date}/${name}`);
    return;
  }
  process.exitCode = await follow(host, { date, name, meta });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(`[spark-run] ${e.message}`); process.exitCode = 2; });
}
