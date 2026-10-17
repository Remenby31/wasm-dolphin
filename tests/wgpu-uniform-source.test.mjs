// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readVendorFileSync, sourceContractTest } from "./helpers/source-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const nativeRoot = join(root, "vendor/dolphin/Source/Core");
const nativeFile = "VideoBackends/WebGPU/WebGPUGfx.cpp";
const gfx = readVendorFileSync(join(nativeRoot, nativeFile)).replace(/\r\n/g, "\n");
const patch = readFileSync(join(root,
  "patches/dolphin-wasm/snapshot/0065-webgpu-select-uniforms-by-pipeline-usage.patch"), "utf8");
const compiler = process.platform === "win32"
  ? join(process.env.USERPROFILE ?? "", "emsdk/upstream/bin/clang++.exe") : "clang++";

function between(text, first, last) {
  const start = text.indexOf(first);
  const end = text.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, first);
  return text.slice(start, end);
}

function functionBody(text, signature) {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, signature);
  let end = text.indexOf("{", start) + 1;
  let depth = 1;
  for (; end < text.length && depth; ++end) {
    if (text[end] === "{") ++depth;
    else if (text[end] === "}") --depth;
  }
  assert.equal(depth, 0, signature);
  return text.slice(start, end);
}

function previousSource(current) {
  // Reconstruct the real pre-fix functions from the checked-in patch. The
  // negative control uses those functions, not an imitation of their policy.
  const section = patch.split("diff --git a/Source/Core/VideoBackends/WebGPU/WebGPUGfx.h")[0];
  for (const hunk of section.split(/^@@[^\n]*\n/m).slice(1)) {
    const lines = hunk.split("\n");
    const before = lines.filter((line) => line.startsWith(" ") || line.startsWith("-"))
      .map((line) => line.slice(1)).join("\n") + "\n";
    const after = lines.filter((line) => line.startsWith(" ") || line.startsWith("+"))
      .map((line) => line.slice(1)).join("\n") + "\n";
    assert.ok(current.includes(after), "snapshot hunk matches current native source");
    current = current.replace(after, before);
  }
  return current;
}

function harness(source) {
  const wrapper = between(source, "class WebGPUPipeline final", "// ---- Day-33 A2:");
  const legacy = wrapper.includes("explicit WebGPUPipeline(u32 bridge_id)");
  const selection = between(source, "    auto off = [](u32 o)", "#ifdef __EMSCRIPTEN__");
  const methods = [
    "void WebGPUGfx::SetPipeline(",
    "u32 WebGPUGfx::RefreshUboControlMode(",
    "void WebGPUGfx::InvalidateUboSlices(",
    "u32 WebGPUGfx::AllocUboSlice(",
    "void WebGPUGfx::UploadUtilityUniforms(",
    "void WebGPUGfx::Draw(",
    "void WebGPUGfx::DrawIndexed(",
  ].map((signature) => functionBody(source, signature)).join("\n");
  return String.raw`
#include <array>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>
#include <unordered_map>
#include <vector>
#include "VideoCommon/AbstractPipeline.h"
enum class BufferUploadRole { Ubo, Utility };
enum class BufferResourceRole { UboRing };
constexpr u32 kUsageUniform = 72;
std::atomic<u64> s_ubo_cache_epoch{0};
std::atomic<u32> s_ubo_control_mode{0};
${wrapper}

struct VertexManager {
  u32 GetVertexBufferId() const { return 10; }
  u32 GetIndexBufferId() const { return 11; }
};
auto g_vertex_manager = std::make_unique<VertexManager>();
std::unordered_map<u32, u32>& DolphinWebTexDiag_PipelineStride() {
  static std::unordered_map<u32, u32> strides;
  return strides;
}
u32 DolphinWebGetLastCommitStride() { return 0; }
struct CommandStream {
  unsigned creates = 0, allocations = 0, draws = 0;
  bool fail_create = false;
  std::vector<u8> bytes;
  std::vector<std::array<u32, 4>> bound;
  u32 PushCreateBuffer(u32 size, u32 usage, BufferResourceRole role) {
    ++creates;
    if (fail_create || usage != kUsageUniform || role != BufferResourceRole::UboRing) return 0;
    bytes.resize(size);
    return 77;
  }
  u32 UploadAlloc(const void* data, u32 size, u32) {
    ++allocations;
    pending.assign(static_cast<const u8*>(data), static_cast<const u8*>(data) + size);
    return 1;
  }
  bool PushUploadBuffer(u32 buffer, u32 offset, u32, u32 size, BufferUploadRole) {
    if (buffer != 77 || offset + size > bytes.size()) return false;
    std::memcpy(bytes.data() + offset, pending.data(), size);
    return true;
  }
  bool PushDraw(u32, u32, u32) { ++draws; return true; }
  bool PushDrawIndexed(u32, u32, u32, u32) { ++draws; return true; }
  std::vector<u8> pending;
};
class WebGPUGfx {
public:
  static constexpr u32 kUboRingSize = 32u * 1024u * 1024u;
  static constexpr u32 kUboSliceStride = 8192, kUboOffNone = 0xffffffffu;
  CommandStream m_cmd_stream;
  u32 m_ubo_ring = 0, m_ubo_ring_off = 0;
  u32 m_cur_pipeline_id = 0, m_last_set_pipeline_id = 0;
  u32 m_ps_off = 131072, m_vs_off = 139264, m_gs_off = 147456, m_util_off = kUboOffNone;
  u64 m_ubo_publication_serial = 0, m_last_ubo_slice_serial = 0;
  u64 m_ps_publication_serial = 0, m_vs_publication_serial = 0, m_gs_publication_serial = 0;
  u64 m_ubo_cache_epoch = 0;
  bool m_ubo_cache_active = false;
  bool m_ps_shadow_valid = true, m_vs_shadow_valid = true, m_gs_shadow_valid = true;
  bool m_util_uniform_mode = false, m_pipeline_uses_utility_uniforms = false;
  bool pass_ok = true;
  unsigned aborts = 0;
  void ResetUboSliceCache() {}
  void InvalidateUboSlices();
  u32 RefreshUboControlMode();
  void SetPipeline(const AbstractPipeline* pipeline);
  u32 AllocUboSlice(const void* data, u32 size, BufferUploadRole role);
  void UploadUtilityUniforms(const void* data, u32 size);
  void Draw(u32 base_vertex, u32 num_vertices);
  void DrawIndexed(u32 base_index, u32 num_indices, u32 base_vertex);
  bool BeginPassIfNeeded() { return pass_ok; }
  void DiscardOrAbortPendingGeometryRange() {}
  void AbortRecordedPass() { ++aborts; }
  bool SetRecordedPipeline(u32 id) { m_last_set_pipeline_id = id; return true; }
  bool SetRecordedVertexBuffer(u32, u32, u32) { return true; }
  bool SetRecordedIndexBuffer(u32, u32, u32) { return true; }
  bool PrepareDrawResources() {
    RefreshUboControlMode();
    ${selection}
    m_cmd_stream.bound.push_back({dyn[0], dyn[1], dyn[2], dyn[3]});
    return true;
  }
};
${methods}
WebGPUPipeline pipeline(AbstractPipelineUsage usage, u32 id) {
  AbstractPipelineConfig config{};
  config.usage = usage;
  config.depth_state.hex = 1234;
  return WebGPUPipeline(${legacy ? "id" : "config, id"});
}
int main() {
  auto gx = pipeline(AbstractPipelineUsage::GX, 1);
  auto uber = pipeline(AbstractPipelineUsage::GXUber, 2);
  auto utility = pipeline(AbstractPipelineUsage::Utility, 3);
  const std::array<float, 4> ui{2.0f / 640, 2.0f / 480, 0, 0};
  WebGPUGfx renderer;
  renderer.m_ubo_ring = renderer.m_cmd_stream.PushCreateBuffer(
    WebGPUGfx::kUboRingSize, kUsageUniform, BufferResourceRole::UboRing);
  const auto selected = [&] { return renderer.m_cmd_stream.bound.back()[0]; };

  // Actual Sunshine trigger: ImGui uploads, emits zero draws, then GX resumes.
  renderer.SetPipeline(&utility);
  renderer.UploadUtilityUniforms(ui.data(), sizeof(ui));
  renderer.SetPipeline(&gx);
  renderer.Draw(0, 3);
  if (selected() != renderer.m_ps_off) {
    std::fprintf(stderr, "empty UI upload redirected GX from PS=%u to utility=%u\n",
                 renderer.m_ps_off, selected());
    return 42;
  }
  if (utility.m_config.usage != AbstractPipelineUsage::Utility ||
      uber.m_config.usage != AbstractPipelineUsage::GXUber ||
      gx.m_config.depth_state.hex != 1234) return 1;

  const u32 utility_offset = renderer.m_util_off;
  renderer.SetPipeline(&utility);
  renderer.Draw(0, 3);
  renderer.DrawIndexed(0, 6, 0);
  renderer.Draw(0, 3);
  for (unsigned i = 1; i < 4; ++i) {
    const auto& offsets = renderer.m_cmd_stream.bound[i];
    if (offsets[0] != utility_offset || offsets[2] != utility_offset ||
        offsets[1] != renderer.m_vs_off || offsets[3] != renderer.m_gs_off) return 2;
  }
  renderer.SetPipeline(&uber);
  renderer.DrawIndexed(0, 6, 0);
  if (selected() != renderer.m_ps_off) return 3;
  renderer.SetPipeline(&utility);
  renderer.DrawIndexed(0, 6, 0);
  if (selected() != utility_offset) return 4;
  renderer.SetPipeline(nullptr);
  const auto count = renderer.m_cmd_stream.draws;
  renderer.Draw(0, 3);
  renderer.DrawIndexed(0, 6, 0);
  if (renderer.m_cmd_stream.draws != count || renderer.m_pipeline_uses_utility_uniforms) return 5;
  renderer.SetPipeline(&gx);
  renderer.Draw(0, 3);
  if (selected() != renderer.m_ps_off) return 6;

  // First-use utility data must be published before any game draw creates resources.
  WebGPUGfx first;
  first.UploadUtilityUniforms(nullptr, sizeof(ui));
  first.UploadUtilityUniforms(ui.data(), 0);
  if (first.m_cmd_stream.creates != 0) return 7;
  first.m_cmd_stream.fail_create = true;
  first.UploadUtilityUniforms(ui.data(), sizeof(ui));
  if (first.m_util_off != WebGPUGfx::kUboOffNone || first.m_cmd_stream.allocations != 0) return 8;
  first.m_cmd_stream.fail_create = false;
  first.UploadUtilityUniforms(ui.data(), sizeof(ui));
  if (first.m_ubo_ring != 77 || first.m_util_off == WebGPUGfx::kUboOffNone ||
      first.m_cmd_stream.creates != 2 || first.m_cmd_stream.allocations != 1 ||
      std::memcmp(first.m_cmd_stream.bytes.data() + first.m_util_off, ui.data(), sizeof(ui))) return 9;
  first.SetPipeline(&utility);
  first.Draw(0, 3);
  if (first.m_cmd_stream.bound.back()[0] != first.m_util_off) return 10;

  // Epoch invalidation happens before the replacement upload, preserving its
  // selection even when PrepareDrawResources checks the same epoch afterward.
  s_ubo_control_mode.store(1);
  s_ubo_cache_epoch.fetch_add(1);
  const std::array<float, 4> changed_ui{1, 2, 3, 4};
  first.UploadUtilityUniforms(changed_ui.data(), sizeof(changed_ui));
  const u32 refreshed = first.m_util_off;
  first.Draw(0, 3);
  if (refreshed == WebGPUGfx::kUboOffNone || first.m_cmd_stream.bound.back()[0] != refreshed ||
      std::memcmp(first.m_cmd_stream.bytes.data() + refreshed, changed_ui.data(), sizeof(changed_ui))) return 11;
  std::puts("empty UI, repeated utility draws, GX/Uber/null transitions, first upload and epoch checks passed");
  return 0;
}
`;
}

sourceContractTest("native pipeline usage owns uniform selection across empty and repeated utility draws", {
  skip: process.platform === "win32" && !existsSync(compiler),
}, (t) => {
  assert.match(gfx, /return std::make_unique<WebGPUPipeline>\(config, bridge_id\);/);
  const directory = mkdtempSync(join(tmpdir(), "wgpu-uniform-source-"));
  try {
    const run = (source, name) => {
      const cpp = join(directory, `${name}.cpp`);
      const executable = join(directory, `${name}${process.platform === "win32" ? ".exe" : ""}`);
      writeFileSync(cpp, harness(source));
      const compiled = spawnSync(compiler, ["-std=c++20", "-O2", "-I", nativeRoot,
        "-I", join(root, "vendor/dolphin/Externals/fmt/fmt/include"),
        cpp, "-o", executable], { cwd: root, encoding: "utf8" });
      assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
      return spawnSync(executable, [], { cwd: root, encoding: "utf8" });
    };
    const before = run(previousSource(gfx), "before");
    assert.equal(before.status, 42, before.stderr || before.stdout);
    assert.match(before.stderr, /empty UI upload redirected GX from PS=131072 to utility=0/);
    const after = run(gfx, "after");
    assert.equal(after.status, 0, after.stderr || after.stdout);
    t.diagnostic(`Before: ${before.stderr.trim()}`);
    t.diagnostic(after.stdout.trim());
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});
