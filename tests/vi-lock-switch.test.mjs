// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// ?vilock=1 (src/wgpu-vi-phase-lock.js, patch 0212): off by default, every hop
// from the page's URL to the core's throttle checked (an option the adapter
// forgot to carry was silently dropped before: ?aotsample, ?wasmengine).
test("vilock: off by default, ?vilock=1 only", async () => {
  const { requestedPacing } = await import("../src/core-host.js");
  assert.equal(requestedPacing("").viLock, false);
  assert.equal(requestedPacing("?vilock=1").viLock, true);
  for (const other of ["?vilock=0", "?vilock=true", "?vilock=on", "?vilock="]) assert.equal(requestedPacing(other).viLock, false, other);
});

test("vilock reaches the worker's init message through the adapter", async (t) => {
  const { requestedPacing } = await import("../src/core-host.js");
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  for (const [query, expected] of [["?vilock=1", true], ["", false]]) {
    const adapter = new UpstreamWorkerAdapter(requestedPacing(query));
    let posted = null;
    adapter.worker = {
      postMessage(message) {
        posted = message;
        queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
      }
    };
    const originalWindow = globalThis.window;
    globalThis.window = { location: { href: `http://127.0.0.1:8080/${query}`, search: query } };
    t.after(() => {
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    });
    await adapter.load();
    assert.equal(posted.payload.viLock, expected, query || "default");
  }
});

test("vilock: host, worker and patch 0212 (a trim of the throttle's wall rate only, exactly 1 at 0 ppm)", async () => {
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const patch = await readFile(new URL("../patches/dolphin-wasm/snapshot/0212-throttle-rate-trim.patch", import.meta.url), "utf8");
  assert.match(host, /\n {12}viLock: this\.pacing\.viLock,\n/);
  assert.match(worker, /\n {8}viLock: payload\.viLock,\n/);
  // the lock only on the vsync presenter at the normal speed, and only through the core's trim
  assert.match(worker, /wgpuViLock = viLock === true && wgpuPresentVsync && Number\(emulationSpeed\) === 1 \? createViPhaseLock\(\) : null;/);
  assert.match(worker, /module\._DolphinWeb_SetThrottleRatePpm\(Math\.round\(Number\(ppm\)\) \| 0\)/);
  assert.match(worker, /if \(r\.changed\) api\.setThrottleRatePpm\(wgpuViLock\.stats\.ppm\);/);
  assert.doesNotMatch(worker, /setEmulationSpeed\?\.\(r\.factor\)/, "never the pre-boot speed setter");
  // the patch: the throttle, its header, and the mixer that follows the trim
  assert.deepEqual([...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]).sort(),
    ["Source/Core/AudioCommon/Mixer.cpp", "Source/Core/Core/CoreTiming.cpp", "Source/Core/Core/WasmThrottleRate.h"]);
  assert.match(patch, /\+constexpr int MAX_PPM = 2000;/);
  assert.match(patch, /\+  return ppm == 0 \? 1\.0 : 1\.0 \+ static_cast<double>\(ppm\) \* 1e-6;/);
  assert.match(patch, /\+inline std::atomic<int> g_requested_ppm\{0\};\n\+inline std::atomic<int> g_applied_ppm\{0\};/);
  assert.match(patch, /TR::g_requested_ppm\.store\(std::clamp\(ppm, -TR::MAX_PPM, TR::MAX_PPM\), std::memory_order_relaxed\);/);
  assert.match(patch, /\+\/\/ them: relaxed is enough\. At 0 ppm the factor is exactly 1\.0\./);
  assert.doesNotMatch(patch, /memory_order_(acquire|release|seq_cst)/);
  assert.match(patch, /\+    UpdateSpeedLimit\(target_cycle, m_emulation_speed\);/);
  assert.match(patch, /new_speed \*\n\+                  DolphinWeb::ThrottleRate::Factor\(rate_ppm\)\);/);
  // the mixer resamples at the trim the CPU thread applied (no drift of the queue), after the speed
  assert.match(patch, /\+  in_sample_rate \*= DolphinWeb::ThrottleRate::Factor\(\n\+      DolphinWeb::ThrottleRate::g_applied_ppm\.load\(std::memory_order_relaxed\)\);/);
  // the queue's overflow skips and underrun fills, counted and exported
  assert.match(patch, /\+    DolphinWeb::ThrottleRate::g_audio_overflow_skips\.fetch_add\(1, std::memory_order_relaxed\);/);
  assert.match(patch, /\+      DolphinWeb::ThrottleRate::g_audio_underrun_fills\.fetch_add\(1, std::memory_order_relaxed\);/);
  assert.match(patch, /\+extern "C" EMSCRIPTEN_KEEPALIVE u32 DolphinWeb_AudioQueueEvents\(int which\)/);
  assert.match(worker, /case "validationReadAudioQueue":/);
  // the speed and the config are not touched (code lines: the comments name them)
  assert.doesNotMatch(patch, /^\+(?!\s*\/\/).*(Config::SetCurrent|Config::SetBase|MAIN_EMULATION_SPEED)/m);
  assert.doesNotMatch(patch, /^\+(?!\s*\/\/).*m_emulation_speed\s*=/m);
  // at 0 ppm the factor is exactly 1 (the same double arithmetic as the patch)
  const factor = (ppm) => (ppm === 0 ? 1.0 : 1.0 + ppm * 1e-6);
  assert.equal(factor(0), 1);
  const ticksPerSec = 486000000;
  assert.equal(Math.round(ticksPerSec * 1 * factor(0)), ticksPerSec);
  assert.equal(Math.round(ticksPerSec * 1 * factor(1001)), 486486486);
});
