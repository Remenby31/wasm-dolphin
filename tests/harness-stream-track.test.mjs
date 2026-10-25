// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { streamTrackStats } from "../harness/lib/stream-track.mjs";

test("stream-track stats: rate, intervals, gaps over 25 ms and repeated captures", () => {
  // 60 Hz captures with one missed frame (33.4 ms) and one repeat (0 ms)
  const capture = [0, 16.7, 33.4, 66.8, 83.5, 83.5, 100.2];
  const frames = capture.map((t, i) => [t, 1000 + t + (i % 2)]);
  const s = streamTrackStats(frames, 0.1);
  assert.equal(s.frames, 7);
  assert.equal(s.fps, 70);
  assert.equal(s.gaps, 1);
  assert.equal(s.repeats, 1);
  assert.equal(s.captureInterval.max, 33.4);
  assert.equal(s.captureInterval.n, 6);
  assert.deepEqual(streamTrackStats([], 20).captureInterval, { n: 0, p50: null, p95: null, p99: null, max: null });
});

test("stream-track probe: takes the perf lock unless --no-lock, a watchdog per run, exits", async () => {
  const src = await readFile(new URL("../harness/probes/stream-track.mjs", import.meta.url), "utf8");
  assert.match(src, /values\["no-lock"\] \? null : await acquirePerfLock\(/);
  assert.match(src, /const runTimeoutMs = /);
  assert.match(src, /if \(held\.session\) await held\.session\.close\(\)/, "a timed-out run's session is closed before the next");
  assert.match(src, /process\.exit\(/, "ensureServer keeps node alive: the probe must exit");
  assert.match(src, /window\.__host\?\.captureVideoTrack\?\.\(\)/);
});
