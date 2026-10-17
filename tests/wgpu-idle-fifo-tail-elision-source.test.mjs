import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patchUrl = new URL(
  "../patches/dolphin-wasm/snapshot/0034-wgpu-idle-fifo-tail-elision.patch",
  import.meta.url
);

test("idle FIFO tail elision is default-off and uses exact independent dirty predicates", async () => {
  const patch = await readFile(patchUrl, "utf8");
  assert.match(patch, /s_enabled\{false\}/);
  assert.match(patch, /SAMPLE_PERIOD = 256/);
  assert.match(patch, /SetWgpuIdleFifoTailElisionEnabled/);
  assert.match(patch, /'_SetWgpuIdleFifoTailElisionEnabled'/);
  assert.match(patch, /if \(!DolphinWeb::WgpuIdleFifoTailGate::IsEnabled\(\)\)[\s\S]+g_vertex_manager->Flush\(\);[\s\S]+g_framebuffer_manager->RefreshPeekCache\(\);/);
  assert.match(patch, /const bool flush_needed = g_vertex_manager->NeedsFlush\(\);/);
  assert.match(patch, /const bool refresh_needed = g_framebuffer_manager->NeedsPeekCacheRefresh\(\);/);
  assert.match(patch, /if \(flush_needed\)[\s\S]+g_vertex_manager->Flush\(\);/);
  assert.match(patch, /if \(refresh_needed\)[\s\S]+g_framebuffer_manager->RefreshPeekCache\(\);/);
  assert.doesNotMatch(patch, /decoded_any|decoded_chunks/);
  assert.match(patch, /wgtail:1,/);
  for (const field of [
    "sampled_payloads",
    "flush_needed",
    "refresh_needed",
    "both_clean",
    "dirty_at_skip"
  ]) {
    assert.match(patch, new RegExp(`\\b${field}\\b`));
  }
});

const pinnedClang = join(process.env.USERPROFILE ?? "", "emsdk", "upstream", "bin", "clang++.exe");
const compiler = process.platform === "win32" ? pinnedClang : "clang++";

sourceContractTest(
  "native idle-tail gate policy keeps stable enable epochs and period-256 samples",
  { skip: process.platform === "win32" && !existsSync(compiler) },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "wgpu-idle-tail-"));
    const source = join(directory, "main.cpp");
    const executable = join(directory, process.platform === "win32" ? "gate.exe" : "gate");
    writeFileSync(source, String.raw`
#include "VideoCommon/WasmWgpuIdleFifoTailGate.h"
using namespace DolphinWeb::WgpuIdleFifoTailGate;
int main()
{
  if (IsEnabled() || GetEpoch() != 0 || SAMPLE_PERIOD != 256) return 1;
  SetEnabled(true);
  if (!IsEnabled() || GetEpoch() != 1) return 2;
  SetEnabled(true);
  if (GetEpoch() != 1) return 3;
  RecordDecision(false, false, false);
  for (unsigned i = 1; i < SAMPLE_PERIOD; ++i) RecordDecision(true, true, true);
  const auto& first = GetCounters();
  if (first.sampled_payloads.load() != 1 || first.both_clean.load() != 1 ||
      first.flush_needed.load() != 0 || first.refresh_needed.load() != 0 ||
      first.dirty_at_skip.load() != 0) return 4;
  RecordDecision(true, false, true);
  if (first.sampled_payloads.load() != 2 || first.flush_needed.load() != 1 ||
      first.refresh_needed.load() != 0 || first.both_clean.load() != 1 ||
      first.dirty_at_skip.load() != 1) return 5;
  SetEnabled(false);
  if (IsEnabled() || GetEpoch() != 2) return 6;
  return 0;
}
`);
    try {
      const compile = spawnSync(
        compiler,
        [
          "-std=c++17",
          "-I",
          join(root, "vendor", "dolphin", "Source", "Core"),
          source,
          "-o",
          executable
        ],
        { cwd: root, encoding: "utf8" }
      );
      assert.equal(compile.status, 0, compile.stderr || compile.stdout);
      const run = spawnSync(executable, [], { cwd: root, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr || run.stdout);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
