// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// video=wgpu needs a WebGPU adapter. Without one the worker refuses to start
// the core (upstream-discio-worker.js), and a page that asked for wgpu by URL
// waited with no picture and no reason (Firefox's WebGPU blocklist,
// 2026-11-02). The host asks for an adapter before it starts the worker and,
// when there is none, boots the precise (software) renderer instead and says
// why. Salon's own preflight already does the same choice (renderer.ts
// chooseRenderer, reason "no-adapter"); this covers forced URLs and the demo.

export const WGPU_ADAPTER_CHECK_TIMEOUT_MS = 4000;

// Why video=wgpu cannot run here, or null when an adapter answered:
//   "no-webgpu"        navigator.gpu is missing
//   "no-adapter"       requestAdapter() gave null (blocklist, no GPU)
//   "adapter-error"    requestAdapter() threw
//   "adapter-timeout"  no answer within timeoutMs
//   "fallback-adapter" a CPU adapter (SwiftShader), unless acceptFallback
export async function wgpuAdapterProblem({
  gpu = globalThis.navigator?.gpu,
  powerPreference = "high-performance",
  timeoutMs = WGPU_ADAPTER_CHECK_TIMEOUT_MS,
  acceptFallback = false,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id)
} = {}) {
  if (!gpu || typeof gpu.requestAdapter !== "function") return "no-webgpu";
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimer(() => resolve("timeout"), timeoutMs); });
  let adapter;
  try {
    adapter = await Promise.race([gpu.requestAdapter({ powerPreference }), timeout]);
  } catch {
    return "adapter-error";
  } finally {
    clearTimer(timer);
  }
  if (adapter === "timeout") return "adapter-timeout";
  if (!adapter) return "no-adapter";
  const cpu = adapter.isFallbackAdapter === true || adapter.info?.isFallbackAdapter === true ||
    adapter.info?.architecture === "swiftshader";
  if (cpu && !acceptFallback) return "fallback-adapter";
  return null;
}
