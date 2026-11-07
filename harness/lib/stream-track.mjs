// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// What the worker's stream track carries (harness/probes/stream-track.mjs):
// the frames a streaming host would encode, read in the page through a
// MediaStreamTrackProcessor. Each frame's timestamp is the worker's capture
// time (StreamCapture, ms); the arrival is the page's read time.

const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1) : null;
};
export const distribution = (values) => ({
  n: values.length,
  p50: quantile(values, 0.5),
  p95: quantile(values, 0.95),
  p99: quantile(values, 0.99),
  max: values.length ? +Math.max(...values).toFixed(1) : null
});

// frames: [captureMs, arrivalMs] in read order, over `secs` seconds.
// gapMs: a capture interval above it is a frame the stream missed (at 60 Hz
// a frame is 16.7 ms; 25 ms means at least one VI went by without one).
export function streamTrackStats(frames, secs, { gapMs = 25 } = {}) {
  const capture = frames.slice(1).map((f, i) => f[0] - frames[i][0]);
  const arrival = frames.slice(1).map((f, i) => f[1] - frames[i][1]);
  return {
    frames: frames.length,
    fps: secs > 0 ? +(frames.length / secs).toFixed(1) : null,
    captureInterval: distribution(capture),
    arrivalInterval: distribution(arrival),
    gaps: capture.filter((ms) => ms > gapMs).length,
    // the same capture time twice: a frame captured again (never expected)
    repeats: capture.filter((ms) => ms === 0).length
  };
}
