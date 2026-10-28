// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BACKGROUND_MARGIN, benchJudge, benchLane, benchLimit, benchRead, grantedLanes, LANE_FOREIGN_PCT, PER_LANE_LOAD, REFERENCE_BACKGROUND } from "../harness/lib/bench-load.mjs";
import { defaultMaxLoad, gateReader, loadGaveUp, waitForLoad } from "../harness/lib/env.mjs";
import { visitLimit } from "../harness/probes/drop-meter.mjs";

test("bench load gate: a fixed reference plus 5 per granted lane, never above the cores", () => {
  assert.equal(PER_LANE_LOAD, 5);
  assert.equal(LANE_FOREIGN_PCT, 50);
  assert.equal(REFERENCE_BACKGROUND, 6);
  assert.equal(BACKGROUND_MARGIN, 6);
  // a build or a multi holds both lanes; a waiting ticket none; another host's ticket none
  const h = "spark";
  assert.equal(grantedLanes([{ lane: "a", host: h }, { lane: null, host: h }, { lane: "none", host: h }], h), 1);
  assert.equal(grantedLanes([{ lane: "a", host: h }, { lane: "b", host: h }], h), 2);
  assert.equal(grantedLanes([{ lane: "a b", host: h }], h), 2);
  assert.equal(grantedLanes([{ lane: "a", host: h }, { lane: "b", host: "mac" }], h), 1, "another host's ticket is not this machine's lane");
  // 2026-10-28: a lane a pair at --max-load 5 with two lane b screens running
  // (load 6-9) gave every run up; with both lanes granted the limit is 16
  assert.equal(benchLimit({ granted: 2, cores: 20 }), 16);
  assert.equal(benchLimit({ granted: 0, cores: 20 }), 11, "this job's own lane at least");
  assert.equal(benchLimit({ granted: 4, cores: 20 }), 20, "never above the cores");
  assert.equal(benchLane({}), null, "off the bench: the caller's --max-load");
  assert.deepEqual(benchLane({ SPARK_LANE: "a", SPARK_LANE_CPUS: "15-19,10-14" }), { lane: "a", cpus: "15-19,10-14", list: [15, 16, 17, 18, 19, 10, 11, 12, 13, 14] });
});

// Review of #342: the limit was background + 5 per lane, the background
// counting the very threads the gate should catch.
test("bench load gate: 40 unpinned foreign threads are refused, whatever load1 still says", () => {
  const g = benchJudge({ load: 9, background: 40, total: 44, granted: 1, cores: 20 });
  assert.equal(g.ok, false);
  assert.equal(g.limit, 11, "the background does not raise the limit");
  assert.deepEqual(g.over, ["background 40 > 12 runnable threads", "44 runnable threads > 20 cores"]);
  assert.equal(benchJudge({ load: 9, background: 7, total: 15, granted: 2, cores: 20 }).ok, true, "the bench's usual background with two lanes running");
  assert.deepEqual(benchJudge({ load: 17, background: 7, total: 15, granted: 2, cores: 20 }).over, ["load 17 > 16"]);
  assert.deepEqual(benchJudge({ load: 5, background: 7, total: 22, granted: 2, cores: 20 }).over, ["22 runnable threads > 20 cores"]);
});

test("bench load gate: an explicit --max-load caps the computed limit; none is given by default on the bench", () => {
  assert.equal(benchLimit({ granted: 2, cores: 20, cap: 8 }), 8);
  assert.equal(benchLimit({ granted: 0, cores: 20, cap: 30 }), 11, "a cap above the computed limit changes nothing");
  assert.deepEqual(benchJudge({ load: 9, background: 6, total: 12, granted: 2, cores: 20, cap: 8 }).over, ["load 9 > 8"]);
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
  const spike = { load: 9, limit: 11, ok: false, over: ["background 40 > 12 runnable threads"], lane: "a", laneBusy: [] };
  assert.match(loadGaveUp(spike), /^background 40 > 12 runnable threads after --load-wait/, "the gave-up message names the bound that refused");
});

test("the bench's own tree: spark-race exports the lane; race-perf and drop-meter judge a side or visit against its gate's limit", async () => {
  const race = await readFile(new URL("../harness/remote/spark-race.sh", import.meta.url), "utf8");
  assert.match(race, /export SPARK_LANE="\$lane" SPARK_LANE_CPUS="\$SPARK_CHROME_CPUS,\$\{SPARK_NODE_CPUS:-\$ncpus\}"/);
  const perf = await readFile(new URL("../harness/probes/race-perf.mjs", import.meta.url), "utf8");
  assert.match(perf, /if \(loadGate\?\.limit != null\) o = \{ \.\.\.o, maxLoad: loadGate\.limit \};/);
  assert.doesNotMatch(perf, /o\.maxLoad = /, "o.maxLoad stays the option, never the last side's limit");
  const drop = await readFile(new URL("../harness/probes/drop-meter.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(drop, /o\.maxLoad = /);
  // a visit keeps its gate in raw.gate: a re-analysis judges it the same
  assert.equal(visitLimit({ gate: { limit: 16 } }, null), 16);
  assert.equal(visitLimit({ gate: { limit: 5, ok: true } }, 5), 5);
  assert.equal(visitLimit({}, 8), 8, "an older raw without a gate: --max-load");
});

test("bench read on Linux (CI): the lane's cores and the runnable threads from /proc", { skip: process.platform !== "linux" && "/proc: Linux only" }, async () => {
  const g = await benchRead({ lane: { lane: "a", cpus: "0" }, tickets: [], load: () => 0.5, ms: 50 });
  assert.equal(g.granted, 0);
  assert.ok(g.background >= 0 && g.total >= g.background);
  assert.equal(g.limit, benchLimit({ granted: 0 }));
  assert.ok(Array.isArray(g.laneBusy));
});
