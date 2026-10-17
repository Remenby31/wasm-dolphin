// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pinnedClang = join(process.env.USERPROFILE ?? "", "emsdk", "upstream", "bin", "clang++.exe");
const compiler = process.platform === "win32" ? pinnedClang : "clang++";

sourceContractTest("uniform fast path is default-off, normal-path-only, and keeps exact live comparisons", async () => {
  const [patch, gfx] = await Promise.all([
    readFile(new URL(
      "../patches/dolphin-wasm/snapshot/0038-webgpu-guarded-uniform-compare.patch",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp",
      import.meta.url
    ), "utf8"),
  ]);

  assert.match(patch, /s_ubo_control_mode\{0\}/);
  assert.match(patch, /static_cast<u32>\(mode\) & 5u/);
  assert.match(patch, /const u64 epoch = s_ubo_cache_epoch\.load\(std::memory_order_acquire\);[\s\S]*?s_ubo_control_mode\.load\(std::memory_order_relaxed\)/);
  assert.match(patch, /const bool mandatory = dirty \|\| offset_missing \|\| !shadow_valid \|\| expired/);
  assert.match(patch, /shadow_valid && \(!fast_enabled \|\| !mandatory\)/);

  const normalStart = gfx.indexOf("static_assert(sizeof(vsm.constants)");
  const normalEnd = gfx.indexOf("RecordUboPacketOpportunity", normalStart);
  const normal = gfx.slice(normalStart, normalEnd);
  for (const prefix of ["vs", "ps", "gs"]) {
    assert.match(normal, new RegExp(`const auto ${prefix}_plan =`));
    assert.match(normal, new RegExp(`${prefix}_plan\\.compare_shadow &&[\\s\\S]*?std::memcmp`));
    assert.match(normal, new RegExp(`if \\(${prefix}_plan\\.ShouldUpload\\(${prefix}_changed\\)\\)`));
    assert.match(normal, new RegExp(`else if \\(m_${prefix}_shadow_valid\\)[\\s\\S]*?s_uniform_fast_skipped_comparisons`));
  }

  const denseStart = gfx.indexOf("if (use_dense_ubo_packets)");
  const denseEnd = gfx.indexOf("static_assert(sizeof(vsm.constants)", denseStart);
  assert.doesNotMatch(gfx.slice(denseStart, denseEnd), /WebGpuUniformFastPath|uniform_fast/);

  const acquireStart = gfx.indexOf("u32 WebGPUGfx::AcquireUboSlice");
  const acquireEnd = gfx.indexOf("u32 WebGPUGfx::AllocUboSlice", acquireStart);
  assert.match(gfx.slice(acquireStart, acquireEnd),
    /entry\.size != size \|\| std::memcmp\(entry\.bytes\.data\(\), data, size\) != 0/);
});

sourceContractTest("native uniform comparison plan exhaustively preserves the mandatory-upload invariant", {
  skip: process.platform === "win32" && !existsSync(compiler),
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "wgpu-uniform-fast-"));
  const source = join(directory, "main.cpp");
  const executable = join(directory, process.platform === "win32" ? "plan.exe" : "plan");
  writeFileSync(source, String.raw`
#include "VideoCommon/WasmWebGpuUniformFastPath.h"
using DolphinWeb::WebGpuUniformFastPath::Plan;
int main()
{
  for (int fast = 0; fast < 2; ++fast)
  for (int dirty = 0; dirty < 2; ++dirty)
  for (int missing = 0; missing < 2; ++missing)
  for (int valid = 0; valid < 2; ++valid)
  for (int expired = 0; expired < 2; ++expired)
  {
    const auto plan = Plan(fast, dirty, missing, valid, expired);
    const bool mandatory = dirty || missing || !valid || expired;
    if (plan.upload_mandatory != mandatory) return 1;
    if (plan.compare_shadow != (valid && (!fast || !mandatory))) return 2;
    if (!plan.ShouldUpload(true)) return 3;
    if (plan.ShouldUpload(false) != mandatory) return 4;
    if (valid && !mandatory && !plan.compare_shadow) return 5;
    if (fast && mandatory && plan.compare_shadow) return 6;
  }
  return 0;
}
`);
  try {
    const compile = spawnSync(compiler, [
      "-std=c++17",
      "-I", join(root, "vendor", "dolphin", "Source", "Core"),
      source,
      "-o", executable,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync(executable, [], { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
