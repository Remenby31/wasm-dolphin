// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Patch 0225 (judge's re-review of e6cbcf21): the missed wake-up. With the
// REAL AsyncShaderCompiler code (QueueWorkItem, WorkerThreadRun,
// RetrieveWorkItems, WaitForRealCompletion) and the REAL
// VertexManagerBase::WaitForSpecializedPipeline, all extracted from the patched
// vendor tree, and work items that behave as ShaderCache's: the vertex shader
// cached, the pixel shader new; the pipeline item, queued after the pixel
// shader's, finds its stages not ready and finishes first as a no-op. Retrieved
// before the pixel shader is inserted, it re-queued a pipeline item that was
// still a no-op and finished without a wake-up: the wait slept until T and
// ended on the ubershader. Required: the specialized pipeline after blocking,
// well before T.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readVendorFileSync, sourceContractTest } from "./helpers/source-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const core = join(root, "vendor/dolphin/Source/Core");
const vm = readVendorFileSync(join(core, "VideoCommon/VertexManagerBase.cpp"));
const asc = readVendorFileSync(join(core, "VideoCommon/AsyncShaderCompiler.cpp"));
function body(text, signature) {
  const start = text.indexOf(signature);
  assert.notEqual(start, -1, signature);
  let i = text.indexOf("{", start), depth = 0, end = i;
  for (; end < text.length; end += 1) { if (text[end] === "{") depth += 1; else if (text[end] === "}" && --depth === 0) break; }
  return text.slice(text.lastIndexOf("\n", start) + 1, end + 1);
}
const between = (text, a, b) => { const i = text.indexOf(a); const j = text.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return text.slice(i, j); };

export function harness() {
  const statics = between(vm, "static std::atomic<u32> s_uber_wait_us_budget{0};", "#endif");
  const setter = body(vm, 'extern "C" EMSCRIPTEN_KEEPALIVE void DolphinWeb_SetUberWaitMs(int ms)').replace("EMSCRIPTEN_KEEPALIVE ", "");
  const stats = body(vm, 'extern "C" EMSCRIPTEN_KEEPALIVE void DolphinWeb_UberWaitStats(double* out)').replace("EMSCRIPTEN_KEEPALIVE ", "");
  const wait = body(vm, "std::optional<const AbstractPipeline*> VertexManagerBase::WaitForSpecializedPipeline()");
  const queue = body(asc, "void AsyncShaderCompiler::QueueWorkItem(WorkItemPtr item, u32 priority)");
  const retrieve = body(asc, "void AsyncShaderCompiler::RetrieveWorkItems()");
  const run = body(asc, "void AsyncShaderCompiler::WorkerThreadRun()");
  const realWait = body(asc, "bool AsyncShaderCompiler::WaitForRealCompletion(u64 seen, double timeout_ms)");
  return String.raw`
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>
#include <vector>
using u32 = uint32_t; using u64 = uint64_t; using s64 = int64_t;
static const auto t_origin = std::chrono::steady_clock::now();
static double emscripten_get_now() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t_origin).count(); }
struct AbstractPipeline {};
namespace Common { struct Flag { std::atomic<bool> v{false}; bool IsSet() const { return v; } void Set() { v = true; } }; }
${statics}
${setter}
${stats}
// AsyncShaderCompiler: the members its extracted code uses
class AsyncShaderCompiler {
public:
  class WorkItem {
  public:
    virtual ~WorkItem() = default;
    virtual bool Compile() = 0;
    virtual void Retrieve() = 0;
    virtual bool DidWork() const { return true; }
    virtual bool RetrieveAfterShaders() const { return false; }
  };
  using WorkItemPtr = std::unique_ptr<WorkItem>;
  void QueueWorkItem(WorkItemPtr item, u32 priority);
  void RetrieveWorkItems();
  bool WaitForRealCompletion(u64 seen, double timeout_ms);
  u64 RealCompletions() const { return m_real_completions.load(); }
  bool HasWorkerThreads() const { return !m_worker_threads.empty(); }
  void WorkerThreadRun();
  void Start(int n) { for (int i = 0; i < n; i += 1) m_worker_threads.emplace_back([this] { WorkerThreadRun(); }); }
  void Stop() { { std::lock_guard g(m_pending_work_lock); m_exit_flag.Set(); m_worker_thread_wake.notify_all(); } for (auto& t : m_worker_threads) t.join(); }
  Common::Flag m_exit_flag;
  std::vector<std::thread> m_worker_threads;
  std::multimap<u32, WorkItemPtr> m_pending_work;
  std::mutex m_pending_work_lock;
  std::condition_variable m_worker_thread_wake;
  std::atomic_size_t m_busy_workers{0};
  std::deque<WorkItemPtr> m_completed_work;
  std::mutex m_completed_work_lock;
  std::condition_variable m_completed_work_cv;
  std::atomic<u64> m_real_completions{0};
};
${queue}
${retrieve}
${run}
${realWait}
// a shader cache with ShaderCache's work-item behaviour (ShaderCache.cpp:
// QueuePixelShaderCompile marks the shader pending; PipelineWorkItem checks its
// stages at construction, is a no-op when one is pending, re-queues itself at
// Retrieve; the shader item inserts the shader, not pending, at Retrieve)
struct Cache {
  AsyncShaderCompiler c;
  std::mutex m;  // the GPU thread owns the maps; workers never touch them
  bool vs_ready = true;                  // the vertex shader: cached
  std::optional<bool> ps_pending;        // the pixel shader: new
  std::optional<bool> pipe_pending;
  AbstractPipeline pipeline;
  bool pipeline_in = false;
  double ps_compile_ms;
  struct ShaderItem : AsyncShaderCompiler::WorkItem {
    Cache* sc; ShaderItem(Cache* s) : sc(s) {}
    bool Compile() override { std::this_thread::sleep_for(std::chrono::microseconds(static_cast<int>(sc->ps_compile_ms * 1000))); return true; }
    void Retrieve() override { sc->ps_pending = false; }
  };
  struct PipelineItem : AsyncShaderCompiler::WorkItem {
    Cache* sc; bool ready;
    PipelineItem(Cache* s) : sc(s) { ready = sc->vs_ready && sc->ps_pending.has_value() && !*sc->ps_pending; if (!sc->ps_pending.has_value()) { sc->ps_pending = true; sc->c.QueueWorkItem(std::make_unique<ShaderItem>(sc), 1); } }
    bool Compile() override { if (ready) std::this_thread::sleep_for(std::chrono::microseconds(500)); return true; }
    bool DidWork() const override { return ready; }
    bool RetrieveAfterShaders() const override { return true; }
    void Retrieve() override { if (ready) sc->pipeline_in = true; else sc->c.QueueWorkItem(std::make_unique<PipelineItem>(sc), 1); }
  };
  u64 AsyncRealCompletions() const { return c.RealCompletions(); }
  bool WaitForAsyncCompletion(u64 seen, double ms) { return c.WaitForRealCompletion(seen, ms); }
  void RetrieveAsyncShaders() { c.RetrieveWorkItems(); }
  std::optional<const AbstractPipeline*> GetPipelineForUidAsync(int) {
    if (pipeline_in) return &pipeline;
    if (!pipe_pending.has_value()) { pipe_pending = true; c.QueueWorkItem(std::make_unique<PipelineItem>(this), 1); }
    return std::nullopt;
  }
};
static Cache* g_shader_cache = nullptr;
struct VertexManagerBase {
  int m_current_pipeline_config = 0;
  double m_uber_wait_frame_us = 0;
  std::optional<const AbstractPipeline*> WaitForSpecializedPipeline();
};
${wait}
int main() {
  int fails = 0;
  for (int trial = 0; trial < 5; trial += 1) {
    Cache cache; cache.ps_compile_ms = 3; cache.c.Start(2); g_shader_cache = &cache;
    // both workers asleep on their condition before any work: the pixel shader
    // goes to one, the no-op pipeline item to the other (it finishes first)
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    DolphinWeb_SetUberWaitMs(20);
    VertexManagerBase vmb;
    // the draw: the specialized pipeline is missing (this queues the pixel shader, then the no-op pipeline item)
    auto first = cache.GetPipelineForUidAsync(0);
    const double t0 = emscripten_get_now();
    auto r = vmb.WaitForSpecializedPipeline();
    const double spent = emscripten_get_now() - t0;
    std::fprintf(stderr, "trial %d: %s after %.2f ms (T = 20 ms)\n", trial, r && *r ? "specialized" : "UBERSHADER", spent);
    if (first || !(r && *r) || spent >= 15) fails += 1;
    cache.c.Stop();
  }
  return fails;
}
`;
}

sourceContractTest("0225 missed wake-up: VS cached, PS new, the no-op pipeline retrieved before the PS", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "uberwait-missed-"));
  try {
    const cpp = join(dir, "h.cpp"), exe = join(dir, "h");
    writeFileSync(cpp, harness());
    // -D__EMSCRIPTEN__: the extracted RetrieveWorkItems keeps its web-only order (shaders first)
    const c = spawnSync("clang++", ["-std=c++20", "-O1", "-pthread", "-D__EMSCRIPTEN__", cpp, "-o", exe], { encoding: "utf8" });
    assert.equal(c.status, 0, c.stderr || c.stdout);
    const r = spawnSync(exe, [], { encoding: "utf8", timeout: 30000 });
    t.diagnostic(r.stderr.trim());
    assert.equal(r.status, 0, `the wait must end on the specialized pipeline, well before T:\n${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
