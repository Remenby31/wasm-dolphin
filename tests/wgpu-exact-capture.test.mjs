// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { clampSourceRect, createWgpuExactCapture, packReadbackRows, WGPU_CAPTURE_SOURCE } from "../src/wgpu-exact-capture.js";

const tag = (boot, load = boot, ticks = boot * 1000, generation = 0) => ({ boot, load, ticks, generation });
const arm = (c, ...args) => c.arm(...args).promise;
const image = (label) => ({ width: 1, height: 1, pixels: new Uint8Array([label, 0, 0, 255]) });

function reads() {
  const calls = [];
  let n = 0;
  return { calls, readback: (kind) => { calls.push(kind); return image(++n); } };
}

test("the PRESENT that follows the tagged VI output is the capture", async () => {
  const c = createWgpuExactCapture();
  const r = reads();
  c.onViTag(tag(9), r.readback); c.onPresent(r.readback);
  const capture = arm(c, 10);
  c.onViTag(tag(10, 4, 10_000), r.readback);
  assert.deepEqual(r.calls, [], "nothing read before the present");
  c.onPresent(r.readback);
  const got = await capture;
  assert.deepEqual(r.calls, ["present"]);
  assert.equal(got.index, 10);
  assert.equal(got.ticks, 10_000);
  assert.equal(got.source, WGPU_CAPTURE_SOURCE);
  assert.equal(got.pixels[0], 1);
});

test("a duplicate XFB output is the last presented picture", async () => {
  const c = createWgpuExactCapture();
  const r = reads();
  const capture = arm(c, 12);
  c.onViTag(tag(11), r.readback); c.onPresent(r.readback);
  c.onViTag(tag(12), r.readback); // no PRESENT: duplicate
  assert.deepEqual(r.calls, []);
  c.onViTag(tag(13), r.readback);
  const got = await capture;
  assert.deepEqual(r.calls, ["last"]);
  assert.equal(got.index, 12);
});

test("a skipped output is rejected, never answered with a neighbour", async () => {
  const c = createWgpuExactCapture();
  const r = reads();
  const capture = arm(c, 20);
  c.onViTag(tag(19), r.readback); c.onPresent(r.readback);
  c.onViTag(tag(21), r.readback); c.onPresent(r.readback);
  await assert.rejects(capture, /VI output 20 was skipped/);
  assert.deepEqual(r.calls, []);
});

test("an output the stream already showed is rejected at arm time", () => {
  const c = createWgpuExactCapture();
  const r = reads();
  c.onViTag(tag(30), r.readback); c.onPresent(r.readback);
  assert.throws(() => arm(c, 30), /already passed/);
  assert.throws(() => arm(c, 29), /already passed/);
  c.onViTag(tag(31), r.readback);
  // Tagged but not yet presented: still capturable.
  const pending = arm(c, 31);
  c.onPresent(r.readback);
  return pending;
});

test("since-load indices of a new load generation are judged in that generation", async () => {
  const c = createWgpuExactCapture();
  const r = reads();
  c.onViTag(tag(100, 50, 0, 1), r.readback); c.onPresent(r.readback);
  c.onLoad();
  const capture = arm(c, 3, true, 2);
  c.onViTag(tag(101, 1, 0, 2), r.readback); c.onPresent(r.readback);
  c.onViTag(tag(102, 2, 0, 2), r.readback); c.onPresent(r.readback);
  c.onViTag(tag(103, 3, 7, 2), r.readback); c.onPresent(r.readback);
  const got = await capture;
  assert.equal(got.index, 3);
  assert.equal(got.fromLoad, true);
  assert.equal(got.ticks, 7);
});

test("a failed readback rejects the request and frees it", async () => {
  const c = createWgpuExactCapture();
  const capture = arm(c, 5);
  c.onViTag(tag(5), () => image(0));
  c.onPresent(() => { throw new Error("no presented WebGPU texture to read back"); });
  await assert.rejects(capture, /no presented WebGPU texture/);
  assert.equal(c.pending, false);
  assert.equal(c.open, 0);
});

test("readback rows drop the 256-byte padding and swap BGRA", () => {
  const bytes = new Uint8Array(256 * 2);
  bytes.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
  bytes.set([9, 10, 11, 12, 13, 14, 15, 16], 256);
  assert.deepEqual([...packReadbackRows(bytes, 2, 2, 256, false)],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual([...packReadbackRows(bytes, 2, 1, 256, true)], [3, 2, 1, 4, 7, 6, 5, 8]);
});

// Review P1: the capture is the presented rectangle, not the whole texture.
test("the copy region is the presenter's source rectangle, clamped to the texture", () => {
  assert.deepEqual(clampSourceRect({ x: 0, y: 0, w: 640, h: 448 }, 640, 480), { x: 0, y: 0, w: 640, h: 448 });
  assert.deepEqual(clampSourceRect({ x: 8, y: 16, w: 640, h: 480 }, 640, 480), { x: 8, y: 16, w: 632, h: 464 });
  assert.equal(clampSourceRect({ x: 700, y: 0, w: 10, h: 10 }, 640, 480), null);
  assert.equal(clampSourceRect(null, 640, 480), null);
});

// Review P1: after a load, an untagged ImmediateSwap must not answer a
// request with the previous VI output's index and ticks.
test("a savestate load rejects the waiting capture and untagged presents never count", async () => {
  const c = createWgpuExactCapture();
  const r = reads();
  const before = arm(c, 12, false, 0);
  c.onViTag(tag(11), r.readback); c.onPresent(r.readback);
  c.onViTag(tag(12), r.readback); // duplicate: no present yet
  c.onLoad();
  await assert.rejects(before, /savestate load replaced the timeline/);
  c.onPresent(r.readback); // the ImmediateSwap showing the restored state
  // Tags still in the ring from before the load decide nothing.
  const after = arm(c, 13, false, 1);
  c.onViTag(tag(13, 13, 0, 0), r.readback); c.onPresent(r.readback);
  assert.deepEqual(r.calls, []);
  c.onViTag(tag(13, 1, 99, 1), r.readback); c.onPresent(r.readback);
  const got = await after;
  assert.equal(got.ticks, 99);
  assert.deepEqual(r.calls, ["present"]);
});

test("a duplicate output whose last picture was untagged is rejected", async () => {
  const c = createWgpuExactCapture();
  const r = reads();
  const capture = arm(c, 6, false, 0);
  c.onViTag(tag(5), r.readback); c.onPresent(r.readback);
  c.onPresent(r.readback); // second, untagged present
  c.onViTag(tag(6), r.readback);
  c.onViTag(tag(7), r.readback);
  await assert.rejects(capture, /repeats a picture no tagged present showed/);
});

test("a tag from a newer load generation rejects a request from the older one", async () => {
  const c = createWgpuExactCapture();
  const r = reads();
  const capture = arm(c, 50, false, 0);
  c.onViTag(tag(40, 1, 0, 1), r.readback);
  await assert.rejects(capture, /savestate load replaced the timeline/);
});

// Review P2: the timeout belongs to its own request, even mid-readback.
test("cancelling a capture whose readback is in flight rejects that capture only", async () => {
  const c = createWgpuExactCapture();
  let release;
  const slow = () => new Promise((resolve) => { release = () => resolve(image(1)); });
  const first = c.arm(5, false, 0);
  c.onViTag(tag(5), slow); c.onPresent(slow);
  assert.equal(c.pending, false, "the request left pending once its frame was found");
  const second = c.arm(8, false, 0);
  c.cancel(first.id, new Error("first timed out"));
  await assert.rejects(first.promise, /first timed out/);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(c.pending, true, "the second request is untouched");
  c.onViTag(tag(8), () => image(2)); c.onPresent(() => image(2));
  assert.equal((await second.promise).pixels[0], 2);
  assert.equal(c.open, 0);
});

// Review P2: a load in pause must not leave a stale tag that rejects a
// request counted from the new load.
test("arming after a load is not judged against a tag of the old timeline", async () => {
  const c = createWgpuExactCapture();
  const r = reads();
  c.onViTag(tag(300, 100, 0, 3), r.readback); c.onPresent(r.readback);
  // The load arrives through the core only (no onLoad): the tag is stale.
  const capture = arm(c, 2, true, 4);
  c.onViTag(tag(301, 1, 0, 4), r.readback); c.onPresent(r.readback);
  c.onViTag(tag(302, 2, 0, 4), r.readback); c.onPresent(r.readback);
  assert.equal((await capture).index, 2);
});

test("the worker routes video=wgpu captures to the tagged presents", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /if \(harnessVideoBackend === "WebGPU-Real" \|\| harnessVideoBackend === "WebGPU"\) return captureAtViOutputWgpu\(/);
  assert.match(worker, /const WGPU_CMD_OP_VI_TAG = 26;/);
  assert.match(worker, /const WGPU_CMD_OP_PRESENT_SOURCE = 27;/);
  assert.match(worker, /generation: u32\[recWord \+ 5\]/);
  assert.match(worker, /wgpuExactCapture\.arm\(index, fromLoad, generation\)/);
  assert.match(worker, /setTimeout\(\(\) => wgpuExactCapture\.cancel\(id, /);
  // Both savestate paths drop waiting captures before the core loads.
  assert.equal(worker.match(/wgpuExactCapture\.onLoad\(\);/g)?.length, 2);
  // The copy starts at the presented rectangle's origin.
  assert.match(worker, /copyTextureToBuffer\(\{ texture: entry\.tex, origin: \{ x: rect\.x, y: rect\.y, z: 0 \} \}/);
  assert.match(worker, /wgpuPresentedSource = \{\n\s*textureId: wgpuLastBackbufferSourceTextureId, rect: wgpuNextPresentSource\n\s*\};\n\s*wgpuNextPresentSource = null;\n\s*wgpuExactCapture\.onPresent\(readbackWgpuPresentSource\);/);
  assert.match(worker, /\(\(harnessEnabled \|\| DIAG_TEX_READBACK/);
  const patch = await readFile(new URL(
    "../patches/dolphin-wasm/snapshot/0069-webgpu-tag-presents-with-vi-output.patch", import.meta.url), "utf8");
  assert.match(patch, /\+  ViTag = 26,/);
  assert.match(patch, /\+  PresentSource = 27,/);
  assert.match(patch, /\+        DolphinWeb_WebGpuTagViOutput\(vi_since_boot, vi_since_load, ticks, load_generation\);/);
  // The rectangle is the one the blit uses: same fit to the backbuffer.
  assert.match(patch, /\+    AdjustRectanglesToFitBounds\(&harness_target_rc, &harness_source_rc, m_backbuffer_width,/);
});
