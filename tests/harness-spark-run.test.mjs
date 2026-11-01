// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
  assert.equal(benchQuery("core=upstream&video=wgpu&presenter=webgpu&cpu=dual&jitwarmup=60&aot=1"), "core=upstream&video=null&presenter=2d&cpu=dual&jitwarmup=60&aot=1&xfbdecode=0");
  assert.equal(benchQuery("wgpu"), "core=upstream&video=null&presenter=2d&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1&xfbdecode=0");
  // The XFB decode the product never pays is off on the bench unless asked (2026-10-31).
  assert.equal(benchQuery("video=wgpu&xfbdecode=1"), "video=null&xfbdecode=1&presenter=2d");
  assert.equal(benchQuery("video=software&presenter=webgpu"), "video=software&presenter=webgpu");
  // No query: the race's own, swapped; --config becomes a --query; --baseline-query too.
  const none = benchRaceArgs(["--warmup", "25"]);
  assert.deepEqual(none.args, ["--warmup", "25", "--lock-wait", "14400", "--query", benchQuery(RACE_QUERY)]);
  assert.equal(none.swaps.length, 1);
  const both = benchRaceArgs(["--config", "wgpu", "--baseline-query", "video=wgpu&aot=1"]);
  assert.deepEqual(both.args, ["--query", benchQuery("wgpu"), "--baseline-query", "video=null&aot=1&presenter=2d&xfbdecode=0", "--lock-wait", "14400"]);
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
  // 2026-10-28: a waiting ticket older than the running one (img-gpu-ir2-light
  // before img-gpu-ir1-light, running): "head" goes just after the running
  // ticket by position, not at the count of running tickets
  const q2 = [t(1000, "older-waiting"), t(2000, "running", "a"), t(5000, "w1"), t(9000, "smoke")];
  const id = movedId(q2, "smoke", "head");
  assert.ok(id < q2[0].id, `head goes before the first waiting ticket, even before the running one (${id})`);
  // once the running job is through, the moved ticket is the first to go on lane a
  const moved = q2.map((x) => (x.name === "smoke" ? { ...x, id, kind: "pair", lanes: "a" } : { ...x, kind: "pair", lanes: "a" }));
  const after = moved.filter((x) => x.name !== "running").sort((x, y) => (x.id < y.id ? -1 : 1));
  const free = () => false;
  assert.deepEqual(nextStep(after.find((x) => x.name === "smoke"), after, free), { go: ["a"] });
  assert.match(nextStep(after.find((x) => x.name === "older-waiting"), after, free).wait, /pair smoke arrived first/);
  // eta counts the running job first, even with a waiting ticket sorted before it
  const withRunning = [...moved].sort((x, y) => (x.id < y.id ? -1 : 1)).map((x) => (x.name === "running" ? { ...x, estMin: 20, grantedAt: new Date(Date.now() - 5 * 60000).toISOString() } : { ...x, estMin: 10 }));
  assert.equal(eta(withRunning).find((x) => x.name === "smoke").startsIn, 15, "the smoke starts once the running job is through");
  // a named target before a running job is still refused
  assert.throws(() => movedId(q2, "smoke", "older-waiting"), /before a running job/);
  assert.equal(movedId([t(1000, "w0"), t(5000, "w1")], "w1", "head"), "000000000000000-5000.json", "nothing running: before every waiting ticket");
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

test("spark-run --multi-lanes: one lane per arm, disjoint, off node's cores; the three-lane default needs three arms", async () => {
  const { multiArms, multiLanes, MULTI_LANES, multiRaceArgs } = await import("../harness/remote/spark-run.mjs");
  // two lanes: baseline and candidate, no third arm
  assert.deepEqual(multiArms("base", ["cand"], { lanes: 2 }), ["base", "cand"]);
  assert.deepEqual(multiArms("base", ["cand"]), ["base", "cand", "base"]);
  assert.throws(() => multiArms("base", ["c1", "c2"], { lanes: 2 }), /two lanes: one --candidate/);
  assert.equal(multiLanes(null, 3), MULTI_LANES);
  assert.throws(() => multiLanes(null, 2), /--multi with 2 arms: --multi-lanes/);
  // the two pair lanes' big cores, one arm each (simultaneous A/B, lanes swapped by race-multi)
  assert.equal(multiLanes("15-19;5-9", 2), "15,16,17,18,19;5,6,7,8,9");
  assert.throws(() => multiLanes("15-19", 2), /1 lanes for 2 arms/);
  assert.throws(() => multiLanes("15-19;17-21", 2), /cpus 0-19/);
  assert.throws(() => multiLanes("15-19;5-9,15", 2), /share cpus|different sizes/);
  assert.throws(() => multiLanes("10-14;5-9", 2), /cpus 10-14 run node/);
  // review of #345: an A725 lane (0-4, 2.8 GHz) against an X925 one measures the cores
  assert.throws(() => multiLanes("15-19;0-4", 2), /cpus 0-4 are Cortex-A725/);
  assert.throws(() => multiLanes("5,6,7;15,16,17;2,3,4", 3), /Cortex-A725/);
  assert.throws(() => multiLanes("15-19;5-8", 2), /different sizes/);
  assert.throws(() => multiLanes("a;b", 2), /cpus as n or n-m/);
  const args = multiRaceArgs({ iso: "/d.iso", state: "/s.sav", runs: 6, armDirs: ["/a", "/b"], lanes: "15,16,17,18,19;5,6,7,8,9" });
  assert.equal(args[args.indexOf("--lanes") + 1], "15,16,17,18,19;5,6,7,8,9");
});

test("spark-run --queue: each ticket's wait and estimate, a waiting ticket past an hour flagged", async () => {
  const { queueRows, QUEUE_STARVED_MIN } = await import("../harness/remote/spark-run.mjs");
  assert.equal(QUEUE_STARVED_MIN, 60);
  const now = Date.parse("2026-10-28T12:00:00Z");
  const rows = queueRows([
    { kind: "pair", name: "x11-a", owner: "wt-x", at: "2026-10-28T11:50:00Z", lane: "a", endsIn: 7 },
    { kind: "pair", name: "late", owner: "wt-y", at: "2026-10-28T10:30:00Z", lane: null, startsIn: 7 },
    { kind: "pair", name: "held", at: "2026-10-28T11:55:00Z", lane: null, holdUntil: "2026-10-28T12:01:00Z", startsIn: 20 }
  ], now);
  assert.deepEqual(rows, [
    "pair x11-a (wt-x) [wants ?] running in a, 10 min since queued, ends in ~7 min",
    "STARVED pair late (wt-y) [wants ?] waiting, 90 min since queued, starts in ~7 min",
    "pair held [wants ?] held (cores busy), 5 min since queued, starts in ~20 min"
  ]);
  // review of #345: a ticket that stepped aside on its own (cores busy) is not starved
  const [heldLong] = queueRows([{ kind: "multi", name: "aa", at: "2026-10-28T10:00:00Z", lane: null, holdUntil: "2026-10-28T12:01:00Z", startsIn: 30 }], now);
  assert.equal(heldLong, "multi aa [wants ?] held (cores busy), 120 min since queued, starts in ~30 min");
});

// --probe (2026-10-28): drop-meter and replay-gates run on the bench like
// race-perf (same lane, lock, cores, display); the Spark side picks the
// script from SPARK_PROBE, refusing any other name.
test("spark-run --probe: the probe goes in SPARK_PROBE, race-perf stays the default, other names refused", async () => {
  const { SPARK_PROBES } = await import("../harness/remote/spark-run.mjs");
  assert.deepEqual(SPARK_PROBES, ["race-perf", "drop-meter", "replay-gates", "parcours"]);
  assert.doesNotMatch(launchCommand({ harnessDir: "/h/k", outDir: "/h/r/d/n", raceArgs: [] }), /SPARK_PROBE/);
  const cmd = launchCommand({ harnessDir: "/h/k", outDir: "/h/r/d/n", raceArgs: ["--display"], headed: ":2", probe: "drop-meter" });
  assert.match(cmd, /\{ SPARK_PROBE='drop-meter' HARNESS_DISPLAY=x11 DISPLAY=':2' /);
  assert.throws(() => launchCommand({ harnessDir: "/h/k", outDir: "/h/r/d/n", raceArgs: [], probe: "../../evil" }), /one of race-perf, drop-meter, replay-gates, parcours/);
  const { readFile } = await import("node:fs/promises");
  const race = await readFile(new URL("../harness/remote/spark-race.sh", import.meta.url), "utf8");
  assert.match(race, /case \$probe in\n\s+race-perf\|drop-meter\|replay-gates\|parcours\) ;;/);
  assert.match(race, /node "harness\/probes\/\$probe\.mjs" "\$@" --port "\$port" --out "\$out"/);
  for (const p of SPARK_PROBES) assert.ok((await readFile(new URL(`../harness/probes/${p}.mjs`, import.meta.url), "utf8")).length > 0, `${p}.mjs exists`);
});

// Review of #335: a presentation gate that would pass without exercising the
// presentation, or without a reading, is refused.
test("spark-run --probe drop-meter|replay-gates: --headed, an explicit wgpu --query, --extra never touches video", async () => {
  const { checkPresentationProbe } = await import("../harness/remote/spark-run.mjs");
  const q = "core=upstream&video=wgpu&presenter=webgpu&jitwarmup=700";
  const args = (raw, headed = ":2") => benchRaceArgs(raw, { keepVideo: Boolean(headed) }).args;
  assert.throws(() => checkPresentationProbe("replay-gates", ["--query", q], args(["--query", q], null), null), /needs --headed/);
  assert.throws(() => checkPresentationProbe("drop-meter", ["--display"], args(["--display"]), ":2"), /explicit --query/);
  assert.throws(() => checkPresentationProbe("drop-meter", ["--query", "video=software"], args(["--query", "video=software"]), ":2"), /video=wgpu needed/);
  assert.throws(() => checkPresentationProbe("drop-meter", ["--query", q, "--baseline-query", "video=null"], args(["--query", q, "--baseline-query", "video=null"]), ":2"), /--baseline-query video=null: video=wgpu needed/);
  assert.throws(() => checkPresentationProbe("replay-gates", ["--query", q, "--extra", "&video=null"], args(["--query", q, "--extra", "&video=null"]), ":2"), /--extra must not change video=/);
  assert.doesNotThrow(() => checkPresentationProbe("replay-gates", ["--query", q, "--extra", "&wgpureplayms=4"], args(["--query", q, "--extra", "&wgpureplayms=4"]), ":2"));
  const { readFile } = await import("node:fs/promises");
  const run = await readFile(new URL("../harness/remote/spark-run.mjs", import.meta.url), "utf8");
  assert.match(run, /positionals\.includes\("--no-lock"\)\) throw/);
  const gates = await readFile(new URL("../harness/probes/replay-gates.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(gates, /baseline-query|baseline: \{/, "both sides from one tree: no --baseline");
  assert.match(gates, /process\.exit\(failed\.length \|\| empty\.length \|\| summary\.integrity\.length \|\| flickerFails \? 1 : 0\)/);
  // review of 768b7be1: a reading needs the tracker on and presses seen
  assert.match(gates, /!v\.input\?\.enabled \|\| !v\.input\.visibleCount/);
  assert.match(gates, /!summary\.input\[side\]\.presses/);
  assert.match(run, /probe === "replay-gates" && \(values\.baseline \|\| splitEquals\(positionals\)\.includes\("--baseline-query"\)\)\) throw/);
  assert.match(run, /if \(summary\.probe === "replay-gates" \|\| summary\.probe === "drop-meter" \|\| summary\.probe === "parcours"\) \{/, "race-perf keeps its paired-change lines");
});

// parcours (2026-11-01): a pad film from the boot, pushed like a savestate;
// a presentation probe (--headed, an explicit wgpu --query) like drop-meter.
test("spark-run --probe parcours: --film required and pushed, never --state; set by spark-run, not after --", async () => {
  const { checkProbeInputs, checkPresentationProbe } = await import("../harness/remote/spark-run.mjs");
  assert.throws(() => checkProbeInputs("parcours", { state: null, film: null }), /needs --film/);
  assert.throws(() => checkProbeInputs("parcours", { state: "x.sav", film: "f.json" }), /no --state/);
  assert.doesNotThrow(() => checkProbeInputs("parcours", { state: null, film: "f.json" }));
  assert.throws(() => checkProbeInputs("race-perf", { state: "x.sav", film: "f.json" }), /--probe parcours only/);
  assert.throws(() => checkProbeInputs("race-perf", { state: null, film: null }), /usage/);
  assert.doesNotThrow(() => checkProbeInputs("drop-meter", { state: null, film: null }));
  const q = "core=upstream&video=wgpu&presenter=webgpu&cpu=dual";
  assert.throws(() => checkPresentationProbe("parcours", ["--query", q], benchRaceArgs(["--query", q]).args, null), /needs --headed/);
  const cmd = launchCommand({ harnessDir: "/h/k", outDir: "/h/r/d/n", raceArgs: ["--film", "/h/roms/f.film.json"], headed: ":2", probe: "parcours" });
  assert.match(cmd, /\{ SPARK_PROBE='parcours' HARNESS_DISPLAY=x11 DISPLAY=':2' /);
  const run = readFileSync(new URL("../harness/remote/spark-run.mjs", import.meta.url), "utf8");
  assert.match(run, /for \(const f of \["--iso", "--state", "--film", "--out"/, "--film after -- refused");
  assert.match(run, /\.\.\.\(film \? \["--film", abs\(film\)\] : \[\]\)/);
  assert.match(run, /umask 077; cat > \$\{sh\(`\$\{dest\}\.tmp`\)\}; mv \$\{sh\(`\$\{dest\}\.tmp`\)\} \$\{sh\(dest\)\}[^\n]*\n[^\n]*film pushed as roms/, "the film is pushed private and quoted");
  assert.match(run, /const name = `\$\{safeName\(path\.basename\(file, "\.json"\)\)\}-/, "a safe name for a local film file");
  const probe = readFileSync(new URL("../harness/probes/parcours.mjs", import.meta.url), "utf8");
  assert.match(probe, /"lock-wait": \{ type: "string"/, "the probe takes the bench's --lock-wait");
});

test("spark-queue estimates: replay-gates and drop-meter by their own shape", async () => {
  const { estimateMin } = await import("../harness/remote/spark-queue.mjs");
  assert.equal(estimateMin("pair", ["--runs", "4", "--extra", "&wgpureplayms=4"]), 10);
  assert.equal(estimateMin("pair", ["--runs", "4", "--visits", "2", "--baseline", "/b"]), 24);
  assert.equal(estimateMin("pair", ["--runs", "4", "--visits", "2"]), 12);
  assert.equal(estimateMin("pair", ["--runs", "6", "--warmup", "20", "--secs", "10"]), 5, "race-perf as before (6 × (20 + 10 + 20) s)");
  assert.equal(estimateMin("pair", ["--runs", "3", "--film", "/f", "--baseline", "/b"]), 36, "parcours: ~6 min a run and side");
});

// 2026-10-29, the user's decision: the Spark is shared, cpus 0-9 are
// Excalibur's evals, 10-19 Salon's. Lane b (5-9, 0-4), its screening runs
// and the multi (arms on 5-9) are gone; one pair at a time in lane a.
test("spark bench on cpus 10-19 only: lane b, --screen and --multi refused; a pair in lane a and builds still queue", async () => {
  const { checkLane, LANE_B_GONE, SALON_CPUS, SCREEN_NOTE } = await import("../harness/remote/spark-run.mjs");
  assert.equal(SALON_CPUS, "10-19");
  assert.throws(() => checkLane("b"), /Excalibur's since 2026-10-29/);
  assert.throws(() => checkLane("b", { screen: true }), /lane b, --screen and --multi are gone/);
  assert.throws(() => checkLane("a", { screen: true }), /--screen/);
  for (const lane of ["a", "auto"]) assert.doesNotThrow(() => checkLane(lane));
  assert.throws(() => checkLane("c"), /--lane c: a or auto/);
  // an older screening run keeps its stamp when fetched
  assert.match(stampSummary({ change: null }, { host: "spark", screen: SCREEN_NOTE }).bench.screen, /never a conclusion/);
  const src = readFileSync(new URL("../harness/remote/spark-run.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(values\.multi\) throw new Error\(`--multi: \$\{LANE_B_GONE\}`\);/);
  assert.ok(src.indexOf("if (values.fetch)") < src.indexOf("if (values.multi) throw"), "an older multi still comes back with --fetch");
  assert.match(LANE_B_GONE, /cpus 0-9 are Excalibur's/);
  const { acceptsWait } = await import("../harness/remote/spark-queue.mjs");
  assert.equal(acceptsWait({ kind: "pair", lanes: "auto" }), true);
  assert.equal(acceptsWait({ kind: "pair", lanes: "a" }), true);
  assert.equal(acceptsWait({ kind: "build" }), true);
  assert.equal(acceptsWait({ kind: "pair", lanes: "b" }), false);
  assert.equal(acceptsWait({ kind: "multi" }), false);
  const queue = readFileSync(new URL("../harness/remote/spark-queue.mjs", import.meta.url), "utf8");
  assert.match(queue, /if \(!acceptsWait\(\{ kind: values\.kind, lanes: values\.lanes \}\)\) throw/);
  const race = readFileSync(new URL("../harness/remote/spark-race.sh", import.meta.url), "utf8");
  assert.doesNotMatch(race, /^\s+b\) cpus=5-9/m, "spark-race has no lane b");
  const multi = readFileSync(new URL("../harness/remote/spark-multi.sh", import.meta.url), "utf8");
  assert.match(multi, /no multi on the bench"[^]*echo 2 > "\$out\.exit"\nexit 2/);
  const build = readFileSync(new URL("../harness/remote/spark-build.mjs", import.meta.url), "utf8");
  assert.match(build, /run\("taskset", \["-c", "10-19", "nice"[^]*"--jobs", "10"\]/, "a build on Salon's cpus only");
});

test("spark-run --noise: drop-meter's A/A named as a bench run, its summary there", async () => {
  const { benchNoiseArgs } = await import("../harness/remote/spark-run.mjs");
  assert.deepEqual(benchNoiseArgs("20261028/jit-0189c-drops-aa", "/h/salon-bench/results"), ["--noise", "/h/salon-bench/results/20261028/jit-0189c-drops-aa/summary.json"]);
  assert.deepEqual(benchNoiseArgs(undefined, "/r"), []);
  assert.throws(() => benchNoiseArgs("jit-0189c-drops-aa", "/r"), /<yyyymmdd>\/<name>/);
  assert.throws(() => benchNoiseArgs("20261028/../x/y", "/r"), /<yyyymmdd>\/<name>/);
});

test("spark queue: a lane b job backfills past an older whole-bench job that cannot start before it ends", () => {
  // 2026-10-28: a multi waiting ~37 min for lane a held two lane b screens
  // (and lane b) idle behind it
  const now = Date.parse("2026-10-28T15:00:00Z");
  const t = (id, kind, lanes, extra = {}) => ({ id: `${id}`, kind, lanes, lane: null, name: `${kind}${id}`, ...extra });
  const running = t(1, "pair", "a", { lane: "a", estMin: 20, grantedAt: new Date(now - 5 * 60000).toISOString() });
  const pairA = t(2, "pair", "a", { estMin: 10 });
  const multi = t(3, "multi", "auto", { estMin: 13 });
  const busy = (l) => l === "a";
  // the multi starts once lane a is through (~15 + 10 = 25 min): a 12 min
  // screen on lane b ends before, a 40 min one would not
  const short = t(4, "pair", "b", { estMin: 12 }), long = t(5, "pair", "b", { estMin: 40 });
  assert.deepEqual(nextStep(short, [running, pairA, multi, short], busy, now), { go: ["b"] });
  assert.match(nextStep(long, [running, pairA, multi, long], busy, now).wait, /multi multi3 arrived first/);
  // no estimate: no backfill
  assert.match(nextStep(t(6, "pair", "b"), [running, pairA, multi, t(6, "pair", "b")], busy, now).wait, /multi3 arrived first/);
  // a younger pair that wants lane a still waits for the older pair on a (plain FIFO)
  assert.match(nextStep(t(7, "pair", "a", { estMin: 1 }), [running, pairA, multi, t(7, "pair", "a", { estMin: 1 })], busy, now).wait, /pair2 arrived first/);
  // a whole-bench job never backfills past another
  assert.match(nextStep(t(8, "build", "auto", { estMin: 1 }), [running, pairA, multi, t(8, "build", "auto", { estMin: 1 })], busy, now).wait, /arrived first/);
  // review of #338: an older ticket stepped aside (held) does not count in the multi's start
  const heldPair = t(2.5, "pair", "a", { estMin: 30, holdUntil: new Date(now + 60000).toISOString() });
  const mid = t(9, "pair", "b", { estMin: 30 }); // 30 min: ends after the multi's ~25 min start without the held pair (55 with it)
  assert.match(nextStep(mid, [running, pairA, heldPair, multi, mid], busy, now).wait, /multi3 arrived first/);
  assert.deepEqual(nextStep(short, [running, pairA, heldPair, multi, short], busy, now), { go: ["b"] });
  // a job of 0 min never backfills, nor before a start of 0
  assert.match(nextStep(t(4.5, "pair", "b", { estMin: 0 }), [running, pairA, multi, t(4.5, "pair", "b", { estMin: 0 })], busy, now).wait, /multi3 arrived first/);
  const multiNow = t(3, "multi", "auto", { estMin: 13 });
  assert.match(nextStep(short, [multiNow, short], () => false, now).wait, /multi3 arrived first/, "the multi can start at once: nothing passes it");
  // a running ticket without grantedAt (an older harness): no backfill
  const oldRunning = t(1, "pair", "a", { lane: "a", estMin: 20 });
  assert.match(nextStep(short, [oldRunning, pairA, multi, short], busy, now).wait, /multi3 arrived first/);
});

// Review of #345: a multi on two lanes (residual sigma 1.05 %, A/A
// multi2-aa-5x5-c) is stamped as screening in spark.json and the summary.
test("spark-run --multi on two lanes: stamped as screening, three lanes not", async () => {
  const { multiScreen, MULTI_SCREEN_NOTE, stampSummary } = await import("../harness/remote/spark-run.mjs");
  assert.equal(multiScreen("15,16,17,18,19;5,6,7,8,9"), MULTI_SCREEN_NOTE);
  assert.equal(multiScreen("5,6,7;15,16,17;8,9,19"), null);
  assert.match(MULTI_SCREEN_NOTE, /^screening: .*never a conclusion/);
  const s = stampSummary({ probe: "race-multi" }, { host: "spark", screen: MULTI_SCREEN_NOTE });
  assert.equal(s.screen, MULTI_SCREEN_NOTE);
  assert.equal("screen" in stampSummary({ probe: "race-multi" }, { host: "spark" }), false);
  const src = readFileSync(new URL("../harness/remote/spark-run.mjs", import.meta.url), "utf8");
  assert.match(src, /raceArgs, \.\.\.\(multiScreen\(lanes\) \? \{ screen: multiScreen\(lanes\) \} : \{\}\),/, "spark.json carries it");
  assert.match(src, /if \(meta\.screen\) console\.log\(`\[spark-run\] \$\{meta\.screen\}`\);/, "said at the launch");
});


test("spark-run --loaded: correctness runs skip the cores wait, speed probes keep it", async () => {
  const { launchCommand, LOADED_PROBES } = await import("../harness/remote/spark-run.mjs");
  assert.deepEqual(LOADED_PROBES, ["replay-gates"]);
  const cmd = launchCommand({ harnessDir: "/h", outDir: "/r/x", raceArgs: ["--runs", "2"], probe: "replay-gates", loaded: true });
  assert.match(cmd, /SPARK_PROBE='?replay-gates'? SPARK_LOADED=1 /);
  assert.ok(!launchCommand({ harnessDir: "/h", outDir: "/r/x", raceArgs: [], probe: "replay-gates" }).includes("SPARK_LOADED"));
  for (const probe of ["race-perf", "drop-meter"]) assert.throws(() => launchCommand({ harnessDir: "/h", outDir: "/r/x", raceArgs: [], probe, loaded: true }), /correctness probes only/);
  const race = await readFile(new URL("../harness/remote/spark-race.sh", import.meta.url), "utf8");
  assert.match(race, /if \[ "\$\{SPARK_LOADED:-0\}" = 1 \] && \[ "\$probe" = replay-gates \]; then[\s\S]*spark-queue\.mjs wait --pid \$\$ --kind pair --lanes "\$want" --name "\$\(basename "\$out"\)" -- "\$@"\)\n\s+else/);
  const gates = await readFile(new URL("../harness/probes/replay-gates.mjs", import.meta.url), "utf8");
  assert.match(gates, /\.\.\.\(process\.env\.SPARK_LOADED === "1" \? \{ loaded: true \} : \{\}\),/);
});
