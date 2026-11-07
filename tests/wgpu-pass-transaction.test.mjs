// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

import { selectAtomicReplayLimit } from "../src/wgpu-replay-diagnostics.js";

const BEGIN_PASS = 12;
const END_PASS = 21;

class CommandRingModel {
  constructor(capacity, { read = 0, write = 0 } = {}) {
    this.capacity = capacity;
    this.read = read >>> 0;
    this.write = write >>> 0;
    this.slots = new Array(capacity).fill(null);
    this.releaseStores = 0;
    this.batchAborts = 0;
    this.batchOversize = 0;
  }

  publishBatch(records, { timeout = false, poisoned = false } = {}) {
    const count = records.length;
    if (poisoned) {
      this.batchAborts += 1;
      return false;
    }
    if (count > this.capacity) {
      this.batchAborts += 1;
      this.batchOversize += 1;
      return false;
    }
    if (timeout || ((this.write - this.read) >>> 0) + count > this.capacity) {
      this.batchAborts += 1;
      return false;
    }
    const originalWrite = this.write;
    for (let offset = 0; offset < count; offset += 1) {
      this.slots[(originalWrite + offset) % this.capacity] = records[offset];
    }
    this.write = (originalWrite + count) >>> 0;
    this.releaseStores += 1;
    return true;
  }
}

test("a pass batch wraps without becoming partially visible", () => {
  const ring = new CommandRingModel(8, { read: 4, write: 6 });
  const records = [BEGIN_PASS, 17, 19, END_PASS];

  assert.equal(ring.publishBatch(records), true);
  assert.equal(ring.write, 10);
  assert.equal(ring.releaseStores, 1);
  assert.deepEqual(
    [6, 7, 8, 9].map((index) => ring.slots[index % ring.capacity]),
    records
  );
});

test("the 16K drain budget extends through a 16,385-record pass", () => {
  const count = 16_385;
  const records = new Uint32Array(count).fill(19);
  records[0] = BEGIN_PASS;
  records[count - 1] = END_PASS;
  const ring = new CommandRingModel(32_768);
  assert.equal(ring.publishBatch(records), true);

  const replayLimit = selectAtomicReplayLimit({
    read: 0,
    write: count,
    maxRecords: 16_384,
    opAt: (index) => records[index]
  });
  assert.equal(replayLimit, count);
});

test("the 16K drain budget limits ordinary records without reserving slots", () => {
  const records = new Uint32Array(20_000).fill(6);
  assert.equal(selectAtomicReplayLimit({
    read: 0,
    write: records.length,
    maxRecords: 16_384,
    opAt: (index) => records[index]
  }), 16_384);
});

test("oversize and timeout failures leave write and slots unchanged", () => {
  const oversize = new CommandRingModel(4, { read: 9, write: 9 });
  assert.equal(
    oversize.publishBatch([BEGIN_PASS, 17, 19, 19, END_PASS]),
    false
  );
  assert.equal(oversize.write, 9);
  assert.deepEqual(oversize.slots, [null, null, null, null]);
  assert.equal(oversize.batchAborts, 1);
  assert.equal(oversize.batchOversize, 1);

  const timeout = new CommandRingModel(8, { read: 0, write: 7 });
  assert.equal(timeout.publishBatch([BEGIN_PASS, END_PASS], { timeout: true }), false);
  assert.equal(timeout.write, 7);
  assert.deepEqual(timeout.slots, new Array(8).fill(null));
  assert.equal(timeout.releaseStores, 0);
});

test("a failed required resource publication poisons the whole pass", () => {
  const ring = new CommandRingModel(16);
  const staged = [BEGIN_PASS, 13, 14, 19, END_PASS];
  assert.equal(ring.publishBatch(staged, { poisoned: true }), false);
  assert.equal(ring.write, 0);
  assert.equal(ring.slots.includes(BEGIN_PASS), false);
  assert.equal(ring.slots.includes(END_PASS), false);
  assert.equal(ring.batchAborts, 1);
});

sourceContractTest("producer source stages passes, publishes batches once, and resets cached state on abort", async () => {
  const [header, stream, gfx] = await Promise.all([
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.h",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.cpp",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp",
      import.meta.url
    ), "utf8")
  ]);

  assert.match(header, /std::vector<CmdRecord>\s+m_pass_records/);
  assert.match(header, /bool PushBatch\(const CmdRecord\* records, u32 count\)/);
  assert.match(header, /bool PushBeginPass\(/);
  assert.match(header, /bool PushEndPass\(\)/);
  assert.match(header, /bool PushUploadBuffer\(/);
  assert.match(header, /bool PushUploadTexture\(/);
  assert.match(header, /bool PushSetViewport\(/);
  assert.match(header, /bool PushSetScissor\(/);
  assert.match(header, /bool PushDraw\(/);
  assert.match(header, /bool PushDrawIndexed\(/);

  const batchBody = /bool WebGPUCommandStream::PushBatch\([\s\S]*?\n\}/.exec(stream)?.[0] ?? "";
  assert.match(batchBody, /count > m_capacity/);
  assert.match(batchBody, /m_slots\[\(w \+ i\) % m_capacity\] = records\[i\]/);
  assert.equal((batchBody.match(/m_header->write\.store/g) || []).length, 1);
  assert.match(stream, /m_pass_poisoned = true/);
  assert.match(stream, /m_batch_abort_count|CountBatchAbort\(/);
  assert.match(stream, /m_batch_oversize_count/);
  assert.match(stream, /m_upload_wait_timeouts/);

  assert.match(gfx, /void WebGPUGfx::AbortRecordedPass\((?:GfxAbortSite site)?\)/);
  assert.match(gfx,
    /void WebGPUGfx::AbortRecordedPass\((?:GfxAbortSite site)?\)[\s\S]*?m_cmd_stream\.AbortPass\(\)[\s\S]*?ResetRecordedPassState\(\)/);
  assert.match(gfx,
    /void WebGPUGfx::PresentBackbuffer\(\)[\s\S]*?if \(EndPassIfOpen\(\)[\s\S]*?PushSubmitPresent/);
});

test("worker publishes the actual consumed index and uses 16K only as a work budget", async () => {
  const [worker, runtime] = await Promise.all([
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../src/wgpu-renderer-runtime.js", import.meta.url), "utf8"),
  ]);
  const publishBody = /function publishWgpuReadIndex\([\s\S]*?\n\}/.exec(worker)?.[0] ?? "";
  const runtimePublishBody = /publishReadIndex\(readIndex\) \{[\s\S]*?\n  \}/
    .exec(runtime)?.[0] ?? "";

  assert.match(publishBody, /wgpuRendererRuntime\.publishReadIndex\(readIndex\)/);
  assert.match(runtimePublishBody, /publishWgpuRingProgress\(this\.ring, 1, normalized\)/);
  assert.doesNotMatch(publishBody, /capacity\s*-\s*WGPU_REPLAY_WINDOW_RECORDS/);
  assert.match(worker,
    /selectAtomicReplayLimit\(\{[\s\S]*?maxRecords:\s*WGPU_REPLAY_WINDOW_RECORDS/);
});

sourceContractTest("buffer uploads carry stable producer roles without widening the wire record", async () => {
  const [header, stream, gfxHeader, gfx, vertex] = await Promise.all([
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.h",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.cpp",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.h",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp",
      import.meta.url
    ), "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUVertexManager.cpp",
      import.meta.url
    ), "utf8"),
  ]);

  assert.match(header, /enum class BufferUploadRole : u32[\s\S]*?Unknown = 0,[\s\S]*?Ubo = 1,[\s\S]*?Utility = 2,[\s\S]*?Vertex = 3,[\s\S]*?Index = 4,[\s\S]*?TextureAdjacent = 5,[\s\S]*?Geometry = 6,[\s\S]*?Count = 7/);
  assert.match(header, /static_assert\(sizeof\(CmdRecord\) == 32/);
  assert.match(header, /PushUploadBuffer\([\s\S]*?BufferUploadRole role\)/);
  assert.match(stream, /rec\.arg\.u\[4\] = static_cast<u32>\(role\)/);
  assert.match(vertex, /PushUploadBuffer\([\s\S]*?BufferUploadRole::Vertex\)/);
  assert.match(vertex, /PushUploadBuffer\([\s\S]*?BufferUploadRole::Index\)/);
  assert.match(gfxHeader, /AllocUboSlice\([\s\S]*?BufferUploadRole role\)/);
  assert.match(gfx, /AllocUboSlice\([\s\S]*?BufferUploadRole::Ubo\)/);
  assert.match(gfx, /UploadUtilityUniforms\([\s\S]*?BufferUploadRole::Utility/);
});
