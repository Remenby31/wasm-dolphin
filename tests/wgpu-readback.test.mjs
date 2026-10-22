import assert from "node:assert/strict";
import test from "node:test";

import { READBACK_LOST, READBACK_OK, WgpuReadback, copyRows, paddedBytesPerRow } from "../src/wgpu-readback.js";

// A device whose buffers map when the test says so, in any order.
function fakeDevice() {
  const created = [];
  const device = {
    created,
    createBuffer({ size }) {
      const bytes = new Uint8Array(size);
      let resolve, reject;
      const buffer = {
        size, bytes, destroyed: false, mapped: false,
        mapAsync() { return new Promise((res, rej) => { resolve = res; reject = rej; }); },
        land() { buffer.mapped = true; resolve(); },
        fail() { reject(new Error("device lost")); },
        getMappedRange() { return bytes.buffer; },
        unmap() { buffer.mapped = false; },
        destroy() { buffer.destroyed = true; }
      };
      created.push(buffer);
      return buffer;
    }
  };
  return device;
}

// The encoder fills the buffer the way the GPU would: rows of the source
// rectangle at the padded stride.
function fakeEncoder(texture) {
  return {
    copyTextureToBuffer(src, dst, size) {
      const texel = texture.texelSize;
      for (let y = 0; y < size.height; y += 1) {
        for (let b = 0; b < size.width * texel; b += 1) {
          dst.buffer.bytes[y * dst.bytesPerRow + b] = texture.byteAt(src.origin.x * texel + b, src.origin.y + y);
        }
      }
    }
  };
}

const texture = { texelSize: 4, byteAt: (bx, y) => (bx + 7 * y) & 0xff };
const flush = () => new Promise((r) => setImmediate(r));

function setup() {
  const device = fakeDevice();
  const heap = new Uint8Array(4096);
  const words = new Int32Array(new SharedArrayBuffer(64));
  return { device, heap, words, rb: new WgpuReadback({ device, heap: () => heap, words: () => words }) };
}

const copyOf = (seq, extra = {}) => ({
  slot: 0, seq, texture, origin: { x: 3, y: 2, z: 0 }, width: 5, height: 3, texelSize: 4,
  heapPtr: 100, dstStride: 20, wordIndex: 0, ...extra
});

test("rows are padded to 256 bytes on the GPU side and packed on the host side", () => {
  assert.equal(paddedBytesPerRow(20), 256);
  assert.equal(paddedBytesPerRow(256), 256);
  assert.equal(paddedBytesPerRow(257), 512);
  const src = new Uint8Array(512).map((_, i) => i & 0xff);
  const dst = new Uint8Array(16);
  copyRows(src, dst, 2, { rowBytes: 3, srcStride: 256, dstStride: 5, rows: 2 });
  assert.deepEqual([...dst], [0, 0, 0, 1, 2, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0]);
});

test("a copy lands in the heap, then its seq is published", async () => {
  const { device, heap, words, rb } = setup();
  rb.record(fakeEncoder(texture), copyOf(1));
  const done = rb.submitted();
  assert.equal(Atomics.load(words, 0), 0, "nothing before the map");
  device.created[0].land();
  await done;
  assert.equal(Atomics.load(words, 0), 1);
  assert.equal(Atomics.load(words, 1), READBACK_OK);
  for (let y = 0; y < 3; y += 1) {
    for (let b = 0; b < 20; b += 1) assert.equal(heap[100 + y * 20 + b], texture.byteAt(12 + b, 2 + y));
  }
  assert.equal(rb.stats.completed, 1);
});

test("an older copy landing after a newer one of the same slot leaves the newer texels", async () => {
  const { device, heap, words, rb } = setup();
  rb.record(fakeEncoder(texture), copyOf(1));
  rb.record(fakeEncoder({ texelSize: 4, byteAt: () => 0xaa }), copyOf(2));
  const done = rb.submitted();
  device.created[1].land();
  await flush();
  device.created[0].land();
  await done;
  assert.equal(Atomics.load(words, 0), 2);
  assert.equal(heap[100], 0xaa);
  assert.equal(rb.stats.stale, 1);
});

test("a failed map wakes the waiter with LOST", async () => {
  const { device, words, rb } = setup();
  rb.record(fakeEncoder(texture), copyOf(1));
  const done = rb.submitted();
  device.created[0].fail();
  await done;
  assert.equal(Atomics.load(words, 0), 1);
  assert.equal(Atomics.load(words, 1), READBACK_LOST);
});

test("reset releases every waiter as LOST and drops what lands later", async () => {
  const { device, heap, words, rb } = setup();
  rb.record(fakeEncoder(texture), copyOf(1));
  const done = rb.submitted();
  rb.record(fakeEncoder(texture), copyOf(1, { wordIndex: 2, heapPtr: 600 }));
  rb.reset();
  assert.equal(Atomics.load(words, 0), 1);
  assert.equal(Atomics.load(words, 1), READBACK_LOST);
  assert.equal(Atomics.load(words, 2), 1);
  assert.equal(Atomics.load(words, 3), READBACK_LOST);
  device.created[0].land();
  await done;
  assert.equal(heap[100], 0, "no texels from before the reset");
  assert.equal(rb.stats.lost, 2);
});

test("map buffers are reused per size", async () => {
  const { device, rb } = setup();
  for (let seq = 1; seq <= 3; seq += 1) {
    rb.record(fakeEncoder(texture), copyOf(seq));
    const done = rb.submitted();
    device.created.at(-1).land();
    await done;
  }
  assert.equal(device.created.length, 1);
});

test("a late LOST for an older copy never overwrites a newer copy's OK", async () => {
  const { device, words, rb } = setup();
  rb.record(fakeEncoder(texture), copyOf(1));
  rb.record(fakeEncoder(texture), copyOf(2));
  const done = rb.submitted();
  device.created[1].land();
  await flush();
  assert.equal(Atomics.load(words, 0), 2);
  device.created[0].fail(); // copy 1's map fails after copy 2 landed
  await done;
  assert.equal(Atomics.load(words, 0), 2);
  assert.equal(Atomics.load(words, 1), READBACK_OK, "status still the newer copy's");
});

test("a rectangle outside the heap or with overlapping rows is refused, the buffer unmapped, the waiter released", async () => {
  for (const bad of [{ heapPtr: 4090 }, { dstStride: 8 }, { heapPtr: -4 }]) {
    const { device, heap, words, rb } = setup();
    rb.record(fakeEncoder(texture), copyOf(1, bad));
    const done = rb.submitted();
    device.created[0].land();
    await done;
    assert.equal(Atomics.load(words, 0), 1, JSON.stringify(bad));
    assert.equal(Atomics.load(words, 1), READBACK_LOST);
    assert.equal(device.created[0].mapped, false, "unmapped");
    assert.equal(rb.stats.rejected, 1);
    assert.ok(heap.every((b) => b === 0), "nothing written");
  }
});
