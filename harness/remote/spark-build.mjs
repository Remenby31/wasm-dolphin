#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Spark side of spark-run.mjs --build: the core of one commit of the fork,
// built on the bench with the pinned toolchain (tools/build-core-repro.mjs,
// linux-arm64) into its own worktree, ~/salon-bench/build/wt/<commit>, and
// installed there (cores/dolphin), so that worktree is a side race-perf can
// serve (--candidate spark:<commit>). The build holds every lane's perf
// lock: no pair is measured while it compiles.
//
//   node harness/remote/spark-build.mjs <commit> [--jobs 16]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { done, laneLock, LANES, waitTurn } from "./spark-queue.mjs";

const [commit, ...rest] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("usage: spark-build.mjs <full commit sha> [build-core-repro options]");
const B = path.join(os.homedir(), "salon-bench", "build");
const clone = path.join(B, "wasm-dolphin");
const wt = path.join(B, "wt", commit);
const env = {
  ...process.env,
  RUSTUP_HOME: path.join(B, "rustup"), CARGO_HOME: path.join(B, "cargo"), WASM_TOOLCHAIN_DIR: path.join(B, ".tools"),
  PATH: `${path.join(B, "cargo", "bin")}:${process.env.PATH}`
};
const run = (cmd, args, cwd) => {
  console.log(`[spark-build] ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]}: exit ${r.status}`);
};

if (!existsSync(wt)) {
  run("git", ["fetch", "--quiet", "origin"], clone);
  run("git", ["worktree", "add", "--detach", wt, commit], clone);
}
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
  run("nice", ["-n", "10", "node", "tools/build-core-repro.mjs", "--install", ...(rest.length ? rest : ["--jobs", "16"])], wt);
} finally {
  for (const r of releases.reverse()) r();
}
console.log(`[spark-build] done: --candidate spark:${commit}`);
