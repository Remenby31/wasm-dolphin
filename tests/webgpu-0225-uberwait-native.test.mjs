// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Patch 0225, exercised natively: VertexManagerBase::WaitForSpecializedPipeline,
// DolphinWeb_SetUberWaitMs / DolphinWeb_UberWaitStats and
// AsyncShaderCompiler::WaitForWake are extracted from the patched
// vendor tree and compiled against a mock shader cache whose "compiler" thread
// finishes real work at set times while flooding no-op completions (pipeline
// items whose shaders were not ready). Checked: the per-frame budget, the
// 50 ms cap, T = 0 doing nothing (no early retrieve), and no busy loop (the
// GPU thread retrieves only after real work, never on the no-op flood).

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
  const realWait = body(asc, "bool AsyncShaderCompiler::WaitForWake(u64 seen, double timeout_ms)");
  return String.raw`
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <optional>
#include <thread>
using u32 = uint32_t; using u64 = uint64_t; using s64 = int64_t;
static const auto t_origin = std::chrono::steady_clock::now();
static double emscripten_get_now() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t_origin).count(); }
struct AbstractPipeline {};
namespace VideoCommon { struct AsyncShaderCompiler { static void SetRetrieveShadersFirst(bool) {} }; }
${statics}
${setter}
${stats}
// the compiler's wake wait, extracted
struct AsyncShaderCompiler {
  std::mutex m_completed_work_lock;
  std::condition_variable m_completed_work_cv;
  std::atomic<u64> m_wakes{0};
  bool WaitForWake(u64 seen, double timeout_ms);
};
${realWait}
// a mock shader cache: one specialized pipeline, its shader "compiled" by a
// background thread at shader_ms (real work), the pipeline item then compiled
// pipe_ms after the retrieve that queued it (real work); meanwhile the thread
// floods no-op completions, which must never wake the waiting GPU thread
struct MockCache {
  AsyncShaderCompiler c;
  double shader_ms, pipe_ms;
  std::atomic<bool> stop{false};
  std::atomic<double> pipe_due{-1};
  std::atomic<int> retrieves{0};
  std::atomic<u64> noops{0};
  bool shader_in = false, pipe_queued = false;
  u64 pipe_seen = 0;
  AbstractPipeline pipeline;
  std::thread worker;
  MockCache(double s, double p) : shader_ms(s), pipe_ms(p) {
    worker = std::thread([this] {
      bool shader_done = false, pipe_done = false;
      while (!stop) {
        const double now = emscripten_get_now();
        if (!shader_done && now >= shader_ms) { shader_done = true; real(); }
        const double due = pipe_due.load();
        if (!pipe_done && due >= 0 && now >= due) { pipe_done = true; real(); }
        noops++;  // a no-op item finishing: no real work, no wake-up
        std::this_thread::sleep_for(std::chrono::microseconds(20));
      }
    });
  }
  ~MockCache() { stop = true; worker.join(); }
  void real() { std::lock_guard g(c.m_completed_work_lock); c.m_wakes.fetch_add(1); c.m_completed_work_cv.notify_all(); }
  u64 AsyncWakeCount() const { return c.m_wakes.load(); }
  bool WaitForAsyncWake(u64 seen, double ms) { return c.WaitForWake(seen, ms); }
  void RetrieveAsyncShaders() {
    retrieves++;
    const u64 r = c.m_wakes.load();
    if (!shader_in && r >= 1) { shader_in = true; pipe_queued = true; pipe_seen = r; pipe_due = emscripten_get_now() + pipe_ms; }
  }
  std::optional<const AbstractPipeline*> GetPipelineForUidAsync(int) {
    if (pipe_queued && c.m_wakes.load() > pipe_seen) return &pipeline;
    return std::nullopt;
  }
};
static MockCache* g_shader_cache = nullptr;
struct VertexManagerBase {
  int m_current_pipeline_config = 0;
  double m_uber_wait_frame_us = 0;
  std::optional<const AbstractPipeline*> WaitForSpecializedPipeline();
};
${wait}
static double stat(int i) { double o[10]; DolphinWeb_UberWaitStats(o); return o[i]; }
int main() {
  int fails = 0;
  auto check = [&](bool ok, const char* what) { if (!ok) { std::fprintf(stderr, "FAIL %s\n", what); fails++; } };
  VertexManagerBase vmb;
  // T = 0: nothing, not even a retrieve
  { MockCache m(1e9, 1); g_shader_cache = &m; DolphinWeb_SetUberWaitMs(0);
    auto r = vmb.WaitForSpecializedPipeline();
    check(!r && m.retrieves == 0, "T=0 does nothing"); }
  // the cap: 80 -> 50 ms; a negative -> 0
  DolphinWeb_SetUberWaitMs(80); check(stat(4) == 50, "cap 50 ms");
  DolphinWeb_SetUberWaitMs(-3); check(stat(4) == 0, "negative -> 0");
  // nothing finishes: the budget (4 ms) is slept through, the no-op flood never wakes it
  { MockCache m(1e9, 1); g_shader_cache = &m; DolphinWeb_SetUberWaitMs(4); vmb.m_uber_wait_frame_us = 0;
    const double t0 = emscripten_get_now();
    auto r = vmb.WaitForSpecializedPipeline();
    const double spent = emscripten_get_now() - t0;
    std::fprintf(stderr, "starved: spent %.2f ms, retrieves %d, no-ops %llu\n", spent, m.retrieves.load(), (unsigned long long)m.noops.load());
    check(!r, "starved: no pipeline");
    check(spent >= 3.5 && spent < 8, "starved: the 4 ms budget, once");
    check(m.retrieves <= 2, "starved: no busy loop (at most 2 retrieves)");
    check(m.noops > 20, "starved: the no-op flood ran");
    // the same frame: the budget is spent, no second wait
    const double t1 = emscripten_get_now();
    vmb.WaitForSpecializedPipeline();
    check(emscripten_get_now() - t1 < 0.5, "same frame: no second wait");
    // the next frame (OnEndFrame resets the budget): it waits again
    vmb.m_uber_wait_frame_us = 0;
    const double t2 = emscripten_get_now();
    vmb.WaitForSpecializedPipeline();
    check(emscripten_get_now() - t2 >= 3.5, "next frame: waits again"); }
  // the shader at +1 ms, the pipeline 1 ms after its retrieve: got in ~2 ms, woken twice
  { MockCache m(emscripten_get_now() + 1, 1); g_shader_cache = &m; DolphinWeb_SetUberWaitMs(4); vmb.m_uber_wait_frame_us = 0;
    const double w0 = stat(6), h0 = stat(3);
    const double t0 = emscripten_get_now();
    auto r = vmb.WaitForSpecializedPipeline();
    const double spent = emscripten_get_now() - t0;
    std::fprintf(stderr, "ready: spent %.2f ms, retrieves %d, wake-ups %.0f\n", spent, m.retrieves.load(), stat(6) - w0);
    check(r && *r != nullptr, "ready: the specialized pipeline");
    check(spent < 3.9, "ready: before the budget");
    check(stat(6) - w0 == 2 && m.retrieves == 3, "ready: two wake-ups, three retrieves");
    check(stat(3) - h0 == 1, "ready: one hit"); }
  return fails;
}
`;
}

sourceContractTest("0225 bounded wait: per-frame budget, 50 ms cap, T = 0 inert, no busy loop", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "uberwait-native-"));
  try {
    const cpp = join(dir, "h.cpp"), exe = join(dir, "h");
    writeFileSync(cpp, harness());
    const c = spawnSync("clang++", ["-std=c++20", "-O1", "-pthread", cpp, "-o", exe], { encoding: "utf8" });
    assert.equal(c.status, 0, c.stderr || c.stdout);
    const r = spawnSync(exe, [], { encoding: "utf8", timeout: 20000 });
    t.diagnostic(r.stderr.trim());
    assert.equal(r.status, 0, r.stderr || r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
