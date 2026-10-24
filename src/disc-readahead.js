// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// The disc's reads through WORKERFS, ahead of the DVD thread (task 4, patch
// 0151's counters). WORKERFS reads exactly what is asked, ~15 KB a call, each
// one a FileReaderSync round trip: 12-46 ms per emulated second on a race and
// an intro, most of the emulation's disc stall. This reads ahead instead:
// 64 KiB after a seek, doubling while the reads follow on (up to 1 MiB), so a
// stream costs a few big reads and a first boot (scattered small reads) does
// not pay for 1 MiB blocks it never uses. The last segments are kept, 8 MiB
// at most, oldest out first.

export const DISC_READAHEAD_MIN_BYTES = 64 << 10;
export const DISC_READAHEAD_MAX_BYTES = 1 << 20;
export const DISC_READAHEAD_HELD_BYTES = 8 << 20;

// A WORKERFS stream_ops.read reading ahead. `readBlob(blob)` returns the
// bytes of a Blob slice (FileReaderSync in the worker). Stats: segment reads
// (misses) and their bytes, copies served from what is held (hits), bytes
// held at most.
export function createDiscReadahead({
  readBlob,
  minBytes = DISC_READAHEAD_MIN_BYTES,
  maxBytes = DISC_READAHEAD_MAX_BYTES,
  heldBytes = DISC_READAHEAD_HELD_BYTES,
}) {
  const stats = { blockReads: 0, blockHits: 0, bytesRead: 0, heldBytes: 0, maxHeldBytes: 0 };
  // Per file: segments held (oldest first) and the read-ahead state.
  const files = new WeakMap();

  function stateOf(blob) {
    let f = files.get(blob);
    if (!f) files.set(blob, (f = { segments: [], next: minBytes, lastEnd: -1 }));
    return f;
  }

  // Room for `incoming` bytes before they are read: the cap holds at every
  // moment, the new segment included.
  function evict(f, incoming) {
    while (stats.heldBytes + incoming > heldBytes && f.segments.length > 0) {
      stats.heldBytes -= f.segments.shift().bytes.length;
    }
  }

  // The segment holding `at`, or a new one read from there.
  function segmentAt(blob, size, at) {
    const f = stateOf(blob);
    for (let i = f.segments.length - 1; i >= 0; i -= 1) {
      const s = f.segments[i];
      if (at >= s.start && at < s.start + s.bytes.length) {
        stats.blockHits += 1;
        return s;
      }
    }
    // Following on from the last read: twice as far; anything else is a seek.
    f.next = at === f.lastEnd ? Math.min(maxBytes, f.next * 2) : minBytes;
    const end = Math.min(size, at + f.next);
    evict(f, end - at);
    const bytes = new Uint8Array(readBlob(blob.slice(at, end)));
    const s = { start: at, bytes };
    f.segments.push(s);
    f.lastEnd = at + bytes.length;
    stats.blockReads += 1;
    stats.bytesRead += bytes.length;
    stats.heldBytes += bytes.length;
    stats.maxHeldBytes = Math.max(stats.maxHeldBytes, stats.heldBytes);
    return s;
  }

  function read(stream, buffer, offset, length, position) {
    const blob = stream.node.contents;
    const size = stream.node.size;
    if (position >= size) return 0;
    const end = Math.min(size, position + length);
    let at = position;
    let out = offset;
    while (at < end) {
      const s = segmentAt(blob, size, at);
      const from = at - s.start;
      const count = Math.min(s.bytes.length - from, end - at);
      buffer.set(s.bytes.subarray(from, from + count), out);
      at += count;
      out += count;
    }
    return end - position;
  }

  return { read, stats };
}
