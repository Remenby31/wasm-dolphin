// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decodeRegionStats, regionShares, REGION_STATS_BYTES } from "../harness/lib/jit-region-stats.mjs";
import { regionRecord, summarizeP4 } from "../harness/probes/race-perf.mjs";
import { launchTtff, summarizeTtff } from "../harness/lib/ttff.mjs";
import { summarizeLaunch, summarizeP7, unavailable } from "../harness/lib/aot-progress.mjs";
import { classify, KPI_ROWS, kpiMarkdown, kpiTable, raceSide } from "../harness/lib/kpi.mjs";
import { findResults, loadResults } from "../harness/kpi-report.mjs";

// The struct the core writes (layout v1), as the worker returns it.
function statsBytes({ version = 1, sampleEvery = 64, f64 = [] } = {}) {
  const buf = new ArrayBuffer(REGION_STATS_BYTES);
  const v = new DataView(buf);
  v.setUint32(0, version, true);
  v.setUint32(4, sampleEvery, true);
  f64.forEach((x, i) => v.setFloat64(8 + i * 8, x, true));
  return Array.from(new Uint8Array(buf));
}

test("region stats: layout v1 decoded, shares over the CPU loop's four parts", () => {
  // regionCycles, totalCycles, regionMs, dispatchMs, blockMs, interpMs, calls, notEntry, stops
  const s = decodeRegionStats(statsBytes({ f64: [900, 1000, 70, 10, 15, 5, 1234, 3, 7] }));
  assert.equal(s.version, 1);
  assert.equal(s.sampleEvery, 64);
  assert.deepEqual(regionShares(s), {
    regionCycleShare: 0.9, regionTimeShare: 0.7, dispatchTimeShare: 0.1, blockTimeShare: 0.15, interpTimeShare: 0.05,
    regionCalls: 1234, regionNotEntry: 3, regionStops: 7, sampleEvery: 64
  });
  // Counters only (no host time sampled): time shares are null, not 0.
  const counters = regionShares(decodeRegionStats(statsBytes({ sampleEvery: 0, f64: [1, 4] })));
  assert.equal(counters.regionCycleShare, 0.25);
  assert.equal(counters.regionTimeShare, null);
});

test("region stats: an unknown layout or a short buffer is refused, never misread", () => {
  assert.match(decodeRegionStats(statsBytes({ version: 2 })).error, /version 2/);
  assert.match(decodeRegionStats([1, 0, 0]).error, /3 bytes/);
});

test("race-perf p4: null with the reason when the core has no export, medians otherwise", () => {
  assert.deepEqual(regionRecord({ error: "core has no DolphinWeb_JitRegionStats" }), { p4: null, p4Why: "core has no DolphinWeb_JitRegionStats" });
  assert.equal(regionRecord({ error: "Unknown upstream worker message: validationReadJitRegionStats" }).p4, null); // older worker
  assert.equal(regionRecord(null).p4, null);
  const w = (share) => regionRecord({ bytes: statsBytes({ f64: [share * 100, 100, share * 10, 10 - share * 10, 0, 0, 5, 0, 0] }) });
  const p4 = summarizeP4([w(0.5), w(0.9), w(0.7), { p4: null }]);
  assert.equal(p4.regionCycleShare, 0.7);
  assert.equal(p4.regionCalls, 5);
  assert.equal(summarizeP4([{ p4: null }, undefined]), null);
});

test("ttff: first present after the hand-over, medians cold and warm against 10 s", () => {
  // Presents of the empty boot frames (vi 0) come first: the KPI is the first core frame.
  const launch = launchTtff({ clickAt: 1000, presents: [{ t: 900, vi: 3 }, { t: 1200, vi: 0 }, { t: 4000, vi: 4 }, { t: 4016, vi: 5 }], loadedAt: 3000, contentTimes: [1100, 5000] });
  assert.deepEqual(launch, { firstPresentMs: 3000, firstEmptyPresentMs: 200, coreLoadedMs: 2000, firstContentMs: 4000, error: null });
  assert.equal(launchTtff({ clickAt: 1000, presents: [{ t: 500, vi: 2 }, { t: 1500, vi: 0 }] }).firstPresentMs, null);
  assert.equal(launchTtff({ clickAt: 0, presents: [{ t: 7, vi: -1 }] }).firstPresentMs, 7); // a core that cannot say
  const s = summarizeTtff([
    { cold: { firstPresentMs: 8000 }, warm: { firstPresentMs: 3000 } },
    { cold: { firstPresentMs: 9000 }, warm: { firstPresentMs: 4000 } },
    { cold: { error: "no presentation" }, warm: { firstPresentMs: 5000 } }
  ]);
  assert.equal(s.cold.firstPresentMs.median, 8500);
  assert.equal(s.cold.runs, 2);
  assert.equal(s.warm.firstPresentMs.median, 4000);
  assert.equal(s.pass, true);
  assert.equal(summarizeTtff([{ cold: { firstPresentMs: 12000 } }]).pass, false);
  assert.equal(summarizeTtff([{ cold: { error: "x" } }]).pass, null);
});

test("P7 progress: n/a until the engine has it, then duration, shape and second launch", () => {
  assert.match(unavailable({ error: "Unknown upstream worker message: validationReadAotProgress" }, null), /no P7 progress/);
  assert.match(unavailable({ schema: "wasm-dolphin.aot-progress.v1", state: "unsupported", events: [] }, null), /unsupported/);
  assert.match(unavailable({ schema: "other" }, null), /schema other/);
  assert.match(unavailable({ schema: "wasm-dolphin.aot-progress.v1", state: "disabled", events: [] }, []), /disabled/); // the page log exists anyway
  assert.equal(unavailable({ error: "Unknown" }, []), null); // page log only
  assert.equal(unavailable({ schema: "wasm-dolphin.aot-progress.v1", state: "running", events: [] }, null), null);

  const first = summarizeLaunch([
    { t: 1000, type: "start" }, { t: 2000, type: "progress", fraction: 0.4, done: 40, total: 100 },
    { t: 1500, type: "progress", fraction: 0.1, done: 10, total: 100 },
    { t: 9000, type: "done", total: 100, ms: 8000, compiled: 100 }
  ]);
  assert.equal(first.durationMs, 8000);
  assert.equal(first.monotonic, true); // sorted by time first
  assert.equal(first.total, 100);
  assert.deepEqual(first.window, { from: 1000, to: 9000 });
  const second = summarizeLaunch([{ t: 1, type: "install", loaded: 100, failed: 0, deferred: 0, ms: 40 }, { t: 2, type: "start" }, { t: 3, type: "done", total: 100, ms: 1, compiled: 0 }]);
  assert.equal(second.install.loaded, 100);
  const p7 = summarizeP7([{ first: { ...first, speedDuring: 80 }, second }, { first: { ...first, durationMs: 12000, speedDuring: 70 }, second }]);
  assert.equal(p7.durationMs, 10000);
  assert.equal(p7.secondLaunchCompiled, 0);
  assert.equal(p7.pass, true);
  assert.equal(summarizeP7([{ first: summarizeLaunch([{ t: 0, type: "start" }]) }]), null); // never finished
  assert.equal(summarizeP7([{ first, second: { ...second, compiled: 3 } }]).pass, false);
});

test("KPI: rows in PROGRAM.md's order, newest value per row, reasons when missing", () => {
  assert.deepEqual(KPI_ROWS.map((r) => r.group).filter((g, i, a) => a.indexOf(g) === i), ["North star", "Leviers", "Garde-fous", "Expérience joueur"]);
  const race = (at, speed, extra = {}) => ({ kind: "race-perf", file: `race-${at}`, json: { probe: "race-perf", at, chrome: { path: "chrome stable", args: "" }, sides: { candidate: "this tree" }, candidate: { cold: speed == null ? null : { speed: { median: speed }, presentP99Ms: { median: 30 } } }, ...extra } });
  const results = [
    race("2026-10-19T10:00:00Z", 80),
    race("2026-10-19T12:00:00Z", null, { p4: null }), // newest, every run failed
    race("2026-10-19T13:00:00Z", 200, { chrome: { path: "/ecore-wrapper", args: "" } }), // not stock Chrome
    { kind: "ttff", file: "ttff", json: { probe: "ttff", at: "2026-10-19T11:00:00Z", cold: { firstPresentMs: { median: 7000 } }, warm: { firstPresentMs: { median: 12000 } } } },
    { kind: "first-launch", file: "fl", json: { probe: "first-launch", at: "2026-10-19T11:00:00Z", p7: null, p7Why: "no P7 progress in this engine" } }
  ];
  const rows = Object.fromEntries(kpiTable(results, { pcSpeed: { value: 49, source: "P9" } }).map((r) => [r.id, r]));
  assert.equal(rows.macSpeed.value, 80);
  assert.equal(rows.macSpeed.source, "race-2026-10-19T10:00:00Z");
  assert.equal(rows.macSpeed.status, "KO");
  assert.equal(rows.raceFrameP99.status, "OK");
  assert.equal(rows.regionTimeShare.status, "n/a");
  assert.match(rows.regionTimeShare.why, /P4 non fusionnée/);
  assert.equal(rows.ttffCold.status, "OK");
  assert.equal(rows.ttffWarm.status, "KO");
  assert.equal(rows.optimisationMs.why, "no P7 progress in this engine");
  assert.equal(rows.pcSpeed.nature, "declared");
  assert.equal(rows.aotcompilerMemory.status, "n/a");
  assert.equal(rows.oracleDivergences.why, "aucun résultat fuzz");
  const md = kpiMarkdown(Object.values(rows), { at: "T" });
  assert.ok(md.indexOf("North star") < md.indexOf("Leviers") && md.indexOf("Garde-fous") < md.indexOf("Expérience joueur"));
  assert.match(md, /\| Time-to-first-frame, à froid \| 7 s \| ≤ 10 s \| OK \| mesuré/);
});

test("KPI: trunk's side of an A/B is the program's number", () => {
  const j = { sides: { candidate: "/x/wt-jit-0074", baseline: "/x/wt-jit-trunk" }, candidate: { cold: { speed: { median: 81 } } }, baseline: { cold: { speed: { median: 79 } } }, p4: { regionTimeShare: 0.5 }, baselineP4: null };
  assert.equal(raceSide(j).side, "baseline");
  assert.equal(raceSide(j).cold.speed.median, 79);
  assert.equal(raceSide({ ...j, sides: { candidate: "origin/main", baseline: "x" } }).side, "candidate");
  assert.equal(raceSide({ ...j, sides: { candidate: "this tree" } }).side, "candidate");
});

test("KPI report: result files classified by content, wherever they sit", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kpi-report-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel, json) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), JSON.stringify(json)); };
  put("a/race/summary.json", { state: "s.sav", query: "q", candidate: {}, change: null });
  put("b/c/d/fuzz.json", { interpQuery: "i", jitQuery: "j", results: [] });
  put("gate.json", { decision: { ok: true }, correctness: {} });
  put("e/summary.json", { spec: { name: "freeze-loop" }, results: [] });
  put("f/summary.json", { spec: { name: "kart" }, results: [] }); // a matrix run: not a KPI source
  put("a/b/c/d/e/summary.json", { probe: "ttff" }); // too deep
  assert.equal(findResults(root).length, 5);
  assert.deepEqual(loadResults([root]).map((r) => r.kind).sort(), ["freeze-loop", "fuzz", "gate", "race-perf"]);
  assert.equal(classify({ probe: "first-launch" }), "first-launch");
  assert.equal(classify(null), null);
  assert.equal(classify({ probe: "ttff", locked: false }), null);
});
