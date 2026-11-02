// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";

import { replayWaitsOf, replayWaitSummary } from "../harness/lib/replay-wait.mjs";
import { mergeTimeline } from "../harness/lib/timeline.mjs";
import { createPipelineLog, PIPELINE_WAKE } from "../src/harness-pipeline-log.js";

const swap = (vi, t) => ({ vi, t, behind: 0, fifoBytes: 0, fresh: true, held: false });

test("a tag waits for the drain that replayed it: wait charged to that drain's wake, lag from its schedule", () => {
  const tl = {
    swaps: [swap(1, 100), swap(2, 200)],
    pipeline: {
      tags: [{ vi: 1, t: 104.5 }, { vi: 2, t: 201.2 }],
      // vi 1: a 0 ms timer scheduled at 100.2 ran at 104 (clamped); vi 2: the parker, parked at 150, woke at 201
      drains: [{ t: 104, wake: PIPELINE_WAKE.timer0, setAt: 100.2 }, { t: 201, wake: PIPELINE_WAKE.parker, setAt: 150 }]
    }
  };
  const w = replayWaitsOf(tl);
  assert.deepEqual(w.map((x) => [x.vi, x.wake, x.waitMs, x.lagMs, x.processingMs, x.missed]), [[1, "timer0", 4, 3.8, 0.5, 0], [2, "parker", 1, 51, 0.2, 0]]);
  const s = replayWaitSummary(w);
  assert.equal(s.all.tags, 2);
  assert.equal(s.all.byWake.timer0.waitShare, 0.8);
  assert.equal(s.late.tags, 1, "only vi 1 is over 2 ms");
  assert.equal(s.late.byWake.timer0.tags, 1);
});

test("drains after the swap that did not replay it are counted missed; a drain started before the swap waits 0", () => {
  const tl = {
    swaps: [swap(5, 100), swap(6, 300)],
    pipeline: {
      tags: [{ vi: 5, t: 109 }, { vi: 6, t: 300.4 }],
      drains: [{ t: 101, wake: 0, setAt: 101 }, { t: 103, wake: 0, setAt: 102 }, { t: 108, wake: 1, setAt: 104 }, { t: 299, wake: 3, setAt: null }]
    }
  };
  const w = replayWaitsOf(tl);
  assert.deepEqual(w.map((x) => [x.vi, x.wake, x.waitMs, x.missed, x.lagMs]), [[5, "timerIdle", 8, 2, 4], [6, "presentation", 0, 0, null]]);
  assert.equal(w[1].processingMs, 0.4);
});

test("no swaps or no drain records: null, never zeros; a tag without its replay is left out", () => {
  assert.equal(replayWaitsOf({ swaps: null, pipeline: { tags: [], drains: [] } }), null);
  assert.equal(replayWaitsOf({ swaps: [swap(1, 1)], pipeline: { tags: [], queued: [], ticks: [] } }), null);
  assert.equal(replayWaitSummary(null), null);
  const w = replayWaitsOf({ swaps: [swap(1, 1), swap(2, 2)], pipeline: { tags: [{ vi: 2, t: 3 }], drains: [{ t: 2.5, wake: 2, setAt: null }] } });
  assert.deepEqual(w.map((x) => x.vi), [2]);
  assert.equal(w[0].lagMs, null);
});

test("pipeline log: drain records round-trip through the log and mergeTimeline", () => {
  const log = createPipelineLog({ capacity: 8 });
  log.replayStart(PIPELINE_WAKE.parker, 10, 5);
  log.replayStart(PIPELINE_WAKE.presentation, 11, null);
  const d = log.drain();
  assert.deepEqual(d.drains, { t: [10, 11], wake: [2, 3], setAt: [5, null] });
  const base = { presents: { t: [], frame: [], vi: [], lost: 0 }, vi: { supported: true, t: [], ticks: [], sinceBoot: [], sinceLoad: [], lost: 0 }, displayed: null, displayedWhy: "x", displayedLost: 0, swaps: null, swapsWhy: "x" };
  assert.deepEqual(mergeTimeline([{ ...base, pipeline: d }]).pipeline.drains, [{ t: 10, wake: 2, setAt: 5 }, { t: 11, wake: 3, setAt: null }]);
  // a log from before the drain records: none, never an error
  const old = { tags: { vi: [], t: [] }, queued: { vi: [], t: [] }, ticks: { t: [], cb: [], vi: [] }, lost: 0 };
  assert.deepEqual(mergeTimeline([{ ...base, pipeline: old }]).pipeline.drains, []);
});

test("drop-meter --pipeline samples the threads' occupancy at each timeline read (null where not measured)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../harness/probes/drop-meter.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(o\.pipeline\) \(raw\.occupancy \?\?= \[\]\)\.push\(await page\.evaluate\(/);
  assert.match(src, /return \[performance\.timeOrigin \+ performance\.now\(\), n\(f\.cpuThreadBusy\), n\(f\.gpuThreadBusy\), n\(f\.replayBusy\)\];/);
});
