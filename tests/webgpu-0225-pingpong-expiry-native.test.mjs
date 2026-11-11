// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Patch 0225 (judge's fourth review of df256ac3), with the REAL
// AsyncShaderCompiler code (QueueWorkItem, WorkerThreadRun, RetrieveWorkItems,
// WaitForWake) and the REAL VertexManagerBase::WaitForSpecializedPipeline,
// extracted from the patched vendor tree.
// 1. Ping-pong: two no-op pipeline items (their pixel shaders stay pending past
//    T) that finish after one real compile landed. Each wakes the wait once;
//    re-queued, they must stay silent. If the wake of a no-op moved the count
//    the no-op items compare to, they would wake each other in turn until T.
//    Required: wake-ups <= 3 per blocked call (the validity bound of the A/B).
// 2. Expiry: the wait expires with an item finished silently whose retrieve is
//    slow. The wait must end at T, without a retrieve and a look after the
//    expiry. Required: each wait and uberWaitMaxUs <= T + the platform timer's
//    own overshoot (measured here, same wait) + 4 ms (T = 20 ms, retrieve 40 ms).

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

function harness() {
  const statics = between(vm, "static std::atomic<u32> s_uber_wait_us_budget{0};", "#endif");
  const setter = body(vm, 'extern "C" EMSCRIPTEN_KEEPALIVE void DolphinWeb_SetUberWaitMs(int ms)').replace("EMSCRIPTEN_KEEPALIVE ", "");
  const stats = body(vm, 'extern "C" EMSCRIPTEN_KEEPALIVE void DolphinWeb_UberWaitStats(double* out)').replace("EMSCRIPTEN_KEEPALIVE ", "");
  const wait = body(vm, "std::optional<const AbstractPipeline*> VertexManagerBase::WaitForSpecializedPipeline()");
  const queue = body(asc, "void AsyncShaderCompiler::QueueWorkItem(WorkItemPtr item, u32 priority)");
  const retrieve = body(asc, "void AsyncShaderCompiler::RetrieveWorkItems()");
  const run = body(asc, "void AsyncShaderCompiler::WorkerThreadRun()");
  const wakeWait = body(asc, "bool AsyncShaderCompiler::WaitForWake(u64 seen, double timeout_ms)");
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
static void sleep_ms(double ms) { std::this_thread::sleep_for(std::chrono::microseconds(static_cast<int>(ms * 1000))); }
struct AbstractPipeline {};
namespace Common { struct Flag { std::atomic<bool> v{false}; bool IsSet() const { return v; } void Set() { v = true; } }; }
namespace VideoCommon {
class AsyncShaderCompiler {
public:
  class WorkItem {
  public:
    virtual ~WorkItem() = default;
    virtual bool Compile() = 0;
    virtual void Retrieve() = 0;
    virtual bool DidWork() const { return true; }
    virtual bool RetrieveAfterShaders() const { return false; }
    u64 queued_real_completions = 0;
  };
  static void SetRetrieveShadersFirst(bool on) { s_retrieve_shaders_first.store(on); }
  static inline std::atomic<bool> s_retrieve_shaders_first{false};
  using WorkItemPtr = std::unique_ptr<WorkItem>;
  void QueueWorkItem(WorkItemPtr item, u32 priority);
  void RetrieveWorkItems();
  bool WaitForWake(u64 seen, double timeout_ms);
  u64 WakeCount() const { return m_wakes.load(); }
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
  std::atomic<u64> m_wakes{0};
};
}  // namespace VideoCommon
using VideoCommon::AsyncShaderCompiler;
${statics}
${setter}
${stats}
${queue}
${retrieve}
${run}
${wakeWait}
// start-up by events: a barrier item per worker, until both ran
struct Barrier : AsyncShaderCompiler::WorkItem {
  std::atomic<int>* n; std::mutex* m; std::condition_variable* cv;
  Barrier(std::atomic<int>* n_, std::mutex* m_, std::condition_variable* cv_) : n(n_), m(m_), cv(cv_) {}
  bool Compile() override { std::unique_lock l(*m); (*n)++; cv->notify_all(); cv->wait_for(l, std::chrono::seconds(5), [this] { return n->load() >= 2; }); return true; }
  void Retrieve() override {}
  bool DidWork() const override { return false; }
};
static void StartWorkers(AsyncShaderCompiler& c) {
  c.Start(2);
  std::atomic<int> n{0}; std::mutex m; std::condition_variable cv;
  c.QueueWorkItem(std::make_unique<Barrier>(&n, &m, &cv), 0);
  c.QueueWorkItem(std::make_unique<Barrier>(&n, &m, &cv), 0);
  for (int i = 0; i < 500 && n.load() < 2; i += 1) { { std::lock_guard g(c.m_pending_work_lock); c.m_worker_thread_wake.notify_all(); } std::unique_lock l(m); cv.wait_for(l, std::chrono::milliseconds(10)); }
  for (int i = 0; i < 500 && (c.m_busy_workers.load() != 0); i += 1) std::this_thread::yield();
  c.RetrieveWorkItems();
}
// a real compile (a shader item for another draw)
struct Real : AsyncShaderCompiler::WorkItem {
  double ms; Real(double m) : ms(m) {}
  bool Compile() override { sleep_ms(ms); return true; }
  void Retrieve() override {}
};
// a pipeline item whose pixel shader stays pending: a no-op that re-queues
// itself at Retrieve (ShaderCache's PipelineWorkItem), the first run slow
struct Cache;
struct NoopPipe : AsyncShaderCompiler::WorkItem {
  Cache* sc; double ms; NoopPipe(Cache* s, double m) : sc(s), ms(m) {}
  bool Compile() override { sleep_ms(ms); return true; }
  bool DidWork() const override { return false; }
  bool RetrieveAfterShaders() const override { return true; }
  void Retrieve() override;
};
// an item finished silently whose retrieve takes a while
struct SlowRetrieve : AsyncShaderCompiler::WorkItem {
  double ms; SlowRetrieve(double m) : ms(m) {}
  bool Compile() override { sleep_ms(3); return true; }
  bool DidWork() const override { return false; }
  void Retrieve() override { sleep_ms(ms); }
};
struct Cache {
  AsyncShaderCompiler c;
  int scenario = 0; bool queued = false;
  u64 AsyncWakeCount() const { return c.WakeCount(); }
  bool WaitForAsyncWake(u64 seen, double ms) { return c.WaitForWake(seen, ms); }
  void RetrieveAsyncShaders() { c.RetrieveWorkItems(); }
  std::optional<const AbstractPipeline*> GetPipelineForUidAsync(int) {
    if (!queued) {
      queued = true;
      if (scenario == 1) {
        // worker 1: the real compile (2 ms), worker 2: P1 (5 ms); then P2 on
        // worker 1; both pipeline items finish after the real compile landed
        c.QueueWorkItem(std::make_unique<Real>(2), 0);
        c.QueueWorkItem(std::make_unique<NoopPipe>(this, 5), 1);
        c.QueueWorkItem(std::make_unique<NoopPipe>(this, 5), 1);
      } else {
        c.QueueWorkItem(std::make_unique<SlowRetrieve>(40), 0);
      }
    }
    return std::nullopt;  // the specialized pipeline is never ready before T
  }
};
// re-queued, each no-op takes 3 ms: P1 and P2, 2 ms apart, overlap, so each
// finishes after the other's wake-up (the ping-pong needs exactly that)
void NoopPipe::Retrieve() { sc->c.QueueWorkItem(std::make_unique<NoopPipe>(sc, 3), 1); }
static Cache* g_shader_cache = nullptr;
struct VertexManagerBase {
  int m_current_pipeline_config = 0;
  double m_uber_wait_frame_us = 0;
  std::optional<const AbstractPipeline*> WaitForSpecializedPipeline();
};
${wait}
static void Stats(double* v) { DolphinWeb_UberWaitStats(v); }
// the platform timer's own overshoot: the longest of 5 timed waits of T ms on a
// condition variable that nobody signals (a loaded or niced run oversleeps)
static double TimerOvershoot(int T) {
  std::mutex m; std::condition_variable cv; double worst = 0;
  for (int i = 0; i < 5; i += 1) {
    std::unique_lock l(m); const double t0 = emscripten_get_now();
    cv.wait_for(l, std::chrono::milliseconds(T), [] { return false; });
    worst = std::max(worst, emscripten_get_now() - t0 - T);
  }
  return worst;
}
static double g_bound = 0;
int scenario(int s, int T) {
  int fails = 0;
  for (int trial = 0; trial < 5; trial += 1) {
    Cache cache; cache.scenario = s; g_shader_cache = &cache;
    StartWorkers(cache.c);
    DolphinWeb_SetUberWaitMs(T);
    double v0[10], v1[10];
    Stats(v0);
    VertexManagerBase vmb;
    auto first = cache.GetPipelineForUidAsync(0);
    const double t0 = emscripten_get_now();
    auto r = vmb.WaitForSpecializedPipeline();
    const double spent = emscripten_get_now() - t0;
    Stats(v1);
    const double waits = v1[2] - v0[2], wakeups = v1[6] - v0[6];
    bool bad;
    if (s == 1) {
      bad = first.has_value() || waits != 1 || wakeups > 3 * waits;
      std::fprintf(stderr, "ping-pong trial %d: %.0f wake-ups for %.0f blocked call(s) in %.2f ms (T = %d ms, bound 3 per call)%s\n", trial, wakeups, waits, spent, T, bad ? " FAIL" : "");
    } else {
      bad = first.has_value() || spent > g_bound || v1[1] / 1000 > g_bound;
      std::fprintf(stderr, "expiry trial %d: wait ended after %.2f ms (T = %d ms, bound %.2f ms)%s\n", trial, spent, T, g_bound, bad ? " FAIL" : "");
    }
    if (bad) fails += 1;
    (void)r;
    cache.c.Stop();
  }
  return fails;
}
int main() {
  const double over = TimerOvershoot(20);
  g_bound = 20 + over + 4;  // T + the timer's own overshoot + 4 ms
  std::fprintf(stderr, "timer overshoot %.2f ms: expiry bound T + %.2f ms\n", over, over + 4);
  // expiry first: uberWaitMaxUs is a running max over the process
  const int b = scenario(2, 20), a = scenario(1, 40);
  double v[10]; Stats(v);
  std::fprintf(stderr, "uberWaitMaxUs over all calls: %.0f; failures: ping-pong %d, expiry %d\n", v[1], a, b);
  return a + b;
}
`;
}

sourceContractTest("0225 ping-pong and expiry: no-op items never wake each other in turn; an expired wait ends at T", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "uberwait-pingpong-"));
  try {
    const cpp = join(dir, "h.cpp"), exe = join(dir, "h");
    writeFileSync(cpp, harness());
    const c = spawnSync("clang++", ["-std=c++20", "-O1", "-pthread", "-D__EMSCRIPTEN__", cpp, "-o", exe], { encoding: "utf8" });
    assert.equal(c.status, 0, c.stderr || c.stdout);
    const r = spawnSync(exe, [], { encoding: "utf8", timeout: 60000 });
    t.diagnostic(r.stderr.trim());
    assert.equal(r.status, 0, `no ping-pong (<= 3 wake-ups per blocked call) and an expired wait ending by T + timer overshoot + 4 ms:\n${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
