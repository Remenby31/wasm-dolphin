// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { benchJudge, benchLane, benchLimit, benchRead, grantedLanes, LANE_FOREIGN_PCT, MACHINE_LOAD_MAX, SALON_CPUS, SALON_FOREIGN_MAX, salonForeign, salonOverloaded } from "../harness/lib/bench-load.mjs";
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
  // seq-aa-lane-a-3's readings: load1 13, its cores free: now let through
  assert.deepEqual(benchJudge({ load: 13.33, background: 0.4 }), { limit: 40, ok: true, over: [] });
  assert.deepEqual(benchJudge({ load: 9, background: 3.2 }).over, ["3.2 foreign runnable threads on cpus 10-19 > 2"]);
  assert.deepEqual(benchJudge({ load: 45, background: 0 }).over, ["load 45 > 40"], "a machine collapsing (memory bandwidth is shared)");
  // a window: the median of its counts
  assert.equal(salonOverloaded([0, 1, 0, 3, 0]), false);
  assert.equal(salonOverloaded([3, 4, 0, 3, 5]), true);
  assert.equal(salonOverloaded([]), false);
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
  assert.match(perf, /overloaded: medianLoad > o\.maxLoad \|\| \(salon\.length > 0 && median\(salon\) > o\.benchSalonMax\),/);
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
