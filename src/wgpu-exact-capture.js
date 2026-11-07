// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// Exact-frame capture for the hardware renderer (harness/README.md,
// validationCaptureAtVi). The picture lives on the GPU, so the frame identity
// has to travel with the command stream: when the harness hooks are on, the
// core emits one ViTag record (VI output index since boot and since the last
// load, ticks, savestate load generation) on the video thread right before
// each ViSwap, and a PresentSource record with the XFB rectangle the
// presenter's blit samples. The PRESENT that follows a tag shows that output.
// A ViTag with no PRESENT before the next one is a duplicate XFB (Dolphin
// does not re-present it), so that output shows the last tagged picture.
//
// This module is the matching logic only; the worker supplies the readback.
// It never answers with a frame other than the one asked for: a target the
// stream has passed or skipped is rejected, and so is any request a savestate
// load overtakes. Only presents tagged in the request's load generation count;
// an untagged present (the ImmediateSwap that shows a restored state) never
// does.

export const WGPU_CAPTURE_SOURCE = "wgpu-present";

export function createWgpuExactCapture() {
  let current = null; // { boot, load, ticks, generation, presented }
  let lastPresented = null; // the tag whose picture is on screen, or null
  let tagsSeen = 0;
  let pending = null; // the request waiting for its VI output
  let nextId = 1;
  const open = new Map(); // id -> request, until resolved or rejected

  const indexOf = (tag, fromLoad) => (fromLoad ? tag.load : tag.boot);

  function finish(request, error, value) {
    if (!open.delete(request.id)) return;
    if (pending === request) pending = null;
    if (error) request.reject(error);
    else request.resolve(value);
  }

  function settle(request, tag, kind, readback) {
    // The request leaves `pending` (later tags must not judge it) but stays
    // open until its readback lands, so a timeout can still reject it.
    pending = null;
    let image;
    try {
      // Synchronously: the copy has to reach the queue before the replay
      // submits the next frame, which may overwrite the texture.
      image = readback(kind);
    } catch (error) {
      finish(request, error);
      return;
    }
    Promise.resolve(image).then((img) => finish(request, null, {
      index: request.target,
      fromLoad: request.fromLoad,
      ticks: tag.ticks,
      width: img.width,
      height: img.height,
      pixels: img.pixels,
      source: WGPU_CAPTURE_SOURCE,
    }), (error) => finish(request, error));
  }

  return {
    get tagsSeen() { return tagsSeen; },
    get pending() { return pending !== null; },
    get open() { return open.size; },

    // `generation` is the core's savestate load generation when the request
    // is made. Returns { id, promise }. Throws when the stream has already
    // shown the target in that generation, or another capture is waiting.
    arm(target, fromLoad = false, generation = 0) {
      if (pending) throw new Error("a wgpu capture is already armed");
      if (current && current.generation === generation) {
        const now = indexOf(current, fromLoad);
        if (now > target || (now === target && current.presented)) {
          throw new Error(`VI output ${target} (${fromLoad ? "since load" : "since boot"}) has already passed`);
        }
      }
      const request = { id: nextId++, target, fromLoad: Boolean(fromLoad), generation };
      const promise = new Promise((resolve, reject) => {
        request.resolve = resolve;
        request.reject = reject;
      });
      open.set(request.id, request);
      pending = request;
      return { id: request.id, promise };
    },

    // Rejects request `id` if it is still open; never touches another one.
    cancel(id, reason) {
      const request = open.get(id);
      if (request) finish(request, reason instanceof Error ? reason : new Error(String(reason)));
    },

    // The VI output (since boot) the next present shows: the last ViTag, or
    // null before the first one (a core without tags, harness off).
    currentBoot() {
      return current ? current.boot : null;
    },

    // The VI output since the last load the next present shows (null before
    // a tag): what a capture's fromLoad index names.
    currentLoad() {
      return current ? current.load : null;
    },

    // A savestate load finished: every waiting request belongs to the
    // replaced timeline, and nothing on screen is attributable any more.
    onLoad() {
      current = null;
      lastPresented = null;
      if (pending) finish(pending, new Error("a savestate load replaced the timeline before the capture"));
    },

    // A ViTag record. `readback(kind)` is called with "last" when the
    // previous output turned out to be a duplicate of the last tagged picture.
    onViTag(tag, readback) {
      tagsSeen += 1;
      const previous = current;
      current = {
        boot: tag.boot >>> 0, load: tag.load >>> 0, ticks: tag.ticks,
        generation: tag.generation >>> 0, presented: false,
      };
      const request = pending;
      if (!request) return;
      if (current.generation !== request.generation) {
        // Older: a tag the ring held from before the load; it decides nothing.
        if (current.generation > request.generation) {
          finish(request, new Error("a savestate load replaced the timeline before the capture"));
        }
        return;
      }
      if (previous && !previous.presented && previous.generation === request.generation &&
          indexOf(previous, request.fromLoad) === request.target) {
        if (!lastPresented || lastPresented.generation !== request.generation) {
          finish(request, new Error(`VI output ${request.target} repeats a picture no tagged present showed`));
          return;
        }
        settle(request, previous, "last", readback);
        return;
      }
      if (indexOf(current, request.fromLoad) > request.target) {
        finish(request, new Error(`VI output ${request.target} was skipped`));
      }
    },

    // A SUBMIT_PRESENT that reached the queue. `readback("present")` reads
    // what that present showed.
    onPresent(readback) {
      if (!current || current.presented) {
        // Untagged: what is on screen now has no VI output.
        lastPresented = null;
        return;
      }
      current.presented = true;
      lastPresented = current;
      const request = pending;
      if (request && current.generation === request.generation &&
          indexOf(current, request.fromLoad) === request.target) {
        settle(request, current, "present", readback);
      }
    },
  };
}

// The part of a `width`×`height` texture the presenter's blit samples, as a
// copy region. Returns null when the rectangle is missing or empty.
export function clampSourceRect(rect, width, height) {
  if (!rect) return null;
  const x = Math.min(Math.max(0, rect.x | 0), width);
  const y = Math.min(Math.max(0, rect.y | 0), height);
  const w = Math.min(Math.max(0, rect.w | 0), width - x);
  const h = Math.min(Math.max(0, rect.h | 0), height - y);
  return w > 0 && h > 0 ? { x, y, w, h } : null;
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
