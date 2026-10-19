// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// One emulated CPU thread repeats a boot only on a fixed console clock
// (patch 0081). The live proof is in every harness boot (bootIso checks the
// clock the core reports) and in harness/probes/determinism.mjs; these tests
// cover the rules and, on a built core, that the value reaches it.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import test from "node:test";

import { clockCheck, HARNESS_RTC, isSingleCore, withDeterministicClock } from "../harness/lib/matrix.mjs";
import { parseCustomRtc } from "../src/custom-rtc.js";

test("?rtc= is whole seconds from 2000 to the end of u32, anything else the host clock", () => {
  assert.equal(parseCustomRtc("1000000000"), 1000000000);
  assert.equal(parseCustomRtc("946684800"), 946684800);
  assert.equal(parseCustomRtc("4294967295"), 4294967295);
  for (const raw of [null, "", " ", "host", "946684799", "0", "-5", "1e9", "1000000000.5", "4294967296"]) {
    assert.equal(parseCustomRtc(raw), null, String(raw));
  }
});

test("single-core runs get the fixed clock: cpu=single, and cpu=auto unless OGL", () => {
  const rtc = (q) => new URLSearchParams(withDeterministicClock(q)).get("rtc");
  assert.equal(rtc("core=upstream&cpu=single"), String(HARNESS_RTC));
  assert.equal(rtc("core=upstream&cpu=auto&video=software"), String(HARNESS_RTC));
  assert.equal(rtc("core=upstream&cpu=auto&video=ogl"), null); // auto is dual core with OGL
  assert.equal(rtc("core=upstream&cpu=dual"), null);
  assert.equal(rtc("core=upstream"), null); // no cpu= is dual core
  // An explicit clock wins, the host's included.
  assert.equal(rtc("cpu=single&rtc=host"), "host");
  assert.equal(rtc("cpu=single&rtc=1500000000"), "1500000000");
  assert.equal(isSingleCore("cpu=auto&video=wgpu"), true);
});

test("a fixed clock the core did not take, or does not follow, is an error", () => {
  const q = `cpu=single&rtc=${HARNESS_RTC}`;
  const progress = (over) => ({ coreTicks: 486000000 * 3.5, coreTicksPerSecond: 486000000, customRtc: { requested: HARNESS_RTC, applied: true, why: null }, emulatedRtc: HARNESS_RTC + 3, ...over });
  assert.deepEqual(clockCheck(q, progress()), { fixed: true, rtc: HARNESS_RTC, emulatedRtc: HARNESS_RTC + 3 });
  assert.match(clockCheck(q, progress({ customRtc: { applied: false, why: "core without SetCustomRtc" } })).error, /rtc not applied: core without SetCustomRtc/);
  assert.match(clockCheck(q, progress({ customRtc: undefined })).error, /rtc not applied/);
  assert.match(clockCheck(q, progress({ emulatedRtc: 1760000000 })).error, /rtc not followed/); // the host's clock
  assert.match(clockCheck(q, progress({ emulatedRtc: null })).error, /not verifiable/);
  assert.deepEqual(clockCheck("cpu=single&rtc=host", progress()), { fixed: false });
  assert.deepEqual(clockCheck("cpu=dual", progress()), { fixed: false });
});

// On a built core: the value reaches the core, a start before 2000 is
// refused, and reading the clock before the system starts does not trap (it
// is the host's until boot applies the setting; bootIso reads it once the
// core runs). Pull
// requests carry sources only: a core older than 0081 skips; CI builds and
// tests the branch's.
const coreDir = new URL("../cores/dolphin/", import.meta.url);
async function loadCore() {
  const wasm = new URL("dolphin-core-upstream.wasm", coreDir);
  if (!existsSync(wasm)) return null;
  const { default: createDolphinCore } = await import(new URL("dolphin-core-upstream.js", coreDir));
  const module = await createDolphinCore({ wasmBinary: readFileSync(wasm), noInitialRun: true, print: () => {}, printErr: () => {} });
  return typeof module._SetCustomRtc === "function" && typeof module._GetCustomRtc === "function" ? module : null;
}
const core = await loadCore();
const skip = core ? false : "the core in cores/dolphin predates the fixed clock (CI builds this branch's core)";

test("the core takes ?rtc= before it starts, and refuses a start before 2000", { skip }, () => {
  assert.equal(core._GetCustomRtc() >>> 0, 0);
  assert.equal(core._SetCustomRtc(1, 945000000), 0);
  assert.equal(core._GetCustomRtc() >>> 0, 0);
  assert.equal(core._SetCustomRtc(1, HARNESS_RTC), 1);
  assert.equal(core._GetCustomRtc() >>> 0, HARNESS_RTC);
  assert.ok(Number.isInteger(core._DolphinWeb_EmulatedRtc() >>> 0));
});

test("patch 0081: the custom clock follows emulated time and formats the cards", async () => {
  const dir = new URL("../patches/dolphin-wasm/snapshot/", import.meta.url);
  const name = (await readdir(dir)).find((f) => /^0081-.*\.patch$/.test(f));
  assert.ok(name, "patch 0081 is in the locked snapshot series");
  const patch = readFileSync(new URL(name, dir), "utf8");
  assert.match(patch, /\+    ltime = Config::Get\(Config::MAIN_CUSTOM_RTC_VALUE\);\n\+    ltime \+= system\.GetCoreTiming\(\)\.GetTicks\(\) \/ system\.GetSystemTimers\(\)\.GetTicksPerSecond\(\);/);
  assert.match(patch, /\+        Config::Get\(Config::MAIN_CUSTOM_RTC_ENABLE\) \?\n\+            static_cast<u64>\(Config::Get\(Config::MAIN_CUSTOM_RTC_VALUE\)\) -/);
  // The trace's log is allocated when it is turned on, never for a player.
  assert.match(patch, /\+inline std::atomic<Entry\*> s_log\{nullptr\};/);
});
