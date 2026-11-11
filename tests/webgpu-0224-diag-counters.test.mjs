// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Patch 0224 (harness only): the uber flag per VI window with its time, the
// first bind of every async pipeline, the GPU time per replay command buffer.
// Zero cost when off: core timings only with patch 0219's counters on, the
// GPU timer only once the harness is on.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createGpuFrameTimer, MAX_PASSES, READ_SLOTS } from "../src/wgpu-gpu-frame-timer.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const patch = read("patches/dolphin-wasm/snapshot/0224-webgpu-harness-uber-retrieve-gpu-time-counters.patch");
const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");

test("0224 core: VI windows timed and first binds logged only with the counters on", () => {
  assert.match(added, /slot\.t_ms\.store\(DolphinWeb::LoadStats::On\(\) \? EpochMs\(\) : 0\.0, std::memory_order_relaxed\);/);
  assert.match(added, /if \(xlat_stats_async\)\n\s+shader->m_xlat_end_ms = EpochMs\(\);/);
  assert.match(added, /if \(DolphinWeb::LoadStats::On\(\)\)\n\s+pending->m_ready_ms = EpochMs\(\);/);
  assert.match(added, /\/\/ Patch 0224 \(harness\): this pipeline's first specialized bind\.\n\s+if \(DolphinWeb::LoadStats::On\(\)\)/);
  assert.match(added, /extern "C" EMSCRIPTEN_KEEPALIVE u32 DolphinWeb_UberViLog\(double\* out, u32 max\)/);
  assert.match(added, /extern "C" EMSCRIPTEN_KEEPALIVE u32 DolphinWeb_RetrieveLog\(double\* out, u32 max\)/);
  // allocated at the first event, never a static array
  assert.match(added, /log = new RetrieveEvent\[RETRIEVE_LOG\]\(\);/);
  assert.doesNotMatch(added, /static RetrieveEvent [a-z_]+\[/);
});

test("0224 worker: the GPU timer exists only with the harness on, every hook optional", () => {
  const w = read("src/upstream-discio-worker.js");
  assert.match(w, /if \(harnessEnabled\) \{\n\s+gpuFrameTimer \?\?= createGpuFrameTimer\(dev\);\n\s+gpuFrameTimer\.beginEncoder\?\.\(\);/);
  assert.match(w, /const timestampWrites = gpuFrameTimer\?\.passWrites\?\.\(\);\n\s+if \(timestampWrites\) desc\.timestampWrites = timestampWrites;\n\s+pass = enc\.beginRenderPass\(desc\);/);
  assert.match(w, /gpuFrameTimer\?\.beforeFinish\?\.\(enc\);\n\s+const renderCommandBuffer = enc\.finish\(\);/);
  assert.match(w, /gpuFrameTimer\?\.afterSubmit\?\.\(reason, submitted\);\n\s+enc = null;/);
  assert.match(w, /\.\.\.readUberDiagLogs\(m\),/);
});

test("0224 timer: absent without timestamp-query", () => {
  const t = createGpuFrameTimer({ features: new Set() });
  assert.equal(t.absent, true);
  assert.deepEqual(t.snapshot(), { gpuTimer: "absent" });
});

function fakeDevice({ stamps }) {
  const buffers = [];
  return {
    features: new Set(["timestamp-query"]),
    createQuerySet: () => ({}),
    createBuffer: ({ size }) => {
      const b = { size, mapped: null, mapAsync: async () => { b.mapped = stamps.buffer.slice(0, size); }, getMappedRange: (o, n) => b.mapped.slice(o, o + n), unmap: () => { b.mapped = null; } };
      buffers.push(b);
      return b;
    }
  };
}
const usage = { QUERY_RESOLVE: 1, COPY_SRC: 2, MAP_READ: 4, COPY_DST: 8 }, mode = { READ: 1 };

test("0224 timer: span and busy of an encoder's passes, with the submit time and reason", async () => {
  // two passes: [1.0 ms, 1.5 ms] and [2.0 ms, 3.1 ms] (ns)
  const stamps = new BigUint64Array(2 * MAX_PASSES);
  stamps.set([1_000_000n, 1_500_000n, 2_000_000n, 3_100_000n]);
  const t = createGpuFrameTimer(fakeDevice({ stamps }), { now: () => 42, bufferUsage: usage, mapMode: mode });
  const calls = [];
  const enc = { resolveQuerySet: (...a) => calls.push(["resolve", a[1], a[2]]), copyBufferToBuffer: (...a) => calls.push(["copy", a[4]]) };
  t.beginEncoder();
  assert.deepEqual(t.passWrites().beginningOfPassWriteIndex, 0);
  assert.deepEqual(t.passWrites().endOfPassWriteIndex, 3);
  t.beforeFinish(enc);
  assert.deepEqual(calls, [["resolve", 0, 4], ["copy", 32]]);
  t.afterSubmit("present", true);
  await new Promise((r) => setTimeout(r, 0));
  const s = t.snapshot();
  assert.equal(s.gpuTimer, "timestamp-query");
  assert.deepEqual(s.gpuFrameLog, [[42, 2.1, 1.6, 2, 0, 0]]);
  assert.equal(s.gpuTimerMinStepUs, 500);
});

test("0224 timer: an encoder begun with every read slot busy is not timed (counted)", () => {
  const t = createGpuFrameTimer(fakeDevice({ stamps: new BigUint64Array(2 * MAX_PASSES) }), { bufferUsage: usage, mapMode: mode });
  const enc = { resolveQuerySet() {}, copyBufferToBuffer() {} };
  for (let i = 0; i < READ_SLOTS; i += 1) { t.beginEncoder(); t.passWrites(); t.beforeFinish(enc); }
  t.beginEncoder();
  assert.equal(t.passWrites(), null);
  assert.equal(t.snapshot().gpuTimerUntimed, 1);
});
