// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { consistentRead, decodeRegionStats, poolStats, regionShares, REGION_STATS_BYTES } from "../harness/lib/jit-region-stats.mjs";
import { p4Summary, regionRecord, summarizeP4 } from "../harness/probes/race-perf.mjs";
import { launchTtff, summarizeTtff } from "../harness/lib/ttff.mjs";
import { summarizeLaunch, summarizeP7, unavailable } from "../harness/lib/aot-progress.mjs";
import { classify, KPI_ROWS, kpiMarkdown, kpiTable, servedSides, trunkSide } from "../harness/lib/kpi.mjs";
import { findResults, loadResults, readManual } from "../harness/kpi-report.mjs";

// The struct the core writes (layout v1), as the worker returns it.
function statsBytes({ version = 1, size = REGION_STATS_BYTES, sampleEvery = 64, f64 = [] } = {}) {
  const buf = new ArrayBuffer(REGION_STATS_BYTES);
  const v = new DataView(buf);
  v.setUint32(0, version, true);
  v.setUint32(4, size, true);
  v.setUint32(8, sampleEvery, true);
  f64.forEach((x, i) => v.setFloat64(16 + i * 8, x, true));
  return Array.from(new Uint8Array(buf));
}
// regionCycles, totalCycles, regionMs, dispatchMs, blockMs, interpMs, calls, notEntry, stops
const reply = (f64, again = f64) => ({ bytes: statsBytes({ f64 }), again: statsBytes({ f64: again }) });

test("region stats: layout v1 decoded, shares over the CPU loop's four parts", () => {
  const s = decodeRegionStats(statsBytes({ f64: [900, 1000, 70, 10, 15, 5, 1234, 3, 7] }));
  assert.equal(s.version, 1);
  assert.equal(s.sizeBytes, 88);
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

test("region stats: unknown layout, short struct, torn read and impossible shares are refused", () => {
  assert.match(decodeRegionStats(statsBytes({ version: 2 })).error, /version 2/);
  assert.match(decodeRegionStats(statsBytes({ size: 80 })).error, /struct of 80 bytes/);
  assert.match(decodeRegionStats([1, 0, 0]).error, /no header/);
  // The second copy went backwards: a reset or a mid-update read.
  assert.match(regionRecord(reply([900, 1000, 70, 10, 15, 5, 9, 0, 0], [10, 20, 1, 1, 1, 1, 1, 0, 0])).p4Why, /torn read/);
  // More region cycles than cycles: never clamped into a plausible share.
  assert.match(regionRecord(reply([1100, 1000, 1, 1, 1, 1, 1, 0, 0])).p4Why, /regionCycleShare 1\.1 outside \[0, 1\]/);
  assert.match(consistentRead({ error: "x" }, {}).error, /x/);
});

test("race-perf p4: precise reason when null, pooled shares that add up, one-sided A/B withheld", () => {
  assert.equal(regionRecord(null).p4Why, "region stats not asked (no --region-sample)");
  assert.equal(regionRecord({ error: "core has no DolphinWeb_JitRegionStats" }).p4Why, "core has no DolphinWeb_JitRegionStats");
  assert.equal(regionRecord({ error: "Unknown upstream worker message: validationReadJitRegionStats" }).p4Why, "engine without validationReadJitRegionStats");
  assert.equal(regionRecord({ error: "harness hooks are off" }).p4Why, "harness hooks are off");
  // Two windows of very different sizes: shares of the sums, so they add up to 1.
  const a = regionRecord(reply([10, 100, 1, 9, 0, 0, 5, 0, 0])), b = regionRecord(reply([900, 1000, 90, 10, 0, 0, 50, 1, 2]));
  const { p4, why } = summarizeP4([a, b, regionRecord(null)]);
  assert.equal(p4.regionTimeShare, 0.8273); // 91 ms of 110, not the median of 0.1 and 0.9
  assert.equal(p4.regionTimeShare + p4.dispatchTimeShare + p4.blockTimeShare + p4.interpTimeShare, 1);
  assert.equal(p4.regionCalls, 55);
  assert.equal(p4.windows, 2);
  assert.equal(p4.missingWindows, 1);
  assert.match(why, /not asked/);
  assert.equal(poolStats([]), null);
  assert.deepEqual(summarizeP4([regionRecord({ error: "core has no DolphinWeb_JitRegionStats" })]), { p4: null, why: "core has no DolphinWeb_JitRegionStats" });
  const run = (c, bl) => ({ candidate: { cold: c }, baseline: { cold: bl } });
  const oneSided = p4Summary([run(a, regionRecord({ error: "core has no DolphinWeb_JitRegionStats" }))], { candidate: {}, baseline: {} });
  assert.equal(oneSided.p4Compare, "withheld: counters on the candidate only");
  assert.equal(oneSided.baselineP4Why, "core has no DolphinWeb_JitRegionStats");
  assert.equal(p4Summary([run(a, b)], { candidate: {}, baseline: {} }).p4Compare, "both sides");
  assert.equal(p4Summary([run(a, b)], { candidate: {} }).p4Compare, null);
});

test("ttff: a picture after the first core frame; every failed launch counts", () => {
  // Presents of the empty boot frames (vi 0), then the first core frame at
  // 4000; the page's loading screen changed the canvas at 1100.
  const presents = [{ t: 900, vi: 3 }, { t: 1200, vi: 0 }, { t: 4000, vi: 4 }, { t: 4016, vi: 5 }];
  assert.deepEqual(launchTtff({ clickAt: 1000, presents, loadedAt: 3000, contentTimes: [1100, 5000] }),
    { firstContentMs: 4000, firstPresentMs: 3000, firstEmptyPresentMs: 200, coreLoadedMs: 2000, error: null });
  assert.match(launchTtff({ clickAt: 1000, presents, contentTimes: [1100], timeoutSec: 60 }).error, /no picture after the first core frame within 60 s/);
  assert.match(launchTtff({ clickAt: 1000, presents, watcherError: "tainted" }).error, /canvas: tainted/);
  // Black frames only (vi 0), or a core that cannot say (vi -1): no first frame.
  assert.match(launchTtff({ clickAt: 0, presents: [{ t: 5, vi: 0 }] }).error, /no core frame presented/);
  assert.match(launchTtff({ clickAt: 0, presents: [{ t: 7, vi: -1 }], contentTimes: [8] }).error, /does not report VI outputs/);

  const ok = (ms) => ({ firstContentMs: ms, firstPresentMs: ms - 100, error: null });
  // Two failures and one success: the phase and the whole do not pass.
  const s = summarizeTtff([
    { run: 1, cold: ok(8000), warm: ok(3000) },
    { run: 2, cold: { error: "no core frame presented within 60 s" }, warm: ok(4000) },
    { run: 3, cold: { error: "no picture after the first core frame" }, warm: ok(5000) }
  ]);
  assert.equal(s.cold.firstContentMs.median, 8000);
  assert.deepEqual(s.cold.failed.map((f) => f.run), [2, 3]);
  assert.equal(s.cold.pass, false);
  assert.equal(s.warm.pass, true);
  assert.equal(s.pass, false);
  assert.equal(summarizeTtff([{ run: 1, cold: ok(5000), warm: ok(4000) }]).pass, true);
  assert.equal(summarizeTtff([{ run: 1, cold: ok(12000), warm: ok(4000) }]).pass, false);
  // A run started on an overloaded machine is left out and listed, not a failure.
  const loaded = summarizeTtff([{ run: 1, loadGate: { ok: false }, cold: ok(30000), warm: ok(30000) }, { run: 2, loadGate: { ok: true }, cold: ok(5000), warm: ok(4000) }]);
  assert.equal(loaded.cold.firstContentMs.median, 5000);
  assert.deepEqual(loaded.overloadedRuns, [1]);
  assert.equal(summarizeTtff([{ run: 1, loadGate: { ok: false }, cold: ok(1) }]).pass, null);
});

test("P7 progress: n/a until the engine has it, then duration and second launch, failures counted", () => {
  assert.match(unavailable({ error: "Unknown upstream worker message: validationReadAotProgress" }, null), /no P7 progress/);
  assert.match(unavailable({ schema: "wasm-dolphin.aot-progress.v1", state: "unsupported", events: [] }, null), /unsupported/);
  assert.match(unavailable({ schema: "wasm-dolphin.aot-progress.v1", state: "disabled", events: [] }, []), /disabled/); // the page log exists anyway
  assert.match(unavailable({ schema: "other" }, null), /schema other/);
  assert.equal(unavailable({ error: "Unknown" }, []), null); // page log only
  assert.equal(unavailable({ schema: "wasm-dolphin.aot-progress.v1", state: "running", events: [] }, null), null);

  const first = summarizeLaunch([
    { t: 1000, type: "start" }, { t: 2000, type: "progress", fraction: 0.4, done: 40, total: 100 },
    { t: 1500, type: "progress", fraction: 0.1, done: 10, total: 100 },
    { t: 9000, type: "done", total: 100, ms: 8000, compiled: 100 }
  ]);
  assert.equal(first.durationMs, 8000);
  assert.equal(first.monotonic, true); // sorted by time first
  assert.deepEqual(first.window, { from: 1000, to: 9000 });
  const second = summarizeLaunch([{ t: 1, type: "install", loaded: 100, failed: 0, deferred: 0, ms: 40 }, { t: 2, type: "start" }, { t: 3, type: "done", total: 100, ms: 1, compiled: 0 }]);
  assert.equal(second.install.loaded, 100);
  const good = summarizeP7([{ run: 1, first: { ...first, speedDuring: 80 }, second }, { run: 2, first: { ...first, durationMs: 12000, speedDuring: 70 }, second }]);
  assert.equal(good.durationMs, 10000);
  assert.equal(good.secondLaunchCompiled, 0);
  assert.equal(good.pass, true);

  // A first launch that never finished counts: no pass, its reason listed.
  const unfinished = summarizeLaunch([{ t: 0, type: "start" }]);
  const twoFailed = summarizeP7([{ run: 1, first, second }, { run: 2, first: { ...unfinished, timedOut: true } }, { run: 3, error: "boot timeout" }]);
  assert.equal(twoFailed.pass, false);
  assert.deepEqual(twoFailed.failedFirst.map((f) => f.why), ['first launch: no "done" event before the timeout', "first launch: boot timeout"]);
  // A second launch without "done": never a pass, never a silent null.
  const noDone = summarizeP7([{ run: 1, first, second: summarizeLaunch([{ t: 1, type: "install", loaded: 100 }]) }]);
  assert.equal(noDone.pass, false);
  assert.equal(noDone.secondLaunchCompiled, null);
  assert.match(noDone.failedSecond[0].why, /second launch: no "done" event/);
  assert.equal(summarizeP7([{ run: 1, first, second: { ...second, compiled: 3 } }]).pass, false);
  assert.equal(summarizeP7([{ run: 1, loadGate: { ok: false }, first, second }]), null);
});

// Results as kpi-report hands them over: trunk = {T1, T2}, B = a branch.
const TRUNK = new Set(["T1", "T2"]);
const served = (commit, dirty = false) => ({ commit, dirty, snapshot: "x", files: 1 });
const race = (at, { speed = 80, side = "candidate", commit = "T1", dirty = false, failed = [], chrome = { path: "chrome stable", args: "" }, extra = {} } = {}) => ({
  kind: "race-perf", file: `race-${at}`,
  json: { probe: "race-perf", at, chrome, failed, served: { [side]: served(commit, dirty) }, [side]: { cold: speed == null ? null : { speed: { median: speed }, presentP99Ms: { median: 30 } } }, ...extra }
});

test("KPI: only clean trunk results count, one result per row, shown with its commit", () => {
  const ttff = (at, commit, cold, warm) => ({ kind: "ttff", file: `ttff-${at}`, json: { probe: "ttff", at, served: served(commit), cold, warm } });
  const phase = (median, failed = []) => ({ firstContentMs: { median }, failed });
  const results = [
    race("2026-10-19T10:00:00Z", { speed: 80, extra: { p4: null, p4Why: "core has no DolphinWeb_JitRegionStats" } }),
    race("2026-10-19T12:00:00Z", { speed: 300, commit: "B" }), // a branch: left out
    race("2026-10-19T12:30:00Z", { speed: 300, dirty: true }), // local changes: left out
    race("2026-10-19T13:00:00Z", { speed: 200, chrome: { path: "/ecore-wrapper", args: "" } }), // not stock Chrome
    ttff("2026-10-19T11:00:00Z", "T2", phase(7000), phase(12000)),
    { kind: "first-launch", file: "fl", json: { probe: "first-launch", at: "2026-10-19T11:00:00Z", served: served("T2"), p7: null, p7Why: "no P7 progress in this engine" } }
  ];
  const rows = Object.fromEntries(kpiTable(results, { pcSpeed: { value: 49, source: "P9" } }, { trunk: TRUNK }).map((r) => [r.id, r]));
  assert.equal(rows.macSpeed.value, 80);
  assert.equal(rows.macSpeed.source, "race-2026-10-19T10:00:00Z");
  assert.equal(rows.macSpeed.commit, "T1");
  assert.equal(rows.macSpeed.status, "KO");
  assert.equal(rows.raceFrameP99.status, "OK");
  assert.equal(rows.regionTimeShare.status, "n/a");
  assert.equal(rows.regionTimeShare.why, "core has no DolphinWeb_JitRegionStats");
  assert.equal(rows.ttffCold.status, "OK");
  assert.equal(rows.ttffWarm.status, "KO");
  assert.equal(rows.optimisationMs.why, "no P7 progress in this engine");
  assert.equal(rows.pcSpeed.nature, "declared");
  assert.match(rows.oracleDivergences.why, /aucun résultat fuzz/);
  const md = kpiMarkdown(Object.values(rows), { at: "T" });
  assert.ok(md.indexOf("North star") < md.indexOf("Leviers") && md.indexOf("Garde-fous") < md.indexOf("Expérience joueur"));
  assert.match(md, /\| Time-to-first-frame, à froid \| 7 s \| ≤ 10 s \| OK \| mesuré \| `ttff-2026-10-19T11:00:00Z` @ T2, 2026-10-19T11:00 \|/);

  // The newest trunk result has no value: the row says why, it does not
  // fall back on an older one.
  const newer = kpiTable([...results, race("2026-10-19T14:00:00Z", { speed: null })], {}, { trunk: TRUNK }).find((r) => r.id === "macSpeed");
  assert.equal(newer.status, "n/a");
  assert.equal(newer.source, "race-2026-10-19T14:00:00Z");
  // No trunk result at all.
  assert.match(kpiTable([race("2026-10-19T12:00:00Z", { commit: "B" })], {}, { trunk: TRUNK })[1].why, /aucun résultat race-perf sur un commit propre de trunk \(1 hors trunk/);
});

test("KPI: failed runs make the row KO with the reasons, whatever the median", () => {
  const ttff = { kind: "ttff", file: "t", json: { probe: "ttff", at: "2026-10-19T11:00:00Z", served: served("T1"),
    cold: { firstContentMs: { median: 4000 }, failed: [{ run: 2, error: "no core frame presented within 60 s" }, { run: 3, error: "no picture" }] },
    warm: { firstContentMs: { median: 3000 }, failed: [] } } };
  const fl = { kind: "first-launch", file: "f", json: { probe: "first-launch", at: "2026-10-19T11:00:00Z", served: served("T1"),
    p7: { durationMs: 30000, secondLaunchCompiled: null, failedFirst: [], failedSecond: [{ run: 1, why: 'second launch: no "done" event' }] } } };
  const crash = race("2026-10-19T10:00:00Z", { failed: [{ run: 2, side: "candidate", why: "crash" }, { run: 3, side: "candidate", why: "overloaded" }] });
  const rows = Object.fromEntries(kpiTable([ttff, fl, crash], {}, { trunk: TRUNK }).map((r) => [r.id, r]));
  assert.equal(rows.ttffCold.status, "KO");
  assert.match(rows.ttffCold.why, /2 run\(s\) en échec : run 2 : no core frame/);
  assert.equal(rows.ttffWarm.status, "OK");
  assert.equal(rows.optimisationMs.status, "OK");
  assert.equal(rows.secondLaunchRecompiled.status, "KO");
  assert.match(rows.secondLaunchRecompiled.why, /no "done" event/);
  assert.equal(rows.macSpeed.status, "KO"); // a crash; the overloaded run is not a failure
  assert.match(rows.macSpeed.why, /1 run\(s\) en échec : run 2 : crash/);
});

test("KPI: trunk's side of an A/B, identities from the result or the files next to it", () => {
  const ab = { kind: "race-perf", file: "ab", json: { at: "2026-10-19T10:00:00Z", state: "s", query: "q", change: null, candidate: { cold: { speed: { median: 81 } } }, baseline: { cold: { speed: { median: 79 } } } },
    extra: { runs: [{ candidate: { served: served("B", true) }, baseline: { served: served("T2") } }, { candidate: { served: served("B", true) }, baseline: { served: served("T2") } }] } };
  assert.deepEqual(trunkSide(ab, TRUNK), { side: "baseline", commit: "T2" });
  const row = kpiTable([ab], {}, { trunk: TRUNK }).find((r) => r.id === "macSpeed");
  assert.equal(row.value, 79);
  assert.equal(row.side, "baseline");
  // Runs that served different commits: no identity, not trunk.
  const mixed = { ...ab, extra: { runs: [{ baseline: { served: served("T1") } }, { baseline: { served: served("T2") } }] } };
  assert.equal(trunkSide(mixed, TRUNK), null);
  // A gate counts for its candidate only.
  const gate = { kind: "gate", json: { decision: { ok: true }, correctness: {} }, extra: { candidate: { results: [{ served: served("T1") }] } } };
  assert.deepEqual(servedSides(gate), { candidate: served("T1") });
  assert.equal(trunkSide({ ...gate, extra: null }, TRUNK), null);
});

test("KPI report: files classified by content; manual.json errors become reasons", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kpi-report-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel, json) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), typeof json === "string" ? json : JSON.stringify(json)); };
  put("a/race/summary.json", { state: "s.sav", query: "q", candidate: {}, change: null });
  put("a/race/run1.json", { run: 1, candidate: { served: served("T1") } });
  put("b/c/d/fuzz.json", { interpQuery: "i", jitQuery: "j", results: [] });
  put("g/gate.json", { decision: { ok: true }, correctness: {} });
  put("g/candidate/summary.json", { spec: { name: "ci-homebrew" }, results: [{ served: served("T1") }] });
  put("e/summary.json", { spec: { name: "freeze-loop" }, results: [] });
  put("p/summary.json", { probe: "ttff", locked: false }); // a --no-lock plumbing check
  put("a/b/c/d/e/summary.json", { probe: "ttff" }); // too deep
  put("bad/summary.json", "{ not json");
  assert.equal(findResults(root).length, 7);
  const results = loadResults([root], { root });
  assert.deepEqual(results.map((r) => r.kind).sort(), ["freeze-loop", "fuzz", "gate", "race-perf"]);
  assert.deepEqual(servedSides(results.find((r) => r.kind === "race-perf")).candidate, served("T1"));
  assert.deepEqual(servedSides(results.find((r) => r.kind === "gate")).candidate, served("T1"));
  assert.equal(classify({ probe: "first-launch" }), "first-launch");
  assert.equal(classify(null), null);

  put("m1.json", "{ broken");
  put("m2.json", { pcSpeed: { value: "33-49" } });
  assert.match(readManual(path.join(root, "m1.json")).error, /m1\.json illisible/);
  assert.deepEqual(readManual(path.join(root, "absent.json")), {});
  const rows = (m) => Object.fromEntries(kpiTable([], m, { trunk: TRUNK }).map((r) => [r.id, r]));
  assert.match(rows(readManual(path.join(root, "m1.json"))).pcSpeed.why, /illisible/);
  assert.match(rows(readManual(path.join(root, "m2.json"))).pcSpeed.why, /non numérique/);
  assert.equal(KPI_ROWS.length, 14);
  // Every TTFF run overloaded: n/a, and the row says so.
  const over = { kind: "ttff", file: "o", json: { probe: "ttff", at: "2026-10-19T11:00:00Z", served: served("T1"), runs: 3, overloadedRuns: [1, 2, 3], cold: null, warm: null } };
  assert.match(kpiTable([over], {}, { trunk: TRUNK }).find((r) => r.id === "ttffCold").why, /runs 1, 2, 3 lancées sur machine surchargée/);
});
