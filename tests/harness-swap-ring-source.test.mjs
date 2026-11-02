// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Patch 0214 (harness pipeline diag): the swap ring costs nothing without the
// harness, and the FIFO lag is read in patch 0211's order. Mode off (no
// harness, or the harness without { pipeline: true }) is the same core code
// as main: no static data is added (the ring is allocated at the first
// enable), so the region translator's output is byte for byte main's, which
// tests/regshape-x64.test.mjs ("mode off translates byte for byte as before
// 0184", a digest over translated code that embeds static addresses) checks
// on the CI core.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  // the ring is written in that function only, and only once allocated
  assert.match(record, /DolphinWebHarnessSwapEntry\* ring = s_harness_swap_ring\.load\(std::memory_order_acquire\);\s+if \(!ring\)\s+return;/);
  assert.equal(discio.match(/ring\[head % HARNESS_SWAP_RING_CAPACITY\]/g).length, 1);
  // no static array: allocated at the first enable, before the flag is released
  assert.doesNotMatch(discio, /std::array<DolphinWebHarnessSwapEntry/);
  const enable = body(discio, "void DolphinWeb_HarnessSwapsEnable(int enabled)");
  assert.ok(enable.indexOf("new DolphinWebHarnessSwapEntry[") < enable.indexOf("s_harness_swaps_enabled.store("), "the ring before the flag");
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

const worker = readFileSync(join(root, "src/upstream-discio-worker.js"), "utf8");

test("worker: the ring's address is read at each timeline read, after the enable, never kept; null is no ring", () => {
  const read = body(worker, "function readHarnessTimeline()");
  // the address comes from the core inside the read, and a null one is "no ring"
  assert.match(read, /!m\._DolphinWeb_HarnessSwapRing\(\) \? "swap ring not allocated yet/);
  assert.match(read, /ptr: m\._DolphinWeb_HarnessSwapRing\(\),/);
  // no copy of the address anywhere else in the worker
  assert.equal(worker.match(/_DolphinWeb_HarnessSwapRing\(\)/g).length, 2);
  assert.doesNotMatch(worker, /=\s*(moduleInstance|m)\??\._DolphinWeb_HarnessSwapRing\(\)/);
  // no ring: swaps null (the analysis then has no swaps: pipeline false), never zeros
  assert.match(read, /let swaps = null;\s+if \(!swapsWhy\)/);
});

// The ring's own functions compiled natively, as the core has them:
// enable -> disable -> enable keeps one allocation; nothing is written before
// the flag, nor with the harness hooks off.
const compilerOk = spawnSync("clang++", ["--version"], { encoding: "utf8" }).status === 0;
test("swap ring, native: allocated once; enable -> disable -> enable keeps the address; no write before the flag", { skip: compilerOk ? false : "requires clang++" }, () => {
  const from = discio.indexOf("struct DolphinWebHarnessSwapEntry");
  const end = discio.indexOf("\n", discio.indexOf("DolphinWeb_HarnessSwapRingHead()"));
  assert.ok(from > 0 && end > from, "swap ring seam");
  const dir = mkdtempSync(join(tmpdir(), "swap-ring-"));
  try {
    writeFileSync(join(dir, "main.cpp"), String.raw`
#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#define EMSCRIPTEN_KEEPALIVE
static std::atomic<int> s_harness_enabled{0};
${discio.slice(from, end)}
int main() {
  int fail = 0;
#define CHECK(c) do { if (!(c)) { std::printf("FAIL %d: %s\n", __LINE__, #c); fail = 1; } } while (0)
  s_harness_enabled = 1;
  CHECK(DolphinWeb_HarnessSwapRing() == nullptr);
  DolphinWeb_HarnessRecordSwap(1, 1.0, 0, 0, 1);  // before any enable: nothing
  CHECK(DolphinWeb_HarnessSwapRingHead() == 0);
  DolphinWeb_HarnessSwapsEnable(1);
  DolphinWebHarnessSwapEntry* first = DolphinWeb_HarnessSwapRing();
  CHECK(first != nullptr);
  CHECK(first[0].seq.load() == 0);
  DolphinWeb_HarnessRecordSwap(7, 2.0, 3, 96, 1);
  CHECK(DolphinWeb_HarnessSwapRingHead() == 1);
  CHECK(first[0].seq.load() == 2 && first[0].vi_since_boot == 7 && first[0].behind_chunks == 3 && first[0].fifo_bytes == 96 && first[0].flags == 1);
  DolphinWeb_HarnessSwapsEnable(0);
  DolphinWeb_HarnessRecordSwap(8, 3.0, 0, 0, 1);  // disabled: nothing
  CHECK(DolphinWeb_HarnessSwapRingHead() == 1);
  CHECK(DolphinWeb_HarnessSwapRing() == first);
  DolphinWeb_HarnessSwapsEnable(1);
  CHECK(DolphinWeb_HarnessSwapRing() == first);  // reused, never reallocated
  s_harness_enabled = 0;
  DolphinWeb_HarnessRecordSwap(9, 4.0, 0, 0, 1);  // harness hooks off: nothing
  CHECK(DolphinWeb_HarnessSwapRingHead() == 1);
  s_harness_enabled = 1;
  DolphinWeb_HarnessRecordSwap(9, 4.0, 0xFFFFFFFFu, 0xFFFFFFFFu, 3);
  CHECK(DolphinWeb_HarnessSwapRingHead() == 2 && first[1].seq.load() == 4 && first[1].behind_chunks == 0xFFFFFFFFu);
  return fail;
}
`);
    const exe = join(dir, "ring");
    const c = spawnSync("clang++", ["-std=c++20", "-Wall", "-Werror", "-Wno-unused-function", join(dir, "main.cpp"), "-o", exe], { encoding: "utf8" });
    assert.equal(c.status, 0, c.stderr);
    const r = spawnSync(exe, { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
