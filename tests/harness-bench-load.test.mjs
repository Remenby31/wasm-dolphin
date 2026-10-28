// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { benchLane, benchLimit, benchRead, grantedLanes, LANE_FOREIGN_PCT, PER_LANE_LOAD } from "../harness/lib/bench-load.mjs";
import { gateReader, loadGaveUp, waitForLoad } from "../harness/lib/env.mjs";

test("bench load gate: the limit is the background plus 5 per granted lane, not a fixed --max-load", () => {
  assert.equal(PER_LANE_LOAD, 5);
  assert.equal(LANE_FOREIGN_PCT, 50);
  // a build or a multi holds both lanes; a waiting ticket none
  assert.equal(grantedLanes([{ lane: "a" }, { lane: null }, { lane: "none" }]), 1);
  assert.equal(grantedLanes([{ lane: "a" }, { lane: "b" }]), 2);
  assert.equal(grantedLanes([{ lane: "a b" }]), 2);
  // 2026-10-28: a lane a pair at --max-load 5 with two lane b screens running
  // (load 6-9) gave every run up; with both lanes granted the limit is 10 + background
  assert.equal(benchLimit({ background: 1.2, granted: 2 }), 11.2);
  assert.equal(benchLimit({ background: 0.4, granted: 0 }), 5.4, "this job's own lane at least");
  assert.equal(benchLane({}), null, "off the bench: the caller's --max-load");
  assert.deepEqual(benchLane({ SPARK_LANE: "a", SPARK_LANE_CPUS: "15-19,10-14" }), { lane: "a", cpus: "15-19,10-14", list: [15, 16, 17, 18, 19, 10, 11, 12, 13, 14] });
});

test("load gate: off the bench the 1-minute load against --max-load as before; a busy lane says which thread", async () => {
  const read = gateReader({ maxLoad: 5, load: () => 3.456, env: {} });
  assert.deepEqual(await read(), { load: 3.46, limit: 5, ok: true });
  assert.deepEqual(await gateReader({ maxLoad: 5, load: () => 7, env: { SPARK_LANE_CPUS: "15-19" } })(), { load: 7, limit: 5, ok: false }, "an injected load is kept even on the bench");
  const seen = [];
  const g = await waitForLoad({ waitSec: 0, log: (m) => seen.push(m), read: async () => ({ load: 4, limit: 10, ok: false, lane: "a", laneBusy: [{ comm: "python3", pct: 98, cpu: 16 }] }) });
  assert.equal(g.ok, false);
  assert.match(loadGaveUp(g), /^load 4 > 10, lane a cores busy \(python3 98 % on 16\) after --load-wait/);
});

test("the bench's own tree: spark-race exports the lane, race-perf and drop-meter judge runs against the gate's limit", async () => {
  const race = await readFile(new URL("../harness/remote/spark-race.sh", import.meta.url), "utf8");
  assert.match(race, /export SPARK_LANE="\$lane" SPARK_LANE_CPUS="\$SPARK_CHROME_CPUS,\$\{SPARK_NODE_CPUS:-\$ncpus\}"/);
  const perf = await readFile(new URL("../harness/probes/race-perf.mjs", import.meta.url), "utf8");
  assert.match(perf, /if \(g\.gate\?\.background !== undefined\) o\.maxLoad = g\.gate\.limit;/);
  const drop = await readFile(new URL("../harness/probes/drop-meter.mjs", import.meta.url), "utf8");
  assert.match(drop, /if \(gate\?\.background !== undefined\) o\.maxLoad = gate\.limit;/);
});

test("bench read on Linux (CI): the lane's cores and the background from /proc", { skip: process.platform !== "linux" && "/proc: Linux only" }, async () => {
  const g = await benchRead({ lane: { lane: "a", cpus: "0" }, tickets: [], load: () => 0.5, ms: 50 });
  assert.equal(g.granted, 0);
  assert.ok(g.background >= 0);
  assert.equal(g.limit, benchLimit({ background: g.background, granted: 0 }));
  assert.ok(Array.isArray(g.laneBusy));
});
