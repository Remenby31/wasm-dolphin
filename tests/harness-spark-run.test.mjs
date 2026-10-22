// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { kpiTable } from "../harness/lib/kpi.mjs";
import { estimateMin, eta, isBuildProcess, move, movedId, nextStep, readTickets, waitTurn } from "../harness/remote/spark-queue.mjs";
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
  // One pair at a time: auto never means lane b.
  assert.match(nextStep(pair, [pair, b1, b2], busyA).wait, /lane a in use/);
  assert.deepEqual(nextStep(pair, [pair, b1, b2], free), { go: ["a"] });
  assert.match(nextStep(b1, [pair, b1, b2], free).wait, /pair pair1 arrived first/);
  // Once the pair runs in b, the build still needs both lanes.
  assert.match(nextStep(b1, [{ ...pair, lane: "b" }, b1, b2], free).wait, /in use/);
  assert.deepEqual(nextStep(b1, [b1, b2], free), { go: ["a", "b"] });
  assert.match(nextStep(b2, [b1, b2], free).wait, /build build2 arrived first/);
  // Two pairs: each its own lane; a lane-b pair does not wait for an older lane-a one.
  const pa = t(4, "pair", "a"), pb = t(5, "pair", "b");
  assert.deepEqual(nextStep(pb, [pa, pb], free), { go: ["b"] });
  assert.match(nextStep(t(6, "pair", "auto"), [{ ...pa, lane: "a" }, t(6, "pair", "auto")], free).wait, /lane a in use/);
});

test("spark queue: tickets on disk, dead ones dropped, the lane written once granted", async () => {
  const bench = mkdtempSync(path.join(os.tmpdir(), "spark-queue-"));
  try {
    const lane = await waitTurn({ pid: process.pid, kind: "pair", lanes: "auto", name: "x", bench, pollSec: 0.01 });
    assert.equal(lane, "a");
    writeFileSync(path.join(bench, "queue", "000000000000001-999999.json"), JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), kind: "build", lanes: "auto", name: "dead", lane: null }));
    const live = readTickets(bench);
    assert.deepEqual(live.map((x) => [x.name, x.lane]), [["x", "a"]]);
    // Our ticket runs in a: a second pair waits (one pair at a time).
    const second = waitTurn({ pid: process.ppid, kind: "pair", lanes: "auto", name: "y", bench, pollSec: 0.01 });
    assert.equal(await Promise.race([second, new Promise((r) => setTimeout(() => r("waiting"), 100))]), "waiting");
    rmSync(path.join(bench, "queue", live[0].id));
    assert.equal(await second, "a");
  } finally {
    rmSync(bench, { recursive: true, force: true });
  }
});

test("spark queue: a build is the node process, never the shell that started it", () => {
  assert.equal(isBuildProcess(["node", "harness/remote/spark-build.mjs", "2babd9cf"]), true);
  assert.equal(isBuildProcess(["/home/u/salon-bench/node/bin/node", "/h/harness/remote/spark-build.mjs", "x"]), true);
  // The wrapper spark-run starts it with: it once deadlocked the queue.
  assert.equal(isBuildProcess(["sh", "-c", "node harness/remote/spark-build.mjs 2babd9cf >> log 2>&1; echo $? > exit"]), false);
  assert.equal(isBuildProcess(["bash", "-c", "pgrep -f harness/remote/spark-build.mjs"]), false);
  assert.equal(isBuildProcess(["node", "harness/probes/race-perf.mjs"]), false);
});

test("spark queue: the judge moves a waiting ticket, the waiter follows it", async () => {
  const bench = mkdtempSync(path.join(os.tmpdir(), "spark-queue-"));
  const q = path.join(bench, "queue");
  const ticket = (ms, pid, name, lane = null) => writeFileSync(path.join(q, `${String(ms).padStart(15, "0")}-${pid}.json`), JSON.stringify({ pid, host: os.hostname(), kind: "pair", lanes: "a", name, lane, estMin: null }));
  try {
    mkdirSync(q);
    // Live pids: ours and our parent's stand for other jobs.
    ticket(1000, process.ppid, "running", "a");
    const waiting = waitTurn({ pid: process.pid, kind: "pair", lanes: "a", name: "late", bench, pollSec: 0.02 });
    await new Promise((r) => setTimeout(r, 50));
    const before = readTickets(bench).map((t) => t.name);
    assert.deepEqual(before, ["running", "late"]);
    // Move "late" to the head: still behind the running job, ahead of later ones.
    const id = move("late", "head", { bench });
    assert.equal(readTickets(bench).find((t) => t.name === "late").id, id);
    assert.match(readFileSync(path.join(q, "moves.log"), "utf8"), /judge: late after head/);
    // The running job ends: the moved waiter gets its turn under its new name, once.
    rmSync(path.join(q, "000000000001000-" + process.ppid + ".json"));
    assert.equal(await waiting, "a");
    const left = readTickets(bench);
    assert.equal(left.length, 1);
    assert.equal(left[0].id, id);
    assert.ok(left[0].grantedAt);
  } finally {
    rmSync(bench, { recursive: true, force: true });
  }
});

test("spark queue: move refuses what would break the order, a duplicate keeps the granted copy", () => {
  const t = (ms, name, lane = null, pid = ms) => ({ id: `${String(ms).padStart(15, "0")}-${pid}.json`, name, lane, pid, estMin: null });
  const q = [t(1000, "run", "a"), t(5000, "b1"), t(9000, "b2"), t(9001, "b3")];
  assert.equal(movedId(q, "b3", "head"), "000000000003000-9001.json"); // between run and b1
  assert.equal(movedId(q, "b1", "b3"), "000000000010001-5000.json"); // to the end
  assert.throws(() => movedId(q, "b1", "b2"), /no room between b2 and b3/); // 9000 and 9001
  assert.throws(() => movedId(q, "run", "head"), /already running/);
  // An old waiter (no estMin) cannot follow a rename: refused.
  const { estMin, ...old } = q[1];
  assert.throws(() => movedId([q[0], old, q[2]], "b1", "head"), /would wait for itself/);
  assert.throws(() => movedId(q, "nope", "head"), /no ticket/);
  assert.throws(() => movedId([t(1000, "a"), t(1001, "b"), t(5000, "c")], "c", "a"), /no room/);
  // Two files for one job (a move racing its grant): the granted one stays.
  const bench = mkdtempSync(path.join(os.tmpdir(), "spark-queue-"));
  try {
    mkdirSync(path.join(bench, "queue"));
    const w = (ms, lane) => writeFileSync(path.join(bench, "queue", `${String(ms).padStart(15, "0")}-${process.pid}.json`), JSON.stringify({ pid: process.pid, host: os.hostname(), kind: "pair", lanes: "a", name: "x", lane }));
    w(2000, null); w(3000, "a");
    assert.deepEqual(readTickets(bench).map((x) => [x.id.slice(0, 15), x.lane]), [["000000000003000", "a"]]);
    assert.equal(readdirSync(path.join(bench, "queue")).length, 1);
  } finally {
    rmSync(bench, { recursive: true, force: true });
  }
});

test("spark queue: estimated durations and each job's wait", () => {
  assert.equal(estimateMin("pair", ["--runs", "6", "--baseline", "/b", "--candidate", "/c"]), 13); // 6 × 2 × 65 s
  assert.equal(estimateMin("pair", ["--runs", "4", "--warmup", "10", "--secs", "10"]), 3); // one side
  assert.equal(estimateMin("build"), 8);
  const now = Date.parse("2026-10-22T00:30:00Z");
  const rows = eta([
    { id: "1", kind: "pair", name: "r", lane: "a", estMin: 13, grantedAt: "2026-10-22T00:25:00Z" },
    { id: "2", kind: "build", name: "b", lane: "none" }, // a neutral ticket counts for nothing
    { id: "3", kind: "pair", name: "p", estMin: 10 },
    { id: "4", kind: "build", name: "k" }
  ], now);
  assert.deepEqual(rows.map((r) => [r.name, r.startsIn, r.endsIn]), [["r", 0, 8], ["p", 8, 18], ["k", 18, 26]]);
});
