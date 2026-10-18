// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// One emulated CPU thread repeats a boot only on a fixed console clock
// (patch 0081). The browser-side run is harness/probes/determinism.mjs; these
// tests pin the parts it relies on: the harness puts cpu=single runs on the
// fixed clock, the page passes ?rtc= down to the core, and the patch makes
// the custom clock follow emulated time and format the memory cards with it.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { HARNESS_RTC, withDeterministicClock } from "../harness/lib/matrix.mjs";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
const dir = new URL("../patches/dolphin-wasm/snapshot/", import.meta.url);
const name = (await readdir(dir)).find((f) => /^0081-.*\.patch$/.test(f));
const patch = name ? await readFile(new URL(name, dir), "utf8") : "";

test("the harness runs cpu=single on the fixed clock, and leaves everything else alone", () => {
  const q = (s) => new URLSearchParams(withDeterministicClock(s));
  assert.equal(q("core=upstream&cpu=single").get("rtc"), String(HARNESS_RTC));
  assert.equal(q("core=upstream&cpu=dual").get("rtc"), null);
  assert.equal(q("core=upstream").get("rtc"), null);
  // An explicit clock wins, the host's included (rtc=host).
  assert.equal(q("cpu=single&rtc=host").get("rtc"), "host");
  assert.equal(q("cpu=single&rtc=42").get("rtc"), "42");
});

test("the page passes ?rtc= to the core before it starts", async () => {
  const host = await read("src/core-host.js");
  assert.match(host, /function requestedCustomRtc\(\)/);
  assert.match(host, /Number\.isInteger\(seconds\) && seconds >= 0 && seconds <= 0xffffffff \? seconds : null/);
  const adapter = await read("src/upstream-worker-adapter.js");
  assert.match(adapter, /customRtc: this\.customRtc,/);
  const worker = await read("src/upstream-discio-worker.js");
  assert.match(worker, /if \(Number\.isInteger\(customRtc\) && customRtc >= 0\) api\.setCustomRtc\?\.\(customRtc\);/);
  const core = await read("core/upstream/dolphin_web_core.cpp");
  assert.match(core, /Config::SetBase\(Config::MAIN_CUSTOM_RTC_ENABLE, s_custom_rtc_enabled\);/);
  assert.match(core, /int SetCustomRtc\(int enabled, std::uint32_t seconds_since_1970\)\n\{\n  if \(s_runtime_initialized\)\n    return 0;/);
});

test("patch 0081: the custom clock follows emulated time and formats the cards", () => {
  assert.ok(name, "patch 0081 is in the locked snapshot series");
  // RTC = configured start + emulated seconds, like a movie, never host time.
  assert.match(patch, /\+  else if \(Config::Get\(Config::MAIN_CUSTOM_RTC_ENABLE\)\)\n\+  \{/);
  assert.match(patch, /\+    ltime = Config::Get\(Config::MAIN_CUSTOM_RTC_VALUE\);\n\+    ltime \+= system\.GetCoreTiming\(\)\.GetTicks\(\) \/ system\.GetSystemTimers\(\)\.GetTicksPerSecond\(\);/);
  // The memory cards' format time (it seeds their serial) comes from it too.
  assert.match(patch, /\+        Config::Get\(Config::MAIN_CUSTOM_RTC_ENABLE\) \?\n\+            static_cast<u64>\(Config::Get\(Config::MAIN_CUSTOM_RTC_VALUE\)\) -/);
});

test("patch 0081: the CoreTiming trace is off unless a harness session asks", async () => {
  assert.match(patch, /\+inline std::atomic<bool> s_enabled\{false\};/);
  assert.match(patch, /\+  if \(!Enabled\(\)\)\n\+    return;/);
  for (const kind of ["Run", "Moved", "OffThread"]) assert.match(patch, new RegExp(`DolphinWeb::DetTrace::Record\\(DolphinWeb::DetTrace::${kind},`), kind);
  const worker = await read("src/upstream-discio-worker.js");
  assert.match(worker, /if \(payload\.detTrace && !detTraceRequested\) \{/);
  assert.match(worker, /case "validationReadDetTrace":\n\s*return readDetTrace\(payload\);/);
});
