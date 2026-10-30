// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { benchJudge, GPU_FOREIGN_MAX, gpuNow, MEM_DROP_MB, MEM_FLOOR_MB, MEM_PSI_MAX, memNow, memOver, parsePmon, benchLane, benchLimit, benchRead, grantedLanes, LANE_FOREIGN_PCT, MACHINE_LOAD_MAX, SALON_CPUS, SALON_FOREIGN_MAX, salonForeign, salonOverloaded } from "../harness/lib/bench-load.mjs";
import { defaultMaxLoad, gateReader, loadGaveUp, waitForLoad } from "../harness/lib/env.mjs";
import { visitLimit } from "../harness/probes/drop-meter.mjs";

// 2026-10-29: the Spark is shared, cpus 0-9 Excalibur's (busy all the time),
// 10-19 Salon's. load1 sat at 9-17 and refused or failed 3 runs in 4 of
// seq-aa-lane-a-3 whose own cores were free: the gate counts Salon's cpus.
test("bench load gate: Salon's cpus 10-19 only; the whole machine only against a collapse", () => {
  assert.equal(LANE_FOREIGN_PCT, 50);
  assert.deepEqual(SALON_CPUS, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(SALON_FOREIGN_MAX, 2);
  assert.equal(MACHINE_LOAD_MAX, 40);
  const ours = new Set([100, 101]);
  const threads = [
    { pid: 900, cpu: 3 }, { pid: 901, cpu: 7 }, { pid: 902, cpu: 0 }, // the evals on 0-9: not counted
    { pid: 100, cpu: 16 }, { pid: 101, cpu: 12 }, // our job
    { pid: 903, cpu: 16 }, { pid: 904, cpu: 11 } // a stray python on 16, an unpinned Chromium on 11
  ];
  assert.equal(salonForeign(threads, ours), 2);
  // review of #355: kernel threads on 10-19 (kworker, ksoftirqd) are not another user's work
  assert.equal(salonForeign([...threads, { pid: 77, cpu: 15, kernel: true }, { pid: 2, cpu: 18, kernel: true }], ours), 2);
  const src = readFileSync(new URL("../harness/lib/bench-load.mjs", import.meta.url), "utf8");
  assert.match(src, /const kernel = Number\(name\) === 2 \|\| ppid === 2;/, "kthreadd and its children");
  // seq-aa-lane-a-3's readings: load1 13, its cores free: now let through
  assert.deepEqual(benchJudge({ load: 13.33, background: 0.4 }), { limit: 40, ok: true, over: [] });
  assert.deepEqual(benchJudge({ load: 9, background: 3.2 }).over, ["3.2 foreign runnable threads on cpus 10-19 > 2"]);
  assert.deepEqual(benchJudge({ load: 45, background: 0 }).over, ["load 45 > 40"], "a machine collapsing (memory bandwidth is shared)");
  // a window: the median of its counts
  assert.equal(salonOverloaded([0, 1, 0, 3, 0]), false);
  assert.equal(salonOverloaded([3, 4, 0, 3, 5]), true);
  assert.equal(salonOverloaded([]), false);
  // pair #361: a median of 0-1 with peaks of 6-8 went through; two in a row now count
  assert.equal(salonOverloaded([0, 0, 6, 7, 0, 1, 0]), true, "two samples in a row over the limit");
  assert.equal(salonOverloaded([0, 6, 0, 8, 0, 1, 0]), false, "isolated peaks: a scan's own instant");
  const h = "spark";
  assert.equal(grantedLanes([{ lane: "a", host: h }, { lane: null, host: h }, { lane: "none", host: h }], h), 1);
  assert.equal(grantedLanes([{ lane: "a", host: h }, { lane: "b", host: "mac" }], h), 1, "another host's ticket is not this machine's lane");
  assert.equal(benchLane({}), null, "off the bench: the caller's --max-load");
  assert.deepEqual(benchLane({ SPARK_LANE: "a", SPARK_LANE_CPUS: "15-19,10-14" }), { lane: "a", cpus: "15-19,10-14", list: [15, 16, 17, 18, 19, 10, 11, 12, 13, 14] });
});

test("bench load gate: an explicit --max-load caps the machine limit; none is given by default on the bench", () => {
  assert.equal(benchLimit({ cap: 8 }), 8);
  assert.equal(benchLimit({ cap: 60 }), 40, "a cap above the collapse limit changes nothing");
  assert.equal(benchLimit(), 40);
  assert.deepEqual(benchJudge({ load: 9, background: 0, cap: 8 }).over, ["load 9 > 8"]);
  assert.equal(defaultMaxLoad({ SPARK_LANE_CPUS: "15-19" }), null);
  assert.ok(defaultMaxLoad({}) >= 2);
});

test("load gate: off the bench the 1-minute load against --max-load as before; a busy lane says which thread", async () => {
  const read = gateReader({ maxLoad: 5, load: () => 3.456, env: {} });
  assert.deepEqual(await read(), { load: 3.46, limit: 5, ok: true });
  assert.deepEqual(await gateReader({ maxLoad: 5, load: () => 7, env: { SPARK_LANE_CPUS: "15-19" } })(), { load: 7, limit: 5, ok: false }, "an injected load is kept even on the bench");
  const seen = [];
  const g = await waitForLoad({ waitSec: 0, log: (m) => seen.push(m), read: async () => ({ load: 4, limit: 10, ok: false, lane: "a", laneBusy: [{ comm: "python3", pct: 98, cpu: 16 }] }) });
  assert.equal(g.ok, false);
  assert.match(loadGaveUp(g), /^load 4 > 10, lane a cores busy \(python3 98 % on 16\) after --load-wait/);
  const stray = { load: 9, limit: 40, ok: false, over: ["3 foreign runnable threads on cpus 10-19 > 2"], lane: "a", laneBusy: [] };
  assert.match(loadGaveUp(stray), /^3 foreign runnable threads on cpus 10-19 > 2 after --load-wait/, "the gave-up message names the bound that refused");
});

test("the bench's own tree: spark-race exports the lane; race-perf and drop-meter judge a side or visit against its gate's limit", async () => {
  const race = await readFile(new URL("../harness/remote/spark-race.sh", import.meta.url), "utf8");
  assert.match(race, /export SPARK_LANE="\$lane" SPARK_LANE_CPUS="\$SPARK_CHROME_CPUS,\$\{SPARK_NODE_CPUS:-\$ncpus\}"/);
  const perf = await readFile(new URL("../harness/probes/race-perf.mjs", import.meta.url), "utf8");
  assert.match(perf, /if \(loadGate\?\.limit != null\) o = \{ \.\.\.o, maxLoad: loadGate\.limit \};/);
  assert.doesNotMatch(perf, /o\.maxLoad = /, "o.maxLoad stays the option, never the last side's limit");
  // the window judged on the foreign count on Salon's cpus too, sampled at most once a second
  assert.match(perf, /if \(loadGate\?\.salonForeignMax != null\) \{[^]*?benchSalon: \(\) => salonForeignNow\(\), benchSalonMax: loadGate\.salonForeignMax/);
  assert.match(perf, /overloaded: medianLoad > o\.maxLoad \|\| \(salon\.length > 0 && o\.benchSalonOverloaded\(salon\)\) \|\|/);
  assert.match(perf, /benchSalonOverloaded: salonOverloaded, benchGpu: \(\) => gpuNow\(\), benchGpuMax: GPU_FOREIGN_MAX, benchMem: \(\) => memNow\(\), benchMemOver: memOver \};/, "the window rules are bench-load's");
  assert.match(perf, /windowLoads: runsDone\.flatMap\(/, "every window's load1 and salonForeign in the summary");
  assert.match(perf, /if \(!o\.benchSalon \|\| performance\.now\(\) - salonAt < 1000\) return;/);
  const drop = await readFile(new URL("../harness/probes/drop-meter.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(drop, /o\.maxLoad = /);
  // a visit keeps its gate in raw.gate: a re-analysis judges it the same
  assert.equal(visitLimit({ gate: { limit: 16 } }, null), 16);
  assert.equal(visitLimit({ gate: { limit: 5, ok: true } }, 5), 5);
  assert.equal(visitLimit({}, 8), 8, "an older raw without a gate: --max-load");
});

test("bench read on Linux (CI): the lane's cores and Salon's foreign runnable threads from /proc", { skip: process.platform !== "linux" && "/proc: Linux only" }, async () => {
  const g = await benchRead({ lane: { lane: "a", cpus: "0" }, tickets: [], load: () => 0.5, ms: 50 });
  assert.equal(g.granted, 0);
  assert.ok(g.background >= 0);
  assert.equal(g.limit, 40);
  assert.equal(g.salonForeignMax, 2);
  assert.ok(Array.isArray(g.laneBusy));
});

// 2026-10-30 01:10-01:50: every lane a run of a JIT pair fell to ~20 %,
// load1 and the cpus normal; nothing read the GPU, shared (and its memory
// with it on the GB10).
test("bench gate: another user's process on the GPU above 20 % refuses the gate; the bench's Xorg is ours", () => {
  assert.equal(GPU_FOREIGN_MAX, 20);
  const pmon = `# gpu         pid   type     sm    mem    enc    dec    jpg    ofa    command
# Idx           #    C/G      %      %      %      %      %      %    name
    0     900001     C     85     40      -      -      -      -    python
    0     900002     G      3      1      -      -      -      -    Xorg
    0     100        G     12      5      -      -      -      -    chrome
    0     900003     C      -      -      -      -      -      -    vllm
`;
  assert.deepEqual(parsePmon(pmon).map((p) => [p.pid, p.sm, p.command]), [[900001, 85, "python"], [900002, 3, "Xorg"], [100, 12, "chrome"], [900003, 0, "vllm"]]);
  const run = (args) => (args[0] === "pmon" ? pmon : "91\n");
  const g = gpuNow([], { run, ours: new Set([100]) });
  assert.equal(g.util, 91);
  assert.equal(g.foreignSm, 85);
  assert.deepEqual(g.foreign.map((p) => p.command), ["python", "vllm"], "our Chromium and the bench's Xorg left out");
  assert.deepEqual(benchJudge({ load: 9, background: 0, gpu: g }).over, ["GPU: python (pid 900001) at 85 % > 20"]);
  assert.equal(benchJudge({ load: 9, background: 0, gpu: { ...g, foreignSm: 15 } }).ok, true);
  assert.equal(benchJudge({ load: 9, background: 0, gpu: null }).ok, true, "no nvidia-smi: no GPU gate");
  assert.equal(gpuNow([], { run: () => { throw new Error("no nvidia-smi"); } }), null);
  const perf = readFileSync(new URL("../harness/probes/race-perf.mjs", import.meta.url), "utf8");
  assert.match(perf, /\[gpuStart, gpuEnd\]\.some\(\(g\) => g && g\.foreignSm > o\.benchGpuMax\)/, "a window is invalid when another user held the GPU at its start or end");
  const race = readFileSync(new URL("../harness/remote/spark-race.sh", import.meta.url), "utf8");
  assert.match(race, /gpu before: [^\n]*nvidia-smi pmon -c 1 -s um/);
  assert.match(race, /gpu after: [^\n]*nvidia-smi pmon -c 1 -s um/);
});

// The runs that fell to ~20 % (2026-10-30, headless: not our GPU) had their
// busiest thread at 32-40 %: waiting. Memory pressure, read without root.
test("bench gate: memory available under 8 GB, a fall of 4 GB in a window, or pressure above 10 % make the window invalid", () => {
  assert.deepEqual([MEM_FLOOR_MB, MEM_DROP_MB, MEM_PSI_MAX], [8192, 4096, 10]);
  const files = {
    "/proc/meminfo": "MemTotal:       128000000 kB\nMemFree:  1000 kB\nMemAvailable:   20971520 kB\n",
    "/proc/pressure/memory": "some avg10=1.50 avg60=0.80 avg300=0.20 total=12345\nfull avg10=0.40 avg60=0.10 avg300=0.00 total=2345\n",
    "/proc/vmstat": "nr_free_pages 1\npgmajfault 777\npswpin 12\n"
  };
  const m = memNow((f) => { if (!(f in files)) throw new Error("ENOENT"); return files[f]; });
  assert.deepEqual(m, { memAvailMB: 20480, psiSome10: 1.5, psiFull10: 0.4, majFaults: 777, swapIns: 12 });
  assert.deepEqual(memNow(() => { throw new Error("ENOENT"); }), { memAvailMB: null, psiSome10: null, psiFull10: null, majFaults: null, swapIns: null }, "no file: nothing judged");
  assert.deepEqual(memOver(m, m), []);
  assert.deepEqual(memOver(m, { ...m, memAvailMB: 6000 }), ["memory available 6000 MB < 8192", "memory available fell 14480 MB > 4096 in the window"]);
  assert.deepEqual(memOver({ ...m, memAvailMB: 30000 }, { ...m, memAvailMB: 25000 }), ["memory available fell 5000 MB > 4096 in the window"]);
  assert.deepEqual(memOver(m, { ...m, psiSome10: 23.4 }), ["memory pressure 23.4 % > 10"]);
  assert.deepEqual(memOver(null, null), []);
  assert.deepEqual(benchJudge({ load: 9, background: 0, mem: { ...m, psiSome10: 30 } }).over, ["memory pressure 30 % > 10"]);
  const perf = readFileSync(new URL("../harness/probes/race-perf.mjs", import.meta.url), "utf8");
  assert.match(perf, /\|\| memWhy\.length > 0,/, "a window with a memory reason is invalid");
  assert.match(perf, /majFaults: memDelta\(pressStart\?\.majFaults, pressEnd\?\.majFaults\)/);
});

