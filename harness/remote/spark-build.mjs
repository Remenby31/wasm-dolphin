#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Spark side of spark-run.mjs --build: the core of one commit of the fork,
// built on the bench with the pinned toolchain (tools/build-core-repro.mjs,
// linux-arm64), and the tree it serves exported to
// ~/salon-bench/build/wt/<commit> (index.html, src, cores, tools), a side
// race-perf can serve (--candidate spark:<commit>). The build holds every
// lane's perf lock: no pair is measured while it compiles.
//
// Every commit is built in one checkout, ~/salon-bench/build/work: its
// CMake tree, its Dolphin sources and the ccache (~/salon-bench/build/ccache)
// carry over from one build to the next. ccache entries only match at the
// same path (no CCACHE_BASEDIR, see ccacheEnvironment), and the path maps
// make the core's bytes independent of that path. A commit after another
// only recompiles what differs, instead of a fresh worktree per commit
// (sources fetched again, every file compiled: ~7 min).
//   node harness/remote/spark-build.mjs <commit> [--jobs 16]
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { done, laneLock, LANES, waitTurn } from "./spark-queue.mjs";

const [commit, ...rest] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("usage: spark-build.mjs <full commit sha> [build-core-repro options]");
const B = path.join(os.homedir(), "salon-bench", "build");
const clone = path.join(B, "wasm-dolphin");
const work = path.join(B, "work");
const wt = path.join(B, "wt", commit);
const env = {
  ...process.env,
  RUSTUP_HOME: path.join(B, "rustup"), CARGO_HOME: path.join(B, "cargo"), WASM_TOOLCHAIN_DIR: path.join(B, ".tools"),
  CCACHE_DIR: path.join(B, "ccache"), CCACHE_MAXSIZE: "20G",
  PATH: `${path.join(B, "cargo", "bin")}:${process.env.PATH}`
};
// What race-perf serves from a tree (lib/server.mjs) and needs to resolve it.
export const SERVED = ["index.html", "src", "cores", "tools"];
const run = (cmd, args, cwd) => {
  console.log(`[spark-build] ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]}: exit ${r.status}`);
};

// Built on the bench: an exported tree (builtOn spark), or an older
// per-commit worktree whose cores/ --install changed. Not a mere wasm: every
// checkout carries the committed CI core.
export function builtOnBench(dir) {
  if (!existsSync(path.join(dir, "cores", "dolphin", "dolphin-core-upstream.wasm"))) return false;
  try { if (JSON.parse(readFileSync(path.join(dir, ".harness-identity.json"), "utf8")).builtOn === "spark") return true; } catch {}
  if (!existsSync(path.join(dir, ".git"))) return false;
  const r = spawnSync("git", ["-C", dir, "status", "--porcelain", "--", "cores"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() !== "";
}
if (builtOnBench(wt)) {
  console.log(`[spark-build] already built: --candidate spark:${commit}`);
  process.exit(0);
}
// A per-commit worktree from an older spark-build (its own build, maybe
// under way): never replaced.
if (existsSync(path.join(wt, ".git"))) throw new Error(`${wt} is a worktree of an older spark-build without a core: remove it (git worktree remove) once nothing builds there`);
run("git", ["fetch", "--quiet", "origin"], clone);
// Its turn in the bench's queue, then every lane's lock, always in the same
// order: a build on 16 jobs would disturb a pair in either cluster.
await waitTurn({ pid: process.pid, kind: "build", name: commit.slice(0, 12), log: (m) => console.log(`[spark-build] ${m}`) });
process.once("exit", () => done(process.pid));
const releases = [];
for (const dir of LANES.map((l) => laneLock(l))) {
  mkdirSync(path.dirname(dir), { recursive: true });
  releases.push(await acquirePerfLock({ dir, name: `spark-build ${commit.slice(0, 12)}`, waitSec: 4 * 3600, log: (m) => console.log(`[spark-build] ${m}`) }));
}
try {
  // The commit in the build checkout; ignored files (build/, vendor/) stay,
  // anything else left by the previous commit goes.
  if (!existsSync(work)) run("git", ["worktree", "add", "--detach", work, commit], clone);
  else {
    run("git", ["checkout", "--quiet", "--force", "--detach", commit], work);
    run("git", ["clean", "-q", "-fd"], work);
  }
  // --reset-vendor: the previous commit's patch series may differ; only the
  // files it changes are rewritten, so the rest keeps its objects.
  run("nice", ["-n", "10", "node", "tools/build-core-repro.mjs", "--install", "--reset-vendor", "--ccache", ...(rest.length ? rest : ["--jobs", "16"])], work);
  // The served tree, published whole (written aside, then renamed).
  const tmp = `${wt}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // Not tools/'s Rust build output (naga): never served, and large.
  for (const f of SERVED) cpSync(path.join(work, f), path.join(tmp, f), { recursive: true, filter: (src) => !/\/target(?:\/|$)/.test(src) });
  writeFileSync(path.join(tmp, ".harness-identity.json"), JSON.stringify({ ref: `spark:${commit}`, commit, dirty: true, builtOn: "spark" }));
  rmSync(wt, { recursive: true, force: true });
  renameSync(tmp, wt);
} finally {
  for (const r of releases.reverse()) r();
}
console.log(`[spark-build] done: --candidate spark:${commit}`);
