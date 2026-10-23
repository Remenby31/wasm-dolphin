import assert from "node:assert/strict";
import test from "node:test";

import { READBACK_LOST, READBACK_OK, WgpuReadback, copyRows, paddedBytesPerRow, unwrapSeq } from "../src/wgpu-readback.js";

// A device whose buffers map when the test says so, in any order. Its
// encoder fills the buffer the way the GPU would (rows of the source
// rectangle at the padded stride); `rejectNext` makes the next copy fail
// validation (its error scope reports an error, the buffer stays as it was).
function fakeDevice() {
  const created = [];
  const scopes = [];
  const device = {
    created, submits: 0, rejectNext: false, throwNext: false,
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
    },
    pushErrorScope() { scopes.push(null); },
    popErrorScope() { return Promise.resolve(scopes.pop()); },
    createCommandEncoder() {
      return {
        copyTextureToBuffer(src, dst, size) {
          if (device.throwNext) {
            device.throwNext = false;
            throw new Error("bad copy");
          }
          if (device.rejectNext) {
            device.rejectNext = false;
            scopes[scopes.length - 1] = { message: "invalid copy" };
            return;
          }
          const { texture } = src;
          const texel = texture.texelSize;
          for (let y = 0; y < size.height; y += 1) {
            for (let b = 0; b < size.width * texel; b += 1) {
              dst.buffer.bytes[y * dst.bytesPerRow + b] = texture.byteAt(src.origin.x * texel + b, src.origin.y + y);
            }
          }
        },
        finish() { return {}; }
      };
    }
  };
  device.queue = { submit() { device.submits += 1; } };
  return device;
}

const texture = { texelSize: 4, byteAt: (bx, y) => (bx + 7 * y) & 0xff };
const flat = (v) => ({ texelSize: 4, byteAt: () => v });
const flush = () => new Promise((r) => setImmediate(r));

function setup(options = {}) {
  const device = fakeDevice();
  const heap = new Uint8Array(4096);
  const words = new Int32Array(new SharedArrayBuffer(64));
  return { device, heap, words, rb: new WgpuReadback({ device, heap: () => heap, words: () => words, ...options }) };
}

const copyOf = (seq, extra = {}) => ({
  seq, texture, origin: { x: 3, y: 2, z: 0 }, width: 5, height: 3, texelSize: 4,
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

test("a copy lands in the heap in its own submission, then its seq is published", async () => {
  const { device, heap, words, rb } = setup();
  const done = rb.issue(device.queue, copyOf(1));
  await flush();
  assert.equal(device.submits, 1);
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

// #125 review: an invalid copy used to map anyway and publish the pooled
// buffer's old bytes as OK.
test("a copy the device rejects is LOST and its buffer never read", async () => {
  for (const how of ["rejectNext", "throwNext"]) {
    const { device, heap, words, rb } = setup();
    device[how] = true;
    await rb.issue(device.queue, copyOf(1));
    assert.equal(Atomics.load(words, 0), 1, how);
    assert.equal(Atomics.load(words, 1), READBACK_LOST);
    assert.ok(heap.every((b) => b === 0), "nothing written");
    assert.equal(rb.stats.failed, 1);
  }
});

// #125 review: copy 2 (another tile) LOST while copy 1 is in flight made
// Flush return early, and copy 1 was then dropped as stale.
test("a slot is published only up to its first unfinished copy", async () => {
  const { device, heap, words, rb } = setup();
  const one = rb.issue(device.queue, copyOf(1));
  rb.lose(copyOf(2, { heapPtr: 300 }));
  await flush();
  assert.equal(Atomics.load(words, 0), 0, "copy 1 is still in flight");
  device.created[0].land();
  await one;
  assert.equal(Atomics.load(words, 0), 2);
  assert.equal(Atomics.load(words, 1), READBACK_LOST, "the run had a lost copy");
  assert.equal(heap[100], texture.byteAt(12, 2), "copy 1's texels written");
});

test("copies landing out of order are written in seq order: the later copy of a tile wins", async () => {
  const { device, heap, words, rb } = setup();
  const one = rb.issue(device.queue, copyOf(1));
  const two = rb.issue(device.queue, copyOf(2, { texture: flat(0xaa) }));
  await flush();
  device.created[1].land();
  await two;
  assert.equal(Atomics.load(words, 0), 0, "copy 2 waits for copy 1");
  assert.equal(heap[100], 0, "nothing written ahead of copy 1");
  device.created[0].land();
  await one;
  assert.equal(Atomics.load(words, 0), 2);
  assert.equal(Atomics.load(words, 1), READBACK_OK);
  assert.equal(heap[100], 0xaa);
});

test("a seq the replay never saw counts as lost, so the slot cannot jam", async () => {
  const { device, words, rb } = setup();
  const three = rb.issue(device.queue, copyOf(3));
  await flush();
  device.created[0].land();
  await three;
  assert.equal(Atomics.load(words, 0), 3);
  assert.equal(Atomics.load(words, 1), READBACK_LOST);
});

test("a failed map wakes the waiter with LOST", async () => {
  const { device, words, rb } = setup();
  const done = rb.issue(device.queue, copyOf(1));
  await flush();
  device.created[0].fail();
  await done;
  assert.equal(Atomics.load(words, 0), 1);
  assert.equal(Atomics.load(words, 1), READBACK_LOST);
});

test("reset releases every waiter as LOST and drops what lands later", async () => {
  const { device, heap, words, rb } = setup();
  const done = rb.issue(device.queue, copyOf(1));
  rb.issue(device.queue, copyOf(1, { wordIndex: 2, heapPtr: 600 }));
  await flush();
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
    const done = rb.issue(device.queue, copyOf(seq));
    await flush();
    device.created.at(-1).land();
    await done;
  }
  assert.equal(device.created.length, 1);
});

// #125 review: the pool kept 4 buffers per distinct size forever.
test("the reuse pool is capped in bytes", async () => {
  const { device, rb } = setup({ poolBytes: 1024 });
  const sizes = [3, 4, 5];
  const pending = sizes.map((height, i) => rb.issue(device.queue, copyOf(i + 1, { height, heapPtr: 100 + i * 200 })));
  await flush();
  for (const b of device.created) b.land();
  await Promise.all(pending);
  assert.ok(rb.pooledBytes <= 1024);
  assert.equal(device.created.filter((b) => b.destroyed).length, 2, "256*3 kept, 256*4 and 256*5 destroyed");
});

test("a rectangle outside the heap or with overlapping rows is refused, the buffer unmapped, the waiter released", async () => {
  for (const bad of [{ heapPtr: 4090 }, { dstStride: 8 }, { heapPtr: -4 }]) {
    const { device, heap, words, rb } = setup();
    const done = rb.issue(device.queue, copyOf(1, bad));
    await flush();
    device.created[0].land();
    await done;
    assert.equal(Atomics.load(words, 0), 1, JSON.stringify(bad));
    assert.equal(Atomics.load(words, 1), READBACK_LOST);
    assert.equal(device.created[0].mapped, false, "unmapped");
    assert.equal(rb.stats.rejected, 1);
    assert.ok(heap.every((b) => b === 0), "nothing written");
  }
});

test("the 16-bit seq of a record unwraps against the slot's last completed copy", () => {
  assert.equal(unwrapSeq(0, 1), 1);
  assert.equal(unwrapSeq(5, 7), 7, "two in flight");
  assert.equal(unwrapSeq(0xFFFF, 0), 0x10000, "across the 16-bit wrap");
  assert.equal(unwrapSeq(0x1FFFE, 3), 0x20003);
});

// #125 re-review: a rejected buffer (out of memory, say) went back to the
// pool and spoiled every later copy of its size.
test("a buffer from a rejected or unmappable copy is destroyed, never pooled", async () => {
  for (const how of ["rejectNext", "fail"]) {
    const { device, rb } = setup();
    if (how === "rejectNext") device.rejectNext = true;
    const first = rb.issue(device.queue, copyOf(1));
    await flush();
    if (how === "fail") device.created[0].fail();
    await first;
    assert.equal(device.created[0].destroyed, true, how);
    const second = rb.issue(device.queue, copyOf(2));
    await flush();
    assert.equal(device.created.length, 2, "the next copy gets a fresh buffer");
    device.created[1].land();
    await second;
  }
});

// #125 re-review: after a device loss or a fatal replay error, the drain
// stops, so copies left in the ring are never published; the core used to
// wait 500 ms and orphan a block on every Flush. Now the worker releases
// what it tracks before marking the consumer failed, and the core neither
// pushes nor waits for a copy once the consumer has failed.
test("a failed consumer releases its copies first; the core then neither pushes nor waits", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
  const [worker, patch] = await Promise.all([
    read("../src/upstream-discio-worker.js"),
    read("../patches/dolphin-wasm/snapshot/0093-webgpu-staging-readback.patch")
  ]);
  const fatal = worker.slice(worker.indexOf("function markWgpuReplayFatal("));
  const release = fatal.indexOf("releaseWgpuReadback();");
  assert.ok(release > 0 && release < fatal.indexOf("emergencyFail("), "released before the consumer is marked failed");
  assert.match(worker, /wgpuReadback\.module !== moduleInstance/, "a new core module gets a new readback");
  assert.match(worker, /releaseWgpuReadback\(\);\n  moduleInstance = await factory/, "released before a core loads");
  const added = patch.split("\n").filter((l) => l.startsWith("+")).join("\n");
  assert.match(added, /if \(GetCommandStream\(\)\.ReadbackConsumerFailed\(\)\)\n\+    return;/, "no copy pushed");
  assert.match(added, /ReadbackConsumerFailed\(\)\)\n\+    \{\n\+      m_block->words\[0\]\.store\(static_cast<s32>\(m_issued\)/, "the wait settles");
  assert.match(added, /MAX_ORPHANED_BYTES/, "orphaned blocks are capped");

  // The worker side of it: a slot with a copy in flight is released as LOST
  // up to its last recorded seq, and the copy landing later writes nothing.
  const { device, heap, words, rb } = setup();
  const inFlight = rb.issue(device.queue, copyOf(1));
  rb.issue(device.queue, copyOf(2, { heapPtr: 300 }));
  await flush();
  rb.reset();
  assert.equal(Atomics.load(words, 0), 2);
  assert.equal(Atomics.load(words, 1), READBACK_LOST);
  device.created[0].land();
  await inFlight;
  assert.ok(heap.every((b) => b === 0));
});

// #125 third review: the COPY_TO_STAGING case takes the readback, then
// submitEnc goes fatal (markWgpuReplayFatal resets it and marks the
// consumer failed), then the case released the copy on that instance: the
// slot was recreated and LOST stored into words the core may have freed.
test("a readback released by a fatal submit stores nothing afterwards", async () => {
  const { device, words, rb } = setup();
  const held = rb; // taken before submitEnc
  const submitEnc = () => { held.reset(); return false; }; // fatal inside the submit
  if (!submitEnc()) held.lose(copyOf(1));
  await held.issue(device.queue, copyOf(2));
  held.reset();
  assert.deepEqual([...words.slice(0, 4)], [0, 0, 0, 0], "no store after the release");
  assert.equal(device.submits, 0);
  assert.equal(device.created.length, 0);

  const { readFile } = await import("node:fs/promises");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /function readbackFor\(device\) \{\n(?:.*\n)?  if \(wgpuReplayFatal\) return null;/, "no new readback once the replay is fatal");
  assert.match(worker, /const rb = readbackFor\(dev\);\n\s+if \(!rb\) break;/);
});
