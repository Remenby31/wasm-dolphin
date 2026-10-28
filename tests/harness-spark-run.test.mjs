// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { kpiTable } from "../harness/lib/kpi.mjs";
import { estimateMin, eta, isBuildProcess, MAX_BUILDS_PER_OWNER, move, movedId, nextStep, ownerBuilds, readTickets, waitTurn } from "../harness/remote/spark-queue.mjs";
import { BENCH_XAUTHORITY, benchQuery, benchRaceArgs, builtOnBenchTest, headedEnv, launchCommand, RACE_QUERY, runId, sh, stampSummary } from "../harness/remote/spark-run.mjs";

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

test("spark-run --headed: the pair runs in the x11 display mode on the bench's bare Xorg, the display checked", () => {
  assert.deepEqual(headedEnv(null), [], "headless unless asked");
  assert.deepEqual(headedEnv(":2"), ["HARNESS_DISPLAY=x11", "DISPLAY=':2'", `XAUTHORITY='${BENCH_XAUTHORITY}'`]);
  assert.equal(BENCH_XAUTHORITY, "/run/salon-xorg/xauth");
  for (const bad of ["2", ":2; rm", "localhost:2", ""]) assert.throws(() => headedEnv(bad), /an X display as :N/);
  // --headless: headless whatever HARNESS_DISPLAY the bench holds; not with --headed.
  assert.deepEqual(headedEnv(null, BENCH_XAUTHORITY, { headless: true }), ["HARNESS_DISPLAY=headless"]);
  assert.throws(() => headedEnv(":2", BENCH_XAUTHORITY, { headless: true }), /one or the other/);
  assert.match(launchCommand({ harnessDir: "/h/k", outDir: "/h/r/d/n", raceArgs: [], headless: true }), /\{ HARNESS_DISPLAY=headless setsid nohup sh /);
  const cmd = launchCommand({ harnessDir: "/h/k", outDir: "/h/r/d/n", lane: "a", raceArgs: ["--display"], headed: ":2" });
  assert.match(cmd, /\{ HARNESS_DISPLAY=x11 DISPLAY=':2' XAUTHORITY='\/run\/salon-xorg\/xauth' setsid nohup sh harness\/remote\/spark-race\.sh /);
  execFileSync("bash", ["-n", "-c", cmd]);
  assert.doesNotMatch(launchCommand({ harnessDir: "/h/k", outDir: "/h/r/d/n", raceArgs: [] }), /DISPLAY/);
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
  assert.equal(estimateMin("build"), 3);
  const now = Date.parse("2026-10-22T00:30:00Z");
  const rows = eta([
    { id: "1", kind: "pair", name: "r", lane: "a", estMin: 13, grantedAt: "2026-10-22T00:25:00Z" },
    { id: "2", kind: "build", name: "b", lane: "none" }, // a neutral ticket counts for nothing
    { id: "3", kind: "pair", name: "p", estMin: 10 },
    { id: "4", kind: "build", name: "k" }
  ], now);
  assert.deepEqual(rows.map((r) => [r.name, r.startsIn, r.endsIn]), [["r", 0, 8], ["p", 8, 18], ["k", 18, 21]]);
});

test("spark-run: a core counts as built on the bench only when the bench built it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "spark-built-"));
  const built = (d) => { try { execFileSync("sh", ["-c", builtOnBenchTest(d)]); return true; } catch { return false; } };
  const core = (d, bytes = "ci") => { mkdirSync(path.join(d, "cores", "dolphin"), { recursive: true }); writeFileSync(path.join(d, "cores", "dolphin", "dolphin-core-upstream.wasm"), bytes); };
  const git = (d, ...a) => execFileSync("git", ["-C", d, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "ignore" });
  try {
    const plain = path.join(dir, "plain"); core(plain);
    assert.equal(built(plain), false); // a wasm alone proves nothing
    const exported = path.join(dir, "exported"); core(exported);
    writeFileSync(path.join(exported, ".harness-identity.json"), JSON.stringify({ commit: "c", builtOn: "spark" }));
    assert.equal(built(exported), true);
    // A checkout with the committed CI core (2026-10-22: four of these passed for built).
    const wt = path.join(dir, "wt"); core(wt); git(wt, "init", "-q"); git(wt, "add", "."); git(wt, "commit", "-qm", "ci core");
    assert.equal(built(wt), false);
    core(wt, "bench"); // what --install leaves
    assert.equal(built(wt), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spark queue: an agent's builds are counted for the cap of 3", () => {
  const b = (name, owner, lane = null) => ({ kind: "build", name, owner, lane });
  const q = [b("a1", "wt-jit", "a b"), b("a2", "wt-jit"), b("a3", "wt-jit"), b("r1", "wt-robust"), { kind: "pair", name: "p", owner: "wt-jit" }, b("old", undefined), b("w", "wt-jit", "none")];
  assert.equal(MAX_BUILDS_PER_OWNER, 3);
  assert.deepEqual(ownerBuilds(q, "wt-jit").map((t) => t.name), ["a1", "a2", "a3"]); // running and waiting; no pair, no neutral ticket
  assert.equal(ownerBuilds(q, "wt-robust").length, 1);
  assert.equal(ownerBuilds(q, "wt-kpi").length, 0);
});

test("spark-run --multi: three arms, the bench's validated options, refused before the layout fix", async () => {
  const { checkLayoutFix, LAYOUT_FIX, MULTI_LANES, multiArms, multiLaunchCommand, multiRaceArgs } = await import("../harness/remote/spark-run.mjs");
  assert.deepEqual(multiArms("main", ["lever"]), ["main", "lever", "main"], "one candidate: base again as the A/A control");
  assert.deepEqual(multiArms("main", ["l1", "l2"]), ["main", "l1", "l2"]);
  assert.throws(() => multiArms("main", []), /one or two --candidate/);
  assert.throws(() => multiArms("main", ["a", "b", "c"]), /one or two --candidate/);
  assert.throws(() => multiArms(undefined, ["a"]), /needs --baseline/);
  const args = multiRaceArgs({ iso: "/r/d", state: "/r/s.sav", runs: "6", armDirs: ["/t/0", "/t/1", "/t/0"], extra: ["--emulated-window", "20"] });
  assert.deepEqual(args.slice(0, 6), ["--iso", "/r/d", "--state", "/r/s.sav", "--runs", "6"]);
  assert.deepEqual(args.filter((_, i) => args[i - 1] === "--arm"), ["/t/0", "/t/1", "/t/0"]);
  assert.equal(args[args.indexOf("--lanes") + 1], MULTI_LANES);
  for (const o of ["--counters", "--aot-seed", "--isolated-boot"]) assert.ok(args.includes(o), o);
  assert.match(args[args.indexOf("--query") + 1], /cpu=single/);
  assert.match(args[args.indexOf("--query") + 1], /aot=1/);
  assert.equal(args.lastIndexOf("--emulated-window"), args.length - 2, "options after -- come last and win");
  assert.throws(() => multiRaceArgs({ iso: "i", state: "s", runs: "4", armDirs: ["a", "b", "c"] }), /multiple of 3/);
  const isAncestor = (a, b) => a === LAYOUT_FIX && b === "new";
  assert.doesNotThrow(() => checkLayoutFix("main", "new", isAncestor));
  assert.throws(() => checkLayoutFix("old", "243ef96384a1", isAncestor), /predates the region layout fix/);
  assert.throws(() => checkLayoutFix("dir", undefined, isAncestor), /no commit known/);
  const cmd = multiLaunchCommand({ harnessDir: "/h", outDir: "/o/20261022/x", raceArgs: ["--runs", "6"] });
  assert.match(cmd, /setsid nohup sh harness\/remote\/spark-multi\.sh '\/o\/20261022\/x' -- '--runs' '6'/);
  assert.match(cmd, /test ! -e '\/o\/20261022\/x\.log'/);
});

test("spark-queue: a multi takes the whole bench, in order of arrival, its estimate from its runs", () => {
  const free = () => false, busyA = (l) => l === "a";
  const pair = { id: "1", kind: "pair", lanes: "auto", name: "p" };
  const m = { id: "2", kind: "multi", lanes: "auto", name: "m" };
  const later = { id: "3", kind: "pair", lanes: "auto", name: "q" };
  assert.match(nextStep(m, [pair, m], free).wait, /pair p arrived first/);
  assert.deepEqual(nextStep(m, [m, later], free), { go: ["a", "b"] });
  assert.match(nextStep(m, [m], busyA).wait, /a lane is in use/);
  assert.match(nextStep(later, [{ ...m, lane: "a b" }, later], free).wait, /lane a in use/);
  assert.equal(estimateMin("multi", ["--runs", "6"]), 13);
  assert.equal(estimateMin("multi", ["--runs", "12"]), 22);
});

test("Spark Chromium: the bench's store-check flag is added once and merged with a probe's own --js-flags", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chrome-pinned-"));
  try {
    // taskset and Chromium stand-ins: print the arguments Chromium would get, one a line.
    writeFileSync(path.join(dir, "taskset"), "#!/bin/sh\nshift 2\nexec \"$@\"\n", { mode: 0o755 });
    writeFileSync(path.join(dir, "chromium"), "#!/bin/sh\nfor a in \"$@\"; do echo \"$a\"; done\n", { mode: 0o755 });
    const pinned = path.resolve(import.meta.dirname, "../harness/remote/chrome-pinned.sh");
    const run = (...args) => execFileSync("sh", [pinned, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SPARK_CHROMIUM: path.join(dir, "chromium") } }).trim().split("\n");
    assert.deepEqual(run("--headless", "--js-flags=--no-liftoff", "--js-flags=--wasm-partial-oob-writes-are-noops", "about:blank"),
      ["--headless", "about:blank", "--js-flags=--no-liftoff --wasm-partial-oob-writes-are-noops"]);
    assert.deepEqual(run("--headless", "a b"), ["--headless", "a b"], "no --js-flags: nothing added, spaces kept");
    // Both bench launchers add the flag through HARNESS_CHROME_ARGS (recorded in every summary).
    for (const f of ["spark-race.sh", "spark-multi.sh"]) {
      const src = readFileSync(path.resolve(import.meta.dirname, "../harness/remote", f), "utf8");
      assert.match(src, /export HARNESS_CHROME_ARGS="\$\{HARNESS_CHROME_ARGS:\+\$HARNESS_CHROME_ARGS \}--js-flags=--wasm-partial-oob-writes-are-noops"/, f);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spark-run --multi: a KPI scene is measured with its pinned protocol (heavy intro), the caller's options still win", async () => {
  const { multiRaceArgs, multiSceneCheck, sceneMultiArgs } = await import("../harness/remote/spark-run.mjs");
  const { sceneName } = await import("../harness/probes/race-multi.mjs");
  const base = { iso: "i", state: "s", runs: "6", armDirs: ["a", "b", "a"] };
  const last = (args, o) => args[args.lastIndexOf(o) + 1];
  // The heavy intro: warmup 1, window 6, no key, over the race defaults.
  const heavy = multiRaceArgs({ ...base, extra: sceneMultiArgs("heavy-intro-13s.sav") });
  assert.equal(last(heavy, "--emulated-window"), "6");
  assert.equal(last(heavy, "--emulated-warmup"), "1");
  assert.equal(last(heavy, "--hold"), "");
  assert.deepEqual(multiSceneCheck("heavy-intro-13s.sav", heavy).errors, []);
  assert.deepEqual(multiSceneCheck("heavy-intro-13s.sav", heavy).warnings, []);
  // The race defaults on the heavy scene (jit-0121b-heavy): refused, the window leaves the heavy phase.
  assert.match(multiSceneCheck("heavy-intro-13s.sav", multiRaceArgs(base)).errors.join(), /leaves the heavy phase/);
  // A scene without a protocol keeps the race defaults.
  assert.deepEqual(sceneMultiArgs("race-after.sav"), []);
  assert.equal(multiSceneCheck("race-after.sav", multiRaceArgs(base)).protocol, null);
  // The caller's option after -- still wins (and is checked).
  const longer = multiRaceArgs({ ...base, extra: [...sceneMultiArgs("heavy-intro-13s.sav"), "--emulated-window", "12"] });
  assert.match(multiSceneCheck("heavy-intro-13s.sav", longer).errors.join(), /12 s window/);
  // race-multi sees the bench's copy, renamed with its content hash.
  assert.equal(sceneName("/home/admin/salon-bench/roms/heavy-intro-13s-f3ea52d2e166.sav"), "heavy-intro-13s.sav");
  assert.equal(sceneName("race-after.sav"), "race-after.sav");
});

// --probe (2026-10-28): drop-meter and replay-gates run on the bench like
// race-perf (same lane, lock, cores, display); the Spark side picks the
// script from SPARK_PROBE, refusing any other name.
test("spark-run --probe: the probe goes in SPARK_PROBE, race-perf stays the default, other names refused", async () => {
  const { SPARK_PROBES } = await import("../harness/remote/spark-run.mjs");
  assert.deepEqual(SPARK_PROBES, ["race-perf", "drop-meter", "replay-gates"]);
  assert.doesNotMatch(launchCommand({ harnessDir: "/h/k", outDir: "/h/r/d/n", raceArgs: [] }), /SPARK_PROBE/);
  const cmd = launchCommand({ harnessDir: "/h/k", outDir: "/h/r/d/n", raceArgs: ["--display"], headed: ":2", probe: "drop-meter" });
  assert.match(cmd, /\{ SPARK_PROBE='drop-meter' HARNESS_DISPLAY=x11 DISPLAY=':2' /);
  assert.throws(() => launchCommand({ harnessDir: "/h/k", outDir: "/h/r/d/n", raceArgs: [], probe: "../../evil" }), /one of race-perf, drop-meter, replay-gates/);
  const { readFile } = await import("node:fs/promises");
  const race = await readFile(new URL("../harness/remote/spark-race.sh", import.meta.url), "utf8");
  assert.match(race, /case \$probe in\n\s+race-perf\|drop-meter\|replay-gates\) ;;/);
  assert.match(race, /node "harness\/probes\/\$probe\.mjs" "\$@" --port "\$port" --out "\$out"/);
  for (const p of SPARK_PROBES) assert.ok((await readFile(new URL(`../harness/probes/${p}.mjs`, import.meta.url), "utf8")).length > 0, `${p}.mjs exists`);
});
