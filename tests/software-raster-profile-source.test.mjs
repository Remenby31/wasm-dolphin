import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

test("software raster profiling is metrics-gated and explicitly sampled", async () => {
  const header = await readFile(
    new URL("../core/upstream/dolphin_web_raster_profile.h", import.meta.url),
    "utf8"
  );
  assert.match(header, /inline void SetEnabled\(bool enabled\)/);
  assert.match(header, /s_profile_state/);
  assert.match(header, /EnsureLocalEpoch/);
  assert.match(header, /phase == Phase::RasterTraversal \? 63 : 4095/);
  assert.match(header, /duration_cast<std::chrono::nanoseconds>/);
  assert.match(header, /timed_samples/);
  assert.match(header, /sampled_total_us/);
  assert.match(header, /TEXTURE_CASE_CAPACITY = 256/);
  assert.match(header, /TEV_CASE_CAPACITY = 256/);
  assert.match(header, /struct SharedCaseTable/);
  assert.match(header, /inline void RecordCase/);
  assert.match(header, /other_samples/);
  assert.match(header, /collision_count/);
  assert.match(header, /ShouldRecordCase/);
  assert.match(header, /s_case_sample_seed/);
  assert.match(header, /AdvanceCaseSampleRng/);
  assert.match(header, /AvoidTimedSampleCall/);
  assert.match(header, /0x54455631u : 0x54455831u/);
  assert.match(header, /snapshot\.case_sample_seed/);
  assert.match(header, /PackTextureCaseKey/);
  assert.match(header, /PackTevStructuralKey/);
  assert.match(header, /AppendTevProgramWord/);
  assert.match(header, /RecordFifoBurst/);
  assert.match(header, /RecordFifoConsume/);
  assert.match(header, /fifo_consume_count & 1023/);
  assert.match(header, /RecordFifoDistanceUnderflow/);
  assert.match(header, /PublishGeneratedFrame/);
});

sourceContractTest("applied software sources keep measured CMPR and I4 specializations exact", async () => {
  const [texture, hotCase, tev, bridge, hotPatch, i4Patch, parityHarness] = await Promise.all([
    readFile(
      new URL(
        "../vendor/dolphin/Source/Core/VideoBackends/Software/TextureSampler.cpp",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(
      new URL(
        "../vendor/dolphin/Source/Core/VideoBackends/Software/TextureSamplerHotCase.h",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(
      new URL("../vendor/dolphin/Source/Core/VideoBackends/Software/Tev.cpp", import.meta.url),
      "utf8"
    ),
    readFile(new URL("../core/upstream/dolphin_web_discio.cpp", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../patches/dolphin-wasm/snapshot/0016-software-texture-hot-case.patch",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(
      new URL(
        "../patches/dolphin-wasm/snapshot/0017-software-texture-i4-hot-case.patch",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(new URL("../tools/software-texture-hot-case-parity.cpp", import.meta.url), "utf8"),
  ]);
  assert.match(texture, /profile_scope\.ShouldRecordCase\(\)/);
  assert.match(texture, /PackTextureCaseKey/);
  assert.match(texture, /RecordTextureCase/);
  assert.match(texture, /decode_work = \(linear \? 4u : 1u\) \* \(mipLinear \? 2u : 1u\)/);
  assert.match(tev, /profile_scope\.ShouldRecordCase\(\)/);
  assert.match(tev, /TEV_PROGRAM_FINGERPRINT_SEED/);
  assert.match(tev, /PackTevStructuralKey/);
  assert.match(tev, /RecordTevCase/);
  assert.match(bridge, /texcase:/);
  assert.match(bridge, /tevcase:/);
  assert.match(bridge, /caseseed:/);
  for (const exactPredicate of [
    /mip == 0 && linear && texfmt == TextureFormat::CMPR/,
    /tm0\.mipmap_filter == MipMode::None/,
    /tm0\.min_filter == FilterMode::Linear/,
    /tm0\.mag_filter == FilterMode::Linear/,
    /tm0\.wrap_s == WrapMode::Repeat/,
    /tm0\.wrap_t == WrapMode::Repeat/,
    /!texUnit\.texImage1\.cache_manually_managed/,
    /tlutfmt == TLUTFormat::RGB565 \|\| tlutfmt == TLUTFormat::RGB5A3/,
    /IsPowerOfTwo\(static_cast<u32>\(image_width_minus_1 \+ 1\)\)/,
    /IsPowerOfTwo\(static_cast<u32>\(image_height_minus_1 \+ 1\)\)/,
  ]) {
    assert.match(texture, exactPredicate);
  }
  assert.match(hotCase, /SampleCmprLinearRepeatPow2/);
  assert.match(hotCase, /Common::SafeSpanRead<DXTBlock>/);
  assert.match(hotCase, /std::array<DecodedCmprBlock, 4>/);
  assert.match(hotPatch, /keys 0xd38a01e and 0xd34a01e/);
  for (const key of [
    "0x05340010",
    "0x05300010",
    "0x0d34a010",
    "0x0d000010",
    "0x0d280010",
    "0x0d240010",
  ]) {
    assert.match(hotCase, new RegExp(key));
    assert.match(i4Patch, new RegExp(key));
  }
  assert.match(texture, /HotCase::IsMeasuredI4LinearCase/);
  assert.match(texture, /HotCase::SampleI4LinearCanonical/);
  assert.ok(
    texture.indexOf("HotCase::SampleI4LinearCanonical") >
      texture.indexOf("WrapCoord(&imageTPlus1"),
    "I4 dispatch must consume all four canonical WrapCoord results"
  );
  assert.match(hotCase, /Common::SafeSpanRead<u8>/);
  assert.match(hotCase, /const u8 result = static_cast<u8>\(value >> 14\)/);
  assert.match(i4Patch, /Exact union of the six I4 cases/);
  assert.match(parityHarness, /TexDecoder_DecodeTexel/);
  assert.match(parityHarness, /TLUTFormat::RGB565/);
  assert.match(parityHarness, /TLUTFormat::RGB5A3/);
  assert.match(parityHarness, /CheckI4DispatchPredicate/);
  assert.match(parityHarness, /MEASURED_I4_LINEAR_CASE_KEYS/);
  assert.match(parityHarness, /fract_s < 128/);
  assert.match(parityHarness, /fract_t < 128/);
  assert.match(parityHarness, /texture\.empty\(\) \? 0 : texture\.size\(\) - 1/);
  assert.doesNotMatch(tev, /swtevfast|SampleNearestBaseMip/);
});

test("the locked Dolphin patch reaches each measured phase without changing render output", async () => {
  const patch = await readFile(
    new URL(
      "../patches/dolphin-wasm/snapshot/0009-software-raster-phase-profile.patch",
      import.meta.url
    ),
    "utf8"
  );
  for (const marker of [
    "Phase::RasterTraversal",
    "RecordRasterCandidatePixel",
    "Phase::TevPixel",
    "RecordTevStages",
    "Phase::TextureSample",
    "RecordFifoBurst",
    "RecordFifoConsume",
    "RecordFifoDistanceUnderflow",
  ]) {
    assert.match(patch, new RegExp(marker.replaceAll("::", "::")));
  }
  assert.doesNotMatch(patch, /fast_software_raster\s*[=+\-]/);
});

sourceContractTest("sampled one-stage TEV cases retain an exact canonical tuple without a fast path", async () => {
  const [header, tev, bridge, patch] = await Promise.all([
    readFile(new URL("../core/upstream/dolphin_web_raster_profile.h", import.meta.url), "utf8"),
    readFile(
      new URL("../vendor/dolphin/Source/Core/VideoBackends/Software/Tev.cpp", import.meta.url),
      "utf8"
    ),
    readFile(new URL("../core/upstream/dolphin_web_discio.cpp", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../patches/dolphin-wasm/snapshot/0020-software-tev-exact-tuple-profile.patch",
        import.meta.url
      ),
      "utf8"
    ),
  ]);

  assert.match(header, /TEV_EXACT_WORD_COUNT = 9/);
  assert.match(header, /if \(left\.HasExactTuple\(\)\)\s*return left\.exact_words == right\.exact_words/);
  assert.match(header, /if \(!key\.HasExactTuple\(\)\)\s*return hash \^ MixCaseHash\(key\.program_fingerprint/);
  assert.match(tev, /capture_exact_single_stage = tev_stage_count == 1 && indirect_stage_count == 0/);
  assert.ok(
    tev.indexOf("capture_exact_single_stage") > tev.indexOf("profile_scope.ShouldRecordCase()"),
    "exact tuple construction must remain inside the metrics-gated sampled branch"
  );
  for (const word of [
    "bpmem.genMode.hex",
    "bpmem.tevindref.hex",
    "order_word",
    "indirect.fullhex & 0x1fffff",
    "cc.hex",
    "ac.hex",
    "konst_word",
    "raster_swap_word",
    "texture_swap_word",
  ]) {
    assert.match(tev, new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(bridge, /out << "@1"/);
  assert.match(patch, /capture_exact_single_stage/);
  assert.doesNotMatch(patch, /swtevfast|SampleNearestBaseMip|DrawExactTev/);
});

test("the parity-built core exports the software raster profiler", async () => {
  const [bridge, manifest] = await Promise.all([
    readFile(new URL("../core/upstream/dolphin_web_discio.cpp", import.meta.url), "utf8"),
    readFile(new URL("../provenance/dolphin-core-abi-v1.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.match(bridge, /EMSCRIPTEN_KEEPALIVE\s*\n#endif\s*\nint SetSoftwareRasterProfileEnabled/);
  assert.match(bridge, /RasterProfileStats\(\)/);
  assert.match(
    bridge,
    /void DolphinWeb_RecordVideoOutputProfile[\s\S]*?RasterProfile::PublishGeneratedFrame\(\)/,
  );
  assert.ok(
    !manifest.sourceOnlyExportsPendingRebuild.includes("_SetSoftwareRasterProfileEnabled"),
    "the software raster profile export must not remain pending",
  );
  assert.ok(manifest.moduleExports.includes("_SetSoftwareRasterProfileEnabled"));
});
