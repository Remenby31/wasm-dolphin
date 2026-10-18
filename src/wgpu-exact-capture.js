// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// Exact-frame capture for the hardware renderer (harness/README.md,
// validationCaptureAtVi). The picture lives on the GPU, so the frame identity
// has to travel with the command stream: when the harness hooks are on, the
// core emits one ViTag record (VI output index since boot and since the last
// load) on the video thread right before each ViSwap. The PRESENT that follows
// shows that output. A ViTag with no PRESENT before the next one is a
// duplicate XFB (Dolphin does not re-present it), so that output shows the
// last presented picture.
//
// This module is the matching logic only; the worker supplies the readback.
// It never answers with a frame other than the one asked for: a target that
// the stream has passed, or that a later tag skips over, is rejected.

export const WGPU_CAPTURE_SOURCE = "wgpu-present";

export function createWgpuExactCapture() {
  let current = null; // { boot, load, ticks, presented }
  let tagsSeen = 0;
  let pending = null; // { target, fromLoad, resolve, reject }

  const indexOf = (tag, fromLoad) => (fromLoad ? tag.load : tag.boot);

  function settle(tag, kind, readback) {
    const request = pending;
    pending = null;
    // Synchronously: the copy has to reach the queue before the replay
    // submits the next frame, which may overwrite the texture.
    let image;
    try {
      image = readback(kind);
    } catch (error) {
      request.reject(error);
      return;
    }
    Promise.resolve(image)
      .then((image) => request.resolve({
        index: request.target,
        fromLoad: request.fromLoad,
        ticks: tag.ticks,
        width: image.width,
        height: image.height,
        pixels: image.pixels,
        source: WGPU_CAPTURE_SOURCE,
      }), request.reject);
  }

  return {
    get tagsSeen() { return tagsSeen; },
    get pending() { return pending !== null; },
    // Latest VI output the stream has tagged, counted the way the request is.
    latestIndex(fromLoad) { return current ? indexOf(current, fromLoad) : 0; },

    // Returns a promise for the capture. Throws when the stream has already
    // shown the target, or another capture is outstanding.
    arm(target, fromLoad = false) {
      if (pending) throw new Error("a wgpu capture is already armed");
      if (current) {
        const now = indexOf(current, fromLoad);
        if (now > target || (now === target && current.presented)) {
          throw new Error(`VI output ${target} (${fromLoad ? "since load" : "since boot"}) has already passed`);
        }
      }
      return new Promise((resolve, reject) => {
        pending = { target, fromLoad: Boolean(fromLoad), resolve, reject };
      });
    },

    cancel(reason) {
      if (!pending) return;
      const request = pending;
      pending = null;
      request.reject(reason instanceof Error ? reason : new Error(String(reason)));
    },

    // A ViTag record. `readback(kind)` is called with "last" when the
    // previous output turned out to be a duplicate of the last presented
    // picture.
    onViTag(tag, readback) {
      tagsSeen += 1;
      const previous = current;
      current = { boot: tag.boot >>> 0, load: tag.load >>> 0, ticks: tag.ticks, presented: false };
      if (!pending) return;
      if (previous && !previous.presented && indexOf(previous, pending.fromLoad) === pending.target) {
        settle(previous, "last", readback);
        return;
      }
      const now = indexOf(current, pending.fromLoad);
      // A savestate load restarts the since-load count; a lower index is a
      // new timeline, not a skip.
      const restarted = pending.fromLoad && previous && current.load < previous.load;
      if (now > pending.target && !restarted) {
        const request = pending;
        pending = null;
        request.reject(new Error(`VI output ${request.target} was skipped`));
      }
    },

    // A SUBMIT_PRESENT that reached the queue. `readback("present")` reads
    // the texture the present just showed.
    onPresent(readback) {
      if (!current) return;
      current.presented = true;
      if (pending && indexOf(current, pending.fromLoad) === pending.target) {
        settle(current, "present", readback);
      }
    },
  };
}

// RGBA8 rows from a texture readback buffer (rows padded to 256 bytes).
export function packReadbackRows(bytes, width, height, bytesPerRow, bgra) {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = y * bytesPerRow;
    const dst = y * width * 4;
    if (!bgra) {
      out.set(bytes.subarray(src, src + width * 4), dst);
      continue;
    }
    for (let x = 0; x < width * 4; x += 4) {
      out[dst + x] = bytes[src + x + 2];
      out[dst + x + 1] = bytes[src + x + 1];
      out[dst + x + 2] = bytes[src + x];
      out[dst + x + 3] = bytes[src + x + 3];
    }
  }
  return out;
}
