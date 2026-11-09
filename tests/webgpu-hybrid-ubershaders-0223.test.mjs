// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Patch 0223: ?shadermode=hybrid puts the WebGPU backend on Dolphin's hybrid
// ubershaders (AsynchronousUberShaders): GLSL -> WGSL on 2 async compiler
// threads, an ubershader pipeline drawing while a specialized one is not
// ready. The default must not move: Synchronous, no compiler thread.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { coreIntegrityOf, INTEGRITY_REPORTED } from "../src/wgpu-integrity.js";
import { SINCE_BOOT_FATAL } from "../harness/lib/integrity.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const patch = read("patches/dolphin-wasm/snapshot/0223-webgpu-hybrid-ubershaders-async-translation.patch");
const added = (file) => {
  const part = patch.split(/^diff --git /m).find((p) => p.startsWith(`a/${file} `));
  assert.ok(part, `0223 touches ${file}`);
  return part.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
};

test("0223 default unchanged: without the flag, Synchronous and 0 compiler threads", () => {
  const core = read("core/upstream/dolphin_web_core.cpp");
  assert.match(core, /const bool shader_hybrid =\n\s+s_video_backend == "WebGPU" &&\n\s+EM_ASM_INT\(\{ return \(typeof Module !== 'undefined' && Module\['dolphinShaderHybrid'\]\) \? 1 : 0; \}\) != 0;/);
  assert.match(core, /shader_hybrid \? ShaderCompilationMode::AsynchronousUberShaders :\n\s+ShaderCompilationMode::Synchronous\);/);
  assert.match(core, /Config::SetBase\(Config::GFX_SHADER_COMPILER_THREADS, shader_hybrid \? 2 : 0\);/);
  assert.match(core, /Config::SetBase\(Config::GFX_SHADER_PRECOMPILER_THREADS, shader_hybrid \? 2 : 0\);/);
  // one place sets the mode, before the backend is activated
  assert.equal(core.match(/GFX_SHADER_COMPILATION_MODE/g).length, 1);
});

test("0223: ?shadermode=hybrid goes URL -> host -> adapter -> worker -> Module, off by default", async () => {
  const host = read("src/core-host.js");
  assert.match(host, /this\.shaderHybrid = new URLSearchParams\(window\.location\.search\)\.get\("shadermode"\) === "hybrid";/);
  assert.match(host, /\n {12}shaderHybrid: this\.shaderHybrid,\n/);
  const adapter = read("src/upstream-worker-adapter.js");
  assert.match(adapter, /\n {4}shaderHybrid = false,\n/);
  assert.match(adapter, /this\.shaderHybrid = shaderHybrid === true;/);
  assert.match(adapter, /\n {6}shaderHybrid: this\.shaderHybrid,\n/);
  const worker = read("src/upstream-discio-worker.js");
  assert.match(worker, /\n {8}shaderHybrid: payload\.shaderHybrid,\n/);
  assert.match(worker, /\n {2}shaderHybrid = false,\n/);
  assert.match(worker, /dolphinShaderHybrid: shaderHybrid === true,/);
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  assert.equal(new UpstreamWorkerAdapter({}).shaderHybrid, false);
  assert.equal(new UpstreamWorkerAdapter({ shaderHybrid: true }).shaderHybrid, true);
});

test("0223: background compiling only in the hybrid mode, the #ifdef lifted for WebGPU only", () => {
  const backend = added("Source/Core/VideoBackends/WebGPU/VideoBackend.cpp");
  assert.match(backend, /g_backend_info\.bSupportsBackgroundCompiling =\n\s+Config::Get\(Config::GFX_SHADER_COMPILATION_MODE\) ==\n\s+ShaderCompilationMode::AsynchronousUberShaders;/);
  const compiler = added("Source/Core/VideoCommon/AsyncShaderCompiler.cpp");
  assert.match(compiler, /if \(!\(m_web_worker_threads && g_backend_info\.api_type == APIType::Vulkan &&\n\s+g_backend_info\.bSupportsBackgroundCompiling\)\)\n\s+return true;/);
  // only the shader cache's compiler may start threads (the graphics-mod and
  // custom-resource compilers start theirs unconditionally upstream: 3 more)
  const cache = added("Source/Core/VideoCommon/ShaderCache.cpp");
  assert.match(cache, /m_async_shader_compiler->AllowWebWorkerThreads\(\);/);
  assert.equal(patch.match(/AllowWebWorkerThreads\(\);/g).length, 1);
  // the start wait is measured around the one Wait per thread
  assert.match(patch, / {4}m_init_event\.Wait\(\);\n\+#ifdef __EMSCRIPTEN__\n\+\s+RecordThreadStart\(emscripten_get_now\(\) - wait_start\);/);
});

test("0223: off the GPU thread only translation; the GPU thread pushes shaders, then the pipeline", () => {
  const gfx = added("Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp");
  // both deferred paths are gated on the hybrid mode AND a non-GPU thread
  assert.equal(gfx.match(/if \(g_backend_info\.bSupportsBackgroundCompiling && !Core::IsGPUThread\(\)\)/g).length, 2);
  assert.match(gfx, /auto pending = std::make_unique<WebGPUPipeline>\(config, 0u\);\n\s+pending->MarkPending\(\);\n\s+return pending;/);
  // ring order: CreateShader x2, then CreatePipelineCfg, then the bind
  assert.match(gfx, /const u32 vs_id = PushPendingShader\(p->m_config\.vertex_shader\);\n\s+const u32 fs_id = PushPendingShader\(p->m_config\.pixel_shader\);[\s\S]*?PushCreatePipelineCfg/);
  assert.match(gfx, /m_cur_pipeline_id = PushPendingPipeline\(pipeline\);/);
  // translator state shared across threads
  const xlat = added("Source/Core/VideoBackends/WebGPU/WebGPUShaderTranslator.cpp");
  assert.match(xlat, /static std::mutex s_last_xlat_error_lock;/);
  assert.match(xlat, /static std::atomic<bool> dumped\{false\};/);
  const spirv = added("Source/Core/VideoCommon/Spirv.cpp");
  assert.match(spirv, /static const bool glslang_initialized = \[\] \{/);
});

test("0223 integrity: uber counters, translation failures, compiler start, pthreads past the pool", () => {
  const c = coreIntegrityOf("wgdrawskip:0 wguber:120,7,3 wgxlatfail:0,1 wgcomp:2,3.5,2.0,1 wgupfail:0,0,0,0,0,0,0,0,0");
  assert.equal(c.uberDraws, 120);
  assert.equal(c.uberFrames, 7);
  assert.equal(c.uberFramesSinceLoad, 3);
  assert.equal(c.xlatFailGlslang, 0);
  assert.equal(c.xlatFailNaga, 1);
  assert.equal(c.compilerThreads, 2);
  assert.equal(c.compilerStartWaitMs, 3.5);
  assert.equal(c.compilerStartWaitMaxMs, 2);
  assert.equal(c.backgroundCompiling, true);
  // an older core: null, never 0
  assert.equal(coreIntegrityOf("wgdrawskip:0").uberDraws, null);
  assert.ok(INTEGRITY_REPORTED.includes("xlatFailNaga"));
  assert.ok(SINCE_BOOT_FATAL.includes("pthreadsOverPool"));
  const worker = read("src/upstream-discio-worker.js");
  assert.match(worker, /pthreadsOverPool: pthreads\.error \? null : Math\.max\(0, pthreads\.allocated - PTHREAD_POOL_SIZE\),/);
  assert.match(worker, /case "validationReadUberAtVi": \{\n[^\n]*\n[^\n]*\n\s+if \(!harnessEnabled\) return/);
});
