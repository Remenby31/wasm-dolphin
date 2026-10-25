// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Patch 0150's pacing switches, each from the page's URL to the core's config:
// ?rush=1 (Rush is off by default), ?synconidle=1, ?dupvsync=1. An option the adapter forgot to carry
// was silently dropped twice (?aotsample, ?wasmengine; and ?synconidle, which
// the harness trusted while the core ignored it): every hop is checked.
const SWITCHES = [
  { param: "rush=1", option: "rushPresentation", on: true, flag: "dolphinRushPresentation" },
  { param: "synconidle=1", option: "syncOnSkipIdle", on: true, flag: "dolphinSyncOnSkipIdle" },
  { param: "dupvsync=1", option: "dupXfbRearmsThrottle", on: true, flag: "dolphinDupXfbRearmsThrottle" },
  { param: "smoothearly=0", option: "smoothEarly", on: false, flag: "dolphinSmoothEarly" }
];

test("pacing switches: URL parsing, shipped defaults, each switch only its own", async () => {
  const { requestedPacing } = await import("../src/core-host.js");
  // Rush off by default (upstream's default): ?rush=1 turns it back on.
  assert.deepEqual(requestedPacing(""), { rushPresentation: false, syncOnSkipIdle: false, dupXfbRearmsThrottle: false, smoothEarly: true, sleepMarginUs: 0, sleepStepUs: 0 });
  for (const s of SWITCHES) {
    const p = requestedPacing(`?${s.param}`);
    assert.equal(p[s.option], s.on, s.param);
    for (const other of SWITCHES.filter((o) => o !== s)) assert.equal(p[other.option], !other.on, `${s.param} leaves ${other.option}`);
  }
  assert.equal(requestedPacing("?rush=0").rushPresentation, false);
  assert.equal(requestedPacing("?synconidle=0").syncOnSkipIdle, false);
  assert.equal(requestedPacing("?smoothearly=1").smoothEarly, true);
});

test("pacing switches reach the worker's init message through the adapter", async (t) => {
  const { requestedPacing } = await import("../src/core-host.js");
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const adapter = new UpstreamWorkerAdapter(requestedPacing("?rush=1&synconidle=1&dupvsync=1&smoothearly=0"));
  let posted = null;
  adapter.worker = {
    postMessage(message) {
      posted = message;
      queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
    }
  };
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://127.0.0.1:8080/?rush=1&synconidle=1&dupvsync=1", search: "?rush=1&synconidle=1&dupvsync=1" } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  await adapter.load();
  for (const s of SWITCHES) assert.equal(posted.payload[s.option], s.on, `${s.option} in the init payload`);
});

test("pacing switches: host passes them, the worker sets the Module flags, the core reads them into its config", async () => {
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const core = await readFile(new URL("../core/upstream/dolphin_web_core.cpp", import.meta.url), "utf8");
  for (const s of SWITCHES) {
    assert.match(host, new RegExp(`\\n {12}${s.option}: this\\.pacing\\.${s.option},\\n`), `host passes ${s.option}`);
    assert.match(worker, new RegExp(`\\n {8}${s.option}: payload\\.${s.option},\\n`), `worker reads ${s.option} from the payload`);
    assert.match(worker, new RegExp(`\\n {4}${s.flag}: ${s.option} [!=]== (true|false),\\n`), `worker sets Module['${s.flag}']`);
    assert.match(core, new RegExp(`Module\\['${s.flag}'\\]`), `core reads Module['${s.flag}']`);
  }
  assert.match(core, /Config::SetBase\(Config::MAIN_RUSH_FRAME_PRESENTATION, rush_presentation\);/);
  assert.match(core, /Config::SetBase\(Config::MAIN_SYNC_ON_SKIP_IDLE, sync_on_skip_idle\);/);
  assert.match(core, /DolphinWeb_SetDupXfbRearmsThrottle\(/);
  assert.match(core, /Config::SetBase\(Config::MAIN_SMOOTH_EARLY_PRESENTATION, smooth_early\);/);
  // the harness reads back what the core applied, from its effective config
  assert.match(worker, /case "validationReadPacingConfig":/);
  assert.match(worker, /syncOnSkipIdle: Boolean\(bits & 1\), rushFramePresentation: Boolean\(bits & 2\), dupXfbResetsThrottle: Boolean\(bits & 4\), presentSleep, sleepMarginUs, sleepStepUs \};/);
  assert.match(worker, /const presentSleep = typeof moduleInstance\?\._DolphinWeb_SetPresentOnArrival === "function" \? Boolean\(bits & 8\) : null;/);
  assert.match(core, /DolphinWeb_SetPresentOnArrival\(smooth_early \? 0 : 1\);/);
});

// Patch 0153: bit 3 of DolphinWeb_PacingConfig is the present sleep, and
// ?smoothearly=0 really removes it (a present-on-arrival path, not just
// SmoothEarly off, which with Rush off still sleeps to the intended time); the
// video thread's sleep to the present time is counted apart in the headroom
// struct's former spare f64 (offset 88, presentSleepUs), zeroed with the GPU
// thread's other counters, so it can be taken out of maxSpeedGpu.
test("0153: smoothearly readback bit and the present sleep in the headroom struct", async () => {
  const patch = await readFile(new URL("../patches/dolphin-wasm/snapshot/0153-smooth-early-switch-and-present-sleep.patch", import.meta.url), "utf8");
  assert.match(patch, /\+ +\(Config::Get\(Config::MAIN_SMOOTH_EARLY_PRESENTATION\) &&\n\+ +!DolphinWeb::g_present_on_arrival\.load\(std::memory_order_relaxed\) \?\n\+ +8u :/);
  assert.match(patch, /-  double spare = 0;\n\+  double present_sleep_us = 0;/, "the spare f64 (offset 88), layout v1 unchanged");
  assert.match(patch, /     g_stats\.xfb_copies = 0;\n\+    g_stats\.present_sleep_us = 0;/, "reset with the GPU thread's counters");
  // no sleep at all on arrival; the sleep's timing only while the counters are on
  assert.match(patch, /\+        if \(!DolphinWeb::g_present_on_arrival\.load\(std::memory_order_relaxed\)\)\n\+        \{\n\+          const bool timed = DolphinWeb::Headroom::g_on;\n\+          const auto sleep_start = timed \? Clock::now\(\) : TimePoint\{\};\n\+          Core::System::GetInstance\(\)\.GetCoreTiming\(\)\.SleepUntil\(present_time\);\n\+          if \(timed\)\n\+            DolphinWeb::Headroom::AddPresentSleep\(Clock::now\(\) - sleep_start\);/);
  const header = await readFile(new URL("../patches/dolphin-wasm/snapshot/0113-headroom-counters.patch", import.meta.url), "utf8");
  // the spare is the struct's last f64: 16-byte header + 9 f64 before it
  const fields = header.slice(header.indexOf("+struct Stats"), header.indexOf("+static_assert(sizeof(Stats) == 96);")).match(/\+  double \w+/g);
  assert.equal(fields.length, 10);
  assert.equal(fields[9], "+  double spare");
});

test("Rush off by default: a page or core that sets nothing runs without Rush Frame Presentation", async () => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  assert.equal(new UpstreamWorkerAdapter({}).rushPresentation, false);
  const core = await readFile(new URL("../core/upstream/dolphin_web_core.cpp", import.meta.url), "utf8");
  assert.match(core, /Module\['dolphinRushPresentation'\] === true\) \? 1 : 0;/, "the core's own default is off too");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /\n  rushPresentation = false,\n/);
});
