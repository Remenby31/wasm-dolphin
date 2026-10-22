// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { createUniqueFrameCounter, hashRows, MAX_IN_FLIGHT, sampleRowOffsets } from "../src/harness-unique-frames.js";

test("unique frames: rows spread over the rectangle, hash over each row's pixels only", () => {
  assert.deepEqual(sampleRowOffsets(480), [30, 90, 150, 210, 270, 330, 390, 450]);
  assert.deepEqual(sampleRowOffsets(3), [0, 1, 2]);
  // Row padding (bytesPerRow past the row's pixels) never changes the hash.
  const a = new Uint8Array(2 * 256), b = new Uint8Array(2 * 256);
  a.fill(7, 0, 8); b.fill(7, 0, 8); b[200] = 99;
  a.fill(3, 256, 264); b.fill(3, 256, 264);
  assert.equal(hashRows(a, 8, 256, 2), hashRows(b, 8, 256, 2));
  b[257] = 4;
  assert.notEqual(hashRows(a, 8, 256, 2), hashRows(b, 8, 256, 2));
});

test("unique frames: new images counted in present order, whatever order the readbacks end in", async () => {
  let clock = 0;
  const c = createUniqueFrameCounter({ now: () => clock });
  assert.equal(c.active, false);
  c.onPresent(() => Promise.resolve(1)); // off: ignored
  c.start();
  // Images A A B B B C over 6 presents; readbacks resolve in reverse order.
  const resolvers = [];
  for (const h of [1, 1, 2, 2, 2, 3]) c.onPresent(() => new Promise((r) => resolvers.push(() => r(h))));
  assert.equal(resolvers.length, MAX_IN_FLIGHT);
  resolvers.reverse().forEach((r) => r());
  clock = 1000;
  const r = await c.stop();
  assert.equal(r.presents, 6);
  assert.equal(r.compared, 5);
  assert.equal(r.changed, 2);
  assert.equal(r.uniqueShare, 0.4);
  assert.equal(r.presentsPerSecond, 6);
  assert.equal(r.uniquePerSecond, 2.4);
  assert.equal(c.active, false);
});

test("unique frames: presents past the in-flight cap and failed readbacks break the chain, never count as new", async () => {
  let clock = 0;
  const c = createUniqueFrameCounter({ now: () => clock });
  c.start();
  const pending = [];
  for (let i = 0; i < MAX_IN_FLIGHT; i += 1) c.onPresent(() => new Promise((r) => pending.push(() => r(5))));
  c.onPresent(() => Promise.resolve(9)); // over the cap: skipped
  pending.forEach((r) => r());
  await new Promise((r) => setTimeout(r, 0));
  c.onPresent(() => Promise.resolve(9)); // after the gap: no comparison with the 5s
  c.onPresent(() => { throw new Error("no presented WebGPU texture to sample"); });
  c.onPresent(() => Promise.resolve(9));
  clock = 2000;
  const r = await c.stop();
  assert.equal(r.skipped, 1);
  assert.equal(r.errors, 1);
  assert.match(r.lastError, /no presented WebGPU texture/);
  assert.equal(r.compared, MAX_IN_FLIGHT - 1);
  assert.equal(r.changed, 0);
  assert.equal(r.uniqueShare, 0);
  assert.match((await createUniqueFrameCounter().stop()).error, /not started/);
});
