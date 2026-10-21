// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { createStatusRateLimiter } from "../src/status-rate-limit.js";

// A fake clock: `advance(ms)` moves it.
function harness(options = {}) {
  let t = 0;
  const emitted = [];
  const limiter = createStatusRateLimiter({ emit: (m) => emitted.push(m), now: () => t, ...options });
  const relayed = [];
  return {
    limiter, emitted, relayed,
    push: (m) => { if (limiter.push(m)) relayed.push(m); },
    advance(ms) { t += ms; }
  };
}

test("status relay: consecutive identical lines are folded into one count", () => {
  const h = harness();
  h.push("Invalid read from 0xbd420186");
  for (let i = 0; i < 999_999; i += 1) h.push("Invalid read from 0xbd420186");
  assert.deepEqual(h.relayed, ["Invalid read from 0xbd420186"]); // one relayed line, not a million
  assert.deepEqual(h.emitted, []);
  h.advance(1000); // still looping: the count goes out once per window
  h.push("Invalid read from 0xbd420186");
  assert.deepEqual(h.emitted, ["… repeated 1000000 times: Invalid read from 0xbd420186"]);
  h.push("next");
  assert.deepEqual(h.relayed, ["Invalid read from 0xbd420186", "next"]);
  assert.deepEqual(h.limiter.stats(), { relayed: 3, folded: 1_000_000, dropped: 0 });
});

test("status relay: the repeat count comes before a different line", () => {
  const h = harness();
  h.push("a"); h.push("a"); h.push("a"); h.push("b");
  assert.deepEqual(h.relayed, ["a", "b"]);
  assert.deepEqual(h.emitted, ["… repeated 2 times: a"]);
});

test("status relay: over the rate cap lines are counted, one summary per window", () => {
  const h = harness({ maxPerWindow: 5, windowMs: 1000 });
  for (let i = 0; i < 50; i += 1) h.push(`line ${i}`); // all different, in one window
  assert.equal(h.relayed.length, 5);
  h.advance(1000);
  h.push("after"); // the window rolled: the summary, then relayed again
  assert.deepEqual(h.emitted, ["[status] 45 line(s) not relayed in 1000 ms (rate cap 5 per 1000 ms)"]);
  assert.equal(h.relayed.at(-1), "after");
  h.push("x"); h.limiter.flush(); // flush: nothing pending but a fresh window
  assert.equal(h.emitted.length, 1);
});

test("status relay: fatal lines always go through, and the core's quiet output is untouched", () => {
  const h = harness({ maxPerWindow: 1, isFatal: (m) => /abort/.test(m) });
  h.push("boot"); h.push("over the cap");
  h.push("Emscripten abort: x");
  assert.deepEqual(h.relayed, ["boot", "Emscripten abort: x"]);
  const quiet = harness();
  ["boot", "disc mounted", "core loaded"].forEach((m) => quiet.push(m));
  assert.deepEqual(quiet.relayed, ["boot", "disc mounted", "core loaded"]);
  quiet.advance(5000);
  quiet.limiter.flush();
  assert.deepEqual(quiet.emitted, []);
});
