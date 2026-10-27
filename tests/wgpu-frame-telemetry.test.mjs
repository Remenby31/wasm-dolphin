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
  t.reset();
  assert.equal(t.snapshot().ticks, 0);
});

test("frame telemetry: harness only, no timing at all in normal use", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /const tick = \(frameTime\) => \{\n {6}if \(harnessEnabled\) wgpuFrameTelemetry\.tick\(frameTime, performance\.now\(\)\);/);
  assert.match(worker, /const telemetryStartedAt = harnessEnabled \? performance\.now\(\) : 0;/);
  assert.match(worker, /const submitStartedAt = telemetryStartedAt \? performance\.now\(\) : 0;/);
  const calls = worker.match(/wgpuFrameTelemetry\.(tick|drain)\(/g) ?? [];
  assert.equal(calls.length, 3, "one tick, two drain ends");
  assert.equal((worker.match(/if \(telemetryStartedAt\) wgpuFrameTelemetry\.drain\(/g) ?? []).length, 2, "every drain end gated");
  assert.match(worker, /case "validationReadWorkerFrames":\n(?:\s+\/\/[^\n]*\n)+\s+return \{ enabled: harnessEnabled, \.\.\.wgpuFrameTelemetry\.snapshot\(\) \};/);
});
