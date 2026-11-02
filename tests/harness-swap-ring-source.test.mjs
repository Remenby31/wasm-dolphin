// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Patch 0214 (harness pipeline diag): the swap ring costs nothing without the
// harness, and the FIFO lag is read in patch 0211's order.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { readVendorFileSync, sourceContractTest, vendorSourceRoot } from "./helpers/source-contract.mjs";

const root = join(import.meta.dirname, "..");
const discio = readFileSync(join(root, "core/upstream/dolphin_web_discio.cpp"), "utf8");
const patch = readFileSync(join(root, "patches/dolphin-wasm/snapshot/0214-harness-swap-ring.patch"), "utf8");
const videoBackend = readVendorFileSync(join(vendorSourceRoot, "VideoCommon/VideoBackendBase.cpp"));
const fifo = readVendorFileSync(join(vendorSourceRoot, "VideoCommon/Fifo.cpp"));
const present = readVendorFileSync(join(vendorSourceRoot, "VideoCommon/Present.cpp"));

// The body of the C++ function `name` (from its signature to the matching brace).
function body(source, signature) {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `${signature} not found`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${signature}: unbalanced braces`);
}

test("swap ring: nothing is written unless the harness hooks AND the swap ring are on", () => {
  const enabled = body(discio, "int DolphinWeb_HarnessSwapsEnabled()");
  assert.match(enabled, /s_harness_enabled\.load\(std::memory_order_relaxed\) &&\s+s_harness_swaps_enabled\.load/);
  const record = body(discio, "void DolphinWeb_HarnessRecordSwap(");
  // the first statement: the gate
  assert.match(record, /^\{\s+if \(!DolphinWeb_HarnessSwapsEnabled\(\)\)\s+return;/);
  // the ring is written in that function only
  assert.equal(discio.match(/s_harness_swap_ring\[/g).length, 1);
  assert.equal(discio.match(/s_harness_swap_head\.store\(/g).length, 1);
});

test("swap ring: the entry layout the JS reader expects (32 bytes, unknown = UINT32_MAX)", () => {
  assert.match(discio, /struct DolphinWebHarnessSwapEntry\s*\{\s*std::atomic<std::uint32_t> seq;\s*std::uint32_t vi_since_boot;\s*double host_ms;\s*std::uint32_t behind_chunks;\s*std::uint32_t fifo_bytes;\s*std::uint32_t flags;\s*std::uint32_t pad;\s*\};/);
  assert.match(discio, /static_assert\(sizeof\(DolphinWebHarnessSwapEntry\) == 32/);
  assert.match(patch, /constexpr u32 UNKNOWN = 0xFFFFFFFFu;/);
});

test("patch 0214: the recorded swap only under the harness flag; the plain swap otherwise", () => {
  // the flag is read on the CPU thread at the VI, under the harness hooks
  assert.match(patch, /\+\s+const bool harness_swaps = harness_tag && DolphinWeb_HarnessSwapsEnabled\(\) != 0;/);
  // the lambda: the recorded swap behind the flag, then return; else ViSwap
  assert.match(patch, /\+\s+if \(harness_swaps\)\n\+\s+\{\n\+\s+HarnessRecordedViSwap\([^;]+;\n\+\s+return;\n\+\s+\}/);
});

sourceContractTest("patch 0214: the swap ring is written from the recorded swap only, itself called only under harness_swaps", () => {
  assert.equal(videoBackend.match(/DolphinWeb_HarnessRecordSwap\(/g).length, 2, "the declaration and one call");
  assert.match(body(videoBackend, "static void HarnessRecordedViSwap("), /DolphinWeb_HarnessRecordSwap\(/);
  const calls = [...videoBackend.matchAll(/HarnessRecordedViSwap\(/g)].map((m) => m.index);
  assert.equal(calls.length, 2, "the definition and one call");
  const before = videoBackend.slice(Math.max(0, calls[1] - 200), calls[1]);
  assert.match(before, /if \(harness_swaps\)\s*\{\s*$/);
  // without the flag, nothing new on the GPU thread: no clock, no FIFO read
  const lambda = videoBackend.slice(videoBackend.indexOf("AsyncRequests::GetInstance()->PushEvent([=] {"), calls[1]);
  assert.doesNotMatch(lambda, /emscripten_get_now|GpuChunksConsumed/);
});

sourceContractTest("patch 0214: the FIFO lag is read in 0211's order, consumed first, then the distance, in one place", () => {
  const both = body(fifo, "FifoManager::GpuCatchUp FifoManager::GpuCatchUpTargetAndDistance() const");
  const consumed = both.indexOf("m_gpu_chunks_consumed.load(");
  const distance = both.indexOf("CPReadWriteDistance.load(");
  assert.ok(consumed > 0 && distance > consumed, "consumed counter first, then the distance");
  assert.match(both, /the race 0211 fixed comes back/);
  assert.match(body(fifo, "u64 FifoManager::GpuCatchUpTarget() const"), /^\{\s+return GpuCatchUpTargetAndDistance\(\)\.target;\s+\}$/);
  // the target is computed in that one place: no second read order
  assert.equal(fifo.match(/m_gpu_chunks_consumed\.load\(/g)?.length ?? 0, 1);
  // ViSwap reports a duplicate (no new picture) to the recorded swap
  assert.match(present, /bool Presenter::ViSwap\(/);
  assert.match(body(present, "bool Presenter::ViSwap("), /return is_duplicate;\s*\}$/);
});
