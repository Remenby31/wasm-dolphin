// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// SOURCE-CONTRACT test for the hardware-renderer freeze instrumentation. It
// pins the parts a freeze report relies on: the harness-only worker messages,
// that the perturbations are off unless asked, and that the core's GPU-sync
// counters cost one relaxed load when the harness is off.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  // A backlog held back by drainEveryMs sleeps until its next drain: the
  // pump never reschedules itself at 0 ms against a closed gate.
  assert.match(worker, /write === read \|\| wgpuMappedCapacityBlocked \? 4 : wgpuDiagDrainWaitMs\(\)/);
});

test("patch 0080 counts behind its own switch and exposes the PE handshake", () => {
  assert.ok(name, "patch 0080 is in the locked snapshot series");
  assert.match(patch, /\+inline std::atomic<bool> s_enabled\{false\};/);
  assert.match(patch, /\+  if \(Enabled\(\)\)\n\+    counter\.fetch_add\(1, std::memory_order_relaxed\);/);
  for (const counter of ["gpu_loop_iterations", "fifo_chunks_decoded", "pe_events_scheduled", "pe_events_run"]) {
    assert.match(patch, new RegExp(`GpuSyncDiag::s_counters\\.${counter}`), counter);
  }
  assert.match(patch, /\+  SyncState GetSyncState\(\);/);
  // The counters have their own switch, sent only by the freeze probe: the
  // harness switch (every harness session, the perf gate too) leaves them off.
  const harnessEnable = discio.slice(discio.indexOf("void DolphinWeb_HarnessEnable("), discio.indexOf("// The GPU-sync counters have a switch"));
  assert.ok(harnessEnable.length > 0);
  assert.doesNotMatch(harnessEnable, /GpuSyncDiag/);
  assert.match(discio, /void DolphinWeb_GpuSyncDiagEnable\(int enabled\)\n\{\n  DolphinWeb::GpuSyncDiag::s_enabled\.store\(enabled != 0, std::memory_order_relaxed\);/);
  assert.match(worker, /case "validationEnableGpuSyncDiag":/);
  assert.match(discio, /EMSCRIPTEN_KEEPALIVE const char\* DolphinWeb_GpuSyncDiag\(\)/);
  for (const field of ["interruptWaiting", "gpRead", "rwDistance", "atBreakpoint", "eventRaised", "piCause"]) {
    assert.ok(discio.includes(field), field);
  }
});

// Runtime check on the built core: the counters stay off and at zero unless
// the probe's own switch turns them on. Pull requests carry sources only, so
// a local core older than patch 0080 skips; CI builds and tests the branch's.
const coreDir = new URL("../cores/dolphin/", import.meta.url);
const coreWasm = new URL("dolphin-core-upstream.wasm", coreDir);
async function loadCore() {
  if (!existsSync(coreWasm)) return null;
  const { default: createDolphinCore } = await import(new URL("dolphin-core-upstream.js", coreDir));
  const module = await createDolphinCore({ wasmBinary: readFileSync(coreWasm), noInitialRun: true, print: () => {}, printErr: () => {} });
  return typeof module._DolphinWeb_GpuSyncDiagEnable === "function" ? module : null;
}
const core = await loadCore();
const skip = core ? false : "the core in cores/dolphin predates the GPU-sync switch (CI builds this branch's core)";

test("the GPU-sync counters are off and at zero by default, and only their own switch turns them on", { skip }, () => {
  const read = () => JSON.parse(core.UTF8ToString(core._DolphinWeb_GpuSyncDiag()));
  const before = read();
  assert.equal(before.enabled, 0);
  for (const [name, value] of Object.entries(before.counters)) assert.equal(value, 0, name);
  core._DolphinWeb_HarnessEnable(1);
  assert.equal(read().enabled, 0, "the harness switch leaves the counters off");
  core._DolphinWeb_GpuSyncDiagEnable(1);
  assert.equal(read().enabled, 1);
  core._DolphinWeb_GpuSyncDiagEnable(0);
  core._DolphinWeb_HarnessEnable(0);
  assert.equal(read().enabled, 0);
});
