// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { kpiTable } from "../harness/lib/kpi.mjs";
import { launchCommand, runId, sh, stampSummary } from "../harness/remote/spark-run.mjs";

const race = (extra = {}) => ({
  kind: "race-perf", file: "race",
  json: { probe: "race-perf", at: "2026-10-21T20:00:00Z", chrome: { path: "chrome stable", args: "" }, maxLoad: 6, failed: [], served: { candidate: { commit: "T1", dirty: false } }, candidate: { cold: { speed: { median: 90 }, presentP99Ms: { median: 30 } } }, ...extra }
});

test("spark-run: a bench result never feeds trunk's absolute KPI rows", () => {
  const trunk = new Set(["T1"]);
  const mac = Object.fromEntries(kpiTable([race()], {}, { trunk }).map((r) => [r.id, r]));
  assert.equal(mac.macSpeed.value, 90);
  // Even with the Mac's own chrome fields, a stamped summary is left out.
  const stamped = stampSummary(race().json, { host: "spark" });
  assert.equal(stamped.host, "spark");
  assert.equal(stamped.chromium, "playwright");
  const spark = Object.fromEntries(kpiTable([{ ...race(), json: stamped }], {}, { trunk }).map((r) => [r.id, r]));
  assert.equal(spark.macSpeed.value, null);
  assert.equal(spark.raceFrameP99.value, null);
});

test("spark-run: run names are path-safe and dated", () => {
  const now = new Date("2026-10-21T19:05:00Z");
  assert.deepEqual(runId({ name: "a/a ../x", now }), { date: "20261021", name: "a-a-..-x" });
  assert.deepEqual(runId({ candidate: "/w/wt-jit", baseline: "origin/main", now }), { date: "20261021", name: "wt-jit-vs-main-1905" });
});

test("spark-run: the launch command quotes every argument for the remote shell", () => {
  const cmd = launchCommand({ harnessDir: "/h/salon-bench/harness/k", outDir: "/h/salon-bench/results/d/n", raceArgs: ["--query", "video=wgpu&cpu=dual", "--warmup", "it's"], chromeCpus: "15-19" });
  assert.match(cmd, /SPARK_CHROME_CPUS='15-19' setsid nohup sh harness\/remote\/spark-race\.sh '\/h\/salon-bench\/results\/d\/n' -- '--query' 'video=wgpu&cpu=dual'/);
  assert.match(cmd, /^mkdir -p '\/h\/salon-bench\/results\/d' && test ! -e '\/h\/salon-bench\/results\/d\/n\.log' && cd '\/h\/salon-bench\/harness\/k' && /);
  // What sh() quotes, a POSIX shell reads back unchanged.
  const dir = mkdtempSync(path.join(os.tmpdir(), "spark-run-test-"));
  try {
    const script = path.join(dir, "echo.sh");
    writeFileSync(script, 'for a in "$@"; do printf "%s\\n" "$a"; done\n');
    const args = ["it's", "a&b", "$HOME", "x y"];
    assert.equal(execFileSync("sh", ["-c", `sh ${sh(script)} ${args.map(sh).join(" ")}`], { encoding: "utf8" }), args.join("\n") + "\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
