import assert from "node:assert/strict";
import test from "node:test";

import { widenU32Counter } from "../src/u32-counter.js";
import { UpstreamWorkerAdapter } from "../src/upstream-worker-adapter.js";

// What Emscripten's "number" return hands back for a u32 counter crossing
// 2^31 and then 2^32: the i32 bit pattern.
const I32_SAMPLES = [2_147_483_000, 2_147_483_647, -2_147_483_648, -1, 5, 1_000];
const TRUE_COUNTS = [2_147_483_000, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32 + 5, 2 ** 32 + 1_000];

test("a u32 counter read as i32 stays non-negative and monotonic across 2^31 and 2^32", () => {
  const widen = widenU32Counter();
  assert.deepEqual(I32_SAMPLES.map(widen), TRUE_COUNTS);
});

test("repeated samples and several wraps keep counting", () => {
  const widen = widenU32Counter();
  assert.equal(widen(10), 10);
  assert.equal(widen(10), 10);
  assert.equal(widen(3), 2 ** 32 + 3);
  assert.equal(widen(2), 2 * 2 ** 32 + 2);
});

test("the worker adapter reports the widened JIT block run count", () => {
  const adapter = new UpstreamWorkerAdapter();
  const seen = I32_SAMPLES.map((ppcWasmBlockRunCount) => {
    adapter.applyMetadata({ ppcWasmBlockRunCount });
    return adapter.ppcWasmBlockRunCount;
  });
  assert.deepEqual(seen, TRUE_COUNTS);
});
