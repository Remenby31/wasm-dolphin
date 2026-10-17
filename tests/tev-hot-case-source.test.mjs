import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

sourceContractTest("TEV specialization is exact, batch-classified, default-off, and shadow-latched", async () => {
  const [hot, tevHeader, tev, raster, loader, profile, bridge, cmake, worker] = await Promise.all([
    read("../vendor/dolphin/Source/Core/VideoBackends/Software/TevHotCase.h"),
    read("../vendor/dolphin/Source/Core/VideoBackends/Software/Tev.h"),
    read("../vendor/dolphin/Source/Core/VideoBackends/Software/Tev.cpp"),
    read("../vendor/dolphin/Source/Core/VideoBackends/Software/Rasterizer.cpp"),
    read("../vendor/dolphin/Source/Core/VideoBackends/Software/SWVertexLoader.cpp"),
    read("../core/upstream/dolphin_web_raster_profile.h"),
    read("../core/upstream/dolphin_web_discio.cpp"),
    read("../vendor/dolphin/Source/Core/Core/CMakeLists.txt"),
    read("../src/upstream-discio-worker.js"),
  ]);

  for (const tuple of [
    /0x4011, 0x0, 0x40, 0x0, 0x8fa8f, 0x8ffd0, 0x0, 0xe4, 0xe4/,
    /0x10, 0x0, 0x0, 0x0, 0x8fffa, 0x8ffd0, 0x0, 0xe4, 0xe4/,
    /0x4010, 0x0, 0x0, 0x0, 0x8fffa, 0x8ffd0, 0x0, 0xe4, 0xe4/,
  ]) assert.match(hot, tuple);
  assert.match(hot, /constexpr Kind Classify\(const ExactTuple& tuple\)/);
  assert.match(hot, /tuple == TEXTURE_MODULATE_RGB_RASTER_ALPHA/);
  assert.match(hot, /constexpr void Evaluate/);

  assert.match(loader, /Rasterizer::ClassifyTevHotCase\(\)/);
  assert.ok(
    loader.indexOf("Rasterizer::ClassifyTevHotCase()") < loader.indexOf("for (u32 i = 0;"),
    "classification must happen once before the batch's index loop"
  );
  assert.match(raster, /void ClassifyTevHotCase\(\)[\s\S]*?tev\.ClassifyHotCaseDraw\(\)/);
  assert.match(tevHeader, /m_hot_case = TevHotCase::Kind::None/);
  assert.match(tev, /m_hot_case = TevHotCase::Classify\(BuildSingleStageExactTuple\(\)\)/);

  const draw = tev.slice(tev.indexOf("void Tev::Draw()"));
  const commonStageEnd = draw.indexOf("SetRasColor(order.getColorChan(stageOdd), ac.rswap)");
  const specialization = draw.indexOf("if (m_hot_case == TevHotCase::Kind::None)");
  for (const required of ["Indirect(stageNum", "TextureSampler::Sample", "StageKonst.r", "SetRasColor("]) {
    assert.ok(draw.indexOf(required) >= 0 && draw.indexOf(required) <= commonStageEnd);
  }
  assert.ok(specialization > commonStageEnd, "specialization must retain all common stage setup");
  assert.match(draw, /const RegisterSnapshot before = CaptureRegisters\(\)/);
  assert.match(draw, /const RegisterSnapshot generic = CaptureRegisters\(\)/);
  assert.match(draw, /if \(!RegistersEqual\(generic\)\)[\s\S]*?RestoreRegisters\(generic\)[\s\S]*?m_hot_case_latched_off = true/);

  assert.match(tev, /m_hot_case_metrics_enabled = DolphinWeb::RasterProfile::Enabled\(\)/);
  for (const counter of [
    "RecordTevHotCaseClassifiedPixel",
    "RecordTevHotCaseSpecializedPixel",
    "RecordTevHotCaseShadowPixel",
    "RecordTevHotCaseShadowMismatch",
  ]) {
    assert.match(tev, new RegExp(`if \\(m_hot_case_metrics_enabled\\)\\s+.*${counter}`));
  }
  assert.match(profile, /tev_hot_classified_batches/);
  assert.match(profile, /tev_hot_classified_pixels/);
  assert.match(profile, /tev_hot_shadow_mismatches/);
  assert.match(bridge, /s_software_tev_hot_case_mode\{0\}/);
  assert.match(bridge, /int SetSoftwareTevHotCaseMode\(int mode\)/);
  assert.match(bridge, /tevhot:/);
  assert.match(cmake, /'_SetSoftwareTevHotCaseMode'/);
  assert.match(worker, /api\.setSoftwareTevHotCaseMode\?\.\(softwareTevHotCaseMode\)/);
});

test("fixed-state profile reset and timed samplers use non-drifting boundaries", async () => {
  const [worker, menu, gate] = await Promise.all([
    read("../src/upstream-discio-worker.js"),
    read("../tools/menu-progress-validate.mjs"),
    read("../tools/perf-regression-gate.mjs"),
  ]);
  assert.match(
    worker,
    /api\.loadStateFile\(path\)[\s\S]*?setTimeout\(r, 1200\)[\s\S]*?if \(rc === 1 && collectMetrics[\s\S]*?setSoftwareRasterProfileEnabled\?\.\(0\)[\s\S]*?setSoftwareRasterProfileEnabled\?\.\(1\)/
  );
  assert.match(menu, /const nextDeadline = startedAt \+ \(index \+ 1\) \*/);
  assert.match(menu, /waitForTimeout\(Math\.max\(0, nextDeadline - Date\.now\(\)\)\)/);
  assert.match(gate, /const deadline = startedAt \+ action\.atMs/);
  assert.match(gate, /waitForTimeout\(Math\.max\(0, deadline - Date\.now\(\)\)\)/);
});

test("TEV parity runner covers native, Emscripten, random, boundary, and mutation cases", async () => {
  const [harness, runner] = await Promise.all([
    read("../tools/software-tev-hot-case-parity.cpp"),
    read("../tools/test-software-tev-hot-cases.mjs"),
  ]);
  assert.match(harness, /RANDOM_CASES = 1'200'000/);
  assert.match(harness, /byte_boundaries/);
  assert.match(harness, /register_boundaries/);
  assert.match(harness, /mutated\[word\] \^= 1u << bit/);
  assert.match(harness, /ReferenceEvaluate/);
  assert.match(runner, /toolchain\.paths\.clangxx/);
  assert.match(runner, /emcc\.replace\(\/emcc/);
});
