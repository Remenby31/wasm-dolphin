// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// The disc's reads through WORKERFS, in blocks (task 4, patch 0151's
// counters). WORKERFS reads exactly what the DVD thread asks, ~15 KB a call,
// each one a FileReaderSync round trip: 12-46 ms per emulated second on a
// race and an intro, most of the emulation's disc stall. This reads aligned
// blocks (1 MiB) instead and keeps the last few (8: 8 MiB at most), so the
// next reads of the same region are a copy.

export const DISC_READAHEAD_BLOCK_BYTES = 1 << 20;
export const DISC_READAHEAD_BLOCKS = 8;

// A WORKERFS stream_ops.read in blocks. `readBlob(blob)` returns the bytes of
// a Blob slice (FileReaderSync in the worker). Stats: block reads (misses),
// copies served from the cache (hits), bytes held at most.
export function createDiscReadahead({ readBlob, blockBytes = DISC_READAHEAD_BLOCK_BYTES, maxBlocks = DISC_READAHEAD_BLOCKS }) {
  // Per file: blockIndex -> Uint8Array, in least-recently-used order.
  const files = new WeakMap();
  const stats = { blockReads: 0, blockHits: 0, bytesRead: 0, heldBytes: 0, maxHeldBytes: 0 };
  let held = [];

  function block(blob, size, index) {
    let blocks = files.get(blob);
    if (!blocks) files.set(blob, (blocks = new Map()));
    const cached = blocks.get(index);
    if (cached) {
      blocks.delete(index);
      blocks.set(index, cached);
      held = held.filter((h) => h.bytes !== cached);
      held.push({ blocks, index, bytes: cached });
      stats.blockHits += 1;
      return cached;
    }
    const start = index * blockBytes;
    const bytes = new Uint8Array(readBlob(blob.slice(start, Math.min(size, start + blockBytes))));
    stats.blockReads += 1;
    stats.bytesRead += bytes.length;
    blocks.set(index, bytes);
    held.push({ blocks, index, bytes });
    stats.heldBytes += bytes.length;
    while (held.length > maxBlocks) {
      const old = held.shift();
      old.blocks.delete(old.index);
      stats.heldBytes -= old.bytes.length;
    }
    stats.maxHeldBytes = Math.max(stats.maxHeldBytes, stats.heldBytes);
    return bytes;
  }

  function read(stream, buffer, offset, length, position) {
    const blob = stream.node.contents;
    const size = stream.node.size;
    if (position >= size) return 0;
    const end = Math.min(size, position + length);
    let at = position;
    let out = offset;
    while (at < end) {
      const index = Math.floor(at / blockBytes);
      const bytes = block(blob, size, index);
      const from = at - index * blockBytes;
      const count = Math.min(bytes.length - from, end - at);
      buffer.set(bytes.subarray(from, from + count), out);
      at += count;
      out += count;
    }
    return end - position;
  }

  return { read, stats };
}
