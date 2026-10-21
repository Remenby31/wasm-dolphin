#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Spark side of spark-run.mjs --build: the core of one commit of the fork,
// built on the bench with the pinned toolchain (tools/build-core-repro.mjs,
// linux-arm64) into its own worktree, ~/salon-bench/build/wt/<commit>, and
// installed there (cores/dolphin), so that worktree is a side race-perf can
// serve (--candidate spark:<commit>). The build holds the bench's perf lock:
// no pair is measured while it compiles.
//
//   node harness/remote/spark-build.mjs <commit> [--jobs 16]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquirePerfLock } from "../lib/perf-lock.mjs";

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
const release = await acquirePerfLock({ dir: path.join(os.homedir(), "salon-bench", ".perf-lock"), name: `spark-build ${commit.slice(0, 12)}`, waitSec: 3600, log: (m) => console.log(`[spark-build] ${m}`) });
try {
  run("nice", ["-n", "10", "node", "tools/build-core-repro.mjs", "--install", ...(rest.length ? rest : ["--jobs", "16"])], wt);
} finally {
  release();
}
console.log(`[spark-build] done: --candidate spark:${commit}`);
