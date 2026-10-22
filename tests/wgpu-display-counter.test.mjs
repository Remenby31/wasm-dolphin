import assert from "node:assert/strict";
import test from "node:test";

import { createDisplayCounter, startDisplayLoop } from "../src/wgpu-display-counter.js";

test("one entry per BeginFrame: what was submitted since the previous one, the extra ones dropped", () => {
  const c = createDisplayCounter();
  c.beginFrame(0); // nothing submitted yet
  c.submit(10); c.beginFrame(16.7);
  c.submit(11); c.submit(12); c.submit(13); c.beginFrame(33.3); // a burst: 2 of 3 never reach the screen
  c.beginFrame(50);
  c.submit(14); c.beginFrame(66.7);
  const d = c.drain();
  assert.deepEqual(d.displayed.t, [0, 16.7, 33.3, 50, 66.7]);
  assert.deepEqual(d.displayed.submits, [0, 1, 3, 0, 1]);
  assert.deepEqual(d.displayed.vi, [-1, 10, 13, -1, 14], "the VI output actually shown");
  assert.equal(d.dropped, 2);
  assert.equal(d.displayedLost, 0);
  assert.deepEqual(c.drain().displayed.t, [], "drained once");
  assert.equal(c.drain().dropped, 2, "dropped is a running total");
});

test("a ring that wrapped reports what it lost", () => {
  const c = createDisplayCounter({ capacity: 2 });
  for (let i = 0; i < 5; i += 1) { c.submit(i); c.beginFrame(i); }
  const d = c.drain();
  assert.deepEqual(d.displayed.t, [3, 4]);
  assert.equal(d.displayedLost, 3);
});

test("the loop runs on rAF timestamps in the harness clock and stops", () => {
  const c = createDisplayCounter();
  const queue = [];
  const stop = startDisplayLoop(c, { raf: (fn) => queue.push(fn), timeOrigin: 1000 });
  c.submit(1);
  queue.shift()(16);
  assert.deepEqual(c.drain().displayed.t, [1016]);
  stop();
  queue.shift()(32);
  assert.equal(queue.length, 0, "no new request after stop");
  assert.equal(startDisplayLoop(c, { raf: undefined }), null, "no rAF in this worker: nothing runs");
});
