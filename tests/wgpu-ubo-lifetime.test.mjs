// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readVendorFileSync, sourceContractTest } from "./helpers/source-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(root, "vendor/dolphin/Source/Core");
const sourcePath = join(nativeRoot, "VideoBackends/WebGPU/WebGPUGfx.cpp");
const source = readVendorFileSync(sourcePath);
const header = readVendorFileSync(join(nativeRoot, "VideoBackends/WebGPU/WebGPUGfx.h"));
const pinnedClang = join(process.env.USERPROFILE ?? "", "emsdk/upstream/bin/clang++.exe");
const compiler = process.platform === "win32" ? pinnedClang : "clang++";

function extractFunction(text, signature) {
  const start = text.indexOf(signature);
  assert.notEqual(start, -1, signature);
  const body = text.indexOf("{", start);
  let depth = 1;
  let end = body + 1;
  for (; depth > 0 && end < text.length; ++end) {
    if (text[end] === "{") ++depth;
    else if (text[end] === "}") --depth;
  }
  assert.equal(depth, 0, signature);
  return text.slice(start, end);
}

function nativeHarness(text) {
  const constants = ["kUboSliceStride", "kUboRingSize", "kUboRingSliceCount",
    "kUboReuseSafetySlots", "kUboOffNone"].map((name) => {
    const match = header.match(new RegExp(`static constexpr u32 ${name} = [^;]+;`));
    assert.ok(match, name);
    return match[0];
  }).join("\n");
  const checks = ["vs", "ps", "gs"].map((prefix, index) => {
    const expired = text.match(new RegExp(`const bool ${prefix}_expired = [^;]+;`))?.[0];
    const plan = text.match(new RegExp(`const auto ${prefix}_plan = [^;]+;`))?.[0];
    assert.ok(expired && plan, `${prefix} native expiration and comparison plan`);
    return `case ${index}: { ${expired} ${plan}
      return ${prefix}_plan.ShouldUpload(false); }`;
  }).join("\n");
  return String.raw`
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <vector>
#include "VideoCommon/WasmWebGpuUniformFastPath.h"
#include "VideoBackends/WebGPU/WebGPUUboPacket.h"
using namespace WebGPU;
enum class BufferUploadRole { Ubo, Utility };

// Only the command-stream boundary is replaced. Allocation, expiration and
// mandatory-upload decisions below are compiled directly from native source.
struct UploadRecorder {
  std::vector<u8> gpu = std::vector<u8>(32u * 1024u * 1024u);
  std::vector<u8> pending;
  u32 UploadAlloc(const void* bytes, u32 size, u32) {
    const auto* begin = static_cast<const u8*>(bytes);
    pending.assign(begin, begin + size);
    return 1;
  }
  bool PushUploadBuffer(u32, u32 offset, u32, u32 size, BufferUploadRole) {
    if (offset + size > gpu.size() || size != pending.size()) return false;
    std::memcpy(gpu.data() + offset, pending.data(), size);
    return true;
  }
};
struct Manager { bool dirty = false; };
class WebGPUGfx {
public:
  ${constants}
  UploadRecorder m_cmd_stream;
  u32 m_ubo_ring = 1, m_ubo_ring_off = 0;
  u64 m_ubo_publication_serial = 0, m_last_ubo_slice_serial = 0;
  bool m_ubo_cache_active = false;
  u32 m_vs_off = kUboOffNone, m_ps_off = kUboOffNone, m_gs_off = kUboOffNone;
  u64 m_vs_publication_serial = 0, m_ps_publication_serial = 0, m_gs_publication_serial = 0;
  bool m_vs_shadow_valid = true, m_ps_shadow_valid = true, m_gs_shadow_valid = true;
  Manager vsm, psm, gsm;
  unsigned failures = 0;
  void InvalidateUboSlices() { ++failures; }
  bool IsUboSliceLive(u64 publication_serial) const;
  u32 AllocUboSlice(const void* data, u32 size, BufferUploadRole role);
  bool NeedsUpload(unsigned kind, bool ubo_cache_enabled, bool uniform_fast_enabled) {
    switch (kind) { ${checks} }
    return false;
  }
  u32& Offset(unsigned kind) {
    return kind == 0 ? m_vs_off : kind == 1 ? m_ps_off : m_gs_off;
  }
  u64& Serial(unsigned kind) {
    return kind == 0 ? m_vs_publication_serial : kind == 1 ? m_ps_publication_serial :
      m_gs_publication_serial;
  }
};
${extractFunction(text, "bool WebGPUGfx::IsUboSliceLive(")}
${extractFunction(text, "u32 WebGPUGfx::AllocUboSlice(")}

int main() {
  const std::array<u32, 3> sizes{4112, 1536, 64};
  unsigned scenarios = 0, renewals = 0, wraps = 0;
  for (unsigned kind = 0; kind < 3; ++kind)
  for (unsigned cache = 0; cache < 2; ++cache)
  for (unsigned fast = 0; fast < 2; ++fast)
  for (unsigned dense_requested = 0; dense_requested < 2; ++dense_requested) {
    WebGPUGfx gfx;
    gfx.m_ubo_cache_active = cache;
    std::vector<u8> original(sizes[kind]);
    for (u32 i = 0; i < original.size(); ++i) original[i] = u8(17 + kind * 37 + i * 13);
    std::array<u8, WebGPUGfx::kUboSliceStride> other;
    other.fill(0x3f);
    const auto publish_original = [&] {
      gfx.Offset(kind) = gfx.AllocUboSlice(original.data(), u32(original.size()),
                                          BufferUploadRole::Ubo);
      gfx.Serial(kind) = gfx.m_last_ubo_slice_serial;
    };
    const auto matches = [&] {
      return gfx.Offset(kind) != WebGPUGfx::kUboOffNone &&
        std::memcmp(gfx.m_cmd_stream.gpu.data() + gfx.Offset(kind), original.data(),
                    original.size()) == 0;
    };
    publish_original();
    if (gfx.NeedsUpload(kind, cache, fast)) return 1;
    unsigned scenario_renewals = 0, scenario_wraps = 0;
    for (u32 step = 0; step < 4 * WebGPUGfx::kUboRingSliceCount; ++step) {
      // The retained class is clean and byte-identical throughout. Run the
      // real decision before each other publication, as successive draws do.
      if (gfx.NeedsUpload(kind, cache, fast)) {
        if (!matches()) return 2; // Renewal must precede actual overwrite.
        publish_original();
        ++scenario_renewals;
        if (gfx.NeedsUpload(kind, cache, fast)) return 3;
      }
      const u32 old_cursor = gfx.m_ubo_ring_off;
      if (ShouldUseDenseUboPackets(dense_requested, cache) && (step % 2) != 0) {
        const std::array<DenseUboClass, 3> classes{{
          {other.data(), sizes[0]}, {other.data(), sizes[1]}, {other.data(), sizes[2]}}};
        const auto packet = PlanDenseUboPacket(gfx.m_ubo_ring_off,
          WebGPUGfx::kUboRingSize, classes, 1 + step % 7);
        // Publication-age accounting is conservative only while one dense
        // publication owns no more than the fixed allocator's 8192 bytes.
        if (!packet.valid || packet.packet_size > WebGPUGfx::kUboSliceStride) return 4;
        if (packet.destination_start < old_cursor) ++scenario_wraps;
        std::fill(gfx.m_cmd_stream.gpu.begin() + packet.destination_start,
                  gfx.m_cmd_stream.gpu.begin() + packet.destination_end, 0x3f);
        gfx.m_ubo_ring_off = packet.destination_end;
        gfx.m_last_ubo_slice_serial = ++gfx.m_ubo_publication_serial;
      } else {
        // Fixed-slice utility/other-class uploads use the actual allocator.
        const u32 offset = gfx.AllocUboSlice(other.data(), u32(other.size()),
                                            BufferUploadRole::Utility);
        if (offset < old_cursor) ++scenario_wraps;
      }
      if (!matches()) {
        std::fprintf(stderr, "retained UBO overwritten: class=%u cache=%u fast=%u dense=%u step=%u\n",
                     kind, cache, fast, dense_requested, step);
        return 42;
      }
    }
    if (scenario_renewals == 0 || scenario_wraps == 0 || gfx.failures != 0) return 5;
    renewals += scenario_renewals;
    wraps += scenario_wraps;
    ++scenarios;
  }
  std::printf("%u scenarios, %u renewals, %u ring wraps; retained bytes preserved\n",
              scenarios, renewals, wraps);
  return 0;
}
`;
}

sourceContractTest("retained native UBO slices survive ring wrap with content caching off or on", {
  skip: process.platform === "win32" && !existsSync(compiler),
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wgpu-ubo-lifetime-"));
  try {
    const build = (text, name) => {
      const cpp = join(directory, `${name}.cpp`);
      const executable = join(directory, `${name}${process.platform === "win32" ? ".exe" : ""}`);
      writeFileSync(cpp, nativeHarness(text));
      const compiled = spawnSync(compiler, ["-std=c++17", "-O2", "-I", nativeRoot,
        cpp, "-o", executable], { cwd: root, encoding: "utf8" });
      assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
      return spawnSync(executable, [], { cwd: root, encoding: "utf8" });
    };
    // Restore only the old gates. This exercises the same actual allocator
    // and planner and demonstrates the historical failure, not a mock policy.
    const previous = source.replace(/const bool (vs|ps|gs)_expired = /g,
      "const bool $1_expired = ubo_cache_enabled && ");
    const before = build(previous, "before");
    assert.equal(before.status, 42, before.stderr || before.stdout);
    assert.match(before.stderr, /retained UBO overwritten: class=0 cache=0 fast=0 dense=0 step=4095/);
    const after = build(source, "after");
    assert.equal(after.status, 0, after.stderr || after.stdout);
    assert.match(after.stdout, /24 scenarios, \d+ renewals, \d+ ring wraps; retained bytes preserved/);
    t.diagnostic(`Previous gates: ${before.stderr.trim()}`);
    t.diagnostic(after.stdout.trim());
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});
