// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { busyOn, checkCores, cpuTopology, parseCpuList, parseStat, topologyLines, treeOf } from "../harness/remote/spark-cores.mjs";
import { held, lanesCpus, nextStep, readTickets, waitTurn } from "../harness/remote/spark-queue.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("spark-cores: cpu lists, /proc stat lines (a comm with spaces and parentheses), process trees", () => {
  assert.deepEqual(parseCpuList("15-19,10-14"), [15, 16, 17, 18, 19, 10, 11, 12, 13, 14]);
  assert.deepEqual(parseCpuList("5,7-8"), [5, 7, 8]);
  assert.throws(() => parseCpuList("a-b"), /expected n or n-m/);
  // pid (comm) state ppid ... utime(14) stime(15) ... processor(39)
  const fields = Array.from({ length: 50 }, (_, i) => String(i + 1));
  fields[3] = "77"; fields[13] = "300"; fields[14] = "45"; fields[38] = "16";
  const line = `4242 (py (worker) x) S ${fields.slice(3).join(" ")}`;
  assert.deepEqual(parseStat(line), { comm: "py (worker) x", ppid: 77, ticks: 345, cpu: 16 });
  const parents = new Map([[2, 1], [3, 2], [4, 3], [9, 1]]);
  assert.deepEqual([...treeOf(2, parents)].sort(), [2, 3, 4]);
});

test("spark-cores: another user's thread over the threshold on a lane core makes the lane busy; ours, other cores and light ones do not", () => {
  // tid -> { pid, comm, ticks, cpu, user }: single-thread processes here (tid = pid)
  const snap = (rows) => new Map(rows.map(([pid, ticks, cpu, user]) => [pid, { pid, comm: `p${pid}`, ticks, cpu, user }]));
  // 100 ticks a second, 1 s apart
  const before = snap([[10, 0, 16, 5001], [11, 0, 15, 5001], [12, 0, 5, 0], [13, 0, 17, 1000], [14, 0, 18, 10001]]);
  const after = snap([[10, 100, 16, 5001], [11, 99, 15, 5001], [12, 100, 5, 0], [13, 100, 17, 1000], [14, 30, 18, 10001]]);
  const cpus = parseCpuList("15-19,10-14");
  const busy = busyOn({ before, after, ms: 1000, ticksPerSecond: 100, cpus, exclude: new Set([13]), threshold: 50 });
  assert.deepEqual(busy.map((b) => [b.pid, b.cpu, b.pct]), [[10, 16, 100], [11, 15, 99]], "pid 12 on cpu 5 (not the lane), 13 ours, 14 at 30 %");
  assert.deepEqual(busyOn({ before, after, ms: 1000, ticksPerSecond: 100, cpus: parseCpuList("5-9"), threshold: 50 }).map((b) => b.pid), [12]);
});

test("spark-cores: threads are judged one by one, not by their process's main thread", () => {
  // tid -> thread: an eval at 400 % on cpus 0-3 whose main thread sleeps on
  // 12 (lane a), and a process whose main thread sleeps on 3 with one busy
  // thread on 16 (lane a). /proc/<pid>/stat sums the threads' ticks under
  // the main thread's cpu: lane a busy at 400 % on 12, and free on 16.
  const rows = [
    [20, 20, 0, 12], [21, 20, 100, 0], [22, 20, 100, 1], [23, 20, 100, 2], [24, 20, 100, 3],
    [30, 30, 0, 3], [31, 30, 90, 16],
    [40, 40, 0, 15], [41, 40, 100, 17] // ours (excluded by pid)
  ];
  const before = new Map(rows.map(([tid, pid, , cpu]) => [tid, { pid, comm: `t${tid}`, ticks: 0, cpu, user: 5001 }]));
  const after = new Map(rows.map(([tid, pid, ticks, cpu]) => [tid, { pid, comm: `t${tid}`, ticks, cpu, user: 5001 }]));
  const lane = { before, after, ms: 1000, ticksPerSecond: 100, exclude: new Set([40]), threshold: 50 };
  assert.deepEqual(busyOn({ ...lane, cpus: parseCpuList("15-19,10-14") }).map((b) => [b.pid, b.tid, b.cpu, b.pct]), [[30, 31, 16, 90]]);
  assert.deepEqual(busyOn({ ...lane, cpus: parseCpuList("0-4") }).map((b) => b.tid), [21, 22, 23, 24]);
});

test("spark queue: a pair whose lane's cores are busy steps aside, asks again, gives up after its limit; errors are thrown", async () => {
  const bench = mkdtempSync(path.join(os.tmpdir(), "spark-queue-cores-"));
  try {
    // Busy twice, then free: granted, the check asked for the lane's cores.
    const asked = [];
    let n = 0;
    const lane = await waitTurn({ pid: process.pid, kind: "pair", lanes: "auto", name: "p", bench, pollSec: 0.01, holdSec: 0.02, ready: async (l) => { asked.push(l.join(" ")); return { ok: ++n > 2 }; } });
    assert.equal(lane, "a");
    assert.deepEqual(asked, ["a", "a", "a"]);
    assert.equal(readTickets(bench)[0].holdUntil, undefined, "granted, no longer held");
    rmSync(path.join(bench, "queue"), { recursive: true });
    // Held, it is no one's turn ahead: a younger build goes first.
    const now = Date.now();
    const t = (ms, kind, lanes, extra = {}) => ({ id: `${String(ms).padStart(15, "0")}-1.json`, kind, lanes, lane: null, ...extra });
    const pair = t(1, "pair", "auto", { holdUntil: new Date(now + 60000).toISOString() }), build = t(2, "build", "auto");
    assert.equal(held(pair, now), true);
    assert.deepEqual(nextStep(build, [pair, build], () => false, now), { go: ["a", "b"] });
    assert.match(nextStep(pair, [pair, build], () => false, now).wait, /cores are busy/);
    assert.equal(held(pair, now + 61000), false);
    // Never free: null after giveUpSec, its ticket gone.
    assert.equal(await waitTurn({ pid: process.pid, kind: "pair", name: "q", bench, pollSec: 0.01, holdSec: 0.01, giveUpSec: 0.05, ready: async () => ({ ok: false }) }), null);
    assert.deepEqual(readTickets(bench), []);
    // An error in the check is not "busy": it is thrown, never retried.
    let calls = 0;
    await assert.rejects(waitTurn({ pid: process.pid, kind: "pair", name: "r", bench, pollSec: 0.01, ready: async () => { calls++; throw new Error("no /proc"); } }), /no \/proc/);
    assert.equal(calls, 1);
    assert.deepEqual(lanesCpus(["a=15-19,10-14", "b=5-9,0-4"]), { a: "15-19,10-14", b: "5-9,0-4" });
    assert.throws(() => lanesCpus(["c=1"]), /expected <lane>=<cpus>/);
  } finally {
    rmSync(bench, { recursive: true, force: true });
  }
});

test("spark-race: exit codes: the queue's 3 (cores busy for 30 min) is 4, any other failure 2 at once, 0 runs the pair", () => {
  // A stand-in node on the bench's PATH: the queue's `wait` exits $FAKE_WAIT
  // (printing lane a on 0) and logs every call; race-perf exits 0.
  const run = (wait) => {
    const home = mkdtempSync(path.join(os.tmpdir(), "spark-race-codes-"));
    try {
      const bin = path.join(home, "salon-bench", "node", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, "node"), `#!/bin/sh\necho "$*" >> "$HOME/calls"\ncase "$*" in *"spark-queue.mjs wait"*) [ "$FAKE_WAIT" = 0 ] && echo a; exit $FAKE_WAIT ;; esac\nexit 0\n`);
      chmodSync(path.join(bin, "node"), 0o755);
      // taskset -c <cpus> <command…> runs the command; ps prints nothing.
      writeFileSync(path.join(bin, "taskset"), '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 });
      writeFileSync(path.join(bin, "ps"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const out = path.join(home, "r");
      writeFileSync(`${out}.cores`, "{}\n");
      const r = spawnSync("sh", ["harness/remote/spark-race.sh", out, "auto", "--", "--secs", "2"], { cwd: ROOT, env: { ...process.env, HOME: home, FAKE_WAIT: String(wait), SPARK_CHROME_CPUS: "15-19" }, encoding: "utf8" });
      const calls = readFileSync(path.join(home, "calls"), "utf8");
      return { status: r.status, exit: readFileSync(`${out}.exit`, "utf8").trim(), waits: calls.split("spark-queue.mjs wait").length - 1, raced: calls.includes("race-perf.mjs"), calls, log: readFileSync(`${out}.log`, "utf8") };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
  const busy = run(3);
  assert.deepEqual([busy.status, busy.exit, busy.waits, busy.raced], [4, "4", 1, false]);
  assert.match(busy.log, /stayed busy for 30 min: no pair/);
  for (const code of [2, 1]) assert.deepEqual((({ status, exit, waits, raced }) => [status, exit, waits, raced])(run(code)), [2, "2", 1, false], `queue exit ${code}`);
  const ok = run(0);
  assert.deepEqual([ok.exit, ok.waits, ok.raced], ["0", 1, true]);
  assert.match(ok.calls, /--cores a=15-19,10-14 --cores b=15-19,0-4 --cores-out /);
});

test("spark-cores: usage errors exit 2", () => {
  const r = spawnSync(process.execPath, ["harness/remote/spark-cores.mjs", "check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: spark-cores\.mjs check/);
});

test("spark-race: the cores are checked in the queue, before the grant, and the check is kept with the run", async () => {
  const race = await readFile(new URL("../harness/remote/spark-race.sh", import.meta.url), "utf8");
  assert.ok(race.indexOf("--cores-out") < race.indexOf("echo \"$lane\" > \"$out.lane\""), "before the lane is used");
  assert.doesNotMatch(race, /until node harness\/remote\/spark-cores/);
  assert.match(race, /ps -eLo pid,tid,psr,pcpu,user,comm/, "the log per thread too");
  const run = await readFile(new URL("../harness/remote/spark-run.mjs", import.meta.url), "utf8");
  assert.match(run, /for \(const ext of \["log", "exit", "lane", "cores"\]\)/, "fetched with the run");
});

test("spark-cores: a real check on Linux (CI) reads every thread", { skip: process.platform !== "linux" && "/proc: Linux only" }, async () => {
  const r = await checkCores({ cpus: "0", ms: 50, threshold: 1000 });
  assert.equal(r.ok, true, "nothing is over 1000 % of a core");
  assert.equal(r.cpus, "0");
});

// 2026-10-28: the two lanes' Chromium cores ran 7 % apart in a multi A/A;
// the bench logs each cpu's kind so that a lane's cores are known.
test("spark-cores topology: one line per run of cpus of the same kind, read from sysfs", async () => {
  const sys = {};
  for (let cpu = 0; cpu < 4; cpu++) {
    const b = `/sys/devices/system/cpu/cpu${cpu}`;
    sys[`${b}/topology/core_id`] = String(cpu);
    sys[`${b}/cpu_capacity`] = cpu < 2 ? "1024" : "780";
    sys[`${b}/cpufreq/cpuinfo_max_freq`] = cpu < 2 ? "3900000" : "2800000";
    sys[`${b}/regs/identification/midr_el1`] = cpu < 2 ? "0x411fd850" : "0x411fd870";
    sys[`${b}/topology/cluster_id`] = cpu < 2 ? "1" : "0";
  }
  const cpus = cpuTopology((p) => sys[p] ?? null);
  assert.equal(cpus.length, 4, "stops at the first cpu sysfs does not have");
  assert.deepEqual(cpus[0], { cpu: 0, midr: "0x411fd850", capacity: 1024, maxMhz: 3900, cluster: "1" });
  assert.deepEqual(topologyLines(cpus), [
    "0-1: midr 0x411fd850 capacity 1024 max 3900 MHz cluster 1",
    "2-3: midr 0x411fd870 capacity 780 max 2800 MHz cluster 0"
  ]);
  assert.deepEqual(topologyLines([{ cpu: 5, midr: null, capacity: null, maxMhz: null, cluster: null }]), ["5: midr ? capacity ? max ? MHz cluster ?"]);
  for (const f of ["spark-race.sh", "spark-multi.sh"]) {
    const sh = await readFile(new URL(`../harness/remote/${f}`, import.meta.url), "utf8");
    assert.match(sh, /node harness\/remote\/spark-cores\.mjs topology/, `${f} logs the cores' kinds`);
  }
});

// 2026-10-28: the multi A/A ran with evals on lane b's cores; a multi now
// waits for both lanes' cores to be free, as a pair waits for its own.
test("spark-multi asks the queue for both lanes' cores free, and gives up after 30 min busy", async () => {
  const sh = await readFile(new URL("../harness/remote/spark-multi.sh", import.meta.url), "utf8");
  assert.match(sh, /wait --pid \$\$ --kind multi --name "\$\(basename "\$out"\)" \\\n    --cores "a=15-19,10-14" --cores "b=5-9,0-4" --cores-out "\$out\.cores"/);
  assert.match(sh, /3\) echo "\[spark-multi\] the lanes' cores stayed busy for 30 min: no run"; echo 4 > "\$out\.exit"; exit 4 ;;/);
  assert.ok(sh.indexOf("trap 'node harness/remote/spark-queue.mjs done") < sh.indexOf("--kind multi"), "the ticket goes even when the wait gives up");
});

