// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createKtraceJanitor, freeDiskGB, listKtraces, releaseOurHub, parseMetricRows, perKiloGuestCycles, recordingOptions, removeNewKtraces, threadMetrics, XCTRACE_MODES } from "../harness/lib/xctrace-counters.mjs";

// MetricTable as `xctrace export` writes it: each value once (id), then refs.
const thread = (id, tid, name) => `<thread id="${id}" fmt="${name}"><tid id="${id + 1}" fmt="0x${tid.toString(16)}">${tid}</tid><process id="${id + 2}" fmt="p (1)"><pid id="${id + 3}" fmt="1">1</pid></process></thread>`;
const XML = `<?xml version="1.0"?><trace-query-result><node><schema name="MetricTable"/>
<row><start-time id="1" fmt="0">1000000</start-time><duration id="2" fmt="1 ms">1000000</duration><string id="3" fmt="cycle">cycle</string><string id="4" fmt="Cycles">Cycles</string>${thread(5, 77, "DedicatedWorker thread (0x4d) (Google Chrome Helper (Renderer), pid: 1)")}<process ref="7"/><fixed-decimal id="10" fmt="3 000 000">3000000.000000000</fixed-decimal><core id="11" fmt="CPU 4 (P Core)">4</core><boolean id="12" fmt="No">0</boolean><sentinel/></row>
<row><start-time ref="1"/><duration ref="2"/><string id="13" fmt="delivery_latency_icache">delivery_latency_icache</string><string id="14" fmt="I">I</string><thread ref="5"/><process ref="7"/><fixed-decimal id="15" fmt="0,1">0.100000000</fixed-decimal><core ref="11"/><boolean id="16" fmt="Yes">1</boolean><markdown-text id="17" fmt="doc &lt;x&gt;"><string ref="14"/></markdown-text></row>
<row><start-time id="18" fmt="1">2000000</start-time><duration ref="2"/><string ref="3"/><string ref="4"/><thread ref="5"/><process ref="7"/><fixed-decimal id="19" fmt="1 000 000">1000000.000000000</fixed-decimal><core ref="11"/><boolean ref="12"/><sentinel/></row>
<row><start-time ref="18"/><duration ref="2"/><string ref="13"/><string ref="14"/><thread ref="5"/><process ref="7"/><fixed-decimal id="20" fmt="0,5">0.500000000</fixed-decimal><core ref="11"/><boolean ref="16"/></row>
<row><start-time ref="18"/><duration ref="2"/><string ref="3"/><string ref="4"/>${thread(21, 88, "CrRendererMain (0x58) (Google Chrome Helper (Renderer), pid: 1)")}<process ref="7"/><fixed-decimal id="30" fmt="500">500.000000000</fixed-decimal><core ref="11"/><boolean ref="12"/></row>
</node></trace-query-result>`;

test("xctrace: MetricTable rows resolve their refs across rows", () => {
  const rows = parseMetricRows(XML);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => [r.t, r.tid, r.metric, r.value]), [
    [1000000, 77, "cycle", 3000000], [1000000, 77, "delivery_latency_icache", 0.1],
    [2000000, 77, "cycle", 1000000], [2000000, 77, "delivery_latency_icache", 0.5], [2000000, 88, "cycle", 500]
  ]);
  assert.match(rows[3].thread, /^DedicatedWorker thread/);
});

test("xctrace: per thread, cycles summed and fractions weighted by each sample's cycles; busiest first", () => {
  const [cpu, main] = threadMetrics(parseMetricRows(XML));
  assert.equal(cpu.tid, 77);
  assert.equal(cpu.cycles, 4000000);
  assert.equal(cpu.deliveryLatencyIcache, 0.2); // (3M × 0.1 + 1M × 0.5) / 4M
  assert.equal(main.tid, 88);
  assert.equal(main.deliveryLatencyIcache, undefined);
});

test("xctrace: per 1000 guest cycles, host cycles and the cycles each fraction stands for", () => {
  const cold = { guestTicks: 2_000_000, counters: { tool: "xctrace", cycles: 4_000_000, fractions: { deliveryLatencyIcache: 0.2, deliveryBandwidth: 0.1 } } };
  assert.deepEqual(perKiloGuestCycles(cold), { cycles: 2000, deliveryLatencyIcacheCycles: 400, deliveryBandwidthCycles: 200 });
  assert.equal(perKiloGuestCycles({ ...cold, guestTicks: null }), null);
  assert.equal(perKiloGuestCycles({ guestTicks: 1, counters: { tool: "xctrace", error: "x" } }), null);
});

test("xctrace: recording options per guided mode; an unknown mode is refused", () => {
  const o = recordingOptions("delivery")["CPU Counters"];
  assert.equal(o.selectedCountingMode.countingMode, "delivery");
  assert.equal(o.countingLevel, "EL0");
  assert.equal(recordingOptions("discarded")["CPU Counters"].selectedCountingModeDisplayName, XCTRACE_MODES.discarded.display);
  assert.throws(() => recordingOptions("frontend"), /one of delivery, discarded/);
});

test("xctrace: the raw ktraces a window left in $TMPDIR are removed, unless held open or there before", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ktrace-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const make = (name) => { writeFileSync(path.join(dir, name), "x".repeat(1024)); return path.join(dir, name); };
  const old = make("instrumentsOLD.ktrace");
  make("other.trace");
  const before = listKtraces(dir);
  assert.deepEqual(before, [old]);
  const done = make("instrumentsAAA.ktrace"), open = make("instrumentsBBB.ktrace");
  const r = removeNewKtraces(before, listKtraces(dir), { isOpen: (f) => f === open });
  assert.deepEqual(r.removed, ["instrumentsAAA.ktrace"]);
  assert.deepEqual(r.keptOpen, [open]);
  assert.ok(!existsSync(done));
  assert.ok(existsSync(old) && existsSync(open));
  assert.ok(freeDiskGB(dir) > 0);
});

test("xctrace: a ktrace still open at the end of its window is removed later, once closed", async () => {
  const open = new Set(["/t/instrumentsA.ktrace"]), removed = [], logs = [];
  const j = createKtraceJanitor({ isOpen: (f) => open.has(f), remove: (f) => removed.push(f), log: (m) => logs.push(m) });
  j.add(["/t/instrumentsA.ktrace"]);
  assert.deepEqual(j.sweep(), { removed: [], open: ["/t/instrumentsA.ktrace"] });
  assert.deepEqual(removed, []);
  open.clear(); // DTServiceHub let go
  assert.deepEqual(await j.finish({ waitSec: 1, pollSec: 0.01 }), { ktraceLeft: [] });
  assert.deepEqual(removed, ["/t/instrumentsA.ktrace"]);
  assert.match(logs[0], /1 removed later, once closed/);
  // Still open past the wait: left, with its path.
  j.add(["/t/instrumentsB.ktrace"]);
  open.add("/t/instrumentsB.ktrace");
  assert.deepEqual(await j.finish({ waitSec: 0.05, pollSec: 0.01 }), { ktraceLeft: ["/t/instrumentsB.ktrace"] });
});

test("xctrace: a DTServiceHub holding only our window's ktrace is stopped; one holding others' is left alone", () => {
  const ours = ["/t/instrumentsA.ktrace"];
  const killed = [];
  const holders = () => new Map([
    [11, { command: "/Applications/Xcode.app/…/DTServiceHub", ktraces: ["/t/instrumentsA.ktrace"] }],
    [12, { command: "/Applications/Xcode.app/…/DTServiceHub", ktraces: ["/t/instrumentsA.ktrace", "/t/instrumentsZ.ktrace"] }],
    [13, { command: "/usr/bin/tail", ktraces: ["/t/instrumentsA.ktrace"] }]
  ]);
  assert.deepEqual(releaseOurHub(ours, { holders, kill: (pid) => killed.push(pid) }), [11]);
  assert.deepEqual(killed, [11]);
});
