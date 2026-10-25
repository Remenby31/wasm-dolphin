// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// ?presentvsync=1: the pool of backbuffer textures and the queue of frames
// waiting for the worker's rAF (research/deep-frame-pacing.md §5 step 2).
//
// One texture per FRAME, not per pass: the backbuffer pass can open more
// than once in a frame (SetFramebuffer / ClearRegion reopen pass 0 with
// load), and a frame can span two drains of the command ring. The frame's
// texture is taken at its first backbuffer pass, kept (across drains) for
// every later pass, and handed to the queue by its present. A present with
// no backbuffer pass since the previous one queues nothing (the picture has
// not changed), so a texture is never queued twice.
//
// The device is a parameter (`createTexture`): no WebGPU in the tests.

export function createVsyncQueue({ queueSize = 2, poolSize = queueSize + 1, createTexture } = {}) {
  let key = "";
  let free = [];
  let made = 0;
  let current = null;
  const queue = [];
  const stats = { queued: 0, shown: 0, dropped: 0, caughtUp: 0, presentNoPass: 0, overflow: 0 };

  const giveBack = (tex) => { if (tex) free.push(tex); };

  return {
    stats,
    get waiting() { return queue.length; },
    get current() { return current; },

    // The frame's texture for a backbuffer pass: the one this frame already
    // has, else a free one, else a new one while the pool allows, else the
    // oldest queued frame's (dropped, counted). `poolKey` names the size,
    // format and device: a new key drops the pool (resize, new device).
    textureForPass(poolKey, width, height) {
      if (poolKey !== key) {
        key = poolKey;
        free = [];
        made = 0;
        current = null;
        queue.length = 0;
      }
      if (current) return current;
      let tex = free.pop();
      if (!tex && made < poolSize) {
        tex = createTexture(width, height);
        made += 1;
      }
      if (!tex && queue.length) {
        tex = queue.shift().tex;
        stats.dropped += 1;
      }
      if (!tex) {
        // Nothing free and nothing queued: only if textures were lost
        // outside the pool. Never fail the drain: one more texture, counted.
        tex = createTexture(width, height);
        made += 1;
        stats.overflow += 1;
      }
      current = tex;
      return current;
    },

    // The frame's present: its texture joins the queue (the oldest frames
    // beyond `queueSize` are dropped, counted). Null when the frame had no
    // backbuffer pass (nothing new to show).
    queueFrame(meta) {
      if (!current) {
        stats.presentNoPass += 1;
        return null;
      }
      const frame = { ...meta, tex: current };
      current = null;
      stats.queued += 1;
      while (queue.length >= queueSize) {
        giveBack(queue.shift().tex);
        stats.dropped += 1;
      }
      queue.push(frame);
      return frame;
    },

    // At a BeginFrame `tick`: the frame to show, the oldest, after the
    // catch-up (a frame queued before the previous BeginFrame gives way to a
    // newer one). The caller copies it, then calls shown(frame).
    takeForDisplay(tick) {
      while (queue.length > 1 && queue[0].tick < tick - 1) {
        giveBack(queue.shift().tex);
        stats.dropped += 1;
        stats.caughtUp += 1;
      }
      return queue.shift() ?? null;
    },

    // After its copy is submitted (same GPU queue: it runs before any later
    // pass renders into the texture).
    shown(frame) {
      giveBack(frame.tex);
      stats.shown += 1;
    }
  };
}
