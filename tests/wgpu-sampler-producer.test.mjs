// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const compiler = process.platform === "win32"
  ? join(process.env.USERPROFILE ?? "", "emsdk/upstream/bin/clang++.exe")
  : "clang++";
const native = "vendor/dolphin/Source/Core/";
const requiredNativeFiles = [
  "VideoBackends/WebGPU/WebGPUGfx.cpp",
  "VideoBackends/WebGPU/WebGPUGfx.h",
  "VideoCommon/PixelShaderGen.cpp",
];
const missingNativeFile = requiredNativeFiles.find((path) => !existsSync(join(root, native, path)));
const compilerAvailable = !missingNativeFile &&
  spawnSync(compiler, ["--version"], { encoding: "utf8" }).status === 0;
const nativeSkipReason = missingNativeFile
  ? `requires patched vendor source: ${native}${missingNativeFile}`
  : !compilerAvailable ? `requires native C++ compiler: ${compiler}` : false;
const readNative = (path) => readFileSync(join(root, native, path), "utf8").replace(/\r\n/g, "\n");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `native source seam: ${startMarker}`);
  return source.slice(start, end);
}

sourceContractTest("native sampler records preserve independent slots, reuse, failure recovery, and shader bindings", {
  skip: nativeSkipReason,
}, () => {
  const [gfx, header, pixel] = requiredNativeFiles.map(readNative);
  // Compile the actual producer statements with a recording command stream.
  // This exercises the resulting wire records and cache behavior without a
  // browser, Dolphin game boot, or a second implementation of the producer.
  const packing = between(gfx, "static u32 PackSamplerState", "WebGPUGfx::WebGPUGfx()");
  const constructor = between(gfx, "WebGPUGfx::WebGPUGfx()", "WebGPUGfx::~WebGPUGfx()");
  const setter = between(gfx, "void WebGPUGfx::SetSamplerState", "u32 WebGPUGfx::RefreshUboControlMode");
  const writeWord = between(gfx, "static void PutBgU32", "bool WebGPUGfx::PrepareDrawResources");
  const bindingCode = between(gfx, "  auto resolve_tex =", "  // Bind group 2 — bbox SSBO");
  const stateFields = between(header, "  u32 m_tex_id[8]", "  u32 m_ssbo_bbox");
  const cacheFields = between(header, "  static constexpr u32 kBg1CacheSize", "\n};");
  const splitBranch = pixel.indexOf("  if (api_type == APIType::Vulkan)",
    pixel.indexOf("SEPARATE textures"));
  assert.ok(splitBranch >= 0);
  const shaderDeclarations = between(pixel.slice(splitBranch),
    "    for (u32 i = 0; i < 8; i++)", "\n  }\n  else");
  const macroMatch = shaderDeclarations.match(/out\.Write\("(#define SAMP_AT\(i\) [^"\n]+)"\);/);
  assert.ok(macroMatch, "shader emits a sampler routing macro");
  const sampleMacro = JSON.parse(`"${macroMatch[1]}"`);
  const directory = mkdtempSync(join(tmpdir(), "wgpu-sampler-producer-"));
  const source = join(directory, "main.cpp");
  const executable = join(directory, process.platform === "win32" ? "samplers.exe" : "samplers");
  writeFileSync(source, String.raw`
#include <array>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>
using u8 = std::uint8_t;
using u32 = std::uint32_t;
struct SamplerState { struct Word { u32 hex = 0; }; Word tm0, tm1; };
namespace RenderState {
SamplerState GetPointSamplerState() { return {{0}, {255u << 8}}; }
}
namespace DolphinWeb {
namespace WebGpuDrawProfile {
enum class Phase { TextureSamplerResolve, BindResourceRecord };
struct ScopedSample { explicit ScopedSample(Phase) {} };
}
namespace WebGpuProducerProfile {
enum class Phase { BindGroupPrepare };
struct ScopedSample { explicit ScopedSample(Phase) {} };
}
}
struct CommandStream {
  u32 next_id = 1;
  bool fail_sampler = false, fail_group = false;
  std::vector<std::pair<u32, u32>> samplers;
  std::unordered_map<u32, std::vector<u8>> groups;
  u32 PushCreateSampler(u32 state) {
    if (fail_sampler) return 0;
    const u32 id = next_id++;
    samplers.emplace_back(id, state);
    return id;
  }
  u32 PushCreateBindGroup(const void* data, std::size_t bytes, u32 group) {
    assert(group == 1);
    if (fail_group) return 0;
    const u32 id = next_id++;
    const auto* first = static_cast<const u8*>(data);
    groups.emplace(id, std::vector<u8>(first, first + bytes));
    return id;
  }
};
${packing}
${writeWord}
class WebGPUGfx {
public:
${stateFields}
${cacheFields}
  CommandStream m_cmd_stream;
  u32 m_fb_color_id = 0, m_fb_depth_id = 0, m_dummy_tex = 77, bound_group = 0;
  void UpdateActiveConfig() {}
  WebGPUGfx();
  void SetSamplerState(u32 index, const SamplerState& state);
  bool SetRecordedBindGroup(u32 group, u32 id) { assert(group == 1); bound_group = id; return true; }
  bool PrepareSamplerBindings() {
${bindingCode}
    return true;
  }
};
${constructor}
${setter}
u32 word(const std::vector<u8>& blob, std::size_t index) {
  assert(index * 4 + 4 <= blob.size());
  u32 value = 0;
  for (u32 byte = 0; byte < 4; ++byte) value |= u32(blob[index * 4 + byte]) << (byte * 8);
  return value;
}
u32 resource(const WebGPUGfx& gfx, u32 binding, u32 kind) {
  const auto& blob = gfx.m_cmd_stream.groups.at(gfx.bound_group);
  assert(word(blob, 0) == 0x57424731 && word(blob, 1) == 1 && word(blob, 2) == 16);
  assert(blob.size() == 12 + 16 * 20);
  assert(word(blob, 3 + binding * 5) == binding);
  assert(word(blob, 4 + binding * 5) == kind);
  assert(word(blob, 6 + binding * 5) == 0 && word(blob, 7 + binding * 5) == 0);
  return word(blob, 5 + binding * 5);
}
struct Writer {
  std::string text;
  void Write(const char* value) { text += value; }
  void Write(std::string format, u32 first, u32 second) {
    for (u32 value : {first, second}) {
      auto marker = format.find("{}");
      assert(marker != std::string::npos);
      format.replace(marker, 2, std::to_string(value));
    }
    text += format;
  }
};
std::string EmitDeclarations() {
  Writer out;
${shaderDeclarations}
  return out.text;
}
${Array.from({ length: 8 }, (_, i) => `constexpr u32 tex_${i}u = ${100 + i}, samp_${i}u = ${200 + i};`).join("\n")}
${sampleMacro}
int main() {
  const u32 lod_values[] = {0, 1, 15, 16, 127, 255};
  for (u32 filters = 0; filters < 8; ++filters)
  for (u32 wrap_u = 0; wrap_u < 3; ++wrap_u)
  for (u32 wrap_v = 0; wrap_v < 3; ++wrap_v)
  for (u32 aniso = 0; aniso < 16; ++aniso)
  for (u32 min_lod : lod_values)
  for (u32 max_lod : lod_values) {
    const SamplerState state{{filters | (wrap_u << 3) | (wrap_v << 5) | (aniso << 25)},
                             {min_lod | (max_lod << 8)}};
    const u32 packed = PackSamplerState(state);
    assert((packed & 0x80000000u) != 0 && (packed & 0x78000000u) == 0);
    assert((packed & 7) == filters && ((packed >> 3) & 3) == wrap_u);
    assert(((packed >> 5) & 3) == wrap_v && ((packed >> 7) & 15) == aniso);
    assert(((packed >> 11) & 255) == min_lod && ((packed >> 19) & 255) == max_lod);
    auto shader_only = state;
    shader_only.tm0.hex |= (0xffffu << 8) | (1u << 7) | (1u << 24);
    assert(PackSamplerState(shader_only) == packed);
  }
  WebGPUGfx gfx;
  for (auto& texture : gfx.m_tex_id) texture = 900;
  assert(gfx.PrepareSamplerBindings());
  assert(gfx.m_cmd_stream.samplers.size() == 1);
  const u32 point_id = gfx.m_sampler_ids[0], point_group = gfx.bound_group;
  for (u32 i = 0; i < 8; ++i) {
    assert(resource(gfx, i, 1) == 900);
    assert(resource(gfx, i + 8, 2) == point_id);
  }
  const SamplerState linear{{7u | (2u << 3) | (1u << 5)}, {32u | (96u << 8)}};
  gfx.SetSamplerState(7, linear);
  assert(gfx.PrepareSamplerBindings());
  const u32 linear_id = gfx.m_sampler_ids[7];
  assert(linear_id != point_id && gfx.m_cmd_stream.samplers.size() == 2);
  assert(gfx.bound_group != point_group);
  for (u32 i = 0; i < 8; ++i)
    assert(resource(gfx, i + 8, 2) == (i == 7 ? linear_id : point_id));
  const auto stable_ids = gfx.m_sampler_ids;
  const auto stable_states = gfx.m_sampler_states;
  const auto stable_group = gfx.bound_group;
  gfx.SetSamplerState(7, linear);
  gfx.SetSamplerState(8, linear);
  assert(gfx.m_sampler_ids == stable_ids && gfx.m_sampler_states == stable_states);
  assert(gfx.PrepareSamplerBindings() && gfx.bound_group == stable_group);
  gfx.SetSamplerState(7, RenderState::GetPointSamplerState());
  assert(gfx.PrepareSamplerBindings() && gfx.bound_group == point_group);
  assert(gfx.m_cmd_stream.samplers.size() == 2);
  gfx.SetSamplerState(0, linear);
  gfx.SetSamplerState(7, linear);
  assert(gfx.PrepareSamplerBindings());
  assert(resource(gfx, 8, 2) == linear_id && resource(gfx, 15, 2) == linear_id);
  assert(gfx.m_cmd_stream.samplers.size() == 2);
  // A hash match cannot reuse a group whose exact resource identities differ.
  for (auto& slot : gfx.m_bg1_cache)
    if (slot.id == gfx.bound_group) slot.sampler_ids[7] ^= 123u;
  const auto before_collision = gfx.bound_group;
  assert(gfx.PrepareSamplerBindings() && gfx.bound_group != before_collision);
  for (auto& slot : gfx.m_bg1_cache)
    if (slot.id == gfx.bound_group) slot.texture_ids[7] ^= 123u;
  const auto before_texture_collision = gfx.bound_group;
  assert(gfx.PrepareSamplerBindings() && gfx.bound_group != before_texture_collision);
  gfx.m_fb_color_id = 900;
  gfx.m_fb_depth_id = 901;
  gfx.m_tex_id[1] = 901;
  gfx.m_tex_id[2] = 0;
  assert(gfx.PrepareSamplerBindings());
  for (u32 i = 0; i < 8; ++i) assert(resource(gfx, i, 1) == gfx.m_dummy_tex);
  WebGPUGfx retry;
  retry.m_cmd_stream.fail_sampler = true;
  assert(!retry.PrepareSamplerBindings());
  assert(retry.m_sampler_cache.empty() && retry.m_cmd_stream.groups.empty());
  retry.m_cmd_stream.fail_sampler = false;
  retry.m_cmd_stream.fail_group = true;
  assert(!retry.PrepareSamplerBindings() && retry.m_cmd_stream.samplers.size() == 1);
  retry.m_cmd_stream.fail_group = false;
  assert(retry.PrepareSamplerBindings() && retry.m_cmd_stream.samplers.size() == 1);
  const auto declarations = EmitDeclarations();
  for (u32 i = 0; i < 8; ++i) {
    assert(declarations.find("SAMPLER_BINDING(" + std::to_string(i) +
      ") uniform texture2DArray tex_" + std::to_string(i) + "u;") != std::string::npos);
    assert(declarations.find("SAMPLER_BINDING(" + std::to_string(i + 8) +
      ") uniform sampler samp_" + std::to_string(i) + "u;") != std::string::npos);
  }
  const std::array<std::array<u32, 2>, 8> routes = {{
    ${Array.from({ length: 8 }, (_, i) => `{{SAMP_AT(${i}u)}}`).join(",\n    ")}
  }};
  for (u32 i = 0; i < 8; ++i) assert(routes[i][0] == 100 + i && routes[i][1] == 200 + i);
  return 0;
}
`);
  try {
    const compile = spawnSync(compiler, ["-std=c++17", source, "-o", executable],
      { cwd: root, encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync(executable, [], { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const fmtInclude = join(root, "vendor/dolphin/Externals/fmt/fmt/include");
const shaderSkipReason = nativeSkipReason ||
  (!existsSync(join(root, native, "VideoCommon/UberShaderPixel.cpp")) &&
    "requires patched vendor source: VideoCommon/UberShaderPixel.cpp") ||
  (!existsSync(join(fmtInclude, "fmt/format.h")) && "requires vendored fmt headers");

sourceContractTest("native hardware sample helpers keep global pairs and preserve generic and manual dispatch", {
  skip: shaderSkipReason,
}, () => {
  const pixel = readNative("VideoCommon/PixelShaderGen.cpp");
  const uber = readNative("VideoCommon/UberShaderPixel.cpp");
  const hardware = between(pixel, "    // WebGPU validates texture/sampler pairs",
    '\n  }\n  else\n  {\n    out.Write("\\nint4 sampleTexture');
  const dispatch = between(pixel,
    "  if (api_type == APIType::Vulkan && !host_config.manual_texture_sampling)",
    "\n}\n\nstatic void WriteStage");
  const uberWrapper = between(uber,
    '    out.Write("int4 sampleTextureWrapper(uint sampler_num',
    "\n  }\n\n  // ======================");
  const specializedWrapper = between(pixel,
    '  out.Write("\\n#define sampleTextureWrapper',
    "\n\n  if (uid_data->ztest");
  const directory = mkdtempSync(join(tmpdir(), "wgpu-sampler-shaders-"));
  const source = join(directory, "generate.cpp");
  const executable = join(directory, process.platform === "win32" ? "generate.exe" : "generate");
  const paths = ["static.glsl", "generic.glsl", "static-no-bias.glsl", "manual.glsl",
    "uber.glsl", "specialized.glsl"].map((name) => join(directory, name));
  writeFileSync(source, String.raw`
#define FMT_HEADER_ONLY
#include <fmt/format.h>
#include <cstdint>
#include <fstream>
#include <string>
#include <utility>
using u32 = std::uint32_t;
#define I_TEXDIMS "texdims"
enum class APIType { Vulkan, OpenGL };
struct ShaderHostConfig { bool manual_texture_sampling, backend_sampler_lod_bias; };
struct SamplerState { struct TM0 { int lod_bias; }; };
template <auto Member> std::string BitfieldExtract(const char* value) {
  return fmt::format("bitfieldExtract(int({}), 8, 16)", value);
}
struct Writer {
  std::string text;
  template <typename... Args> void Write(fmt::format_string<Args...> format, Args&&... args) {
    text += fmt::format(format, std::forward<Args>(args)...);
  }
};
std::string Generate(APIType api_type, const ShaderHostConfig& host_config) {
  Writer out;
  if (!host_config.manual_texture_sampling) {
${hardware}
  }
${dispatch}
  return out.text;
}
std::string GenerateUberWrapper() {
  Writer out;
${uberWrapper}
  return out.text;
}
std::string GenerateSpecializedWrapper() {
  Writer out;
${specializedWrapper}
  return out.text;
}
int main(int argc, char** argv) {
  if (argc != 7) return 1;
  std::ofstream(argv[1]) << Generate(APIType::Vulkan, {false, false});
  std::ofstream(argv[2]) << Generate(APIType::OpenGL, {false, false});
  std::ofstream(argv[3]) << Generate(APIType::Vulkan, {false, true});
  std::ofstream(argv[4]) << Generate(APIType::Vulkan, {true, false});
  std::ofstream(argv[5]) << GenerateUberWrapper();
  std::ofstream(argv[6]) << GenerateSpecializedWrapper();
}
`);
  try {
    const compile = spawnSync(compiler,
      ["-std=c++17", "-I", fmtInclude, source, "-o", executable],
      { cwd: root, encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync(executable, paths, { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const [staticShader, genericShader, noBiasShader, manualDispatch, uberShader, specializedMacro] =
      paths.map((path) => readFileSync(path, "utf8"));
    assert.equal(staticShader.match(/int4 sampleTexture_\du\(/g)?.length, 8);
    assert.doesNotMatch(staticShader, /SAMP_PARAM|\bdtex\b|\bdsmp\b|sampleTexture\(/);
    for (let slot = 0; slot < 8; slot++) {
      const body = between(staticShader, `int4 sampleTexture_${slot}u(int2 uv, int layer)`, "\n}");
      assert.match(body, new RegExp(`texdims\\[${slot}u\\]\\.x \\* 128`));
      assert.match(body, new RegExp(`texdims\\[${slot}u\\]\\.y \\* 128`));
      assert.ok(body.includes(`samp_texmode0(${slot}u)`));
      assert.ok(body.includes("float lod_bias = float(bitfieldExtract(int(texmode0), 8, 16)) / 256.0f;"));
      assert.ok(body.includes(`iround(255.0 * texture(sampler2DArray(tex_${slot}u, samp_${slot}u),coords, lod_bias))`));
      assert.equal(body.match(/texture\(/g)?.length, 1);
    }
    assert.match(genericShader, /int4 sampleTexture\(uint texmap, SAMP_PARAM, int2 uv, int layer\)/);
    assert.equal(genericShader.match(/int4 sampleTexture\(/g)?.length, 1);
    assert.match(genericShader, /texture\(SAMP_USE,coords, lod_bias\)/);
    assert.doesNotMatch(genericShader, /sampleTexture_\du/);
    assert.doesNotMatch(noBiasShader, /float lod_bias/);
    assert.match(noBiasShader, /texture\(sampler2DArray\(tex_7u, samp_7u\),coords\)/);
    assert.equal(manualDispatch.trim(),
      "#define SAMPLE_TEXTURE(texmap, uv, layer) sampleTexture(texmap, SAMP_AT(texmap), uv, layer)");

    // Compile both emitted caller forms with the actual dispatch macro. This
    // catches token-pasting/argument expansion mistakes before glslang sees it.
    const routingSource = join(directory, "routing.cpp");
    const routingExecutable = join(directory, process.platform === "win32" ? "routing.exe" : "routing");
    const staticDispatch = staticShader.match(/^#define SAMPLE_TEXTURE[^\r\n]+/m)?.[0];
    assert.ok(staticDispatch);
    writeFileSync(routingSource, `#include <cassert>\nusing uint = unsigned; using int2 = int; using int4 = int;\n${
      Array.from({ length: 8 }, (_, slot) =>
        `int4 sampleTexture_${slot}u(int2 uv, int layer) { return ${slot} * 100 + uv * 10 + layer; }`).join("\n")
    }\n${staticDispatch}\nnamespace specialized {\n${specializedMacro}\nint call(int slot) {\nswitch (slot) {\n${
      Array.from({ length: 8 }, (_, slot) =>
        `case ${slot}: return sampleTextureWrapper(${slot}u, 2, 3);`).join("\n")
    }\ndefault: return -1;\n}\n}\n#undef sampleTextureWrapper\n}\n${uberShader}\nint main() {\nfor (int i = 0; i < 8; ++i) {\nassert(specialized::call(i) == i * 100 + 23);\nassert(sampleTextureWrapper(i, 2, 3) == i * 100 + 23);\n}\nassert(sampleTextureWrapper(99, 2, 3) == 23);\n}\n`);
    const routingCompile = spawnSync(compiler,
      ["-std=c++17", routingSource, "-o", routingExecutable],
      { cwd: root, encoding: "utf8" });
    assert.equal(routingCompile.status, 0, routingCompile.stderr || routingCompile.stdout);
    const routingRun = spawnSync(routingExecutable, [], { cwd: root, encoding: "utf8" });
    assert.equal(routingRun.status, 0, routingRun.stderr || routingRun.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
