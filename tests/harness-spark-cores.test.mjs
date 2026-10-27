// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { busyOn, parseCpuList, parseStat, treeOf } from "../harness/remote/spark-cores.mjs";

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

test("spark-cores: another user's process over the threshold on a lane core makes the lane busy; ours, other cores and light ones do not", () => {
  const snap = (rows) => new Map(rows.map(([pid, ticks, cpu, user]) => [pid, { comm: `p${pid}`, ppid: 1, ticks, cpu, user }]));
  // 100 ticks a second, 1 s apart
  const before = snap([[10, 0, 16, 5001], [11, 0, 15, 5001], [12, 0, 5, 0], [13, 0, 17, 1000], [14, 0, 18, 10001]]);
  const after = snap([[10, 100, 16, 5001], [11, 99, 15, 5001], [12, 100, 5, 0], [13, 100, 17, 1000], [14, 30, 18, 10001]]);
  const cpus = parseCpuList("15-19,10-14");
  const busy = busyOn({ before, after, ms: 1000, ticksPerSecond: 100, cpus, exclude: new Set([13]), threshold: 50 });
  assert.deepEqual(busy.map((b) => [b.pid, b.cpu, b.pct]), [[10, 16, 100], [11, 15, 99]], "pid 12 on cpu 5 (not the lane), 13 ours, 14 at 30 %");
  assert.deepEqual(busyOn({ before, after, ms: 1000, ticksPerSecond: 100, cpus: parseCpuList("5-9"), threshold: 50 }).map((b) => b.pid), [12]);
});

test("spark-race: the pair waits for free lane cores, 30 min at most, the check kept with the run", async () => {
  const race = await readFile(new URL("../harness/remote/spark-race.sh", import.meta.url), "utf8");
  assert.match(race, /until node harness\/remote\/spark-cores\.mjs check --cpus "\$SPARK_CHROME_CPUS,\$\{SPARK_NODE_CPUS:-\$ncpus\}" --exclude-tree \$\$ > "\$out\.cores"; do/);
  assert.match(race, /if \[ "\$waited" -ge 1800 \]; then/);
  assert.match(race, /echo 4 > "\$out\.exit"/);
  const run = await readFile(new URL("../harness/remote/spark-run.mjs", import.meta.url), "utf8");
  assert.match(run, /for \(const ext of \["log", "exit", "lane", "cores"\]\)/, "fetched with the run");
});
