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
// Per slot, two Int32 words in shared memory: [done seq, status]. A slot's
// seq S is published only once every copy up to S is finished, in order:
// copies of different tiles of one staging texture may land in any order,
// and the waiter must not read a tile still in flight. Texels are written in
// seq order too, so a later copy of the same tile wins. status is
// READBACK_OK, or READBACK_LOST when a copy in the published run will never
// land (device lost, rejected copy, renderer reset): the waiter wakes and
// keeps its previous texels for those.

export const READBACK_OK = 0;
export const READBACK_LOST = 1;
const MAP_READ = 0x0001;
const COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

// The command record carries the low 16 bits of a copy's seq; the full seq
// follows the slot's last published one (a handful of copies are in flight
// at most, never 65536).
export function unwrapSeq(last, seq16) {
  return (last >>> 0) + (((seq16 & 0xFFFF) - (last & 0xFFFF)) & 0xFFFF);
}

// WebGPU copies rows of a multiple of 256 bytes.
export const paddedBytesPerRow = (rowBytes) => Math.ceil(rowBytes / 256) * 256;

// Padded rows from the mapped range -> tight (or the host's) stride.
export function copyRows(src, dst, dstOffset, { rowBytes, srcStride, dstStride, rows }) {
  for (let y = 0; y < rows; y += 1) {
    dst.set(src.subarray(y * srcStride, y * srcStride + rowBytes), dstOffset + y * dstStride);
  }
}

// Latency buckets (ms) of a copy's steps, for the harness
// (research/deep-efb-ram-copy-latency.md step 0): counts per upper bound.
export const READBACK_LATENCY_BOUNDS_MS = Object.freeze([1, 2, 4, 8, 16, 33, 66, Infinity]);

function latencyHistogram() {
  return { count: 0, sumMs: 0, maxMs: 0, buckets: READBACK_LATENCY_BOUNDS_MS.map(() => 0) };
}

function recordLatency(h, ms) {
  h.count += 1;
  h.sumMs += ms;
  h.maxMs = Math.max(h.maxMs, ms);
  h.buckets[READBACK_LATENCY_BOUNDS_MS.findIndex((b) => ms <= b)] += 1;
}

export class WgpuReadback {
  // heap(): the wasm heap's current Uint8Array (it can grow); words(): the
  // shared Int32Array the slots' words live in. poolBytes caps the MAP_READ
  // buffers kept for reuse.
  constructor({ device, heap, words, poolBytes = 8 << 20 }) {
    this.device = device;
    this.heap = heap;
    this.words = words;
    this.poolBytes = poolBytes;
    this.generation = 0;
    // Set by reset(): the copies are released and the core may already have
    // freed their memory, so nothing is tracked or written any more.
    this.released = false;
    this.pool = new Map(); // size -> [GPUBuffer]
    this.pooledBytes = 0;
    this.slots = new Map(); // wordIndex -> { published, recorded, entries: Map(seq -> entry) }
    this.stats = { copies: 0, completed: 0, stale: 0, lost: 0, failed: 0, rejected: 0, bytes: 0, maxLatencyMs: 0 };
    // Per copy, from its submission: the validation scope resolved, the
    // buffer mapped.
    this.latency = { scope: latencyHistogram(), mapped: latencyHistogram() };
  }

  // Counters and latency histograms; reset: start a new window.
  snapshot({ reset = false } = {}) {
    const out = {
      stats: { ...this.stats },
      latency: JSON.parse(JSON.stringify(this.latency)),
      boundsMs: READBACK_LATENCY_BOUNDS_MS.map((b) => (b === Infinity ? null : b)),
      inFlight: [...this.slots.values()].reduce((n, s) => n + s.entries.size, 0)
    };
    if (reset) this.latency = { scope: latencyHistogram(), mapped: latencyHistogram() };
    return out;
  }

  takeBuffer(size) {
    const free = this.pool.get(size);
    const buffer = free?.pop();
    if (buffer) {
      this.pooledBytes -= size;
      return buffer;
    }
    return this.device.createBuffer({ size, usage: MAP_READ | COPY_DST, label: "dolphin-readback" });
  }

  giveBack(buffer, size) {
    const free = this.pool.get(size) ?? [];
    if (free.length < 4 && this.pooledBytes + size <= this.poolBytes) {
      free.push(buffer);
      this.pool.set(size, free);
      this.pooledBytes += size;
    } else {
      buffer.destroy();
    }
  }

  // The copy's place in its slot. Records arrive in seq order, so a seq
  // skipped since the slot's last record (a record the producer pushed but
  // the replay never saw) will never come: it counts as lost, or the slot
  // would wait for it forever.
  track(c) {
    if (this.released) return null;
    let slot = this.slots.get(c.wordIndex);
    if (!slot || slot.entries.size === 0) {
      // Idle: start from the shared word (a staging texture may have been
      // freed and another one allocated at the same address).
      const published = Atomics.load(this.words(), c.wordIndex) >>> 0;
      slot = { published, recorded: published, entries: new Map() };
      this.slots.set(c.wordIndex, slot);
    }
    if (c.seq <= slot.recorded) return null;
    for (let seq = slot.recorded + 1; seq < c.seq; seq += 1) {
      slot.entries.set(seq, { c: { ...c, seq }, state: "lost" });
    }
    slot.recorded = c.seq;
    const entry = { c, state: "pending" };
    slot.entries.set(c.seq, entry);
    return entry;
  }

  // A copy that never reaches the GPU (no source texture, replay failure):
  // released as LOST in its turn.
  lose(c) {
    if (this.released) return;
    const entry = this.track(c);
    if (!entry) {
      this.stats.rejected += 1;
      return;
    }
    this.stats.lost += 1;
    entry.state = "lost";
    this.advance(c.wordIndex);
  }

  // Its own encoder and submission, inside a validation scope, after the
  // caller submitted everything recorded before it: a bad copy invalidates
  // nothing else, and a copy the device rejects is LOST, never OK with the
  // stale bytes of a pooled buffer. copy: { seq, texture, mipLevel, origin
  // {x,y,z}, width, height, texelSize, aspect?, heapPtr, dstStride, wordIndex }.
  async issue(queue, copy, now = () => performance.now()) {
    if (this.released) return;
    const entry = this.track(copy);
    if (!entry) {
      this.stats.rejected += 1;
      return;
    }
    const generation = this.generation;
    const rowBytes = copy.width * copy.texelSize;
    const srcStride = paddedBytesPerRow(rowBytes);
    const size = srcStride * copy.height;
    const c = Object.assign(entry.c, { rowBytes, srcStride, size, at: now() });
    this.stats.copies += 1;
    let buffer = null;
    let thrown = false;
    this.device.pushErrorScope("validation");
    try {
      buffer = this.takeBuffer(size);
      const encoder = this.device.createCommandEncoder({ label: "dolphin-readback" });
      encoder.copyTextureToBuffer(
        { texture: c.texture, mipLevel: c.mipLevel ?? 0, origin: c.origin, ...(c.aspect ? { aspect: c.aspect } : {}) },
        { buffer, bytesPerRow: srcStride, rowsPerImage: c.height },
        { width: c.width, height: c.height, depthOrArrayLayers: 1 }
      );
      queue.submit([encoder.finish()]);
    } catch {
      thrown = true;
    }
    const scope = this.device.popErrorScope();
    const rejected = thrown || Boolean(await scope.catch(() => true));
    recordLatency(this.latency.scope, now() - c.at);
    if (generation !== this.generation) {
      buffer?.destroy();
      return;
    }
    if (rejected) {
      // The buffer itself may be what the device rejected (out of memory):
      // never pooled again.
      buffer?.destroy();
      this.finish(entry, "lost", null, "failed");
      return;
    }
    try {
      await buffer.mapAsync(MAP_MODE_READ);
    } catch {
      buffer.destroy();
      if (generation === this.generation) this.finish(entry, "lost", null, "failed");
      return;
    }
    if (generation !== this.generation) {
      // Reset while in flight: reset() already released the waiter.
      this.stats.stale += 1;
      buffer.unmap();
      buffer.destroy();
      return;
    }
    this.stats.maxLatencyMs = Math.max(this.stats.maxLatencyMs, now() - c.at);
    recordLatency(this.latency.mapped, now() - c.at);
    this.finish(entry, "ok", buffer);
  }

  finish(entry, state, buffer = null, stat = null) {
    if (stat) this.stats[stat] += 1;
    entry.state = state;
    entry.buffer = buffer;
    this.advance(entry.c.wordIndex);
  }

  // Publishes the slot's finished copies that have no unfinished one before
  // them, writing their texels in seq order.
  advance(wordIndex) {
    const slot = this.slots.get(wordIndex);
    if (!slot) return;
    let status = READBACK_OK;
    let moved = false;
    for (let entry = slot.entries.get(slot.published + 1); entry && entry.state !== "pending"; entry = slot.entries.get(slot.published + 1)) {
      const { c, buffer } = entry;
      if (entry.state === "ok") {
        try {
          if (this.fits(c)) {
            copyRows(new Uint8Array(buffer.getMappedRange()), this.heap(), c.heapPtr,
              { rowBytes: c.rowBytes, srcStride: c.srcStride, dstStride: c.dstStride, rows: c.height });
            this.stats.completed += 1;
            this.stats.bytes += c.rowBytes * c.height;
          } else {
            // The producer asked for a rectangle that does not fit its
            // buffer: nothing is written, the waiter is released.
            this.stats.rejected += 1;
            status = READBACK_LOST;
          }
        } finally {
          buffer.unmap();
          this.giveBack(buffer, c.size);
        }
      } else {
        status = READBACK_LOST;
      }
      slot.entries.delete(c.seq);
      slot.published = c.seq;
      moved = true;
    }
    if (moved) this.publish(wordIndex, slot.published, status);
  }

  // The destination rectangle lies inside the heap, rows do not overlap.
  fits(c) {
    const heap = this.heap();
    const { heapPtr, dstStride, rowBytes, height } = c;
    if (![heapPtr, dstStride, rowBytes, height].every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
    if (height === 0 || rowBytes === 0) return true;
    return dstStride >= rowBytes && heapPtr + dstStride * (height - 1) + rowBytes <= heap.length;
  }

  // The status is written before the seq that publishes it.
  publish(wordIndex, seq, status) {
    if (this.released) return;
    const words = this.words();
    Atomics.store(words, wordIndex + 1, status);
    Atomics.store(words, wordIndex, seq);
    Atomics.notify(words, wordIndex);
  }

  // Device lost, core reload, replay fatal: nothing in flight will land.
  // Every slot is released up to its last recorded copy, once: after that
  // the instance is inert (a caller holding it must not write again).
  reset() {
    if (this.released) return;
    this.generation += 1;
    for (const [wordIndex, slot] of this.slots) {
      for (const entry of slot.entries.values()) {
        if (entry.buffer) {
          entry.buffer.unmap();
          entry.buffer.destroy();
        }
        if (entry.state === "pending") this.stats.lost += 1;
      }
      if (slot.entries.size > 0) this.publish(wordIndex, slot.recorded, READBACK_LOST);
    }
    this.slots.clear();
    this.released = true;
    for (const buffers of this.pool.values()) for (const b of buffers) b.destroy();
    this.pool.clear();
    this.pooledBytes = 0;
  }
}
