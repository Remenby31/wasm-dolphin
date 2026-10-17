import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiler = process.platform === "win32"
  ? join(process.env.USERPROFILE ?? "", "emsdk", "upstream", "bin", "clang++.exe")
  : "clang++";

sourceContractTest("draw profile source preserves separate default-off sampled contract", async () => {
  const header = await readFile(
    new URL("../vendor/dolphin/Source/Core/VideoCommon/WasmWebGpuDrawProfile.h", import.meta.url),
    "utf8"
  );
  const gfx = await readFile(
    new URL("../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp", import.meta.url),
    "utf8"
  );
  const worker = await readFile(
    new URL("../src/upstream-discio-worker.js", import.meta.url),
    "utf8"
  );
  assert.match(header, /SAMPLE_PERIODS[^}]+64, 64, 256, 64, 64, 64, 256/s);
  assert.match(header, /ValidSampleConfiguration/);
  assert.match(header, /ENABLE_REFRESH_PERIOD = 1024/);
  assert.match(header, /inline thread_local ThreadEnableCache/);
  assert.match(header, /inline std::atomic<std::uint64_t> s_control\{0\}/);
  assert.match(header, /s_control\.load\(std::memory_order_acquire\)/);
  assert.match(header, /compare_exchange_weak\(control, desired, std::memory_order_release/);
  assert.match(header, /if \(!IsEnabledCached\(\)\)/);
  assert.match(header, /block \* SAMPLE_STRIDES\[index\] \+ SAMPLE_SEEDS\[index\]/);
  assert.match(header, /s_control\{0\}/);
  assert.match(gfx, /SetWebGpuDrawProfileEnabled/);
  assert.match(gfx, /wgdraw:1/);
  assert.match(worker, /wgpudrawprofile=1 requires metrics=1/);
  assert.match(worker, /wgpudrawprofile=1 requires video=wgpu/);
  for (const tag of ["wgdrd", "wgdrc", "wgdrs", "wgdrt", "wgdrm"])
    assert.match(gfx, new RegExp(`append_draw_phase_values\\("${tag}"`));
});

sourceContractTest("locked vendor snapshot contains the complete draw profiler header", async () => {
  const sourceLock = JSON.parse(await readFile(
    new URL("../provenance/dolphin-source.lock.json", import.meta.url),
    "utf8"
  ));
  const snapshot = JSON.parse(await readFile(
    new URL("../provenance/dolphin-vendor-snapshot-v1.json", import.meta.url),
    "utf8"
  ));
  const record = snapshot.root.records.find(
    ({ path }) => path === "Source/Core/VideoCommon/WasmWebGpuDrawProfile.h"
  );
  assert.ok(record, "draw profiler header must be represented in the locked vendor snapshot");
  assert.ok(
    sourceLock.patches.some(
      ({ path }) => path ===
        "patches/dolphin-wasm/snapshot/0037-webgpu-draw-profile-header-completion.patch"
    ),
    "the locked patch series must include the header-completion repair"
  );

  const header = (await readFile(
    new URL("../vendor/dolphin/Source/Core/VideoCommon/WasmWebGpuDrawProfile.h", import.meta.url),
    "utf8"
  )).replaceAll("\r\n", "\n");
  const bytes = Buffer.from(header);
  assert.equal(bytes.length, record.size);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256);
  assert.match(header, /};\n}  \/\/ namespace DolphinWeb::WebGpuDrawProfile\n$/);
});

sourceContractTest("native draw profiler cadence harness compiles and runs", {
  skip: process.platform === "win32" && !existsSync(compiler),
}, () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "wgpu-draw-profile-"));
  const executable = join(outputDirectory, process.platform === "win32" ? "profile.exe" : "profile");
  try {
    const compile = spawnSync(compiler, [
      "-std=c++17",
      "-I", join(root, "vendor", "dolphin", "Source", "Core"),
      join(root, "tests", "native", "wgpu-draw-profile-main.cpp"),
      "-o", executable,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync(executable, [], { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});
