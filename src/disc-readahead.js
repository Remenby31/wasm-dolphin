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
//
// Prefetch (patch 0155, with `readBlobAsync`): once a stream follows on, the
// next segment is read in the background (Blob.arrayBuffer: the worker's
// event loop, between two WebGPU drains) so the DVD thread finds it held. A
// read that reaches it while still in flight reads synchronously (a
// FileReaderSync cannot wait for a promise) and the late prefetch is dropped.

export const DISC_READAHEAD_MIN_BYTES = 64 << 10;
export const DISC_READAHEAD_MAX_BYTES = 1 << 20;
export const DISC_READAHEAD_HELD_BYTES = 8 << 20;

// A WORKERFS stream_ops.read reading ahead. `readBlob(blob)` returns the
// bytes of a Blob slice (FileReaderSync in the worker). Stats: segment reads
// (misses) and their bytes, copies served from what is held (hits), bytes
// held at most.
export function createDiscReadahead({
  readBlob,
  readBlobAsync = null,
  minBytes = DISC_READAHEAD_MIN_BYTES,
  maxBytes = DISC_READAHEAD_MAX_BYTES,
  heldBytes = DISC_READAHEAD_HELD_BYTES,
}) {
  const stats = {
    blockReads: 0, blockHits: 0, bytesRead: 0, heldBytes: 0, maxHeldBytes: 0,
    prefetchIssued: 0, prefetchUsed: 0, prefetchWasted: 0, syncMissInflight: 0, prefetchBytes: 0,
  };
  // Segments held, every file's together (oldest first): one cap for all,
  // so a disc change lets the previous disc's segments go first.
  const segments = [];
  // Per file: the read-ahead state.
  const files = new WeakMap();

  function stateOf(blob) {
    let f = files.get(blob);
    if (!f) files.set(blob, (f = { next: minBytes, lastEnd: -1, pending: null }));
    return f;
  }

  // Room for `incoming` bytes before they are read: the cap holds at every
  // moment, the new segment included.
  function evict(incoming) {
    while (stats.heldBytes + incoming > heldBytes && segments.length > 0) {
      const old = segments.shift();
      stats.heldBytes -= old.bytes.length;
      if (old.prefetched && !old.used) stats.prefetchWasted += 1;
    }
  }

  function hold(s) {
    evict(s.bytes.length);
    segments.push(s);
    stats.heldBytes += s.bytes.length;
    stats.maxHeldBytes = Math.max(stats.maxHeldBytes, stats.heldBytes);
  }

  function heldAt(blob, at) {
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const s = segments[i];
      if (s.blob === blob && at >= s.start && at < s.start + s.bytes.length) return s;
    }
    return null;
  }

  // The next segment of a stream, in the background: twice the last one, up
  // to maxBytes; one in flight per file.
  function prefetchFrom(f, blob, size, at) {
    if (!readBlobAsync || f.pending || at >= size || heldAt(blob, at)) return;
    f.next = Math.min(maxBytes, f.next * 2);
    const end = Math.min(size, at + f.next);
    const pending = { start: at, end };
    f.pending = pending;
    stats.prefetchIssued += 1;
    Promise.resolve(readBlobAsync(blob.slice(at, end))).then((buffer) => {
      if (f.pending === pending) f.pending = null;
      const bytes = new Uint8Array(buffer);
      // Read synchronously meanwhile, or nothing there: this one is dropped.
      if (heldAt(blob, at) || bytes.length === 0) {
        stats.prefetchWasted += 1;
        return;
      }
      stats.prefetchBytes += bytes.length;
      hold({ blob, start: at, bytes, prefetched: true, used: false });
    }, () => {
      if (f.pending === pending) f.pending = null;
    });
  }

  // The segment holding `at`, or a new one read from there; null when the
  // file gives nothing there (shorter than its node says).
  function segmentAt(blob, size, at) {
    const f = stateOf(blob);
    const held = heldAt(blob, at);
    if (held) {
      stats.blockHits += 1;
      // A prefetched segment in use: the stream goes on, fetch the next one.
      if (held.prefetched && !held.used) {
        held.used = true;
        stats.prefetchUsed += 1;
        f.lastEnd = held.start + held.bytes.length;
        prefetchFrom(f, blob, size, f.lastEnd);
      }
      return held;
    }
    if (f.pending && at >= f.pending.start && at < f.pending.end) stats.syncMissInflight += 1;
    // Following on from the last read: twice as far; anything else is a seek.
    const follows = at === f.lastEnd;
    f.next = follows ? Math.min(maxBytes, f.next * 2) : minBytes;
    const end = Math.min(size, at + f.next);
    evict(end - at);
    const bytes = new Uint8Array(readBlob(blob.slice(at, end)));
    if (bytes.length === 0) return null;
    const s = { blob, start: at, bytes };
    hold(s);
    f.lastEnd = at + bytes.length;
    stats.blockReads += 1;
    stats.bytesRead += bytes.length;
    if (follows) prefetchFrom(f, blob, size, f.lastEnd);
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
      // A short file: what was read, as WORKERFS's own read would return.
      if (!s) break;
      const from = at - s.start;
      const count = Math.min(s.bytes.length - from, end - at);
      buffer.set(s.bytes.subarray(from, from + count), out);
      at += count;
      out += count;
    }
    return at - position;
  }

  return { read, stats };
}
