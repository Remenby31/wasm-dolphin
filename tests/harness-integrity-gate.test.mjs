import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { integrityBrief, integrityOf, parseIntegrityAllow, readIntegrity, treeHasIntegrity } from "../harness/lib/integrity.mjs";
import { exitCodeOf, integrityFailures } from "../harness/probes/drop-meter.mjs";

const clean = { id: 1, skipPipelineFailed: 0, skipBindGroup: 0, skipNoPass: 0, missingColorTarget: 0, droppedRecords: 0, batchAborts: 0, uploadTimeouts: 0, presents: 100, stagingCapacityWaits: 0 };

test("integrity over a window: deltas, the fatal counters that moved, the allowed ones apart", () => {
  const end = { ...clean, id: 9, skipBindGroup: 2, uploadTimeouts: 1, presents: 700, stagingCapacityWaits: 5 };
  const i = integrityOf(clean, end);
  assert.equal(i.delta.presents, 600);
  assert.ok(!("id" in i.delta));
  assert.deepEqual(i.fatal, ["skipBindGroup 2", "uploadTimeouts 1"]);
  assert.deepEqual(i.allowed, []);
  assert.match(integrityBrief(i), /INTEGRITY skipBindGroup 2, uploadTimeouts 1/);
  const allowed = integrityOf(clean, end, { allow: ["uploadTimeouts"] });
  assert.deepEqual(allowed.fatal, ["skipBindGroup 2"]);
  assert.deepEqual(allowed.allowed, ["uploadTimeouts 1"]);
  // context counters never fail a run
  assert.deepEqual(integrityOf(clean, { ...clean, presents: 900, stagingCapacityWaits: 40 }).fatal, []);
  assert.equal(integrityBrief(integrityOf(clean, clean)), "");
});

test("a load-epoch abort is excused only in a post-load window that saw the load, one per load", () => {
  const base = { ...clean, batchAborts: 0, rangeFailEpoch: 0, stateLoads: 0 };
  const at = (d) => ({ ...base, ...d });
  // the Spark case: a window holding one load, one pass lost to its epoch
  const load = integrityOf(base, at({ batchAborts: 1, rangeFailEpoch: 1, stateLoads: 1 }), { postload: true });
  assert.deepEqual(load.fatal, []);
  assert.deepEqual(load.allowed, ["batchAborts 1"]);
  // not a post-load window, or a window that did not see the load: fatal
  assert.deepEqual(integrityOf(base, at({ batchAborts: 1, rangeFailEpoch: 1, stateLoads: 1 })).fatal, ["batchAborts 1"]);
  assert.deepEqual(integrityOf(base, at({ batchAborts: 1, rangeFailEpoch: 1 }), { postload: true }).fatal, ["batchAborts 1"]);
  // two epoch losses for one load (the bump before and after): one abort excused at most
  assert.deepEqual(integrityOf(base, at({ batchAborts: 2, rangeFailEpoch: 2, stateLoads: 1 }), { postload: true }).fatal, ["batchAborts 2"]);
  // more aborts than epoch losses: fatal
  assert.deepEqual(integrityOf(base, at({ batchAborts: 2, rangeFailEpoch: 1, stateLoads: 2 }), { postload: true }).fatal, ["batchAborts 2"]);
  // no epoch loss with a 0207 core: nothing to excuse
  assert.deepEqual(integrityOf(base, at({ batchAborts: 1, stateLoads: 1 }), { postload: true }).fatal, ["batchAborts 1"]);
  // a core before 0207 (no rangeFailEpoch): the loads alone cap it
  const old = { ...clean, batchAborts: 0, stateLoads: 0 };
  assert.deepEqual(integrityOf(old, { ...old, batchAborts: 1, stateLoads: 1 }, { postload: true }).fatal, []);
  assert.deepEqual(integrityOf(old, { ...old, batchAborts: 2, stateLoads: 1 }, { postload: true }).fatal, ["batchAborts 2"]);
});

test("an excused abort never hides a failed upload or a range given up for another reason", () => {
  const base = { ...clean, batchAborts: 0, rangeFailEpoch: 0, stateLoads: 0, uploadAllocFailed: 0, uploadFailedGeometry: 0, uploadTextureFailed: 0, rangeFailInvalid: 0, rangeFailUpload: 0 };
  const load = { batchAborts: 1, rangeFailEpoch: 1, stateLoads: 1 };
  for (const k of ["uploadAllocFailed", "uploadFailedGeometry", "uploadTextureFailed", "rangeFailInvalid", "rangeFailUpload"]) {
    const i = integrityOf(base, { ...base, ...load, [k]: 1 }, { postload: true });
    assert.deepEqual(i.fatal, [`${k} 1`], k);
    assert.deepEqual(i.allowed, ["batchAborts 1"], k);
  }
});

// a page whose worker answers `reply` (or whose evaluate throws `reply`)
const pageAnswering = (reply) => ({ evaluate: async () => { if (reply instanceof Error) throw reply; return reply; } });

test("reading: only an older worker is unavailable; any other failure is UNREAD and fails the run", async () => {
  assert.deepEqual(await readIntegrity(pageAnswering(clean), { expected: true }), clean);
  // a tree without the counters (an older baseline): reported, not a failure
  assert.deepEqual(await readIntegrity(pageAnswering({ error: "Unknown upstream worker message: validationReadIntegrity" }), { expected: false }),
    { unavailable: "worker without validationReadIntegrity" });
  // the same answer from a tree that has them: unread
  const silent = await readIntegrity(pageAnswering({ error: "Unknown upstream worker message: validationReadIntegrity" }), { expected: true });
  assert.match(silent.unread, /the tree has the counters but its worker does not answer/);
  // a crashed page, a dead worker, a timeout: unread whatever the tree
  for (const reply of [new Error("Target page, context or browser has been closed"), { error: "worker terminated" }, { error: "validationReadIntegrity timed out after 10000 ms" }]) {
    for (const expected of [true, false]) {
      const r = await readIntegrity(pageAnswering(reply), { expected });
      assert.ok(r.unread, `${JSON.stringify(reply)} expected=${expected}`);
      const i = integrityOf(clean, r);
      assert.equal(i.fatal.length, 1);
      assert.match(i.fatal[0], /^unread \(/);
      assert.match(integrityBrief(i), /INTEGRITY unread/);
    }
  }
  // unread at the start fails too
  assert.equal(integrityOf({ unread: "worker terminated" }, clean).fatal.length, 1);
});

test("a tree has the counters when it carries src/wgpu-integrity.js", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "integrity-tree-"));
  assert.equal(treeHasIntegrity(root), false);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "wgpu-integrity.js"), "");
  assert.equal(treeHasIntegrity(root), true);
  assert.equal(treeHasIntegrity(null), false);
});

test("an older worker or core is reported, never failed", () => {
  assert.deepEqual(integrityOf({ unavailable: "worker without validationReadIntegrity" }, clean), { unavailable: "worker without validationReadIntegrity" });
  assert.equal(integrityBrief(integrityOf(null, clean)), "");
  // a field an older core does not print is null: no delta, not fatal
  const i = integrityOf({ ...clean, batchAborts: null }, { ...clean, batchAborts: null });
  assert.ok(!("batchAborts" in i.delta));
  assert.deepEqual(i.fatal, []);
});

test("an older picture shown after a newer one (patch 0208) fails the window; untagged, it is null", () => {
  assert.deepEqual(integrityOf({ ...clean, framesOutOfOrder: 0 }, { ...clean, framesOutOfOrder: 2 }).fatal, ["framesOutOfOrder 2"]);
  // a state load is no exception: the core's tag epoch already keeps it out
  assert.deepEqual(integrityOf({ ...clean, framesOutOfOrder: 0 }, { ...clean, framesOutOfOrder: 1 }, { postload: true }).fatal, ["framesOutOfOrder 1"]);
  // an older core (no frame tags) reports null: no delta, never fatal
  const untagged = integrityOf({ ...clean, framesOutOfOrder: null }, { ...clean, framesOutOfOrder: null });
  assert.ok(!("framesOutOfOrder" in untagged.delta));
  assert.deepEqual(untagged.fatal, []);
});

test("--integrity-allow takes fatal counters only", () => {
  assert.deepEqual(parseIntegrityAllow("deviceLosses, uncapturedErrors"), ["deviceLosses", "uncapturedErrors"]);
  assert.deepEqual(parseIntegrityAllow(undefined), []);
  assert.throws(() => parseIntegrityAllow("presents"), /not an integrity counter/);
});

test("drop meter: a visit whose integrity broke fails the batch (exit 2), compared or not", () => {
  const analyses = [
    { side: "baseline", run: 1, visit: 1, analysis: { integrityFailed: false } },
    { side: "candidate", run: 2, visit: 1, analysis: { integrityFailed: true, integrity: { fatal: ["skipNoPass 3"] } } }
  ];
  const failures = integrityFailures(analyses);
  assert.deepEqual(failures, [{ side: "candidate", run: 2, visit: 1, fatal: ["skipNoPass 3"] }]);
  assert.equal(exitCodeOf({ integrity: failures }, { compared: true, failed: false }), 2);
  assert.equal(exitCodeOf({ integrity: failures }, { compared: false, failed: false }), 2);
  assert.equal(exitCodeOf({ integrity: [] }, { compared: false, failed: false }), 0);
});

test("the probes read integrity around what they measure and act on it", async () => {
  const race = await readFile(new URL("../harness/probes/race-perf.mjs", import.meta.url), "utf8");
  assert.match(race, /const integrityStart = await readIntegrity\(page, \{ expected: o\.integrityExpected \}\);/);
  assert.match(race, /const integrityEnd = await readIntegrity\(page, \{ expected: o\.integrityExpected \}\);/);
  assert.match(race, /o = \{ \.\.\.o, integrityExpected: treeHasIntegrity\(side\.root\) \};/);
  assert.match(race, /integrity: integrityOf\(integrityStart, integrityEnd, \{ allow: o\.integrityAllow, postload: o\.phase === "postload" \}\)/);
  assert.match(race, /if \(c\.integrity\?\.fatal\?\.length\) why\.push\(`integrity: /);
  const drops = await readFile(new URL("../harness/probes/drop-meter.mjs", import.meta.url), "utf8");
  assert.match(drops, /raw\.integrityStart = await readIntegrity\(page, \{ expected: o\.integrityExpected \}\);/);
  assert.match(drops, /raw\.integrityEnd = await readIntegrity\(page, \{ expected: o\.integrityExpected \}\);/);
  assert.match(drops, /integrityExpected: treeHasIntegrity\(sides\[name\]\.root\)/);
  assert.match(drops, /!a\.error && !a\.overloaded && !a\.powerDrained && !a\.integrityFailed/);
  const gates = await readFile(new URL("../harness/probes/replay-gates.mjs", import.meta.url), "utf8");
  assert.match(gates, /const integrityExpected = treeHasIntegrity\(root\);/);
  assert.match(gates, /v\.integrity = integrityOf\(integrityStart, await readIntegrity\(session\.page, \{ expected: integrityExpected \}\), \{ postload: true \}\)/);
  assert.match(gates, /process\.exit\(failed\.length \|\| empty\.length \|\| summary\.integrity\.length \? 1 : 0\)/);
});

test("liveness: at speed >= 95 %, a picture changing under the floor is FROZEN (median of the readings)", async () => {
  const { frozenReason, FROZEN_FPS } = await import("../harness/lib/headroom.mjs");
  assert.equal(FROZEN_FPS, 10);
  // the 2026-10-31 Spark run: 4 picture changes a second at speed 100 %
  assert.match(frozenReason({ speed: 100, visualFps: [5, 4, 4] }), /^FROZEN: the picture changes 4 times a second \(< 10\) at speed 100 %/);
  assert.equal(frozenReason({ speed: 100, visualFps: [60, 59, 61] }), null);
  assert.equal(frozenReason({ speed: 100, visualFps: [30, 30, 29] }), null, "a 30 fps game is alive");
  assert.equal(frozenReason({ speed: 100, visualFps: [2, 58, 60] }), null, "one low reading is a moment, not a frozen window");
  assert.equal(frozenReason({ speed: 100, visualFps: [3, 60] }), null, "two readings (emulated window): both must be low");
  assert.equal(frozenReason({ speed: 80, visualFps: [4, 4, 4] }), null, "a slow run is judged by its speed, not here");
  assert.equal(frozenReason({ speed: 100, visualFps: [null, null] }), null, "unread: no verdict");
  assert.match(frozenReason({ speed: 99, visualFps: [8, 9, 30] }, { minFps: 10 }), /FROZEN/);
});

test("race-perf reads liveness around the window and invalidates a frozen steady run", async () => {
  const race = await readFile(new URL("../harness/probes/race-perf.mjs", import.meta.url), "utf8");
  assert.match(race, /const infoStart = await readFrameInfo\(page\)\.catch\(\(\) => null\);\n\s+const visualFps = \[infoStart\?\.vis \?\? null\];/);
  assert.match(race, /const mid = await readFrameInfo\(page\)\.catch\(\(\) => null\);\n\s+visualFps\.push\(mid\?\.vis \?\? null\);/);
  assert.match(race, /visualFps\.push\(info\?\.vis \?\? null\);/);
  // the same readings give the new frames shown (patch 0208), the reference
  assert.match(race, /newFramesPerSec: \{ mean: newFramesRate\(infoStart, info\), /);
  assert.match(race, /const frozen = o\.phase === "steady" \? frozenReason\(c, \{ minFps: o\.frozenFps \}\) : null;\n\s+if \(frozen\) why\.push\(frozen\);/);
});

test("replay-gates: a hash per captured frame, and the slot path inside the integrity window", async () => {
  const gates = await readFile(new URL("../harness/probes/replay-gates.mjs", import.meta.url), "utf8");
  assert.match(gates, /sha256: createHash\("sha256"\)\.update\(f\.data\)\.digest\("hex"\)/);
  assert.match(gates, /hashes: Object\.fromEntries\(Object\.entries\(frames\)\.map\(\(\[vi, f\]\) => \[vi, f\.sha256 \?\? null\]\)\)/);
  assert.match(gates, /"slot-reload": \{ type: "boolean", default: false \}/);
  // the slot load happens after the integrity window opened, before the captures
  const start = gates.indexOf("const integrityStart = await readIntegrity(");
  const slot = gates.indexOf('a.request("loadState", { slot: 1 })');
  const capture = gates.indexOf("await captureAtVi(session.page");
  assert.ok(start > 0 && start < slot && slot < capture);
});
