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
// The device is a parameter (`createTexture`, `destroyTexture`): no WebGPU in
// the tests.

// The delay after which the presenter's rAF counts as late: 1.5 x the
// display's frame period, at least `floor`; `fallback` before there are 4
// deltas. The period is the SMALLEST rAF frame-time delta of the window:
// frame times fall on vsyncs, so a delta is a whole number of periods and
// the smallest one is the period, which a busy stretch (ticks 2 or 3 vsyncs
// apart) cannot push up (review of #274).
export function vsyncLateMs(deltas, { floor = 12, fallback = 25 } = {}) {
  const valid = deltas.filter((d) => d > 0);
  if (valid.length < 4) return fallback;
  return Math.max(floor, 1.5 * Math.min(...valid));
}

export function createVsyncQueue({ queueSize = 2, poolSize = queueSize + 1, softCatchUp = false, createTexture, destroyTexture = () => {} } = {}) {
  let key = "";
  // ?presentcatchup=soft: the frame takeForDisplay showed last was late.
  let shownLate = false;
  let free = [];
  let made = 0;
  let current = null;
  const queue = [];
  // droppedNoBeginFrame: frames dropped while no BeginFrame came for 50 ms
  // (a hidden tab, or a visible stall: the drop-meter counts what the screen
  // missed then), kept apart from drops at a BeginFrame.
  const stats = { queued: 0, shown: 0, dropped: 0, droppedNoBeginFrame: 0, caughtUp: 0, presentNoPass: 0, overflow: 0, shownLate: 0 };

  const giveBack = (tex) => { if (tex) free.push(tex); };

  return {
    stats,
    get waiting() { return queue.length; },
    get current() { return current; },
    get softCatchUp() { return softCatchUp; },
    set softCatchUp(on) { softCatchUp = Boolean(on); },

    // The frame's texture for a backbuffer pass: the one this frame already
    // has, else a free one, else a new one while the pool allows, else the
    // oldest queued frame's (dropped, counted). `poolKey` names the size,
    // format and device: a new key drops the pool (resize, new device).
    textureForPass(poolKey, width, height) {
      if (poolKey !== key) {
        key = poolKey;
        // The free textures go now; the queued ones and the frame's current
        // one may still be referenced by commands not yet submitted: left
        // to the GC.
        for (const tex of free) destroyTexture(tex);
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
    // beyond `queueSize` are dropped, counted, as droppedNoBeginFrame when
    // `hidden`: no BeginFrame comes). Null when the frame had no backbuffer
    // pass (nothing new to show).
    queueFrame(meta, { hidden = false } = {}) {
      if (!current) {
        stats.presentNoPass += 1;
        return null;
      }
      const frame = { ...meta, tex: current };
      current = null;
      stats.queued += 1;
      while (queue.length >= queueSize) {
        giveBack(queue.shift().tex);
        if (hidden) stats.droppedNoBeginFrame += 1;
        else stats.dropped += 1;
      }
      queue.push(frame);
      return frame;
    },

    // At a BeginFrame `tick`: the frame to show, the oldest, after the
    // catch-up (a frame queued before the previous BeginFrame gives way to a
    // newer one). The caller copies it, then calls shown(frame).
    // softCatchUp (?presentcatchup=soft): a frame late by one BeginFrame
    // only (queued between the two previous ones) is shown, not dropped,
    // unless the previous BeginFrame showed a late frame too: dropping it
    // left the next BeginFrame with nothing new, a repeat on screen. A
    // backlog that lasts is still caught up, one vsync later at most.
    takeForDisplay(tick) {
      const keep = softCatchUp && !shownLate ? tick - 2 : tick - 1;
      while (queue.length > 1 && queue[0].tick < keep) {
        giveBack(queue.shift().tex);
        stats.dropped += 1;
        stats.caughtUp += 1;
      }
      const f = queue.shift() ?? null;
      shownLate = Boolean(f && queue.length && f.tick < tick - 1);
      if (shownLate) stats.shownLate += 1;
      return f;
    },

    // The device is gone: forget the queue and the frame in progress (their
    // textures die with the device).
    clear() {
      queue.length = 0;
      current = null;
      shownLate = false;
      free = [];
      made = 0;
      key = "";
    },

    // With no BeginFrame to wait for (the presenter's rAF is late or
    // silent): the newest frame, the older ones dropped as caught up, so a
    // silent rAF never leaves the display a frame behind and leaves nothing
    // to show in a burst when it comes back.
    // `hidden`: no BeginFrame comes (a hidden tab): the older frames could
    // not have been shown, counted as droppedNoBeginFrame, not as drops.
    takeNewest({ hidden = false } = {}) {
      shownLate = false;
      while (queue.length > 1) {
        giveBack(queue.shift().tex);
        if (hidden) {
          stats.droppedNoBeginFrame += 1;
        } else {
          stats.dropped += 1;
          stats.caughtUp += 1;
        }
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
