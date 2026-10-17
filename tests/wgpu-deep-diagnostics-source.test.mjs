import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patchUrl = new URL(
  "../patches/dolphin-wasm/snapshot/0036-webgpu-deep-diagnostic-gate.patch",
  import.meta.url
);

sourceContractTest("deep WGPU diagnostics default off while failure signals remain unconditional", async () => {
  const [patch, gfx, vertexManager, fifo, commandProcessor] = await Promise.all([
    readFile(patchUrl, "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUVertexManager.cpp",
      import.meta.url
    ), "utf8"),
    readFile(new URL("../vendor/dolphin/Source/Core/VideoCommon/Fifo.cpp", import.meta.url), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoCommon/CommandProcessor.cpp",
      import.meta.url
    ), "utf8"),
  ]);
  const changedPaths = [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(changedPaths, [
    "Source/Core/Core/CMakeLists.txt",
    "Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp",
    "Source/Core/VideoBackends/WebGPU/WebGPUVertexManager.cpp",
    "Source/Core/VideoCommon/CommandProcessor.cpp",
    "Source/Core/VideoCommon/Fifo.cpp",
    "Source/Core/VideoCommon/WasmWgpuDeepDiagnostics.h",
  ]);
  assert.match(patch, /inline std::atomic<bool> s_enabled\{false\}/);
  assert.match(patch, /SetWgpuDeepDiagnosticsEnabled/);
  assert.match(patch, /'_SetWgpuDeepDiagnosticsEnabled'/);
  assert.match(
    patch,
    /WgpuDeepDiagnostics::IsEnabled\(\) \|\| m_shader_fail != 0/
  );
  assert.match(
    patch,
    /WgpuDeepDiagnostics::IsEnabled\(\) \|\| s_pcfg_skip != 0/
  );
  assert.doesNotMatch(patch, /WebGPUCommandStream\.cpp/);
  assert.doesNotMatch(patch, /VideoBackend\.cpp/);
  assert.doesNotMatch(patch, /WebGPUShaderTranslator\.cpp/);
  assert.doesNotMatch(patch, /console\.warn/);

  for (const [source, tag] of [
    [gfx, "webgpu-DIAG-vs"],
    [gfx, "s28ah-ps"],
    [gfx, "s28ac-bg"],
    [gfx, "s28ac-uu"],
    [vertexManager, "webgpu-DIAG-vtx"],
    [fifo, "s27-gpuloop"],
    [fifo, "s27-gate"],
    [fifo, "s27-decode"],
    [fifo, "s27-RunGpu"],
    [commandProcessor, "s27-GPB"],
  ]) {
    const tagAt = source.indexOf(`[${tag}]`);
    assert.notEqual(tagAt, -1, `missing gated ${tag} site`);
    const gateAt = source.lastIndexOf("WgpuDeepDiagnostics::IsEnabled()", tagAt);
    // Keep this broad enough for adjacent default-off metric helpers while still
    // proving that the diagnostic site remains inside the same guarded block.
    assert.ok(gateAt >= 0 && tagAt - gateAt < 7000, `${tag} is not inside a nearby gate`);
  }
});

const pinnedClang = join(process.env.USERPROFILE ?? "", "emsdk", "upstream", "bin", "clang++.exe");
const compiler = process.platform === "win32" ? pinnedClang : "clang++";

sourceContractTest("native deep-diagnostic switch is default-off and reversible", {
  skip: process.platform === "win32" && !existsSync(compiler),
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "wgpu-deep-diag-"));
  const source = join(directory, "main.cpp");
  const executable = join(directory, process.platform === "win32" ? "gate.exe" : "gate");
  writeFileSync(source, String.raw`
#include "VideoCommon/WasmWgpuDeepDiagnostics.h"
using namespace DolphinWeb::WgpuDeepDiagnostics;
int main()
{
  if (IsEnabled()) return 1;
  SetEnabled(true);
  if (!IsEnabled()) return 2;
  SetEnabled(false);
  return IsEnabled() ? 3 : 0;
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
