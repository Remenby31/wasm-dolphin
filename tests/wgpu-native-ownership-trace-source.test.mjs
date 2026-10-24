// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

sourceContractTest("native ownership trace keeps a separate fixed ABI and explicit allocation gate", async () => {
  const [header, source] = await Promise.all([
    read("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.h"),
    read("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.cpp"),
  ]);

  assert.match(header, /static_assert\(sizeof\(CmdRecord\) == 32/);
  assert.match(header, /static_assert\(sizeof\(CmdRingHeader\) == 28/);
  assert.match(header, /static_assert\(sizeof\(OwnershipTraceHeader\) == 20/);
  assert.match(header, /static_assert\(sizeof\(OwnershipTraceRecord\) == 32/);
  assert.match(header, /std::atomic<bool> m_trace_enabled\{false\}/);
  assert.match(header, /CaptureEnd = 11/);
  assert.match(header, /m_trace_capture_waiting_ack\{0\}/);

  const ensureCalls = source.match(/EnsureOwnershipTrace\(\)/g) ?? [];
  assert.equal(ensureCalls.length, 2, "only the definition and explicit setter may allocate");
  assert.match(
    source,
    /SetOwnershipTraceEnabled\(bool enabled\)[\s\S]*?EnsureOwnershipTrace\(\)[\s\S]*?m_trace_enabled\.store\(true/
  );
  assert.doesNotMatch(source, /webgpu-ownership-trace-ring/);
  const ensureBody = /void WebGPUCommandStream::EnsureOwnershipTrace\(\)[\s\S]*?\n\}/
    .exec(source)?.[0] ?? "";
  assert.doesNotMatch(ensureBody, /EM_ASM|postMessage/);
  assert.match(header, /u32 GetOwnershipTracePtr\(\) const/);
  assert.match(header, /u32 GetOwnershipTraceCapacity\(\) const/);
  assert.match(source, /kOwnershipTraceCapacity = 131072/);
  assert.match(source, /m_trace_header->epoch\.store\(m_trace_epoch/);
  assert.match(
    source,
    /PushSubmitPresent\(\)[\s\S]*?if \(!Push\(rec\)\)[\s\S]*?m_trace_active_transaction = 0;[\s\S]*?FinishOwnershipTraceCapture\(\)/
  );
  assert.match(
    source,
    /FinishOwnershipTraceCapture\(\)[\s\S]*?OwnershipTraceEvent::CaptureEnd[\s\S]*?m_trace_capture_waiting_ack\.store[\s\S]*?m_trace_enabled\.store\(false/
  );
  assert.match(
    source,
    /load_requests != 0[\s\S]*?m_pass_staging[\s\S]*?m_trace_pending_boundaries\.fetch_add[\s\S]*?return;[\s\S]*?OwnershipTraceEvent::LoadRequested/,
    "a load boundary must wait until the current ownership transaction is quiescent"
  );
  assert.match(source, /Push\(const CmdRecord& rec\)[\s\S]*?WaitForOwnershipTraceCaptureAck\(\)/);
  assert.match(source, /PushBatch\([\s\S]*?WaitForOwnershipTraceCaptureAck\(\)/);
});

sourceContractTest("native ownership trace records transaction outcomes without widening replay commands", async () => {
  const [source, vertexManager] = await Promise.all([
    read("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.cpp"),
    read("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUVertexManager.cpp"),
  ]);

  assert.match(source, /TraceCommand\(rec\);[\s\S]*?return true;/);
  assert.match(source, /BeginPendingOwnership\(\)/);
  assert.match(vertexManager, /CommitBuffer[\s\S]*?cs\.BeginPendingOwnership\(\)/);
  assert.match(source, /OwnershipTraceEvent::PendingReserved/);
  assert.match(
    source,
    /BeginPendingOwnership\(\)[\s\S]*?m_pass_staging \|\| m_trace_active_transaction != 0/,
    "an active pass must not reserve a mislabeled successor transaction"
  );
  assert.match(source, /OwnershipTraceEvent::PassBegin/);
  assert.match(source, /OwnershipTraceEvent::Commit/);
  assert.match(source, /OwnershipTraceEvent::Abort/);
  assert.match(source, /OwnershipTraceEvent::Poison/);
  assert.match(source, /OwnershipTraceEvent::Rollback/);
  assert.match(source, /OwnershipTraceEvent::ConsumerFailure/);
  assert.match(source, /OwnershipAttribution::Pending/);
  assert.match(source, /OwnershipAttribution::Active/);
  assert.match(source, /OwnershipAttribution::Outside/);
  assert.match(source, /record\.resource_id = detail0/);
  assert.match(source, /record\.payload_length = detail1/);
  assert.match(
    source,
    /case CmdOp::BeginPass:[\s\S]*?resource_id = rec\.arg\.u\[0\]/,
    "BeginPass must correlate its framebuffer id with the legacy semantic decoder"
  );
  assert.match(source, /publication << 8/);
  // At least release (patch 0148 makes it seq_cst, for the parked-consumer
  // wake: publish, then read the parked flag).
  assert.match(source, /m_header->write\.store\(w \+ count, std::memory_order_(release|seq_cst)\)/);
});

sourceContractTest("the applied save callback publishes the ownership epoch before GPU wake", async () => {
  const [wrapper, gfx, cmake] = await Promise.all([
    read("core/upstream/dolphin_web_core.cpp"),
    read("vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp"),
    read("vendor/dolphin/Source/Core/Core/CMakeLists.txt"),
  ]);

  assert.match(gfx, /SetWebGpuOwnershipTraceEnabled\(int enabled\)/);
  assert.match(gfx, /AcknowledgeWebGpuOwnershipTraceCapture\(u32 capture_id\)/);
  assert.match(gfx, /GetWebGpuOwnershipTracePtr\(\)/);
  assert.match(gfx, /GetWebGpuOwnershipTraceCapacity\(\)/);
  assert.match(gfx, /NotifyWebGpuOwnershipTraceLoadRequested\(\)/);
  assert.equal(
    wrapper.match(/^    NotifyWebGpuOwnershipTraceLoadRequested\(\);/gm)?.length,
    1
  );
  const callback = wrapper.indexOf("State::SetOnAfterLoadCallback");
  const checkpoint = wrapper.indexOf(
    "s_last_loaded_checkpoint_generation.fetch_add",
    callback
  );
  const ownershipBoundary = wrapper.indexOf(
    "NotifyWebGpuOwnershipTraceLoadRequested();",
    callback
  );
  const gpuWake = wrapper.indexOf("fifo.EmulatorState(true)", callback);
  assert.ok(
    callback >= 0 && checkpoint > callback && ownershipBoundary > checkpoint &&
      gpuWake > ownershipBoundary,
    "the load checkpoint must become visible before the trace boundary and GPU wake"
  );
  const loadEntryPoints = wrapper.slice(wrapper.indexOf("int LoadCoreState"));
  assert.doesNotMatch(
    loadEntryPoints,
    /NotifyWebGpuOwnershipTraceLoadRequested\(\);[\s\S]*?State::Load/
  );
  assert.match(cmake, /'_SetWebGpuOwnershipTraceEnabled'/);
  assert.match(cmake, /'_AcknowledgeWebGpuOwnershipTraceCapture'/);
  assert.match(cmake, /'_GetWebGpuOwnershipTracePtr'/);
  assert.match(cmake, /'_GetWebGpuOwnershipTraceCapacity'/);
  assert.doesNotMatch(wrapper, /LoadBoundary/);
});

test("locked native ownership patch replays the source contract", async () => {
  const [patch, appliedBoundaryPatch] = await Promise.all([
    read("patches/dolphin-wasm/snapshot/0039-webgpu-native-ownership-trace.patch"),
    read("patches/dolphin-wasm/snapshot/0040-webgpu-applied-load-boundary.patch"),
  ]);
  assert.match(patch, /OwnershipTraceHeader/);
  assert.match(patch, /ownership trace header must stay 20 bytes/);
  assert.match(patch, /SetWebGpuOwnershipTraceEnabled/);
  assert.match(patch, /AcknowledgeWebGpuOwnershipTraceCapture/);
  assert.match(patch, /OwnershipTraceEvent::CaptureEnd/);
  assert.match(patch, /GetWebGpuOwnershipTracePtr/);
  assert.match(patch, /GetWebGpuOwnershipTraceCapacity/);
  assert.match(patch, /LoadRequested/);
  assert.match(appliedBoundaryPatch, /m_trace_pending_boundaries\.fetch_add/);
  assert.match(appliedBoundaryPatch, /m_pass_staging/);
});
