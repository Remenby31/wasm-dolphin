// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// 0201, counted: the producer's own bind group 1 statements and its
// DestroyRetiredBindGroups, compiled natively against a recording command
// stream (as wgpu-sampler-producer.test.mjs does). 3,000 distinct material
// signatures go through the 1,024-slot cache; every evicted group must be
// destroyed once, only outside a pass, and the consumer's id map (created
// minus destroyed) must stay within the cache's size.

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
const files = ["VideoBackends/WebGPU/WebGPUGfx.cpp", "VideoBackends/WebGPU/WebGPUGfx.h"];
const missing = files.find((path) => !existsSync(join(root, native, path)));
const compilerAvailable = !missing && spawnSync(compiler, ["--version"], { encoding: "utf8" }).status === 0;
const skip = missing ? `requires patched vendor source: ${native}${missing}`
  : !compilerAvailable ? `requires native C++ compiler: ${compiler}` : false;
const readNative = (path) => readFileSync(join(root, native, path), "utf8").replace(/\r\n/g, "\n");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `native source seam: ${startMarker}`);
  return source.slice(start, end);
}

sourceContractTest("0201: evicted bind groups are destroyed once, outside passes, and the live set stays within the cache", { skip }, () => {
  const [gfx, header] = files.map(readNative);
  const packing = between(gfx, "static u32 PackSamplerState", "WebGPUGfx::WebGPUGfx()");
  const constructor = between(gfx, "WebGPUGfx::WebGPUGfx()", "WebGPUGfx::~WebGPUGfx()");
  const setter = between(gfx, "void WebGPUGfx::SetSamplerState", "u32 WebGPUGfx::RefreshUboControlMode");
  const writeWord = between(gfx, "static void PutBgU32", "bool WebGPUGfx::PrepareDrawResources");
  const bindingCode = between(gfx, "  auto resolve_tex =", "  // Bind group 2 — bbox SSBO");
  const destroyRetired = between(gfx, "static constexpr u32 kDestroyTagBindGroup", "// 0202: the consumer's OP_DESTROY tag for a texture.");
  const stateFields = between(header, "  u32 m_tex_id[8]", "  u32 m_ssbo_bbox");
  const cacheFields = between(header, "  static constexpr u32 kBg1CacheSize", "\n};");
  const directory = mkdtempSync(join(tmpdir(), "wgpu-bg-eviction-"));
  const source = join(directory, "main.cpp");
  const executable = join(directory, process.platform === "win32" ? "eviction.exe" : "eviction");
  writeFileSync(source, String.raw`
#include <array>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <set>
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
  bool pass_open = false;  // mirrors WebGPUGfx::m_pass_open for the destroy check
  std::set<u32> created, destroyed;
  u32 destroys_in_pass = 0;
  u32 PushCreateSampler(u32) { return next_id++; }
  u32 PushCreateBindGroup(const void*, std::size_t, u32 group) {
    assert(group == 1);
    const u32 id = next_id++;
    created.insert(id);
    return id;
  }
  bool PushDestroy(u32 tag, u32 id) {
    assert(tag == 3);
    if (pass_open) ++destroys_in_pass;
    assert(created.count(id) == 1);
    assert(destroyed.insert(id).second);  // never twice
    return true;
  }
};
${packing}
${writeWord}
class WebGPUGfx {
public:
${stateFields}
${cacheFields}
  CommandStream m_cmd_stream;
  bool m_pass_open = false;
  u32 m_fb_color_id = 0, m_fb_depth_id = 0, m_dummy_tex = 77, bound_group = 0;
  void UpdateActiveConfig() {}
  WebGPUGfx();
  void SetSamplerState(u32 index, const SamplerState& state);
  bool SetRecordedBindGroup(u32 group, u32 id) { assert(group == 1); bound_group = id; return true; }
  bool PrepareSamplerBindings() {
${bindingCode}
    return true;
  }
  void DestroyRetiredBindGroups();
};
${constructor}
${setter}
${destroyRetired.replace("void WebGPUGfx::DestroyRetiredBindGroups()", "void WebGPUGfx::DestroyRetiredBindGroups()")}
int main() {
  WebGPUGfx gfx;
  constexpr u32 kGroups = 3000;
  // Inside a pass: the evicted groups wait.
  gfx.m_pass_open = gfx.m_cmd_stream.pass_open = true;
  for (u32 k = 0; k < kGroups; ++k) {
    for (u32 i = 0; i < 8; ++i) gfx.m_tex_id[i] = 1000 + k * 8 + i;
    assert(gfx.PrepareSamplerBindings());
    gfx.DestroyRetiredBindGroups();  // refused: the pass is open
  }
  assert(gfx.m_cmd_stream.created.size() == kGroups);
  assert(gfx.m_cmd_stream.destroyed.empty());
  const u32 retired = static_cast<u32>(gfx.m_retired_bind_groups.size());
  // The pass ends: every retired group goes, once.
  gfx.m_pass_open = gfx.m_cmd_stream.pass_open = false;
  gfx.DestroyRetiredBindGroups();
  assert(gfx.m_retired_bind_groups.empty());
  assert(gfx.m_cmd_stream.destroys_in_pass == 0);
  assert(gfx.m_cmd_stream.destroyed.size() == retired);
  // What the consumer keeps: created minus destroyed, as many as cached slots.
  u32 cached = 0;
  for (const auto& slot : gfx.m_bg1_cache)
    if (slot.id != 0) {
      ++cached;
      assert(gfx.m_cmd_stream.destroyed.count(slot.id) == 0);  // a cached group is never destroyed
    }
  const u32 live = kGroups - static_cast<u32>(gfx.m_cmd_stream.destroyed.size());
  assert(live == cached && live <= WebGPUGfx::kBg1CacheSize);
  std::printf("created %u destroyed %u live %u\n", kGroups, static_cast<u32>(gfx.m_cmd_stream.destroyed.size()), live);
  return 0;
}
`);
  try {
    const build = spawnSync(compiler, ["-std=c++20", "-O0", source, "-o", executable], { encoding: "utf8", timeout: 120_000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(executable, [], { encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const [, created, destroyed, live] = /created (\d+) destroyed (\d+) live (\d+)/.exec(run.stdout).map(Number);
    assert.equal(created, 3000);
    assert.ok(destroyed >= 3000 - 1024, `destroyed ${destroyed}`);
    assert.ok(live <= 1024, `live ${live}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
