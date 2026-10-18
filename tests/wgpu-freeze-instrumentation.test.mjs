// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// SOURCE-CONTRACT test for the hardware-renderer freeze instrumentation. It
// pins the parts a freeze report relies on: the harness-only worker messages,
// that the perturbations are off unless asked, and that the core's GPU-sync
// counters cost one relaxed load when the harness is off.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
const discio = await readFile(new URL("../core/upstream/dolphin_web_discio.cpp", import.meta.url), "utf8");
const dir = new URL("../patches/dolphin-wasm/snapshot/", import.meta.url);
const name = (await readdir(dir)).find((f) => /^0080-.*\.patch$/.test(f));
const patch = name ? await readFile(new URL(name, dir), "utf8") : "";

test("the worker reports the replay state and the core's GPU-sync snapshot", () => {
  assert.match(worker, /case "validationReadWgpuReplayState":\n\s*return readWgpuReplayState\(\);/);
  for (const field of ["ring:", "fatal:", "mappedCapacityBlocked:", "loadFenceActive:",
    "sinceLastPresentMs:", "videoStats:", "gpuSync: readGpuSyncDiag()"]) {
    assert.ok(worker.includes(field), field);
  }
  assert.match(worker, /JSON\.parse\(m\.UTF8ToString\(m\._DolphinWeb_GpuSyncDiag\(\)\)\)/);
});

test("replay perturbations are harness-only and off by default", () => {
  assert.match(worker, /const wgpuDiagPerturb = \{ presentDelayMs: 0, drainEveryMs: 0 \};/);
  assert.match(worker, /case "validationSetWgpuPerturbation":/);
  assert.match(worker, /if \(wgpuDiagPerturb\.drainEveryMs > 0\) \{/);
  assert.match(worker, /if \(wgpuDiagPerturb\.presentDelayMs > 0\) \{/);
});

test("patch 0080 counts behind the harness switch and exposes the PE handshake", () => {
  assert.ok(name, "patch 0080 is in the locked snapshot series");
  assert.match(patch, /\+inline std::atomic<bool> s_enabled\{false\};/);
  assert.match(patch, /\+  if \(Enabled\(\)\)\n\+    counter\.fetch_add\(1, std::memory_order_relaxed\);/);
  for (const counter of ["gpu_loop_iterations", "fifo_chunks_decoded", "pe_events_scheduled", "pe_events_run"]) {
    assert.match(patch, new RegExp(`GpuSyncDiag::s_counters\\.${counter}`), counter);
  }
  assert.match(patch, /\+  SyncState GetSyncState\(\);/);
  // The harness switch turns the core counters on together with its hooks.
  assert.match(discio, /DolphinWeb::GpuSyncDiag::s_enabled\.store\(enabled != 0, std::memory_order_relaxed\);/);
  assert.match(discio, /EMSCRIPTEN_KEEPALIVE const char\* DolphinWeb_GpuSyncDiag\(\)/);
  for (const field of ["interruptWaiting", "gpRead", "rwDistance", "atBreakpoint", "eventRaised", "piCause"]) {
    assert.ok(discio.includes(field), field);
  }
});
