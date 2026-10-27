// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { displayStats, mergeTimeline, windowOf } from "../harness/lib/timeline.mjs";

const VSYNC = 1000 / 60;
// A timeline chunk as validationReadTimeline returns it, with BeginFrames
// every vsync and `submits` per BeginFrame.
function chunk(submits, { t0 = 1000 } = {}) {
  return {
    presents: { t: [], frame: [], vi: [], lost: 0 }, vi: { supported: true, t: [], ticks: [], sinceBoot: [], sinceLoad: [], lost: 0 },
    displayedEnabled: true, displayedWhy: null, displayedLost: 0,
    displayed: { t: submits.map((_, i) => t0 + i * VSYNC), submits, vi: submits.map((n, i) => (n ? i : -1)) }
  };
}

test("display: a steady 30 fps game is not judder; dropped pictures are counted", () => {
  // 60 presents/s submitted in pairs every other BeginFrame: 30 shown/s, 30 dropped/s.
  const s = displayStats(mergeTimeline([chunk(Array.from({ length: 121 }, (_, i) => (i % 2 ? 0 : 2)))]));
  assert.equal(s.supported, true);
  assert.equal(Math.round(s.vsyncMs * 10) / 10, 16.7);
  // the BeginFrame cadence's spread, for a real screen's rAF (spark-run --headed)
  assert.ok(s.vsyncP05 <= s.vsyncMs && s.vsyncMs <= s.vsyncP95);
  assert.equal(s.displayedPerSecond, 30.5);
  assert.equal(s.submittedPerSecond, 61);
  assert.equal(s.dropped, 61);
  assert.equal(s.dominantVsyncs, 2);
  assert.equal(s.judderPct, 0);
  assert.equal(s.offOneVsyncPct, 100);
  assert.equal(s.noUpdatePct, 49.6);
});

test("display: uneven pacing (2-1-2-1…) is judder; a missing counter says why", () => {
  // Shown on BeginFrames 0, 2, 3, 5, 6, 8…: intervals 2, 1, 2, 1 vsyncs.
  const submits = Array.from({ length: 90 }, (_, i) => (i % 3 === 1 ? 0 : 1));
  const s = displayStats(mergeTimeline([chunk(submits)]));
  assert.ok(s.judderPct > 40 && s.judderPct < 60, `judder ${s.judderPct}`);
  assert.equal(s.dropped, 0);
  const none = mergeTimeline([{ ...chunk([]), displayed: null, displayedWhy: "not requested (validationEnableHarness { displayed: true })" }]);
  assert.deepEqual(displayStats(none), { supported: false, why: "not requested (validationEnableHarness { displayed: true })" });
  assert.match(displayStats(mergeTimeline([{ ...chunk([]), displayed: null, displayedWhy: undefined }])).why, /engine without the display counter/);
  // windowOf keeps the BeginFrames of the window only.
  assert.equal(windowOf(mergeTimeline([chunk([1, 1, 1, 1, 1])]), 1000, 1020).displayed.length, 2);
});
