// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  attemptRetainedWgpuUpload,
  createWgpuMappedStagingPool,
  submitWgpuUploadBeforeRender,
} from "../src/wgpu-mapped-staging-pool.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createFakeDevice() {
  const lost = deferred();
  const buffers = [];
  const encoders = [];
  const device = {
    lost: lost.promise,
    createBuffer(descriptor) {
      const maps = [];
      const storage = new ArrayBuffer(descriptor.size);
      const buffer = {
        descriptor,
        storage,
        maps,
        unmaps: 0,
        destroys: 0,
        getMappedRange: () => storage,
        unmap() { this.unmaps += 1; },
        mapAsync(mode) {
          const operation = deferred();
          maps.push({ mode, operation });
          return operation.promise;
        },
        destroy() { this.destroys += 1; },
      };
      buffers.push(buffer);
      return buffer;
    },
    createCommandEncoder(descriptor) {
      const copies = [];
      const commandBuffer = { kind: "upload", copies };
      const encoder = {
        descriptor,
        copies,
        copyBufferToBuffer(...args) { copies.push(["buffer", ...args]); },
        copyBufferToTexture(...args) { copies.push(["texture", ...args]); },
        finish() { return commandBuffer; },
      };
      encoders.push(encoder);
      return encoder;
    },
  };
  return { device, lost, buffers, encoders };
}

function createPool(fake, options = {}) {
  return createWgpuMappedStagingPool({
    device: fake.device,
    slotCount: 2,
    slotSize: 1024,
    bufferUsage: 0x0006,
    mapMode: 0x0002,
    now: () => 100,
    ...options,
  });
}

test("creates a fixed mapped-at-creation pool and preserves aligned buffer bytes", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 2, slotSize: 32 });
  assert.equal(fake.buffers.length, 2);
  assert.deepEqual(fake.buffers[0].descriptor, {
    label: "Dolphin mapped upload staging 0",
    size: 32,
    usage: 0x0006,
    mappedAtCreation: true,
  });

  assert.deepEqual(pool.stageBuffer({
    data: Uint8Array.of(1, 2, 3, 4), destination: { name: "a" }, alignment: 16,
  }), { ok: true, slot: 0, offset: 0, logicalBytes: 4, stagedBytes: 4 });
  assert.deepEqual(pool.stageBuffer({
    data: Uint8Array.of(5, 6, 7, 8), destination: { name: "b" }, alignment: 16,
  }), { ok: true, slot: 0, offset: 16, logicalBytes: 4, stagedBytes: 4 });
  assert.deepEqual([...new Uint8Array(fake.buffers[0].storage).slice(0, 20)], [
    1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 6, 7, 8,
  ]);

  const batch = pool.seal();
  assert.equal(batch.oldestPendingAtMs, 100);
  const copies = batch.commandBuffer.copies;
  assert.equal(copies.length, 2);
  assert.deepEqual(copies.map((copy) => [copy[0], copy[2], copy[4], copy[5]]), [
    ["buffer", 0, 0, 4],
    ["buffer", 16, 0, 4],
  ]);
});

test("positional buffer staging preserves object-path bytes, offsets, and metrics", () => {
  const controlFake = createFakeDevice();
  const fastFake = createFakeDevice();
  const control = createPool(controlFake, { slotCount: 1, slotSize: 64 });
  const fast = createPool(fastFake, { slotCount: 1, slotSize: 64 });
  const backing = Uint8Array.of(99, 1, 2, 3, 4, 88);
  const bytes = backing.subarray(1, 5);
  const controlDestination = { name: "control" };
  const fastDestination = { name: "fast" };

  const controlResult = control.stageBuffer({
    data: bytes,
    destination: controlDestination,
    destinationOffset: 12,
    alignment: 16,
  });
  const fastResult = fast.stageBufferFast(bytes, fastDestination, 12, 16);

  assert.equal(fastResult, null);
  assert.equal(controlResult.ok, true);
  assert.deepEqual(
    [...new Uint8Array(fastFake.buffers[0].storage)],
    [...new Uint8Array(controlFake.buffers[0].storage)]
  );
  assert.deepEqual(fast.snapshot(), control.snapshot());
  const controlCopy = control.seal().commandBuffer.copies[0];
  const fastCopy = fast.seal().commandBuffer.copies[0];
  assert.deepEqual(
    [fastCopy[0], fastCopy[2], fastCopy[4], fastCopy[5]],
    [controlCopy[0], controlCopy[2], controlCopy[4], controlCopy[5]]
  );
});

test("packs tight texture rows into 256-byte aligned copy layouts", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake);
  const texture = { name: "texture" };
  const source = Uint8Array.from({ length: 24 }, (_, index) => index + 1);
  const result = pool.stageTexture({
    data: source,
    destination: texture,
    copySize: { width: 2, height: 2, depthOrArrayLayers: 2 },
    sourceBytesPerRow: 4,
    sourceRowsPerImage: 3,
    origin: { x: 1, y: 2, z: 3 },
  });
  assert.deepEqual(result, {
    ok: true, slot: 0, offset: 0, logicalBytes: 16, stagedBytes: 1024,
  });
  const staged = new Uint8Array(fake.buffers[0].storage);
  assert.deepEqual([...staged.slice(0, 4)], [1, 2, 3, 4]);
  assert.deepEqual([...staged.slice(256, 260)], [5, 6, 7, 8]);
  assert.deepEqual([...staged.slice(512, 516)], [13, 14, 15, 16]);
  assert.deepEqual([...staged.slice(768, 772)], [17, 18, 19, 20]);

  const batch = pool.seal();
  const copy = batch.commandBuffer.copies[0];
  assert.equal(copy[0], "texture");
  assert.deepEqual(copy[1], {
    buffer: fake.buffers[0], offset: 0, bytesPerRow: 256, rowsPerImage: 2,
  });
  assert.deepEqual(copy[2], { texture, origin: { x: 1, y: 2, z: 3 } });
  assert.deepEqual(copy[3], { width: 2, height: 2, depthOrArrayLayers: 2 });
});

test("positional texture staging preserves row packing and copy layout", () => {
  const controlFake = createFakeDevice();
  const fastFake = createFakeDevice();
  const control = createPool(controlFake);
  const fast = createPool(fastFake);
  const backing = Uint8Array.from({ length: 26 }, (_, index) => index);
  const bytes = backing.subarray(1, 25);
  const copySize = { width: 2, height: 2, depthOrArrayLayers: 2 };
  const origin = { x: 1, y: 2, z: 3 };
  const controlDestination = { name: "control" };
  const fastDestination = { name: "fast" };

  const controlResult = control.stageTexture({
    data: bytes,
    destination: controlDestination,
    copySize,
    sourceBytesPerRow: 4,
    sourceRowsPerImage: 3,
    origin,
    mipLevel: 2,
    aspect: "all",
  });
  const fastResult = fast.stageTextureFast(
    bytes, fastDestination, copySize, 4, 3, origin, 2, "all"
  );

  assert.equal(fastResult, null);
  assert.equal(controlResult.ok, true);
  assert.deepEqual(
    [...new Uint8Array(fastFake.buffers[0].storage)],
    [...new Uint8Array(controlFake.buffers[0].storage)]
  );
  assert.deepEqual(fast.snapshot(), control.snapshot());
  const controlCopy = control.seal().commandBuffer.copies[0];
  const fastCopy = fast.seal().commandBuffer.copies[0];
  assert.deepEqual(fastCopy[1], {
    buffer: fastFake.buffers[0],
    offset: controlCopy[1].offset,
    bytesPerRow: controlCopy[1].bytesPerRow,
    rowsPerImage: controlCopy[1].rowsPerImage,
  });
  assert.deepEqual(fastCopy[2], {
    texture: fastDestination, origin, mipLevel: 2, aspect: "all",
  });
  assert.deepEqual(fastCopy[3], controlCopy[3]);
});

test("reports bounded capacity misses without allocating or dropping prior uploads", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 1, slotSize: 8 });
  const destination = {};
  assert.equal(pool.stageBuffer({ data: new Uint8Array(8), destination }).ok, true);
  assert.deepEqual(pool.stageBuffer({ data: new Uint8Array(4), destination }), {
    ok: false, reason: "no-capacity",
  });
  assert.deepEqual(pool.stageBuffer({ data: new Uint8Array(12), destination }), {
    ok: false, reason: "payload-too-large",
  });
  assert.equal(fake.buffers.length, 1);
  assert.deepEqual(pool.snapshot(), {
    slotCount: 1,
    slotSize: 8,
    capacityBytes: 8,
    failed: false,
    lastError: null,
    states: { mapped: 1, sealed: 0, remapping: 0, failed: 0 },
    pendingUploads: 1,
    pendingBytes: 8,
    oldestPendingAtMs: 100,
    oldestPendingAgeMs: 0,
    activeBatches: 0,
    recordStore: "objects",
    flatRecordHighWater: 0,
    flatRecordResetCount: 0,
    remapLatencyBucketBoundsMs: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000],
    bufferUploads: 1,
    bufferUploadsCoalesced: 0,
    bufferSnapshotUploads: 0,
    bufferSnapshotSparseUploads: 0,
    bufferSnapshotFullUploads: 0,
    bufferSnapshotEqualUploads: 0,
    bufferSnapshotCopyForwardBytes: 0,
    bufferSnapshotOverlayRanges: 0,
    bufferSnapshotOverlayBytes: 0,
    bufferSnapshotAvoidedStagedBytes: 0,
    textureUploads: 0,
    copyCommandsEncoded: 1,
    logicalBytes: 8,
    stagedBytes: 8,
    capacityMisses: 2,
    oversizedMisses: 1,
    capacityMissesNoMappedSlots: 0,
    capacityMissesMappedSlotsFull: 1,
    batchesSealed: 0,
    batchesSubmitted: 0,
    sealedSlotCountTotal: 0,
    sealedBytesTotal: 0,
    sealedBytesMax: 0,
    sealedRecordsTotal: 0,
    sealedRecordsMax: 0,
    remapsStarted: 0,
    remapsCompleted: 0,
    remapFailures: 0,
    remapLatencyTotalMs: 0,
    remapLatencyMaxMs: 0,
    remapCallbackTotalMs: 0,
    remapLatencyHistogram: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    invalidations: 0,
  });
});

test("positional staging reports interned miss reasons without success objects", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 1, slotSize: 8 });
  const destination = {};
  assert.equal(pool.stageBufferFast(new Uint8Array(8), destination), null);
  assert.equal(pool.stageBufferFast(new Uint8Array(4), destination), "no-capacity");
  assert.equal(pool.stageBufferFast(new Uint8Array(12), destination), "payload-too-large");
  assert.deepEqual(pool.snapshot(), {
    ...pool.snapshot(),
    bufferUploads: 1,
    capacityMisses: 2,
    oversizedMisses: 1,
    capacityMissesMappedSlotsFull: 1,
  });
});

test("coalesces adjacent copies to the same buffer without changing byte order", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 1, slotSize: 32 });
  const destination = { name: "stream" };
  pool.stageBuffer({
    data: Uint8Array.of(1, 2, 3, 4), destination, destinationOffset: 8,
  });
  pool.stageBuffer({
    data: Uint8Array.of(5, 6, 7, 8), destination, destinationOffset: 12,
  });
  const batch = pool.seal();
  assert.equal(batch.commandBuffer.copies.length, 1);
  assert.deepEqual(batch.commandBuffer.copies[0].slice(0, 6), [
    "buffer", fake.buffers[0], 0, destination, 8, 8,
  ]);
  assert.equal(pool.snapshot().bufferUploads, 2);
  assert.equal(pool.snapshot().bufferUploadsCoalesced, 1);
  assert.equal(pool.snapshot().copyCommandsEncoded, 1);
});

test("seals remapped slots in first-pending order instead of slot-id order", async () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 2, slotSize: 8 });
  const destination = { name: "overlap" };

  pool.stageBuffer({ data: new Uint8Array(8), destination });
  const firstBatch = pool.seal();
  const firstRemap = pool.acceptSubmission(firstBatch);

  // slot 0 is remapping, so this older write lands in slot 1.
  pool.stageBuffer({
    data: Uint8Array.of(1, 1, 1, 1),
    destination,
    destinationOffset: 0,
  });
  fake.buffers[0].maps[0].operation.resolve();
  await firstRemap;

  // slot 0 is available again and receives the newer overlapping write.
  pool.stageBuffer({
    data: Uint8Array.of(2, 2, 2, 2),
    destination,
    destinationOffset: 0,
  });
  const ordered = pool.seal().commandBuffer.copies;
  assert.equal(ordered.length, 2);
  assert.equal(ordered[0][1], fake.buffers[1], "older slot-1 write must encode first");
  assert.equal(ordered[1][1], fake.buffers[0], "newer slot-0 write must encode last");
});

test("preserves global A-B-A record order across staging slots", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 2, slotSize: 8 });
  const destination = { name: "overlap" };

  pool.stageBuffer({
    data: Uint8Array.of(1, 1, 1, 1),
    destination,
    destinationOffset: 0,
  });
  pool.stageBuffer({
    data: new Uint8Array(8).fill(2),
    destination,
    destinationOffset: 0,
  });
  pool.stageBuffer({
    data: Uint8Array.of(3, 3, 3, 3),
    destination,
    destinationOffset: 4,
  });

  const copies = pool.seal().commandBuffer.copies;
  assert.equal(copies.length, 3, "A and C must not coalesce across B");
  assert.deepEqual(copies.map((copy) => fake.buffers.indexOf(copy[1])), [0, 1, 0]);
});


test("flat record store matches mixed object copies and reuses retained arrays", async () => {
  const objectFake = createFakeDevice();
  const flatFake = createFakeDevice();
  const objectPool = createPool(objectFake, { slotCount: 1, flatRecords: false });
  const flatPool = createPool(flatFake, { slotCount: 1, flatRecords: true });
  const objectBuffer = { name: "object-buffer" };
  const flatBuffer = { name: "flat-buffer" };
  const objectTexture = { name: "object-texture" };
  const flatTexture = { name: "flat-texture" };
  const textureBytes = Uint8Array.from({ length: 8 }, (_, index) => index + 1);
  const copySize = { width: 2, height: 2, depthOrArrayLayers: 1 };
  const origin = { x: 3, y: 4, z: 0 };

  for (const [pool, buffer, texture] of [
    [objectPool, objectBuffer, objectTexture],
    [flatPool, flatBuffer, flatTexture],
  ]) {
    assert.equal(pool.stageBufferFast(Uint8Array.of(1, 2, 3, 4), buffer, 8), null);
    assert.equal(pool.stageBufferFast(Uint8Array.of(5, 6, 7, 8), buffer, 12), null);
    assert.equal(pool.stageTextureFast(
      textureBytes, texture, copySize, 4, 2, origin, 1, "all"
    ), null);
  }

  const summarize = (copy) => copy[0] === "buffer"
    ? [copy[0], copy[2], copy[4], copy[5]]
    : [
        copy[0], copy[1].offset, copy[1].bytesPerRow, copy[1].rowsPerImage,
        copy[2].origin, copy[2].mipLevel, copy[2].aspect, copy[3],
      ];
  const objectBatch = objectPool.seal();
  const flatBatch = flatPool.seal();
  assert.deepEqual(
    flatBatch.commandBuffer.copies.map(summarize),
    objectBatch.commandBuffer.copies.map(summarize)
  );
  assert.equal(flatPool.snapshot().recordStore, "flat");
  assert.equal(flatPool.snapshot().flatRecordHighWater, 2);
  assert.equal(flatPool.snapshot().pendingUploads, 2);

  const flatRemap = submitWgpuUploadBeforeRender({
    queue: { submit() {} }, pool: flatPool, batch: flatBatch,
  });
  flatFake.buffers[0].maps[0].operation.resolve();
  assert.equal(await flatRemap, true);
  assert.equal(flatPool.snapshot().flatRecordResetCount, 1);
  assert.equal(flatPool.snapshot().pendingUploads, 0);
  assert.equal(flatPool.stageBufferFast(
    Uint8Array.of(9, 8, 7, 6), flatBuffer, 16
  ), null);
  assert.equal(flatPool.snapshot().flatRecordHighWater, 2);
});

test("flat records preserve global A-B-A order without cross-record coalescing", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 2, slotSize: 8, flatRecords: true });
  const destination = { name: "overlap" };

  assert.equal(pool.stageBufferFast(Uint8Array.of(1, 1, 1, 1), destination, 0), null);
  assert.equal(pool.stageBufferFast(new Uint8Array(8).fill(2), destination, 0), null);
  assert.equal(pool.stageBufferFast(Uint8Array.of(3, 3, 3, 3), destination, 4), null);

  const copies = pool.seal().commandBuffer.copies;
  assert.equal(copies.length, 3, "A and C must not coalesce across B");
  assert.deepEqual(copies.map((copy) => fake.buffers.indexOf(copy[1])), [0, 1, 0]);
  assert.equal(pool.snapshot().recordStore, "flat");
});

test("compound snapshots reconstruct sequential UBO slices byte-identically", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 1, slotSize: 256 });
  const shadow = fake.device.createBuffer({ size: 64, usage: 0x000c });
  const destination = fake.device.createBuffer({ size: 192, usage: 0x0008 });
  const baseline = Uint8Array.from({ length: 64 }, (_, index) => index);
  const changed = baseline.slice();
  changed.fill(0xee, 16, 32);

  assert.deepEqual(pool.stageBufferSnapshot({
    data: baseline,
    destination,
    destinationOffset: 0,
    shadowBuffer: shadow,
    ranges: [{ start: 0, end: 64 }],
    copyForward: false,
  }), { ok: true, slot: 0, offset: 0, logicalBytes: 64, stagedBytes: 64 });
  assert.deepEqual(pool.stageBufferSnapshot({
    data: changed,
    destination,
    destinationOffset: 64,
    shadowBuffer: shadow,
    ranges: [{ start: 16, end: 32 }],
    copyForward: true,
  }), { ok: true, slot: 0, offset: 64, logicalBytes: 64, stagedBytes: 16 });
  assert.deepEqual(pool.stageBufferSnapshot({
    data: changed,
    destination,
    destinationOffset: 128,
    shadowBuffer: shadow,
    ranges: [],
    copyForward: true,
  }), { ok: true, slot: 0, offset: 80, logicalBytes: 64, stagedBytes: 0 });

  const copies = pool.seal().commandBuffer.copies;
  assert.equal(copies.length, 6);
  for (const copy of copies) {
    assert.equal(copy[0], "buffer");
    const [, source, sourceOffset, target, targetOffset, size] = copy;
    new Uint8Array(target.storage, targetOffset, size).set(
      new Uint8Array(source.storage, sourceOffset, size)
    );
  }
  assert.deepEqual(
    [...new Uint8Array(destination.storage, 0, 64)],
    [...baseline]
  );
  assert.deepEqual(
    [...new Uint8Array(destination.storage, 64, 64)],
    [...changed]
  );
  assert.deepEqual(
    [...new Uint8Array(destination.storage, 128, 64)],
    [...changed]
  );
  assert.deepEqual([...new Uint8Array(shadow.storage)], [...changed]);
  const snapshot = pool.snapshot();
  assert.equal(snapshot.bufferSnapshotUploads, 3);
  assert.equal(snapshot.bufferSnapshotSparseUploads, 2);
  assert.equal(snapshot.bufferSnapshotFullUploads, 1);
  assert.equal(snapshot.bufferSnapshotEqualUploads, 1);
  assert.equal(snapshot.bufferSnapshotCopyForwardBytes, 128);
  assert.equal(snapshot.bufferSnapshotOverlayBytes, 80);
  assert.equal(snapshot.bufferSnapshotAvoidedStagedBytes, 112);
});

test("compound UBO ordering survives cross-slot staging and an interleaved upload", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 2, slotSize: 64 });
  const shadow = fake.device.createBuffer({ size: 64, usage: 0x000c });
  const destination = fake.device.createBuffer({ size: 128, usage: 0x0008 });
  const unrelated = fake.device.createBuffer({ size: 4, usage: 0x0008 });
  const baseline = new Uint8Array(64).fill(1);
  const changed = baseline.slice();
  changed.fill(2, 32, 48);

  pool.stageBufferSnapshot({
    data: baseline, destination, shadowBuffer: shadow,
    ranges: [{ start: 0, end: 64 }], copyForward: false,
  });
  pool.stageBuffer({ data: Uint8Array.of(9, 8, 7, 6), destination: unrelated });
  pool.stageBufferSnapshot({
    data: changed, destination, destinationOffset: 64, shadowBuffer: shadow,
    ranges: [{ start: 32, end: 48 }], copyForward: true,
  });

  const copies = pool.seal().commandBuffer.copies;
  assert.deepEqual(copies.map((copy) => fake.buffers.indexOf(copy[1])), [0, 0, 1, 2, 1, 1]);
  for (const [, source, sourceOffset, target, targetOffset, size] of copies) {
    new Uint8Array(target.storage, targetOffset, size).set(
      new Uint8Array(source.storage, sourceOffset, size)
    );
  }
  assert.deepEqual([...new Uint8Array(destination.storage, 0, 64)], [...baseline]);
  assert.deepEqual([...new Uint8Array(destination.storage, 64, 64)], [...changed]);
  assert.deepEqual([...new Uint8Array(shadow.storage)], [...changed]);
  assert.deepEqual([...new Uint8Array(unrelated.storage)], [9, 8, 7, 6]);
});

test("flat records preserve compound UBO ordering and equal-copy reconstruction", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 2, slotSize: 64, flatRecords: true });
  const shadow = fake.device.createBuffer({ size: 64, usage: 0x000c });
  const destination = fake.device.createBuffer({ size: 192, usage: 0x0008 });
  const unrelated = fake.device.createBuffer({ size: 4, usage: 0x0008 });
  const baseline = Uint8Array.from({ length: 64 }, (_, index) => index);
  const changed = baseline.slice();
  changed.fill(0xee, 16, 32);

  pool.stageBufferSnapshot({
    data: baseline, destination, shadowBuffer: shadow,
    ranges: [{ start: 0, end: 64 }], copyForward: false,
  });
  assert.equal(pool.stageBufferFast(
    Uint8Array.of(9, 8, 7, 6), unrelated, 0
  ), null);
  pool.stageBufferSnapshot({
    data: changed, destination, destinationOffset: 64, shadowBuffer: shadow,
    ranges: [{ start: 16, end: 32 }], copyForward: true,
  });
  const equal = pool.stageBufferSnapshot({
    data: changed, destination, destinationOffset: 128, shadowBuffer: shadow,
    ranges: [], copyForward: true,
  });
  assert.equal(equal.stagedBytes, 0);
  assert.equal(pool.snapshot().pendingUploads, 4);

  const copies = pool.seal().commandBuffer.copies;
  assert.deepEqual(copies.map((copy) => fake.buffers.indexOf(copy[1])), [0, 0, 1, 2, 1, 1, 2]);
  for (const [, source, sourceOffset, target, targetOffset, size] of copies) {
    new Uint8Array(target.storage, targetOffset, size).set(
      new Uint8Array(source.storage, sourceOffset, size)
    );
  }
  assert.deepEqual([...new Uint8Array(destination.storage, 0, 64)], [...baseline]);
  assert.deepEqual([...new Uint8Array(destination.storage, 64, 64)], [...changed]);
  assert.deepEqual([...new Uint8Array(destination.storage, 128, 64)], [...changed]);
  assert.deepEqual([...new Uint8Array(shadow.storage)], [...changed]);
  assert.deepEqual([...new Uint8Array(unrelated.storage)], [9, 8, 7, 6]);
});

test("compound snapshot capacity failure is atomic and retry-safe", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 1, slotSize: 16 });
  const destination = fake.device.createBuffer({ size: 64, usage: 0x0008 });
  const shadow = fake.device.createBuffer({ size: 32, usage: 0x000c });
  pool.stageBuffer({ data: new Uint8Array(16), destination });
  const before = pool.snapshot();
  assert.deepEqual(pool.stageBufferSnapshot({
    data: new Uint8Array(32),
    destination,
    destinationOffset: 32,
    shadowBuffer: shadow,
    ranges: [{ start: 0, end: 4 }],
    copyForward: true,
  }), { ok: false, reason: "no-capacity" });
  const after = pool.snapshot();
  assert.equal(after.pendingUploads, before.pendingUploads);
  assert.equal(after.pendingBytes, before.pendingBytes);
  assert.equal(after.bufferSnapshotUploads, 0);
  assert.equal(pool.seal().commandBuffer.copies.length, 1);
});

test("submits upload before render and remaps slots only after acceptance", async () => {
  const fake = createFakeDevice();
  const pool = createPool(fake, { slotCount: 1 });
  pool.stageBuffer({ data: Uint8Array.of(1, 2, 3, 4), destination: {} });
  const batch = pool.seal();
  assert.equal(pool.snapshot().states.sealed, 1);
  const render = { kind: "render" };
  const submissions = [];
  const remapped = submitWgpuUploadBeforeRender({
    queue: { submit: (commands) => submissions.push(commands) },
    pool,
    batch,
    renderCommandBuffers: [render],
  });
  assert.deepEqual(submissions, [[batch.commandBuffer, render]]);
  assert.equal(pool.snapshot().states.remapping, 1);
  assert.equal(fake.buffers[0].maps[0].mode, 0x0002);
  fake.buffers[0].maps[0].operation.resolve();
  assert.equal(await remapped, true);
  assert.equal(pool.snapshot().states.mapped, 1);
  assert.equal(pool.stageBuffer({ data: Uint8Array.of(9, 8, 7, 6), destination: {} }).ok, true);
});

test("records batch utilization, remap latency, and unavailable-slot misses", async () => {
  const fake = createFakeDevice();
  let clock = 10;
  const pool = createPool(fake, {
    slotCount: 1,
    slotSize: 32,
    now: () => clock,
  });
  pool.stageBuffer({ data: new Uint8Array(8), destination: {} });
  const batch = pool.seal();
  assert.equal(pool.snapshot().sealedSlotCountTotal, 1);
  assert.equal(pool.snapshot().sealedBytesTotal, 8);
  assert.equal(pool.snapshot().sealedRecordsTotal, 1);
  const remapped = submitWgpuUploadBeforeRender({
    queue: { submit() {} }, pool, batch,
  });
  assert.deepEqual(pool.stageBuffer({ data: new Uint8Array(4), destination: {} }), {
    ok: false, reason: "no-capacity",
  });
  assert.equal(pool.snapshot().capacityMissesNoMappedSlots, 1);
  clock = 29;
  fake.buffers[0].maps[0].operation.resolve();
  assert.equal(await remapped, true);
  const snapshot = pool.snapshot();
  assert.equal(snapshot.remapLatencyTotalMs, 19);
  assert.equal(snapshot.remapLatencyMaxMs, 19);
  assert.equal(snapshot.remapLatencyHistogram[5], 1);
});

test("submission failure invalidates all slots and rethrows", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake);
  pool.stageBuffer({ data: Uint8Array.of(1, 2, 3, 4), destination: {} });
  const batch = pool.seal();
  assert.throws(() => submitWgpuUploadBeforeRender({
    queue: { submit: () => { throw new Error("queue rejected"); } },
    pool,
    batch,
  }), /queue rejected/);
  assert.equal(pool.snapshot().failed, true);
  assert.equal(pool.snapshot().lastError, "queue rejected");
  assert.deepEqual(fake.buffers.map((buffer) => buffer.destroys), [1, 1]);
  assert.deepEqual(pool.stageBuffer({ data: Uint8Array.of(1, 2, 3, 4), destination: {} }), {
    ok: false, reason: "pool-failed",
  });
});

test("remap rejection and device loss fail closed with cleanup", async () => {
  const remapFake = createFakeDevice();
  const remapPool = createPool(remapFake, { slotCount: 1 });
  remapPool.stageBuffer({ data: Uint8Array.of(1, 2, 3, 4), destination: {} });
  const remapBatch = remapPool.seal();
  const remapped = submitWgpuUploadBeforeRender({
    queue: { submit() {} }, pool: remapPool, batch: remapBatch,
  });
  remapFake.buffers[0].maps[0].operation.reject(new Error("map failed"));
  assert.equal(await remapped, false);
  assert.equal(remapPool.snapshot().remapFailures, 1);
  assert.equal(remapPool.snapshot().failed, true);
  assert.equal(remapFake.buffers[0].destroys, 1);

  const lossFake = createFakeDevice();
  const lossPool = createPool(lossFake);
  lossFake.lost.resolve({ message: "adapter reset" });
  await Promise.resolve();
  assert.equal(lossPool.snapshot().failed, true);
  assert.equal(lossPool.snapshot().lastError, "adapter reset");
  assert.deepEqual(lossFake.buffers.map((buffer) => buffer.destroys), [1, 1]);
});

test("rejects invalid copy layouts rather than corrupting adjacent destinations", () => {
  const fake = createFakeDevice();
  const pool = createPool(fake);
  assert.throws(() => pool.stageBuffer({ data: new Uint8Array(3), destination: {} }),
    /multiples of 4/);
  assert.throws(() => pool.stageBuffer({
    data: new Uint8Array(4), destination: {}, destinationOffset: 2,
  }), /multiples of 4/);
  assert.throws(() => pool.stageTexture({
    data: new Uint8Array(4),
    destination: {},
    copySize: { width: 1, height: 2 },
    sourceBytesPerRow: 4,
  }), /every requested row/);
  assert.equal(pool.snapshot().pendingUploads, 0);
});

test("retained ring bytes survive a capacity miss and retry byte-identically", () => {
  const retainedBytes = Uint8Array.of(9, 7, 5, 3);
  const stagedUploads = new Map([[41, { kind: "buffer", data: retainedBytes }]]);
  const seen = [];
  let attempt = 0;
  const stage = (data) => {
    seen.push([...data]);
    attempt += 1;
    return attempt === 1
      ? { ok: false, reason: "no-capacity" }
      : { ok: true, slot: 0 };
  };

  const first = attemptRetainedWgpuUpload({ stagedUploads, recordIndex: 41, stage });
  assert.equal(first.accepted, false);
  assert.equal(stagedUploads.get(41).data, retainedBytes);

  const second = attemptRetainedWgpuUpload({ stagedUploads, recordIndex: 41, stage });
  assert.equal(second.accepted, true);
  assert.equal(stagedUploads.has(41), false);
  assert.deepEqual(seen, [[9, 7, 5, 3], [9, 7, 5, 3]]);
});

test("times the remap callback itself (getMappedRange), apart from the remap latency", async () => {
  const fake = createFakeDevice();
  let clock = 10;
  const pool = createPool(fake, { slotCount: 1, slotSize: 32, now: () => clock });
  pool.stageBuffer({ data: new Uint8Array(8), destination: {} });
  const batch = pool.seal();
  const remapped = submitWgpuUploadBeforeRender({ queue: { submit() {} }, pool, batch });
  const buffer = fake.buffers[0];
  const getMappedRange = buffer.getMappedRange.bind(buffer);
  buffer.getMappedRange = (...args) => {
    clock += 3;
    return getMappedRange(...args);
  };
  clock = 29;
  buffer.maps[0].operation.resolve();
  assert.equal(await remapped, true);
  assert.equal(pool.remapCallbackTotalMs(), 3);
  assert.equal(pool.snapshot().remapCallbackTotalMs, 3);
  assert.equal(pool.snapshot().remapLatencyTotalMs, 22);
});
