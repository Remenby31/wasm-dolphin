// Patch 0222: the ubershaders on the WebGPU backend (api_type Vulkan) build their pipelines, as the specialized
// shaders do: the uber vertex shader's posmtx is uint4 (the backend feeds uint8x4), and an uber pixel shader that
// writes depth does not emit the dual-source output (Naga 26 refuses @blend_src beside @builtin(frag_depth)).
// The default shader mode stays Synchronous (specialized): 0222 changes no default.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const patch = read("patches/dolphin-wasm/snapshot/0222-webgpu-ubershaders-posmtx-dual-source.patch");
const added = (file) => {
  const at = patch.indexOf(`+++ b/${file}`);
  assert.ok(at >= 0, file);
  const next = patch.indexOf("\ndiff --git", at);
  return patch.slice(at, next < 0 ? undefined : next).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
};

test("0222: the uber vertex shader declares posmtx uint4 in the Vulkan dialect, as the specialized one", () => {
  const vs = added("Source/Core/VideoCommon/UberShaderVertex.cpp");
  assert.match(vs, /if \(api_type == APIType::Vulkan\)\n\s+out\.Write\("ATTRIBUTE_LOCATION\(\{:s\}\) in uint4 posmtx;\\n", ShaderAttrib::PositionMatrix\);\n\s+else\n\s+out\.Write\("ATTRIBUTE_LOCATION\(\{:s\}\) in float4 posmtx;\\n", ShaderAttrib::PositionMatrix\);/);
  // the specialized path's rule, which this mirrors, is in the series (0005)
  const series = read("patches/dolphin-wasm/snapshot/0005-video-common-shaders.patch");
  assert.match(series, /if \(api_type == APIType::Vulkan\)\n\+\s+out\.Write\("ATTRIBUTE_LOCATION\(\{:s\}\) in uint4 posmtx;\\n",/);
});

test("0222: an uber pixel shader that writes depth falls back to single-source blending on WebGPU, as specialized ones do", () => {
  const sc = added("Source/Core/VideoCommon/ShaderCache.cpp");
  assert.match(sc, /if \(g_backend_info\.api_type == APIType::Vulkan && out\.ps_uid\.GetUidData\(\)->per_pixel_depth\)\n\s*\{\n\s+out\.blending_state\.use_dual_src = false;\n\s+out\.ps_uid\.GetUidData\(\)->no_dual_src = true;\n\s*\}/);
  // the reason is written: Naga 26 stricter than the WGSL spec
  assert.match(sc, /Naga 26/);
  // and the specialized rule it mirrors exists in the series
  const pipelineUtils = read("patches/dolphin-wasm/snapshot/0006-webgpu-backend.patch") + read("patches/dolphin-wasm/snapshot/0068-webgpu-inverted-depth-dual-source-blend.patch");
  assert.match(pipelineUtils, /api_type == APIType::Vulkan && ps->per_pixel_depth/);
});

test("0222 changes no default: the web core keeps ShaderCompilationMode::Synchronous", () => {
  const core = read("core/upstream/dolphin_web_core.cpp");
  assert.match(core, /Config::SetBase\(Config::GFX_SHADER_COMPILATION_MODE,\n\s+ShaderCompilationMode::Synchronous\);/);
  assert.doesNotMatch(patch, /ShaderCompilationMode|GFX_SHADER_COMPILATION_MODE/);
});
