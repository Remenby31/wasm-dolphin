// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFrameTelemetry } from "../src/wgpu-frame-telemetry.js";

test("frame telemetry: callback lateness in buckets, BeginFrames gone by unseen, drains and their submit part", () => {
  const t = createFrameTelemetry();
  const R = 1000 / 120;
  // 6 BeginFrames every refresh, then one 3 refreshes later (2 unseen), then one 2 later
  let ft = 0;
  const lates = [0.5, 1.5, 3, 6, 12, 20, 0.2, 0.3];
  for (let i = 0; i < 6; i++) t.tick((ft += R), ft + lates[i]);
  t.tick((ft += 3 * R), ft + lates[6]);
  t.tick((ft += 2 * R), ft + lates[7]);
  const s = t.snapshot();
  assert.equal(s.ticks, 8);
  assert.deepEqual([s.late1, s.late2, s.late4, s.late8, s.late16, s.lateOver16], [3, 1, 1, 1, 1, 1]);
  assert.ok(Math.abs(s.periodMs - R) < 1e-9);
  assert.equal(s.skipped, 3, "2 + 1 BeginFrames unseen");
  assert.deepEqual([s.skip0, s.skip1, s.skip2, s.skip3plus], [2, 1, 1, 0], "counted once the period is known (4 gaps)");
  t.drain(3, 1);
  t.drain(9, 2);
  const d = t.snapshot();
  assert.deepEqual([d.drains, d.drainMs, d.submitMs, d.drainOver4, d.drainOver8], [2, 12, 3, 1, 1]);
  for (const [k, v] of Object.entries(d)) if (k !== "periodMs") assert.equal(typeof v, "number", `${k}: flat numbers for race-perf deltas`);
  // the 3-refresh gap above (2 unseen) is no hole; one of 5 refreshes is, with what drained in it
  t.drain(2, 0.1);
  t.drain(30, 1);
  t.tick((ft += 5 * R), ft);
  const h = t.snapshot();
  assert.deepEqual([h.holes, h.holeDrains, h.holeDrainMs, h.holeDrainOver16, h.holeDrainOver50, h.holesWithoutDrain], [1, 4, 44, 1, 0, 0], "the two drains before count too");
  t.tick((ft += 6 * R), ft);
  assert.equal(t.snapshot().holesWithoutDrain, 1, "a hole the worker drained nothing in");
  t.present(5);
  assert.deepEqual([t.snapshot().presents, t.snapshot().presentOver4], [1, 1]);
  // a pipeline and a slow GPU inside the next hole
  t.pipeline(40);
  t.gpuDone(25);
  t.tick((ft += 5 * R), ft);
  const k = t.snapshot();
  assert.deepEqual([k.pipelines, k.pipelineOver4, k.holePipelines, k.holePipelineMs, k.gpuDoneOver8, k.gpuDoneOver16, k.gpuDoneOver33, k.holesGpuDoneOver16], [1, 1, 1, 40, 1, 1, 0, 1]);
  assert.equal(Object.keys(k).some((key) => /Longest|Max/.test(key)), false, "no maxima: race-perf takes deltas");
  t.submit(3);
  t.writeBuffer(100);
  t.writeBuffer(70000);
  t.writeTexture(300000);
  t.mapAsync();
  const q = t.snapshot();
  assert.deepEqual([q.submits, q.submitBuffers, q.writeBuffers, q.writeBufferBytes, q.writeBufferOver64k, q.writeTextures, q.writeTextureOver256k, q.mapAsyncs], [1, 3, 2, 70100, 1, 1, 1, 1]);
  t.reset();
  assert.equal(t.snapshot().ticks, 0);
});

test("frame telemetry: harness only, no timing at all in normal use", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /const tick = \(frameTime\) => \{\n {6}if \(harnessEnabled\) wgpuFrameTelemetry\.tick\(frameTime, performance\.now\(\)\);/);
  assert.match(worker, /const telemetryStartedAt = harnessEnabled \? performance\.now\(\) : 0;/);
  assert.match(worker, /const submitStartedAt = telemetryStartedAt \? performance\.now\(\) : 0;/);
  const calls = worker.match(/wgpuFrameTelemetry\.(tick|drain|present|pipeline|gpuDone)\((?!buffers)/g) ?? [];
  assert.equal(calls.length, 6, "one tick, one present, two drain ends, one pipeline, one GPU done");
  assert.match(worker, /const telemetryCreatedAt = harnessEnabled && !prewarmed \? performance\.now\(\) : 0;/);
  assert.match(worker, /if \(telemetryCreatedAt\) wgpuFrameTelemetry\.pipeline\(/);
  assert.match(worker, /if \(harnessEnabled\) \{\n(?:\s+\/\/[^\n]*\n)?\s+const submittedAt = performance\.now\(\);\n\s+dev\.queue\.onSubmittedWorkDone\(\)\.then\(\(\) => wgpuFrameTelemetry\.gpuDone\(/);
  assert.match(worker, /const presentStartedAt = harnessEnabled \? performance\.now\(\) : 0;/);
  assert.match(worker, /if \(presentStartedAt\) wgpuFrameTelemetry\.present\(/);
  assert.equal((worker.match(/if \(telemetryStartedAt\) wgpuFrameTelemetry\.drain\(/g) ?? []).length, 2, "every drain end gated");
  assert.match(worker, /case "validationReadWorkerFrames":\n(?:\s+\/\/[^\n]*\n)+\s+return \{ enabled: harnessEnabled, \.\.\.wgpuFrameTelemetry\.snapshot\(\), uploadProbe: /);
  // the queue wrapper: installed only from a harness-timed drain
  assert.match(worker, /if \(telemetryStartedAt\) instrumentQueueForHarness\(renderGpu\.device\);/);
  assert.equal((worker.match(/instrumentQueueForHarness\(/g) ?? []).length, 2, "defined once, called once");
});
