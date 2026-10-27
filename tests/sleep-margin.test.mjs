// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Patch 0165 (?sleepmargin=<us>): the throttle sleeps to its target minus the
// margin, then spins to it; the spin's total is counted in 0162's struct.
test("sleepmargin: parsed in range, off by default", async () => {
  const { requestedPacing } = await import("../src/core-host.js");
  assert.equal(requestedPacing("").sleepMarginUs, 0);
  assert.equal(requestedPacing("?sleepmargin=1500").sleepMarginUs, 1500);
  assert.equal(requestedPacing("?sleepmargin=8000").sleepMarginUs, 8000);
  assert.equal(requestedPacing("").sleepStepUs, 0);
  assert.equal(requestedPacing("?sleepstep=500").sleepStepUs, 500);
  assert.equal(requestedPacing("?sleepstep=4001").sleepStepUs, 0);
  assert.equal(requestedPacing("?sleepk=750").sleepK, 750);
  assert.equal(requestedPacing("?sleepk=951").sleepK, 750);
  assert.equal(requestedPacing("").sleepK, 750, "the cascade by default");
  assert.equal(requestedPacing("?sleepk=0").sleepK, 0, "?sleepk=0: the plain sleep");
  assert.equal(requestedPacing("?sleepk=10").sleepK, 500, "a low k is raised to 500");
  assert.equal(requestedPacing("").sleepSpinUs, 150);
  assert.equal(requestedPacing("?sleepspin=200").sleepSpinUs, 200);
  assert.equal(requestedPacing("?sleepspin=20").sleepSpinUs, 150);
  for (const bad of ["?sleepmargin=8001", "?sleepmargin=-1", "?sleepmargin=1e3", "?sleepmargin=abc", "?sleepmargin=12345"]) {
    assert.equal(requestedPacing(bad).sleepMarginUs, 0, bad);
  }
});

test("sleepmargin reaches the worker's init message through the adapter", async (t) => {
  const { requestedPacing } = await import("../src/core-host.js");
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const adapter = new UpstreamWorkerAdapter(requestedPacing("?sleepmargin=2000&sleepstep=500&sleepk=750&sleepspin=200"));
  let posted = null;
  adapter.worker = {
    postMessage(message) {
      posted = message;
      queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
    }
  };
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://127.0.0.1:8080/?sleepmargin=2000", search: "?sleepmargin=2000" } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  await adapter.load();
  assert.equal(posted.payload.sleepMarginUs, 2000);
  assert.equal(posted.payload.sleepStepUs, 500);
  assert.equal(posted.payload.sleepK, 750);
  assert.equal(posted.payload.sleepSpinUs, 200);
});

test("sleepmargin: host, worker, core and patch", async () => {
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const core = await readFile(new URL("../core/upstream/dolphin_web_core.cpp", import.meta.url), "utf8");
  const patch = await readFile(new URL("../patches/dolphin-wasm/snapshot/0165-throttle-sleep-margin.patch", import.meta.url), "utf8");
  assert.match(host, /\n {12}sleepMarginUs: this\.pacing\.sleepMarginUs,\n/);
  assert.match(worker, /\n {8}sleepMarginUs: payload\.sleepMarginUs,\n {8}sleepStepUs: payload\.sleepStepUs,\n/);
  assert.match(host, /\n {12}sleepStepUs: this\.pacing\.sleepStepUs,\n/);
  assert.match(worker, /\n {4}dolphinSleepStepUs: Number\.isInteger\(sleepStepUs\) \? sleepStepUs : 0,\n/);
  assert.match(core, /DolphinWeb_SetThrottleSleepStepUs\(/);
  assert.match(core, /DolphinWeb_SetThrottleSleepCascade\(/);
  assert.match(host, /\n {12}sleepK: this\.pacing\.sleepK,\n {12}sleepSpinUs: this\.pacing\.sleepSpinUs,\n/);
  assert.match(worker, /\n {8}sleepK: payload\.sleepK,\n {8}sleepSpinUs: payload\.sleepSpinUs,\n/);
  assert.match(worker, /\n {4}dolphinSleepK: Number\.isInteger\(sleepK\) \? sleepK : 750,\n/);
  assert.match(worker, /getUint32\(4, true\), 1872\);/, "the v2 struct is read whole");
  assert.match(worker, /\n {4}dolphinSleepMarginUs: Number\.isInteger\(sleepMarginUs\) \? sleepMarginUs : 0,\n/);
  assert.match(worker, /const sleepMarginUs = typeof moduleInstance\?\._DolphinWeb_SetThrottleSleepMarginUs === "function" \? \(bits >>> 16\) & 0x1fff : null;/);
  assert.match(core, /DolphinWeb_SetThrottleSleepMarginUs\(\n\s+EM_ASM_INT\(\{ return \(typeof Module !== 'undefined' &&\n\s+Number\.isInteger\(Module\['dolphinSleepMarginUs'\]\)\)/);
  assert.match(patch, /\+extern "C" EMSCRIPTEN_KEEPALIVE void DolphinWeb_SetThrottleSleepMarginUs\(int us\)/);
  assert.match(patch, /\+std::atomic<u32> g_sleep_margin_us\{0\};/, "off unless the page sets it");
  // sleep to target - margin, spin to target, count the spin
  assert.match(patch, /\+        const TimePoint coarse = time_point - std::chrono::microseconds\{margin_us\};\n\+        if \(coarse > time\)\n\+          DolphinWeb::ThrottleWaitUntil\(coarse\);/);
  assert.match(patch, /\+ {8}while \(now < time_point\)\n\+ {10}now = Clock::now\(\);\n\+ {8}DolphinWeb::PresentCadence::AddSpin\(now - spin_start\);/);
  // review of #292: the spin bounded by ?sleepspin (time left, clock tick),
  // the rest a plain sleep; an explicit margin wins over the default cascade;
  // k at least 500 (0: off)
  assert.match(patch, /\+ {8}if \(time_point - Clock::now\(\) > spin_limit \|\| DolphinWeb::ClockTick\(\) > spin_limit\)\n\+ {8}\{\n\+ {10}DolphinWeb::ThrottleWaitUntil\(time_point\);\n\+ {10}spin = false;/);
  assert.match(patch, /\+ {6}if \(margin_us == 0\)\n/, "?sleepmargin turns the cascade off");
  assert.match(patch, /\+ {6}static_cast<u32>\(k_permille <= 0 \? 0 : std::clamp\(k_permille, 500, 950\)\),/);
  assert.match(patch, /-  u32 reserved\[3\] = \{\};\n\+  u32 spin_us = 0;[^\n]*\n\+  u32 reserved\[2\] = \{\};/, "word 13, layout v1 unchanged");
  assert.match(patch, /\(DolphinWeb::g_sleep_margin_us\.load\(std::memory_order_relaxed\) << 16\)/);
  // ?sleepstep: short sleeps while more than one step is left, then the spin
  assert.match(patch, /\+          while \(time_point - Clock::now\(\) > step\)\n\+            DolphinWeb::ThrottleWaitUntil\(Clock::now\(\) \+ step\);/);
  assert.match(patch, /\+std::atomic<u32> g_sleep_step_us\{0\};/);
  // the cascade: k x the time left per wait, at most 8 waits, then the spin
  assert.match(patch, /\+std::atomic<u32> g_sleep_k_permille\{750\};\n\+std::atomic<u32> g_sleep_spin_us\{150\};/, "the cascade by default, in the core too");
  assert.match(patch, /\+        for \(int waits = 0; waits < 8; \+\+waits\)/);
  assert.match(patch, /\+          DolphinWeb::ThrottleWaitUntil\(now \+ left \* k_permille \/ 1000\);/);
  // v2 layout: v1 untouched, the waits appended
  assert.match(patch, /\+static_assert\(sizeof\(Stats\) == 1872\);/);
  assert.match(patch, /-  u32 version = 1;\n-  u32 size_bytes = 1344;\n\+  u32 version = 2;\n\+  u32 size_bytes = 1872;/);
});
