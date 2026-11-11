// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Patch 0225: ?uberwait=T, the hybrid mode's bounded wait (T ms per frame) for
// a specialized pipeline before an ubershader one. 0 or absent: 0223 as is.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const patch = read("patches/dolphin-wasm/snapshot/0225-webgpu-hybrid-bounded-uber-wait.patch");
const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");

test("0225: ?uberwait=T goes URL -> host -> adapter -> worker -> Module -> core, 0 by default", async () => {
  const host = read("src/core-host.js");
  assert.match(host, /this\.uberWaitMs = uberWaitMsOf\(new URLSearchParams\(window\.location\.search\)\.get\("uberwait"\)\);/);
  assert.match(host, /\n {12}uberWaitMs: this\.uberWaitMs,\n/);
  const adapter = read("src/upstream-worker-adapter.js");
  assert.match(adapter, /\n {4}uberWaitMs = 0,\n/);
  assert.match(adapter, /\n {6}uberWaitMs: this\.uberWaitMs,\n/);
  const worker = read("src/upstream-discio-worker.js");
  assert.match(worker, /\n {8}uberWaitMs: payload\.uberWaitMs,\n/);
  assert.match(worker, /\n {2}uberWaitMs = 0,\n/);
  assert.match(worker, /dolphinUberWaitMs: Number\.isInteger\(uberWaitMs\) && uberWaitMs >= 0 && uberWaitMs <= 50 \? uberWaitMs : 0,/);
  const core = read("core/upstream/dolphin_web_core.cpp");
  assert.match(core, /DolphinWeb_SetUberWaitMs\(shader_hybrid \? EM_ASM_INT/);
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  assert.equal(new UpstreamWorkerAdapter({}).uberWaitMs, 0);
  assert.equal(new UpstreamWorkerAdapter({ uberWaitMs: 4 }).uberWaitMs, 4);
  assert.equal(new UpstreamWorkerAdapter({ uberWaitMs: 99 }).uberWaitMs, 0);
});

test("0225: uberWaitMsOf accepts integers 0..50 only", async () => {
  // core-host.js needs a window: read the helper's source and evaluate it alone
  const src = read("src/core-host.js").match(/export function uberWaitMsOf\(value\) \{[\s\S]*?\n\}/)[0].replace("export ", "");
  const uberWaitMsOf = new Function(`${src}; return uberWaitMsOf;`)();
  assert.equal(uberWaitMsOf(null), 0);
  assert.equal(uberWaitMsOf("4"), 4);
  assert.equal(uberWaitMsOf("51"), 0);
  assert.equal(uberWaitMsOf("2.5"), 0);
  assert.equal(uberWaitMsOf("abc"), 0);
});

test("0225 core: the wait only in AsynchronousUberShaders, a per-frame budget, none at T = 0", () => {
  assert.match(added, /if \(!res && g_ActiveConfig\.iShaderCompilationMode == ShaderCompilationMode::AsynchronousUberShaders\)\n\s+res = WaitForSpecializedPipeline\(\);/);
  // budget per frame: reset at the end of a frame; T = 0 (the default): no wait, no early retrieve
  assert.match(added, /\/\/ Patch 0225: the bounded wait's budget is per frame\.\n\s+m_uber_wait_frame_us = 0;/);
  assert.match(added, /const double left_us = budget_us - m_uber_wait_frame_us;\n\s+if \(!\(left_us > 0\)\)\n\s+return std::nullopt;/);
  assert.match(added, /static std::atomic<u32> s_uber_wait_us_budget\{0\};/);
  assert.match(added, /std::clamp\(ms, 0, 50\)/);
  // only an item that did real work wakes the waiting GPU thread (no busy loop on re-queued no-op items)
  assert.match(added, /if \(did_work\)\n\s+\{\n\s+m_real_completions\.fetch_add\(1, std::memory_order_release\);\n\s+m_completed_work_cv\.notify_all\(\);/);
  assert.equal(added.match(/bool DidWork\(\) const override \{ return config\.has_value\(\); \}/g).length, 2);
  assert.match(added, /if \(g_shader_cache->WaitForAsyncCompletion\(seen, \(left_us - spent_us\) \/ 1000\)\)/);
  // the missed wake-up fix: shaders retrieved before pipelines (the native test reproduces the bug)
  assert.match(added, /std::stable_partition\(completed_work\.begin\(\), completed_work\.end\(\),\n\s+\[\]\(const WorkItemPtr& item\) \{ return !item->RetrieveAfterShaders\(\); \}\);/);
  assert.equal(added.match(/bool RetrieveAfterShaders\(\) const override \{ return true; \}/g).length, 2);
  // a hit is a real pipeline; a call that never blocked is not a wait
  assert.match(added, /const bool got = res\.has_value\(\) && \*res != nullptr;\n\s+if \(blocked\)/);
  assert.match(added, /extern "C" EMSCRIPTEN_KEEPALIVE void DolphinWeb_UberWaitStats\(double\* out\)/);
});
