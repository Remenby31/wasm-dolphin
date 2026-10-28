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
// top-level numeric fields, so no maxima (a delta of a running maximum is 0
// once it was reached before the window): counts over thresholds instead.
// A hole (3 BeginFrames or more gone by unseen between two callbacks) also
// records what the worker did in it: drains, their time and the longest; a
// hole with drains going on had a free worker (the BeginFrames were held
// back elsewhere), one with none had the worker blocked. presentMs: the
// presenter's own work at a BeginFrame (getCurrentTexture, copy, submit),
// which a swapchain that blocks would lengthen. Long tasks seen in the
// worker: a render pipeline created synchronously (the replay's
// createRenderPipeline), and how long the GPU took to finish a present's
// work (queue.onSubmittedWorkDone after its submit: a GPU running behind
// holds BeginFrames back), both also counted inside holes.

export const LATE_BOUNDS_MS = [1, 2, 4, 8, 16];

export function createFrameTelemetry() {
  const zero = () => ({
    ticks: 0, lateTotalMs: 0, late1: 0, late2: 0, late4: 0, late8: 0, late16: 0, lateOver16: 0,
    skipped: 0, skip0: 0, skip1: 0, skip2: 0, skip3plus: 0,
    drains: 0, drainMs: 0, submitMs: 0, drainOver4: 0, drainOver8: 0,
    holes: 0, holeMs: 0, holeDrains: 0, holeDrainMs: 0, holeDrainOver16: 0, holeDrainOver50: 0, holesWithoutDrain: 0,
    presents: 0, presentMs: 0, presentOver4: 0,
    pipelines: 0, pipelineMs: 0, pipelineOver4: 0, holePipelines: 0, holePipelineMs: 0,
    gpuDone: 0, gpuDoneMs: 0, gpuDoneOver8: 0, gpuDoneOver16: 0, gpuDoneOver33: 0, holesGpuDoneOver16: 0,
    // the queue's traffic (instrumentQueue): calls, command buffers, bytes
    submits: 0, submitBuffers: 0, writeBuffers: 0, writeBufferBytes: 0, writeBufferOver64k: 0,
    writeTextures: 0, writeTextureBytes: 0, writeTextureOver256k: 0, mapAsyncs: 0
  });
  // since the previous presenter callback: drains, pipelines, GPU lag
  const fresh = () => ({ drains: 0, ms: 0, over16: 0, over50: 0, pipelines: 0, pipelineMs: 0, gpuDoneOver16: 0 });
  let since = fresh();
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
          if (missed >= 3) {
            s.holes += 1;
            s.holeMs += gap;
            s.holeDrains += since.drains;
            s.holeDrainMs += since.ms;
            s.holeDrainOver16 += since.over16;
            s.holeDrainOver50 += since.over50;
            if (since.drains === 0) s.holesWithoutDrain += 1;
            s.holePipelines += since.pipelines;
            s.holePipelineMs += since.pipelineMs;
            if (since.gpuDoneOver16 > 0) s.holesGpuDoneOver16 += 1;
          }
        }
      }
      lastFrameTime = frameTime;
      since = fresh();
    },
    // A render pipeline created synchronously in `ms`.
    pipeline(ms) {
      s.pipelines += 1;
      s.pipelineMs += ms;
      if (ms > 4) s.pipelineOver4 += 1;
      since.pipelines += 1;
      since.pipelineMs += ms;
    },
    // A present's GPU work done `ms` after its submit.
    gpuDone(ms) {
      s.gpuDone += 1;
      s.gpuDoneMs += ms;
      if (ms > 8) s.gpuDoneOver8 += 1;
      if (ms > 16) s.gpuDoneOver16 += 1;
      if (ms > 33) s.gpuDoneOver33 += 1;
      if (ms > 16) since.gpuDoneOver16 += 1;
    },
    // The presenter's work at one BeginFrame (ms).
    present(ms) {
      s.presents += 1;
      s.presentMs += ms;
      if (ms > 4) s.presentOver4 += 1;
    },
    // A ring drain of `totalMs`, `submitMs` of it in finish() + submit().
    drain(totalMs, submitMs) {
      s.drains += 1;
      s.drainMs += totalMs;
      s.submitMs += submitMs;
      if (totalMs > 4) s.drainOver4 += 1;
      if (totalMs > 8) s.drainOver8 += 1;
      since.drains += 1;
      since.ms += totalMs;
      if (totalMs > 16) since.over16 += 1;
      if (totalMs > 50) since.over50 += 1;
    },
    // GPUQueue traffic, counted by the harness's queue wrapper.
    submit(buffers) { s.submits += 1; s.submitBuffers += buffers; },
    writeBuffer(bytes) { s.writeBuffers += 1; s.writeBufferBytes += bytes; if (bytes > 65536) s.writeBufferOver64k += 1; },
    writeTexture(bytes) { s.writeTextures += 1; s.writeTextureBytes += bytes; if (bytes > 262144) s.writeTextureOver256k += 1; },
    mapAsync() { s.mapAsyncs += 1; },
    snapshot() {
      return { ...s, periodMs: gaps.length >= 4 ? Math.min(...gaps) : null };
    },
    reset() {
      s = zero();
      lastFrameTime = null;
      gaps.length = 0;
      since = fresh();
    }
  };
}
