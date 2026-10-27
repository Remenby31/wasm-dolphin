// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Harness only (validationReadWorkerFrames): how the wgpu worker keeps up
// with the screen. The vsync presenter's rAF and the command ring's replay
// share this worker's thread; on the Spark at 120 Hz (and at 60) the rAF got
// two BeginFrames in three, half of them with nothing new, while a blank
// WebGPU page on the same screen got all of them. Per presenter BeginFrame:
// how late its callback ran after the frame time, and how many BeginFrames
// went by unseen since the previous one. Per ring drain: its time, and the
// part in enc.finish() + queue.submit() (the rest decodes and records the
// commands). Flat numbers only: race-perf --worker-read takes deltas of
// top-level numeric fields.

export const LATE_BOUNDS_MS = [1, 2, 4, 8, 16];

export function createFrameTelemetry() {
  const zero = () => ({
    ticks: 0, lateTotalMs: 0, late1: 0, late2: 0, late4: 0, late8: 0, late16: 0, lateOver16: 0,
    skipped: 0, skip0: 0, skip1: 0, skip2: 0, skip3plus: 0,
    drains: 0, drainMs: 0, submitMs: 0, drainOver4: 0, drainOver8: 0
  });
  let s = zero();
  let lastFrameTime = null;
  // the screen's period: the smallest of the last 16 frame-time gaps
  const gaps = [];
  const lateKeys = ["late1", "late2", "late4", "late8", "late16"];
  return {
    // A presenter BeginFrame of rAF time `frameTime`, its callback run at `now`.
    tick(frameTime, now) {
      const late = Math.max(0, now - frameTime);
      s.ticks += 1;
      s.lateTotalMs += late;
      const i = LATE_BOUNDS_MS.findIndex((b) => late <= b);
      s[i < 0 ? "lateOver16" : lateKeys[i]] += 1;
      if (lastFrameTime !== null && frameTime > lastFrameTime) {
        const gap = frameTime - lastFrameTime;
        gaps.push(gap);
        if (gaps.length > 16) gaps.shift();
        if (gaps.length >= 4) {
          const missed = Math.max(0, Math.round(gap / Math.min(...gaps)) - 1);
          s.skipped += missed;
          s[["skip0", "skip1", "skip2"][missed] ?? "skip3plus"] += 1;
        }
      }
      lastFrameTime = frameTime;
    },
    // A ring drain of `totalMs`, `submitMs` of it in finish() + submit().
    drain(totalMs, submitMs) {
      s.drains += 1;
      s.drainMs += totalMs;
      s.submitMs += submitMs;
      if (totalMs > 4) s.drainOver4 += 1;
      if (totalMs > 8) s.drainOver8 += 1;
    },
    snapshot() {
      return { ...s, periodMs: gaps.length >= 4 ? Math.min(...gaps) : null };
    },
    reset() {
      s = zero();
      lastFrameTime = null;
      gaps.length = 0;
    }
  };
}
