// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// GPU -> CPU readback for the hardware renderer's staging textures
// (docs/wgpu-efb-readback-design.md). The video thread records "copy this
// rectangle of that texture into this host buffer" and goes on; the worker
// copies it into a MAP_READ buffer, maps it once the copy is submitted,
// writes the texels into the wasm heap, then publishes the copy's sequence
// number in shared memory, where the video thread waits for it only when it
// actually reads (Flush). The worker never waits.
//
// Per slot, two Int32 words in shared memory: [done seq, status]. status is
// READBACK_OK, or READBACK_LOST when the copy will never land (device lost,
// renderer reset): the waiter wakes and keeps its previous texels.

export const READBACK_OK = 0;
export const READBACK_LOST = 1;
const MAP_READ = 0x0001;
const COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

// WebGPU copies rows of a multiple of 256 bytes.
export const paddedBytesPerRow = (rowBytes) => Math.ceil(rowBytes / 256) * 256;

// Padded rows from the mapped range -> tight (or the host's) stride.
export function copyRows(src, dst, dstOffset, { rowBytes, srcStride, dstStride, rows }) {
  for (let y = 0; y < rows; y += 1) {
    dst.set(src.subarray(y * srcStride, y * srcStride + rowBytes), dstOffset + y * dstStride);
  }
}

export class WgpuReadback {
  // heap(): the wasm heap's current Uint8Array (it can grow); words(): the
  // shared Int32Array the slots' words live in.
  constructor({ device, heap, words }) {
    this.device = device;
    this.heap = heap;
    this.words = words;
    this.generation = 0;
    this.pool = new Map(); // size -> [GPUBuffer]
    this.recorded = []; // copies encoded, not submitted yet
    this.inFlight = new Set();
    this.stats = { copies: 0, completed: 0, stale: 0, lost: 0, failed: 0, bytes: 0, maxLatencyMs: 0 };
  }

  takeBuffer(size) {
    const free = this.pool.get(size);
    return free?.pop() ?? this.device.createBuffer({ size, usage: MAP_READ | COPY_DST, label: "dolphin-readback" });
  }

  giveBack(buffer, size) {
    const free = this.pool.get(size) ?? [];
    if (free.length < 4) {
      free.push(buffer);
      this.pool.set(size, free);
    } else {
      buffer.destroy();
    }
  }

  // Inside the replay's command encoder. copy: { slot, seq, texture,
  // mipLevel, origin {x,y,z}, width, height, texelSize, aspect?, heapPtr,
  // dstStride, wordIndex }.
  record(encoder, copy, now = performance.now()) {
    const rowBytes = copy.width * copy.texelSize;
    const srcStride = paddedBytesPerRow(rowBytes);
    const size = srcStride * copy.height;
    const buffer = this.takeBuffer(size);
    encoder.copyTextureToBuffer(
      { texture: copy.texture, mipLevel: copy.mipLevel ?? 0, origin: copy.origin, ...(copy.aspect ? { aspect: copy.aspect } : {}) },
      { buffer, bytesPerRow: srcStride, rowsPerImage: copy.height },
      { width: copy.width, height: copy.height, depthOrArrayLayers: 1 }
    );
    this.stats.copies += 1;
    this.recorded.push({ ...copy, buffer, size, rowBytes, srcStride, generation: this.generation, at: now });
  }

  // Right after the queue.submit that carried the recorded copies.
  submitted(now = () => performance.now()) {
    const batch = this.recorded;
    this.recorded = [];
    return Promise.all(batch.map((c) => this.land(c, now)));
  }

  async land(c, now) {
    this.inFlight.add(c);
    try {
      await c.buffer.mapAsync(MAP_MODE_READ);
    } catch (error) {
      this.inFlight.delete(c);
      this.stats.failed += 1;
      this.publish(c, READBACK_LOST);
      return;
    }
    this.inFlight.delete(c);
    if (c.generation !== this.generation) {
      // Reset while in flight: reset() already released the waiter.
      c.buffer.unmap();
      this.stats.stale += 1;
      this.giveBack(c.buffer, c.size);
      return;
    }
    const seqWord = c.wordIndex;
    if (Atomics.load(this.words(), seqWord) >= c.seq) {
      // A later copy of this slot landed first: its texels stand.
      this.stats.stale += 1;
    } else {
      copyRows(new Uint8Array(c.buffer.getMappedRange()), this.heap(), c.heapPtr,
        { rowBytes: c.rowBytes, srcStride: c.srcStride, dstStride: c.dstStride, rows: c.height });
      this.stats.completed += 1;
      this.stats.bytes += c.rowBytes * c.height;
      this.stats.maxLatencyMs = Math.max(this.stats.maxLatencyMs, now() - c.at);
      this.publish(c, READBACK_OK);
    }
    c.buffer.unmap();
    this.giveBack(c.buffer, c.size);
  }

  publish(c, status) {
    const words = this.words();
    Atomics.store(words, c.wordIndex + 1, status);
    if (Atomics.load(words, c.wordIndex) < c.seq) Atomics.store(words, c.wordIndex, c.seq);
    Atomics.notify(words, c.wordIndex);
  }

  // Device lost, core reload, savestate load: nothing in flight will land.
  reset() {
    this.generation += 1;
    for (const c of [...this.recorded, ...this.inFlight]) {
      this.stats.lost += 1;
      this.publish(c, READBACK_LOST);
    }
    this.recorded = [];
    this.inFlight.clear();
    for (const buffers of this.pool.values()) for (const b of buffers) b.destroy();
    this.pool.clear();
  }
}
