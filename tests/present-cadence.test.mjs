// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Patch 0162: per-field histograms of where a VI output comes late, read by
// the harness through validationReadPresentCadence. The layout is a contract
// with the harness decoder: u32 words, version 1, 1344 bytes.
const patchUrl = new URL("../patches/dolphin-wasm/snapshot/0162-present-cadence-counters.patch", import.meta.url);

test("0162 layout: v1, 1344 bytes of u32s, the bins the harness decodes", async () => {
  const patch = await readFile(patchUrl, "utf8");
  assert.match(patch, /\+static_assert\(sizeof\(Stats\) == 1344\);/);
  assert.match(patch, /\+  u32 version = 1;\n\+  u32 size_bytes = 1344;/);
  // 16 header and counter words, then the four histograms in this order
  const body = patch.slice(patch.indexOf("+struct Stats"), patch.indexOf("+static_assert(sizeof(Stats) == 1344);"));
  const words = [...body.matchAll(/\+  u32 (\w+)(?:\[(\d+)\])?/g)].map(([, name, n]) => [name, Number(n ?? 1)]);
  const at = Object.fromEntries(words.reduce((acc, [name, n]) => { acc.list.push([name, acc.off]); acc.off += n; return acc; }, { list: [], off: 0 }).list);
  assert.deepEqual(at, { version: 0, size_bytes: 1, on: 2, generation: 3, throttles: 4, sleeps: 5, sleep_late_max_us: 6, behind_max_us: 7, burst_max_us: 8, outputs: 9, presents: 10, arrival_late_max_us: 11, video_generation: 12, reserved: 13, sleep_late_hist: 16, behind_hist: 80, burst_hist: 144, arrival_hist: 208 });
  assert.equal(words.reduce((s, [, n]) => s + n, 0) * 4, 1344);
  for (const [name, us] of [["SLEEP_BIN_US", 250], ["BEHIND_BIN_US", 500], ["BURST_BIN_US", 500], ["ARRIVAL_BIN_US", 500]]) {
    assert.match(patch, new RegExp(`\\+constexpr u32 ${name} = ${us};`));
  }
});

test("0162 hooks: paced Throttle sleep, OutputXFB, present arrival; the export and the worker reader", async () => {
  const patch = await readFile(patchUrl, "utf8");
  assert.match(patch, / {2}SleepUntil\(target_time\);\n\+#ifdef __EMSCRIPTEN__\n\+ {2}\/\/ Patch 0162[^\n]*\n\+ {2}if \(DolphinWeb::PresentCadence::g_on\)\n\+ {4}DolphinWeb::PresentCadence::OnThrottleSleep\(time, target_time, Clock::now\(\)\);/, "timed only while the counters are on");
  assert.match(patch, /\+ {2}DolphinWeb::PresentCadence::OnThrottle\(\);/);
  assert.match(patch, /\+ {4}DolphinWeb::PresentCadence::OnOutputXfb\(\);\n\+#endif\n {5}g_video_backend->Video_OutputXFB/);
  assert.match(patch, /\+ {8}if \(DolphinWeb::PresentCadence::g_on\)\n\+ {8}\{\n\+ {10}DolphinWeb::PresentCadence::OnPresentArrival\(Clock::now\(\),/);
  // a reset in progress shows as on = 2; the video section names its generation
  assert.match(patch, /\+ {4}g_stats\.on = 2;\n/);
  assert.match(patch, /\+ {4}g_stats\.video_generation = generation;/);
  assert.match(patch, /\+extern "C" EMSCRIPTEN_KEEPALIVE u32 DolphinWeb_PresentCadenceStats\(int reset\)/);
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /case "validationReadPresentCadence":\n {6}return harnessPresentCadence\(payload\);/);
  assert.match(worker, /if \(words\.every\(\(w, i\) => w === again\[i\]\)\) return \{ supported: true, words \};\n {2}\}\n {2}return \{ supported: true, torn: true \};/, "two copies must agree");
});
