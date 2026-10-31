// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  createWgpuMappedStagingPool,
  writeOversizeWgpuUpload,
} from "../src/wgpu-mapped-staging-pool.js";

// A device whose queue keeps the queue timeline: submit runs the copies of its
// command buffers, writeBuffer writes at once; both land in `memory`.
function createTimeline() {
  const memory = new Uint8Array(256);
  const destination = { name: "vertex buffer" };
  const log = [];
  const device = {
    lost: new Promise(() => {}),
    createBuffer(descriptor) {
      const storage = new ArrayBuffer(descriptor.size);
      return {
        storage,
        getMappedRange: () => storage,
        unmap() {},
        mapAsync: () => new Promise(() => {}),
        destroy() {},
      };
    },
    createCommandEncoder() {
      const copies = [];
      return {
        copyBufferToBuffer(source, sourceOffset, target, targetOffset, size) {
          copies.push({ source, sourceOffset, target, targetOffset, size });
        },
        finish: () => ({ copies }),
      };
    },
  };
  const queue = {
    submit(buffers) {
      for (const { copies } of buffers) {
        for (const c of copies) {
          assert.equal(c.target, destination);
          memory.set(new Uint8Array(c.source.storage, c.sourceOffset, c.size), c.targetOffset);
          log.push(`copy@${c.targetOffset}+${c.size}`);
        }
      }
    },
    writeBuffer(target, offset, data) {
      assert.equal(target, destination);
      memory.set(data, offset);
      log.push(`write@${offset}+${data.byteLength}`);
    },
  };
  const pool = createWgpuMappedStagingPool({
    device, slotCount: 2, slotSize: 64, bufferUsage: 0x0006, mapMode: 0x0002,
  });
  const submitPending = () => {
    const batch = pool.seal();
    if (batch) {
      queue.submit([batch.commandBuffer]);
      pool.acceptSubmission(batch);
    }
    return true;
  };
  return { memory, destination, log, queue, pool, submitPending };
}

test("an oversize upload is written after the batch staged before it, and before the next one", () => {
  const tl = createTimeline();
  const { pool, destination, queue } = tl;
  // Staged first: 4 bytes at offset 0.
  assert.equal(pool.stageBuffer({ data: Uint8Array.of(1, 1, 1, 1), destination }).ok, true);
  // Larger than a 64-byte slot: refused by the pool, written by the queue.
  const big = new Uint8Array(128).fill(2);
  const refused = pool.stageBuffer({ data: big, destination });
  assert.equal(refused.reason, "payload-too-large");
  assert.equal(writeOversizeWgpuUpload({
    inPass: false,
    submitPending: tl.submitPending,
    write: () => queue.writeBuffer(destination, 0, big),
  }), true);
  // Staged after: 4 bytes at offset 4.
  assert.equal(pool.stageBuffer({ data: Uint8Array.of(3, 3, 3, 3), destination, destinationOffset: 4 }).ok, true);
  tl.submitPending();

  assert.deepEqual(tl.log, ["copy@0+4", "write@0+128", "copy@4+4"]);
  // Program order: 1s then 2s over [0,128) then 3s over [4,8).
  assert.deepEqual([...tl.memory.subarray(0, 10)], [2, 2, 2, 2, 3, 3, 3, 3, 2, 2]);
});

test("without the submit first, the queue write would land under the earlier staged bytes", () => {
  // The hazard the helper exists for: writing straight away runs the write
  // before the copy still waiting in the unsubmitted batch.
  const tl = createTimeline();
  const { pool, destination, queue } = tl;
  pool.stageBuffer({ data: Uint8Array.of(1, 1, 1, 1), destination });
  queue.writeBuffer(destination, 0, new Uint8Array(128).fill(2));
  tl.submitPending();
  assert.deepEqual([...tl.memory.subarray(0, 4)], [1, 1, 1, 1]);
});

test("inside a render pass the oversize upload is refused and nothing is submitted", () => {
  let calls = 0;
  assert.equal(writeOversizeWgpuUpload({
    inPass: true,
    submitPending: () => { calls += 1; return true; },
    write: () => { calls += 10; },
  }), false);
  assert.equal(calls, 0);
});

test("a failed submission writes nothing", () => {
  let writes = 0;
  assert.equal(writeOversizeWgpuUpload({
    inPass: false,
    submitPending: () => false,
    write: () => { writes += 1; },
  }), false);
  assert.equal(writes, 0);
});
