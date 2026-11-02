// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { wgpuAdapterProblem } from "../src/wgpu-adapter-check.js";

const gpuGiving = (value) => ({ requestAdapter: async () => value });
// A timer that fires at once, so the "no answer" case needs no real wait.
const instant = { setTimer: (fn) => { queueMicrotask(fn); return 1; }, clearTimer: () => {} };

test("a navigator.gpu that answers null (a blocklist) is no adapter", async () => {
  assert.equal(await wgpuAdapterProblem({ gpu: gpuGiving(null) }), "no-adapter");
});

test("every way video=wgpu cannot run is named", async () => {
  assert.equal(await wgpuAdapterProblem({ gpu: undefined }), "no-webgpu");
  assert.equal(await wgpuAdapterProblem({ gpu: {} }), "no-webgpu");
  assert.equal(await wgpuAdapterProblem({ gpu: { requestAdapter: async () => { throw new Error("blocked"); } } }), "adapter-error");
  assert.equal(await wgpuAdapterProblem({ gpu: { requestAdapter: () => new Promise(() => {}) }, ...instant }), "adapter-timeout");
  assert.equal(await wgpuAdapterProblem({ gpu: gpuGiving({ isFallbackAdapter: true }) }), "fallback-adapter");
  assert.equal(await wgpuAdapterProblem({ gpu: gpuGiving({ info: { architecture: "swiftshader" } }) }), "fallback-adapter");
});

test("a real adapter, or a CPU one the harness accepts, is no problem", async () => {
  assert.equal(await wgpuAdapterProblem({ gpu: gpuGiving({ info: { vendor: "apple", architecture: "metal-3" } }) }), null);
  assert.equal(await wgpuAdapterProblem({ gpu: gpuGiving({ isFallbackAdapter: true }), acceptFallback: true }), null);
});

test("the power preference reaches requestAdapter", async () => {
  let asked = null;
  await wgpuAdapterProblem({ gpu: { requestAdapter: async (o) => { asked = o; return {}; } }, powerPreference: "low-power" });
  assert.deepEqual(asked, { powerPreference: "low-power" });
});

test("the host checks the adapter before the core loads, falls back to software and says why", async () => {
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  // before mountGame (which loads the worker), never after
  assert.match(host, /await this\.fallBackWithoutWgpuAdapter\(\);\n\s+const mounted = await this\.adapter\.mountGame\(file\);/);
  assert.match(host, /this\.applyVideoBackend\("Software Renderer"\);\n\s+this\.videoFallback = \{ from: "WebGPU-Real", to: "Software Renderer", reason: problem \};/);
  // the detached presenter cannot switch: an explicit error, never a silent wait
  assert.match(host, /if \(this\.usesDetachedWgpu\) \{\n\s+throw new Error\(`video=wgpu needs a usable WebGPU adapter/);
  // the reason reaches the frame info
  assert.match(host, /videoFallback: this\.videoFallback \?\? null,/);
});
