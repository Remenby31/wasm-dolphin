import { sourceContractTest } from "./helpers/source-contract.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const vendorRoot = new URL("../vendor/dolphin/Source/Core/", import.meta.url);

sourceContractTest("correlated timing retains coherent VI throttle and DVD completion ownership", async () => {
  const [profile, cachedInterpreter, coreTiming, dvdThread, videoInterface, basePatch, phasePatch,
    validationTemplate, validationHarness, perfGate] =
    await Promise.all([
      readFile(new URL("Core/WasmTimingProfile.h", vendorRoot), "utf8"),
      readFile(new URL("Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp", vendorRoot), "utf8"),
      readFile(new URL("Core/CoreTiming.cpp", vendorRoot), "utf8"),
      readFile(new URL("Core/HW/DVD/DVDThread.cpp", vendorRoot), "utf8"),
      readFile(new URL("Core/HW/VideoInterface.cpp", vendorRoot), "utf8"),
      readFile(
        new URL(
          "../patches/dolphin-wasm/snapshot/0014-correlated-core-timing-profile.patch",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../patches/dolphin-wasm/snapshot/0018-core-timing-phase-attribution.patch",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../docs/perf-results/core-timing-phase-attribution-template.md",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL("../tools/menu-progress-validate.mjs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../tools/perf-regression-gate.mjs", import.meta.url),
        "utf8"
      )
    ]);

  assert.match(profile, /inline thread_local CurrentSlice s_current_slice/);
  assert.match(profile, /inline std::atomic<bool> s_enabled/);
  assert.match(
    profile,
    /BeginSlice\(\)[\s\S]*?!s_enabled\.load[\s\S]*?s_current_slice\.active = false[\s\S]*?return false[\s\S]*?s_current_slice = \{\}/
  );
  assert.match(
    profile,
    /BeginDvdCompletion\(\)[\s\S]*?!IsSliceActive\(\)[\s\S]*?s_current_dvd_completion\.active = false[\s\S]*?return false[\s\S]*?s_current_dvd_completion = \{\}/
  );
  assert.match(profile, /RecordCoreTimingEvent[\s\S]*?EventKind::VICallback/);
  assert.match(profile, /nested_wait_us[\s\S]*?elapsed_us - nested_wait_us/);
  assert.match(profile, /sequence\.fetch_add\(1, std::memory_order_acq_rel\)/);
  assert.match(profile, /WorstSlice CaptureWorstSlice\(\)/);
  assert.match(profile, /WorstDvdCompletion/);
  assert.match(profile, /BeginDvdCompletion/);
  assert.match(profile, /FinishDvdCompletion/);
  assert.match(profile, /ThrottleSite::ViEndField/);
  assert.match(profile, /ThrottleSite::ViSiPoll/);
  assert.match(profile, /requested_us/);
  assert.match(profile, /overshoot_us/);
  assert.match(profile, /CurrentSlice[\s\S]*?throttle_sites[\s\S]*?dvd_completion/);
  assert.match(profile, /WorstSliceStorage[\s\S]*?throttle_site_us[\s\S]*?dvd_total_us/);
  assert.match(
    profile,
    /slice_dvd\.total_us = SaturatingAdd[\s\S]*?slice_dvd\.queue_wait_us = SaturatingAdd[\s\S]*?s_worst_dvd_completion\.total_us/
  );
  assert.match(
    profile,
    /dominant_throttle_index[\s\S]*?s_worst_slice\.throttle_site[\s\S]*?s_worst_slice\.dvd_total_us/
  );

  assert.match(cachedInterpreter, /SetPpcProfileEnabled[\s\S]*?WasmTimingProfile::SetEnabled/);
  assert.match(cachedInterpreter, /const bool _profile_slice = .*BeginSlice\(\)/);
  assert.match(cachedInterpreter, /if \(_profile_slice\)[\s\S]*?FinishSlice/);
  assert.match(
    cachedInterpreter,
    /sliceprof:total=[\s\S]*?,advance=[\s\S]*?,execute=[\s\S]*?,compile=[\s\S]*?,throttle=[\s\S]*?,dvd=[\s\S]*?,video=[\s\S]*?,event=/
  );
  assert.match(cachedInterpreter, /dvdprof:v=1/);
  assert.match(cachedInterpreter, /throttleprof:v=1/);
  assert.match(
    cachedInterpreter,
    /slicephase:v=1,throttlesite=[\s\S]*?throttlesiteus=[\s\S]*?dvdtotal=/
  );

  assert.match(coreTiming, /profile_event = .*IsSliceActive\(\)/);
  assert.match(coreTiming, /RecordCoreTimingEvent\(name, callback_us, wait_us_at_start\)/);
  assert.match(coreTiming, /RecordThrottleWaitUs[\s\S]*?requested_us[\s\S]*?overshoot_us/);
  assert.match(dvdThread, /BeginDvdCompletion/);
  assert.match(dvdThread, /WaitForData\(\);[\s\S]*?RecordDvdWaitUs/);
  assert.match(dvdThread, /RecordDvdMapUs/);
  assert.match(dvdThread, /RecordDvdQueuePopUs/);
  assert.match(dvdThread, /RecordDvdRamCopyUs/);
  assert.match(dvdThread, /RecordDvdCommandFinishUs/);
  assert.match(dvdThread, /FinishDvdCompletion/);
  assert.match(videoInterface, /const bool _vi_profile = .*IsSliceActive\(\)/);
  assert.match(videoInterface, /ScopedThrottleSite[\s\S]*?ThrottleSite::ViEndField/);
  assert.match(videoInterface, /ScopedThrottleSite[\s\S]*?ThrottleSite::ViSiPoll/);
  assert.match(validationTemplate, /metrics=1&ppcprof=1/);
  assert.match(
    validationHarness,
    /if \(process\.env\.PPCPROF\) url\.searchParams\.set\("ppcprof", process\.env\.PPCPROF\)/
  );
  assert.match(perfGate, /"audiotransport", "ppcprof", "wgpustatecache"/);

  for (const path of [
    "Source/Core/Core/WasmTimingProfile.h",
    "Source/Core/Core/CoreTiming.cpp",
    "Source/Core/Core/HW/DVD/DVDThread.cpp",
    "Source/Core/Core/HW/VideoInterface.cpp",
    "Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp"
  ]) {
    assert.match(`${basePatch}\n${phasePatch}`, new RegExp(`diff --git a/${path.replaceAll("/", "\\/")}`));
  }
});
