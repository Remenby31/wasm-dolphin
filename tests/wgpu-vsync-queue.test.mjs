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

// ?presentcatchup=soft: one vsync producer (a frame every BeginFrame) after a
// two-frame burst. The default catch-up drops the burst's second frame and the
// next BeginFrame has nothing new (a repeat); the soft one shows it.
function burstThenGap(softCatchUp) {
  const { q, frame } = harness({ queueSize: 2 });
  q.softCatchUp = softCatchUp;
  const shown = [];
  const show = (tick) => { const f = q.takeForDisplay(tick); if (f) q.shown(f); shown.push(f?.i ?? null); };
  frame(); q.queueFrame({ tick: 0, i: 0 });
  frame(); q.queueFrame({ tick: 0, i: 1 }); // the burst
  show(1);                                   // 0
  frame(); q.queueFrame({ tick: 1, i: 2 });
  show(2);                                   // 1 is late by one BeginFrame
  show(3);                                   // the gap after the burst
  return { q, shown };
}

test("soft catch-up: a frame late by one BeginFrame is shown, so the gap after a burst repeats nothing", () => {
  const hard = burstThenGap(false);
  assert.deepEqual(hard.shown, [0, 2, null], "default: 1 dropped, nothing new at tick 3");
  assert.equal(hard.q.stats.caughtUp, 1);
  const soft = burstThenGap(true);
  assert.deepEqual(soft.shown, [0, 1, 2], "soft: every frame shown, one vsync late for one frame");
  assert.equal(soft.q.stats.caughtUp, 0);
  assert.equal(soft.q.stats.shownLate, 1);
});

test("soft catch-up: a backlog that lasts is caught up at the next BeginFrame, never twice late in a row", () => {
  const { q, frame } = harness({ queueSize: 2 });
  q.softCatchUp = true;
  frame(); q.queueFrame({ tick: 0, i: 0 });
  frame(); q.queueFrame({ tick: 0, i: 1 });
  q.shown(q.takeForDisplay(1));                        // 0
  frame(); q.queueFrame({ tick: 1, i: 2 });
  assert.equal(q.takeForDisplay(2).i, 1, "late by one: shown");
  frame(); q.queueFrame({ tick: 2, i: 3 });
  // 2 is late by one again: the previous BeginFrame showed a late frame, so it goes
  assert.equal(q.takeForDisplay(3).i, 3);
  assert.equal(q.stats.caughtUp, 1);
  assert.equal(q.stats.shownLate, 1);
});

test("soft catch-up: a frame late by two BeginFrames still gives way, and takeNewest resets the streak", () => {
  const { q, frame } = harness({ queueSize: 2 });
  q.softCatchUp = true;
  frame(); q.queueFrame({ tick: 0, i: 0 });
  frame(); q.queueFrame({ tick: 3, i: 1 });
  const a = q.takeForDisplay(3);
  assert.equal(a.i, 1, "0 waited two BeginFrames");
  q.shown(a);
  assert.equal(q.stats.caughtUp, 1);
  frame(); q.queueFrame({ tick: 3, i: 2 });
  frame(); q.queueFrame({ tick: 4, i: 3 });
  const b = q.takeForDisplay(5);
  assert.equal(b.i, 2, "late by one, shown");
  q.shown(b);
  q.shown(q.takeNewest());
  frame(); q.queueFrame({ tick: 5, i: 4 });
  frame(); q.queueFrame({ tick: 6, i: 5 });
  assert.equal(q.takeForDisplay(7).i, 4, "after takeNewest a late frame may be shown again");
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

test("a new pool key destroys the free textures, never the queued ones or the current one", () => {
  const destroyed = [];
  let n = 0;
  const q = createVsyncQueue({ queueSize: 2, createTexture: () => ({ id: ++n }), destroyTexture: (t) => destroyed.push(t.id) });
  q.textureForPass("a", 1, 1); q.queueFrame({ tick: 0 });          // 1 queued
  q.shown(q.takeForDisplay(0));                                       // 1 free
  q.textureForPass("a", 1, 1); q.queueFrame({ tick: 0 });          // 1 queued again (reused)
  q.textureForPass("a", 1, 1);                                        // 2 current
  q.textureForPass("b", 1, 1);
  assert.deepEqual(destroyed, [], "nothing free: the queued (1) and current (2) are left to the GC");
  q.queueFrame({ tick: 0 });
  q.shown(q.takeForDisplay(0));                                       // 3 free under key b
  q.textureForPass("c", 1, 1);
  assert.deepEqual(destroyed, [3]);
});

test("an overflow with no BeginFrame coming is counted apart, not as a drop", () => {
  const { q, frame } = harness({ queueSize: 1 });
  frame(); q.queueFrame({ tick: 0 });
  frame(); q.queueFrame({ tick: 0 }, { hidden: true });
  assert.equal(q.stats.dropped, 0);
  assert.equal(q.stats.droppedNoBeginFrame, 1);
  frame(); q.queueFrame({ tick: 0 });
  assert.equal(q.stats.dropped, 1);
});

test("clear(): the device is gone, the queue and the frame in progress go", () => {
  const { q, frame } = harness();
  frame(); q.queueFrame({ tick: 0 });
  frame();
  q.clear();
  assert.equal(q.waiting, 0);
  assert.equal(q.current, null);
  assert.equal(q.takeForDisplay(5), null);
});

test("takeNewest: with no BeginFrame to wait for, the newest frame, older ones caught up", () => {
  const { q, frame } = harness({ queueSize: 2 });
  frame(); q.queueFrame({ tick: 7, i: 0 });
  frame(); q.queueFrame({ tick: 7, i: 1 });
  const f = q.takeNewest();
  assert.equal(f.i, 1);
  assert.equal(q.waiting, 0, "nothing left for a burst when the rAF comes back");
  assert.equal(q.stats.caughtUp, 1);
});

test("takeNewest({ hidden }): with no BeginFrame coming, the older frames are droppedNoBeginFrame, not drops", () => {
  const { q, frame } = harness({ queueSize: 2 });
  frame(); q.queueFrame({ tick: 1, i: 0 });
  frame(); q.queueFrame({ tick: 1, i: 1 });
  assert.equal(q.takeNewest({ hidden: true }).i, 1);
  assert.equal(q.stats.dropped, 0);
  assert.equal(q.stats.caughtUp, 0);
  assert.equal(q.stats.droppedNoBeginFrame, 1);
});

test("vsyncLateMs: the smallest frame-time delta is the period, a busy stretch cannot push it up", async () => {
  const { vsyncLateMs } = await import("../src/wgpu-vsync-queue.js");
  // 12 ticks 2 vsyncs apart (busy) and 4 at the vsync: the period is 16.7
  const busy = [...Array(12).fill(33.3), ...Array(4).fill(16.7)];
  assert.equal(vsyncLateMs(busy), 1.5 * 16.7);
  assert.equal(vsyncLateMs(Array(16).fill(6.94)), 12, "144 Hz: the 12 ms floor");
  assert.equal(vsyncLateMs(Array(16).fill(33.3)), 1.5 * 33.3, "30 Hz");
  assert.equal(vsyncLateMs([16.7, 16.7, 16.7]), 25, "fewer than 4 deltas: 25 ms");
  assert.equal(vsyncLateMs([0, -1, 16.7, 16.7, 16.7, 16.7]), 1.5 * 16.7, "non-positive deltas are left out");
});
