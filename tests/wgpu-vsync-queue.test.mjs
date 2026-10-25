// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { createVsyncQueue } from "../src/wgpu-vsync-queue.js";

// ?presentvsync=1's pool and queue with a fake device: textures are numbered.
function harness({ queueSize = 2 } = {}) {
  let n = 0;
  const q = createVsyncQueue({ queueSize, createTexture: (width, height) => ({ id: ++n, width, height }) });
  const frame = (key = "640x480:bgra8unorm:1") => q.textureForPass(key, 640, 480);
  return { q, frame, made: () => n };
}

test("one texture per frame: a second backbuffer pass in the frame reuses it", () => {
  const { q, frame } = harness();
  const a = frame();
  assert.equal(frame(), a, "pass 0 reopened (SetFramebuffer / ClearRegion) in the same frame");
  q.queueFrame({ tick: 0 });
  assert.notEqual(frame(), a, "the next frame gets another texture");
});

test("a frame spanning two drains keeps its texture until its present", () => {
  const { q, frame } = harness();
  const a = frame();       // drain 1: the pass, no present
  assert.equal(q.current, a);
  assert.equal(frame(), a); // drain 2: a later pass of the same frame
  const f = q.queueFrame({ tick: 0 });
  assert.equal(f.tex, a);
  assert.equal(q.current, null);
});

test("a present without a backbuffer pass queues nothing (never the same texture twice)", () => {
  const { q, frame } = harness();
  frame();
  assert.ok(q.queueFrame({ tick: 0 }));
  assert.equal(q.queueFrame({ tick: 0 }), null);
  assert.equal(q.stats.presentNoPass, 1);
  assert.equal(q.waiting, 1);
  const shown = q.takeForDisplay(1);
  q.shown(shown);
  // the free list has that texture once: two frames get two textures
  const b = frame(); q.queueFrame({ tick: 1 });
  const c = frame();
  assert.notEqual(b, c);
});

test("a full queue drops its oldest frame, counted, and keeps queueSize frames", () => {
  const { q, frame } = harness({ queueSize: 2 });
  const ids = [];
  for (let i = 0; i < 3; i += 1) { ids.push(frame().id); q.queueFrame({ tick: 0, i }); }
  assert.equal(q.waiting, 2);
  assert.equal(q.stats.dropped, 1);
  assert.equal(q.takeForDisplay(0).i, 1, "the oldest (0) went");
});

test("theft: with every texture made and none free, the oldest queued frame gives its texture up", () => {
  const { q, frame, made } = harness({ queueSize: 2 }); // pool of 3
  const a = frame(); q.queueFrame({ tick: 0, i: 0 });
  frame(); q.queueFrame({ tick: 0, i: 1 });
  const c = frame();                                   // third texture, the pool is full
  assert.equal(made(), 3);
  q.queueFrame({ tick: 0, i: 2 });                     // queue full: frame 0 dropped, its texture freed
  assert.equal(frame(), a, "the freed texture, no fourth");
  assert.equal(made(), 3);
  assert.notEqual(c, a);
});

test("no texture free and nothing queued (textures lost outside): one more, counted, never a crash", () => {
  let n = 0;
  const q = createVsyncQueue({ queueSize: 2, poolSize: 1, createTexture: () => ({ id: ++n }) });
  q.textureForPass("k", 1, 1);
  q.queueFrame({ tick: 0 });
  q.takeForDisplay(0);       // taken, never given back (a lost texture)
  q.textureForPass("k", 1, 1);
  assert.equal(q.stats.overflow, 1);
  assert.equal(n, 2);
});

test("catch-up: a frame queued before the previous BeginFrame gives way to a newer one", () => {
  const { q, frame } = harness({ queueSize: 2 });
  frame(); q.queueFrame({ tick: 3, i: 0 });
  frame(); q.queueFrame({ tick: 5, i: 1 });
  const f = q.takeForDisplay(5);
  assert.equal(f.i, 1);
  assert.equal(q.stats.caughtUp, 1);
  // a burst queued in this BeginFrame is shown in order
  frame(); q.queueFrame({ tick: 5, i: 2 });
  frame(); q.queueFrame({ tick: 5, i: 3 });
  assert.equal(q.takeForDisplay(5).i, 2);
});

test("a new pool key (resize, format, device) drops the pool, the queue and the current frame", () => {
  const { q, frame, made } = harness();
  frame(); q.queueFrame({ tick: 0 });
  frame();
  const t = frame("1280x960:bgra8unorm:1");
  assert.equal(q.waiting, 0);
  assert.equal(made(), 3);
  assert.equal(t.id, 3);
  assert.equal(frame("1280x960:bgra8unorm:2").id, 4, "another device: its own textures");
});
