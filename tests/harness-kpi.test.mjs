// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { consistentRead, decodeRegionStats, DIAGNOSTICS, DIAGNOSTICS_BY_VERSION, poolStats, regionShares, REGION_STATS_BYTES, topMisses } from "../harness/lib/jit-region-stats.mjs";
import { p4Summary, regionRecord, summarizeP4 } from "../harness/probes/race-perf.mjs";
import { launchTtff, summarizeTtff } from "../harness/lib/ttff.mjs";
import { summarizeLaunch, summarizeP7, unavailable } from "../harness/lib/aot-progress.mjs";
import { candidateColumn, classify, KPI_ROWS, kpiMarkdown, kpiTable, servedSides, sideFlags, sideHasAot, trunkSide } from "../harness/lib/kpi.mjs";
import { findResults, loadResults, readCandidate, readManual } from "../harness/kpi-report.mjs";

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
    regionCycleShare: 0.9, regionCycleShareRaw: 0.9, regionTimeShare: 0.7, dispatchTimeShare: 0.1, blockTimeShare: 0.15, interpTimeShare: 0.05,
    idleCycleShare: null, idleTimeShare: null, cycleBasis: "all cycles (core without idleCycles)",
    regionCalls: 1234, regionNotEntry: 3, regionStops: 7, sampleEvery: 64
  });
  // Counters only (no host time sampled): time shares are null, not 0.
  const counters = regionShares(decodeRegionStats(statsBytes({ sampleEvery: 0, f64: [1, 4] })));
  assert.equal(counters.regionCycleShare, 0.25);
  assert.equal(counters.regionTimeShare, null);
});

test("region stats: layout versions 1 and 2 decoded each their own way, any other refused", () => {
  const f64 = [414, 1000, 60, 10, 25, 5, 50, 1, 0];
  // v1 of 0075 before its review: four top misses and a spare.
  const v1 = decodeRegionStats(statsBytes256({ version: 1, f64, diag: { idleCycles: 550, topMiss3Pc: 0x80031234, topMiss3Cycles: 9, spare: 0 } }));
  assert.equal(v1.version, 1);
  assert.equal(v1.diagnostics.topMiss3Pc, 0x80031234);
  assert.equal("installMs" in v1.diagnostics, false); // a PC is never read as milliseconds
  assert.deepEqual(topMisses(v1), [["0x80031234", 9]]); // the 4th pair exists in v1
  // v2 of 0075 after its review: three top misses, then the region installs.
  const v2 = decodeRegionStats(statsBytes256({ version: 2, f64, diag: { idleCycles: 550, installMaxSliceMs: 3.5, installsFast: 40, installMs: 120 } }));
  assert.deepEqual([v2.diagnostics.installMaxSliceMs, v2.diagnostics.installsFast, v2.diagnostics.installMs], [3.5, 40, 120]);
  assert.equal(v2.diagnostics.installFallbacks, 0);
  // The v2 header's spare u32 counts the regions compiled cold (no ready byte).
  const packed = decodeRegionStats(statsBytes256({ version: 2, f64, reserved: (57 << 16) | 3 })).diagnostics;
  assert.deepEqual([packed.installFallbacks, packed.installBootMaxSliceMs], [3, 5.7]); // high 16 bits: boot max x 10
  assert.equal("topMiss3Pc" in v2.diagnostics, false);
  assert.equal(topMisses(v2).length, 0); // no top miss set in this read
  // v1 may come without diagnostics (88 bytes); v2 never.
  assert.equal(decodeRegionStats(statsBytes({ f64 })).diagnostics, undefined);
  assert.match(decodeRegionStats(statsBytes256({ version: 2, size: 88, f64 })).error, /v2 needs 256/);
  assert.match(decodeRegionStats(statsBytes256({ version: 3, f64 })).error, /layout version 3, this harness reads 1 and 2/);
});

test("region stats: unknown layout, short struct, torn read and impossible shares are refused", () => {
  assert.match(decodeRegionStats(statsBytes({ version: 7 })).error, /version 7/);
  assert.match(decodeRegionStats(statsBytes({ size: 80 })).error, /struct of 80 bytes/);
  assert.match(decodeRegionStats([1, 0, 0]).error, /no header/);
  // The second copy went backwards: a reset or a mid-update read.
  assert.match(regionRecord(reply([900, 1000, 70, 10, 15, 5, 9, 0, 0], [10, 20, 1, 1, 1, 1, 1, 0, 0])).p4Why, /torn read/);
  // More region cycles than cycles: never clamped into a plausible share.
  assert.match(regionRecord(reply([1100, 1000, 1, 1, 1, 1, 1, 0, 0])).p4Why, /regionCycleShare 1\.1, .* outside \[0, 1\]/);
  assert.match(consistentRead({ error: "x" }, {}).error, /x/);
  // Dispatch time is slice time minus the sampled parts: it may drop between two copies.
  assert.equal(regionRecord(reply([900, 1000, 70, 10, 15, 5, 9, 0, 0], [905, 1010, 71, 9.5, 16, 5, 10, 0, 0])).p4.regionCycleShare, 0.9);
  assert.match(regionRecord(reply([900, 1000, 70, -1, 15, 5, 9, 0, 0])).p4Why, /dispatchTimeMs = -1/);
  // The core's per-install samples ride along as they are; none with an older core.
  const samples = [[0.21, 40960, 1], [3.4, 912384, 2]];
  assert.deepEqual(regionRecord({ ...reply([900, 1000, 70, 10, 15, 5, 9, 0, 0]), installSamples: samples }).installSamples, samples);
  assert.equal("installSamples" in regionRecord(reply([900, 1000, 70, 10, 15, 5, 9, 0, 0])), false);
});

// The 0075 struct of 256 bytes: v1 then the diagnostics (DIAGNOSTICS order).
function statsBytes256({ f64 = [], diag = {}, version = 2, size = 256, reserved = 0 } = {}) {
  const buf = new ArrayBuffer(256);
  const v = new DataView(buf);
  v.setUint32(0, version, true); v.setUint32(4, size, true); v.setUint32(8, 64, true); v.setUint32(12, reserved, true);
  f64.forEach((x, i) => v.setFloat64(16 + i * 8, x, true));
  (DIAGNOSTICS_BY_VERSION[version] ?? DIAGNOSTICS).forEach((name, i) => v.setFloat64(88 + i * 8, diag[name] ?? 0, true));
  return Array.from(new Uint8Array(buf));
}

test("region stats 256 bytes: cycle share outside idle skip, wait time apart, diagnostics", () => {
  // A race: 55 % of the cycles idle-skipped, regions 41.4 % of all cycles.
  const diag = { idleCycles: 550, idleTimeMs: 25, chainBreaks: 7, regionsInstalled: 120, topMiss0Pc: 0x80012345, topMiss0Cycles: 40, topMiss1Pc: 0x80020000, topMiss1Cycles: 10 };
  const s = decodeRegionStats(statsBytes256({ f64: [414, 1000, 60, 10, 25, 5, 50, 1, 0], diag }));
  assert.equal(s.diagnostics.idleCycles, 550);
  const p = regionShares(s);
  assert.equal(p.regionCycleShare, 0.92); // 414 / (1000 - 550)
  assert.equal(p.regionCycleShareRaw, 0.414);
  assert.equal(p.cycleBasis, "outside idle skip");
  assert.equal(p.idleCycleShare, 0.55);
  assert.equal(p.regionTimeShare, 0.6); // over region + dispatch + block + interp, the wait apart
  assert.equal(p.idleTimeShare, 0.2); // 25 / (100 + 25)
  assert.deepEqual(topMisses(s), [["0x80012345", 40], ["0x80020000", 10]]);
  assert.match(decodeRegionStats(statsBytes256({ f64: [1, 10], diag: { idleCycles: 11 } })).error, /idleCycles 11 > totalCycles 10/);
  // Summary over two windows: counters summed, pipeline state of the last one.
  const w = (idle) => regionRecord({ bytes: statsBytes256({ f64: [414, 1000, 60, 10, 25, 5, 50, 1, 0], diag: { ...diag, idleCycles: idle } }), again: statsBytes256({ f64: [414, 1000, 60, 10, 25, 5, 50, 1, 0], diag: { ...diag, idleCycles: idle } }) });
  const { p4 } = summarizeP4([w(550), w(450)]);
  assert.equal(p4.regionCycleShare, 0.828); // 828 / (2000 - 1000)
  assert.equal(p4.diagnostics.idleCycles, 1000);
  assert.equal(p4.diagnostics.chainBreaks, 14);
  assert.equal(p4.diagnostics.regionsInstalled, 120);
  assert.equal(p4.diagnostics.installMs, 0); // the last f64, cumulative (0075)
  assert.equal(p4.diagnostics.installsFast, 0);
  assert.equal("topMiss3Pc" in p4.diagnostics, false); // three top misses since 0075's review
  assert.deepEqual(p4.diagnostics.topMisses[0], ["0x80012345", 40]);
  // Idle cycles going backwards between the two copies: a torn read.
  assert.match(regionRecord({ bytes: statsBytes256({ f64: [1, 1000], diag: { idleCycles: 5 } }), again: statsBytes256({ f64: [1, 1000], diag: { idleCycles: 4 } }) }).p4Why, /idleCycles went backwards/);
  // A window without diagnostics pooled with one that has them: raw basis, never half-subtracted.
  assert.equal(regionShares(poolStats([s, decodeRegionStats(statsBytes({ f64: [414, 1000, 60, 10, 25, 5, 50, 1, 0] }))])).cycleBasis, "all cycles (core without idleCycles)");
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
const race = (at, { speed = 80, side = "candidate", commit = "T1", dirty = false, failed = [], chrome = { path: "chrome stable", args: "" }, maxLoad = 6, extra = {} } = {}) => ({
  kind: "race-perf", file: `race-${at}`,
  json: { probe: "race-perf", at, chrome, maxLoad, failed, served: { [side]: served(commit, dirty) }, [side]: { cold: speed == null ? null : { speed: { median: speed }, presentP99Ms: { median: 30 } } }, ...extra }
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
  assert.equal(rows.regionTimeShare.why, "aucune race-perf avec aot=1 sur trunk"); // P4 shares read aot=1
  assert.equal(rows.macSpeedAot.why, "aucune race-perf avec aot=1 sur trunk");
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
  const ab = { kind: "race-perf", file: "ab", json: { at: "2026-10-19T10:00:00Z", state: "s", query: "q", maxLoad: 6, change: null, candidate: { cold: { speed: { median: 81 } } }, baseline: { cold: { speed: { median: 79 } } } },
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
  put("a/b/c/d/e/f/g/summary.json", { probe: "ttff" }); // too deep
  put("worktree-archive-20261020/wt-x/results/ab-1/baseline/fuzz.json", { interpQuery: "i", jitQuery: "j", results: [] }); // an archived worktree's run
  put("bad/summary.json", "{ not json");
  assert.equal(findResults(root).length, 8);
  const results = loadResults([root], { root });
  assert.deepEqual(results.map((r) => r.kind).sort(), ["freeze-loop", "fuzz", "fuzz", "gate", "race-perf"]);
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
  assert.equal(KPI_ROWS.length, 17);
  // Every TTFF run overloaded: n/a, and the row says so.
  const over = { kind: "ttff", file: "o", json: { probe: "ttff", at: "2026-10-19T11:00:00Z", served: served("T1"), runs: 3, overloadedRuns: [1, 2, 3], cold: null, warm: null } };
  assert.match(kpiTable([over], {}, { trunk: TRUNK }).find((r) => r.id === "ttffCold").why, /runs 1, 2, 3 lancées sur machine surchargée/);
});

test("KPI: the region cycle share counts only outside idle skip", () => {
  const p4 = (basis) => ({ regionCycleShare: 0.93, regionTimeShare: 0.5, dispatchTimeShare: 0.2, idleCycleShare: 0.55, idleTimeShare: 0.3, cycleBasis: basis });
  const rows = (basis) => Object.fromEntries(kpiTable([race("2026-10-20T03:00:00Z", { extra: { query: "video=wgpu&aot=1", p4: p4(basis) } })], {}, { trunk: TRUNK }).map((r) => [r.id, r]));
  const outside = rows("outside idle skip");
  assert.equal(outside.regionCycleShare.value, 0.93);
  assert.equal(outside.regionCycleShare.status, "OK");
  assert.match(outside.regionCycleShare.detail, /idle skip : 55 % des cycles/);
  assert.match(outside.regionTimeShare.detail, /attente : 30 % du temps, à part/);
  const raw = rows("all cycles (core without idleCycles)");
  assert.equal(raw.regionCycleShare.status, "n/a");
  assert.match(raw.regionCycleShare.why, /part brute 93 %, idle compris/);
});

test("KPI: a candidate column beside trunk, never in its place", (t) => {
  // An A/B: trunk as baseline (clean T1), a PR head as candidate (dirty B, aot=1).
  const ab = { kind: "race-perf", file: "ab", json: { probe: "race-perf", at: "2026-10-20T03:11:00Z", query: "video=wgpu&wasmjit=1&aot=1&metrics=1", maxLoad: 6, chrome: { path: "chrome stable", args: "" }, failed: [],
    sides: { candidate: "/x/wt-jit-0074", baseline: "/x/wt-jit-trunk" }, served: { candidate: served("B", true), baseline: served("T1") },
    candidate: { cold: { speed: { median: 95.8 }, presentP99Ms: { median: 27 } } }, baseline: { cold: { speed: { median: 83.3 }, presentP99Ms: { median: 27.2 } } },
    p4: { regionCycleShare: 0.93, regionTimeShare: 0.33, dispatchTimeShare: 0.22, cycleBasis: "outside idle skip" }, baselineP4: null, baselineP4Why: "core has no DolphinWeb_JitRegionStats" } };
  const rows = kpiTable([ab], {}, { trunk: TRUNK });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.macSpeed.value, 83.3); // trunk stays trunk
  assert.equal(byId.regionCycleShare.status, "n/a");
  const c = candidateColumn(ab, { label: "P4 (#43)" });
  assert.deepEqual([c.commit, c.dirty, c.flags], ["B", true, "aot=1&wasmjit=1"]);
  assert.deepEqual(c.values.macSpeedAot, { value: 95.8, status: "KO", why: null });
  assert.equal(c.values.macSpeed, undefined); // an aot=1 candidate leaves the default rows empty
  assert.equal(c.values.regionCycleShare.status, "OK");
  assert.equal(c.values.dispatchTimeShare.value, 0.22);
  assert.equal(c.values.ttffCold, undefined); // only the rows race-perf feeds
  const md = kpiMarkdown(rows, { at: "T", candidate: c });
  assert.match(md, /\| Vitesse course, Mac M4 Pro, défaut \| 83\.3 % \|.*\|  \|/);
  assert.match(md, /\| Vitesse course, Mac M4 Pro, aot=1 [^|]*\| n\/a [^|]*\|.*\| 95\.8 % \(KO\) \|/);
  assert.match(md, /Colonne « Candidat » : `P4 \(#43\)` \(aot=1&wasmjit=1\), max-load 6, `ab` @ B avec modifications locales/);
  assert.doesNotMatch(kpiMarkdown(rows, { at: "T" }), /Candidat/);

  const root = mkdtempSync(path.join(os.tmpdir(), "kpi-candidate-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "s.json"), JSON.stringify(ab.json));
  writeFileSync(path.join(root, "f.json"), JSON.stringify({ probe: "ttff" }));
  assert.equal(readCandidate({ candidate: path.join(root, "s.json"), "candidate-label": "L" }).values.macSpeedAot.value, 95.8);
  assert.match(readCandidate({ candidate: path.join(root, "f.json") }).error, /not a race-perf summary/);
  assert.equal(readCandidate({}, path.join(root, "absent.json")), null);
  // candidate.json pointing at a summary that is gone: an error, never an exception.
  writeFileSync(path.join(root, "candidate.json"), JSON.stringify({ summary: path.join(root, "gone", "summary.json") }));
  assert.match(readCandidate({}, path.join(root, "candidate.json")).error, /missing or unreadable/);
  writeFileSync(path.join(root, "broken.json"), "{ not json");
  assert.match(readCandidate({ candidate: path.join(root, "broken.json") }).error, /missing or unreadable/);
});

test("KPI report: a harness/results moved behind a symbolic link is still read, once", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kpi-report-link-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const moved = path.join(root, "build.noindex", "wt-x", "harness", "results");
  mkdirSync(path.join(moved, "fuzz-1"), { recursive: true });
  writeFileSync(path.join(moved, "fuzz-1", "fuzz.json"), JSON.stringify({ interpQuery: "i", jitQuery: "j", results: [], served: served("T1") }));
  mkdirSync(path.join(root, "wt-x", "harness"), { recursive: true });
  symlinkSync(moved, path.join(root, "wt-x", "harness", "results"));
  // A link below a source is not followed: no loop.
  symlinkSync(moved, path.join(moved, "fuzz-1", "loop"));
  const viaLink = loadResults([path.join(root, "wt-x", "harness", "results")], { root });
  assert.deepEqual(viaLink.map((r) => r.file), ["wt-x/harness/results/fuzz-1/fuzz.json"]);
  // The link and its target both as sources: one result.
  assert.equal(loadResults([path.join(root, "wt-x", "harness", "results"), path.join(root, "build.noindex")], { root }).length, 1);
});

test("KPI: absolute race rows come from night measures (max-load 6 at most)", () => {
  const night = race("2026-10-20T03:11:00Z", { speed: 83.3, maxLoad: 6 });
  const day = race("2026-10-20T13:11:00Z", { speed: 80.2, maxLoad: 8 }); // newer, but a day pair
  const unknown = race("2026-10-20T14:00:00Z", { speed: 70, maxLoad: null }); // its limit unknown
  const rows = Object.fromEntries(kpiTable([night, day, unknown], {}, { trunk: TRUNK }).map((r) => [r.id, r]));
  assert.equal(rows.macSpeed.value, 83.3);
  assert.equal(rows.macSpeed.source, night.file);
  assert.equal(rows.raceFrameP99.source, night.file);
  const none = kpiTable([day], {}, { trunk: TRUNK }).find((r) => r.id === "macSpeed");
  assert.equal(none.status, "n/a");
  assert.match(none.why, /1 hors règle ignoré\(s\) : Chrome non standard ou mesure de jour, max-load > 6/);
  // The candidate column is relative: a day pair is shown, with its limit and note.
  const c = candidateColumn({ ...day, json: { ...day.json, sides: { candidate: "/x/wt-p4" } } }, { label: "P4 (#43)", note: "jour, relatif" });
  assert.equal(c.values.macSpeed.value, 80.2);
  assert.match(kpiMarkdown(kpiTable([night], {}, { trunk: TRUNK }), { at: "T", candidate: c }), /Colonne « Candidat » : `P4 \(#43\)`, jour, relatif, max-load 8,/);
});

test("KPI: one trunk with and without a switch (--baseline-query): the row says which side it read", () => {
  const pair = race("2026-10-20T23:10:00Z", { speed: 95, extra: {
    query: "video=wgpu&aot=1&metrics=1", baselineQuery: "video=wgpu&metrics=1",
    served: { candidate: served("T1"), baseline: served("T1") }, baseline: { cold: { speed: { median: 82 }, presentP99Ms: { median: 27 } } } } });
  assert.equal(sideFlags(pair.json, "candidate"), "aot=1");
  assert.equal(sideFlags(pair.json, "baseline"), null);
  // aot=1 asked of a core without regions (before P4) runs as the default.
  assert.equal(sideHasAot({ query: "aot=1", baselineP4Why: "core has no DolphinWeb_JitRegionStats" }, "baseline"), false);
  assert.equal(sideHasAot({ query: "aot=1", p4Why: "region stats not asked (no --region-sample)" }, "candidate"), true);
  assert.equal(sideFlags({ query: "aot=1", baselineP4Why: "core has no DolphinWeb_JitRegionStats" }, "baseline"), "aot=1 sans effet (cœur sans régions)");
  const rows = Object.fromEntries(kpiTable([pair], {}, { trunk: TRUNK }).map((r) => [r.id, r]));
  // The default rows read the side without aot=1, the aot=1 rows the other.
  assert.deepEqual([rows.macSpeed.value, rows.macSpeed.side, rows.macSpeed.flags], [82, "baseline", null]);
  assert.deepEqual([rows.macSpeedAot.value, rows.macSpeedAot.side, rows.macSpeedAot.flags], [95, "candidate", "aot=1"]);
  assert.equal(rows.macSpeedAot.counted, false);
  assert.equal(rows.macSpeed.counted, true);
  assert.match(kpiMarkdown([rows.macSpeedAot], { at: "T" }), /@ T1, aot=1, 2026-10-20T23:10/);
});
