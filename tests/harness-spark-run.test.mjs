// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { kpiTable } from "../harness/lib/kpi.mjs";
import { nextStep, readTickets, waitTurn } from "../harness/remote/spark-queue.mjs";
import { benchQuery, benchRaceArgs, launchCommand, RACE_QUERY, runId, sh, stampSummary } from "../harness/remote/spark-run.mjs";

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
  const cmd = launchCommand({ harnessDir: "/h/salon-bench/harness/k", outDir: "/h/salon-bench/results/d/n", lane: "b", raceArgs: ["--query", "video=wgpu&cpu=dual", "--warmup", "it's"], chromeCpus: "15-19" });
  assert.match(cmd, /\{ SPARK_CHROME_CPUS='15-19' setsid nohup sh harness\/remote\/spark-race\.sh '\/h\/salon-bench\/results\/d\/n' 'b' -- '--query' 'video=wgpu&cpu=dual'/);
  assert.match(cmd, /^mkdir -p '\/h\/salon-bench\/results\/d' && test ! -e '\/h\/salon-bench\/results\/d\/n\.log' && cd '\/h\/salon-bench\/harness\/k' && /);
  // The whole command parses (a bare `& &&` does not).
  execFileSync("bash", ["-n", "-c", cmd]);
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

test("spark-run: wgpu runs as video=null on the bench, the rest of the query kept", () => {
  assert.equal(benchQuery("core=upstream&video=wgpu&presenter=webgpu&cpu=dual&jitwarmup=60&aot=1"), "core=upstream&video=null&presenter=2d&cpu=dual&jitwarmup=60&aot=1");
  assert.equal(benchQuery("wgpu"), "core=upstream&video=null&presenter=2d&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1");
  assert.equal(benchQuery("video=software&presenter=webgpu"), "video=software&presenter=webgpu");
  // No query: the race's own, swapped; --config becomes a --query; --baseline-query too.
  const none = benchRaceArgs(["--warmup", "25"]);
  assert.deepEqual(none.args, ["--warmup", "25", "--lock-wait", "14400", "--query", benchQuery(RACE_QUERY)]);
  assert.equal(none.swaps.length, 1);
  const both = benchRaceArgs(["--config", "wgpu", "--baseline-query", "video=wgpu&aot=1"]);
  assert.deepEqual(both.args, ["--query", benchQuery("wgpu"), "--baseline-query", "video=null&aot=1&presenter=2d", "--lock-wait", "14400"]);
  // An explicit --lock-wait is kept.
  assert.deepEqual(benchRaceArgs(["--query", "video=wgpu", "--lock-wait", "60"], { keepVideo: true }).args, ["--query", "video=wgpu", "--lock-wait", "60"]);
});

test("spark queue: first come, first served, a burst of builds cannot starve a pair", () => {
  const t = (id, kind, lanes, lane = null) => ({ id: `${id}`, kind, lanes, lane, name: `${kind}${id}` });
  const free = () => false;
  // A pair waiting before three builds: the builds wait for it.
  const pair = t(1, "pair", "auto"), b1 = t(2, "build", "auto"), b2 = t(3, "build", "auto");
  const busyA = (l) => l === "a"; // lane a still held by a job from before the queue
  assert.deepEqual(nextStep(pair, [pair, b1, b2], busyA), { go: ["b"] });
  assert.match(nextStep(b1, [pair, b1, b2], free).wait, /pair pair1 arrived first/);
  // Once the pair runs in b, the build still needs both lanes.
  assert.match(nextStep(b1, [{ ...pair, lane: "b" }, b1, b2], free).wait, /in use/);
  assert.deepEqual(nextStep(b1, [b1, b2], free), { go: ["a", "b"] });
  assert.match(nextStep(b2, [b1, b2], free).wait, /build build2 arrived first/);
  // Two pairs: each its own lane; a lane-b pair does not wait for an older lane-a one.
  const pa = t(4, "pair", "a"), pb = t(5, "pair", "b");
  assert.deepEqual(nextStep(pb, [pa, pb], free), { go: ["b"] });
  assert.deepEqual(nextStep(t(6, "pair", "auto"), [{ ...pa, lane: "a" }, t(6, "pair", "auto")], free), { go: ["b"] });
  assert.match(nextStep(t(7, "pair", "auto"), [{ ...pa, lane: "a" }, { ...pb, lane: "b" }, t(7, "pair", "auto")], free).wait, /lanes a b in use/);
});

test("spark queue: tickets on disk, dead ones dropped, the lane written once granted", async () => {
  const bench = mkdtempSync(path.join(os.tmpdir(), "spark-queue-"));
  try {
    const lane = await waitTurn({ pid: process.pid, kind: "pair", lanes: "auto", name: "x", bench, pollSec: 0.01 });
    assert.equal(lane, "a");
    writeFileSync(path.join(bench, "queue", "000000000000001-999999.json"), JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), kind: "build", lanes: "auto", name: "dead", lane: null }));
    const live = readTickets(bench);
    assert.deepEqual(live.map((x) => [x.name, x.lane]), [["x", "a"]]);
    // Our ticket runs in a: a second pair gets b.
    assert.equal(await waitTurn({ pid: process.ppid, kind: "pair", lanes: "auto", name: "y", bench, pollSec: 0.01 }), "b");
  } finally {
    rmSync(bench, { recursive: true, force: true });
  }
});
