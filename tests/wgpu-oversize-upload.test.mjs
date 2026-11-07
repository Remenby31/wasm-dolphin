// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  createWgpuMappedStagingPool,
  queueWgpuUploadReason,
  writeWgpuUploadThroughQueue,
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
  assert.equal(writeWgpuUploadThroughQueue({
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

test("inside a pass, an upload with no free slot is written after the batch staged before it", () => {
  // Both slots full: a pass cannot wait for a remap.
  const tl = createTimeline();
  const { pool, destination, queue } = tl;
  assert.equal(pool.stageBuffer({ data: new Uint8Array(64).fill(1), destination }).ok, true);
  assert.equal(pool.stageBuffer({ data: new Uint8Array(64).fill(4), destination, destinationOffset: 64 }).ok, true);
  const late = new Uint8Array(8).fill(5);
  const refused = pool.stageBuffer({ data: late, destination, destinationOffset: 60 });
  assert.equal(refused.reason, "no-capacity");
  assert.equal(queueWgpuUploadReason(refused.reason, true), "pass-capacity");
  assert.equal(writeWgpuUploadThroughQueue({
    submitPending: tl.submitPending,
    write: () => queue.writeBuffer(destination, 60, late),
  }), true);
  assert.deepEqual(tl.log, ["copy@0+64", "copy@64+64", "write@60+8"]);
  assert.deepEqual([...tl.memory.subarray(58, 70)], [1, 1, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4]);
});

test("the queue takes oversize uploads anywhere and full slots only inside a pass", () => {
  assert.equal(queueWgpuUploadReason("payload-too-large", false), "oversize");
  assert.equal(queueWgpuUploadReason("payload-too-large", true), "oversize");
  assert.equal(queueWgpuUploadReason("no-capacity", true), "pass-capacity");
  assert.equal(queueWgpuUploadReason("no-capacity", false), null);
  assert.equal(queueWgpuUploadReason("pool-failed", true), null);
  assert.equal(queueWgpuUploadReason(null, true), null);
});

test("a failed submission writes nothing", () => {
  let writes = 0;
  assert.equal(writeWgpuUploadThroughQueue({
    submitPending: () => false,
    write: () => { writes += 1; },
  }), false);
  assert.equal(writes, 0);
});
