import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const patchPath = new URL(
  "../patches/dolphin-wasm/snapshot/0033-webgpu-producer-phase-profile.patch",
  import.meta.url
);

test("WebGPU producer profiler has a stable default-off sampled wire contract", async () => {
  const patch = await readFile(patchPath, "utf8");

  for (const phase of [
    "RingPublish",
    "UploadCopy",
    "GeometryCommit",
    "DrawResources",
    "ShaderTranslateEmit",
    "PipelineSerializeEmit",
    "BindGroupPrepare",
    "XfbShowImage",
    "BackbufferPresent",
    "FifoDecode",
    "FifoTailFlush",
    "Reserved"
  ]) {
    assert.match(patch, new RegExp(`\\b${phase}\\b`));
  }
  assert.match(patch, /SAMPLE_PERIODS[^}]+256, 256, 64, 64, 1, 1, 1, 1, 1, 256, 64, 1/s);
  assert.match(patch, /s_enabled\{false\}/);
  assert.match(patch, /s_epoch\{0\}/);
  assert.match(patch, /inclusive and non-additive/);
  assert.match(patch, /must not be summed/);
  assert.match(patch, /FifoTailFlush covers the dual-core idle-tail/);
  assert.match(patch, /SetWebGpuProducerProfileEnabled/);
  assert.match(patch, /'_SetWebGpuProducerProfileEnabled'/);

  assert.match(patch, /wgprod:1/);
  for (const field of ["wgprd", "wgprc", "wgprs", "wgprt", "wgprm"])
    assert.match(patch, new RegExp(`append_phase_values\\("${field}"`));
});

sourceContractTest("producer waits remain outside sampled ring and upload-copy scopes", async () => {
  const source = await readFile(
    new URL("../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.cpp", import.meta.url),
    "utf8"
  );
  const ringWait = source.indexOf("WaitForRingSpace(w, 1)");
  const ringScope = source.indexOf("Phase::RingPublish", ringWait);
  const ringCopy = source.indexOf("m_slots[w % m_capacity] = rec", ringScope);
  assert.ok(ringWait >= 0 && ringWait < ringScope && ringScope < ringCopy);

  const uploadWait = source.indexOf("ReserveUpload(len, align)");
  const uploadScope = source.indexOf("Phase::UploadCopy", uploadWait);
  const uploadCopy = source.indexOf("std::memcpy", uploadScope);
  assert.ok(uploadWait >= 0 && uploadWait < uploadScope && uploadScope < uploadCopy);
});

test("producer profile setter is explicitly pending the next core rebuild", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../provenance/dolphin-core-abi-v1.json", import.meta.url), "utf8")
  );
  assert.ok(
    manifest.moduleExports.includes("_SetWebGpuProducerProfileEnabled") ||
      manifest.sourceOnlyExportsPendingRebuild.includes("_SetWebGpuProducerProfileEnabled")
  );
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pinnedClang = join(process.env.USERPROFILE ?? "", "emsdk", "upstream", "bin", "clang++.exe");
const compiler = process.platform === "win32" ? pinnedClang : "clang++";

sourceContractTest(
  "native producer profiler harness compiles and runs",
  { skip: process.platform === "win32" && !existsSync(compiler) },
  () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "wgpu-producer-profile-"));
    const executable = join(outputDirectory, process.platform === "win32" ? "profile.exe" : "profile");
    try {
      const compile = spawnSync(
        compiler,
        [
          "-std=c++17",
          "-I",
          join(root, "vendor", "dolphin", "Source", "Core"),
          join(root, "tests", "native", "wgpu-producer-phase-profile-main.cpp"),
          "-o",
          executable
        ],
        { cwd: root, encoding: "utf8" }
      );
      assert.equal(compile.status, 0, compile.stderr || compile.stdout);
      const run = spawnSync(executable, [], { cwd: root, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr || run.stdout);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }
);
