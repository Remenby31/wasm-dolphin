import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { newFramesRate } from "../harness/lib/matrix.mjs";
import { UpstreamWorkerAdapter } from "../src/upstream-worker-adapter.js";
import { createNewFrameCounter } from "../src/wgpu-new-frames.js";
import { INTEGRITY_FATAL } from "../src/wgpu-integrity.js";

const [worker, host, patch] = await Promise.all([
  readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
  readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
  readFile(new URL("../patches/dolphin-wasm/snapshot/0208-webgpu-new-frame-tag.patch", import.meta.url), "utf8")
]);

test("a tag shown twice counts once: duplicate VI swaps are not new frames", () => {
  const c = createNewFrameCounter();
  assert.deepEqual([5, 5, 5, 6, 6].map((t) => c.shown(t)), ["new", "repeat", "repeat", "new", "repeat"]);
  assert.deepEqual(c.window(1000), { newFramesPerSec: 2, newFramesProducedPerSec: 0 });
  assert.equal(c.shownTotal, 2);
  assert.equal(c.outOfOrder, 0);
});

test("produced counts new tags entering the queue, shown those that reach the canvas", () => {
  const c = createNewFrameCounter();
  // 4 presents queued, 3 new XFBs (7 repeats once); the queue dropped 8
  for (const t of [7, 7, 8, 9]) c.queued(t);
  for (const t of [7, 9]) c.shown(t);
  assert.deepEqual(c.window(500), { newFramesPerSec: 4, newFramesProducedPerSec: 6 });
  assert.equal(c.producedTotal, 3);
  assert.equal(c.shownTotal, 2);
  // the window restarted, the totals did not
  assert.deepEqual(c.window(500), { newFramesPerSec: 0, newFramesProducedPerSec: 0 });
  assert.equal(c.shownTotal, 2);
});

test("an older tag shown after a newer one is out of order, never new", () => {
  const c = createNewFrameCounter();
  assert.deepEqual([5, 6, 5].map((t) => c.shown(t)), ["new", "new", "older"]);
  assert.equal(c.outOfOrder, 1);
  assert.equal(c.shownTotal, 2);
  // the newer one stays the reference: 6 again is a repeat, 7 is new
  assert.equal(c.shown(6), "repeat");
  assert.equal(c.shown(7), "new");
  assert.equal(c.outOfOrder, 1);
});

test("a state load (the core's tag epoch moves) never counts as out of order", () => {
  const c = createNewFrameCounter();
  c.shown(5000, 0);
  c.shown(5001, 0);
  // the load restored an older frame count: the core moved the epoch
  assert.equal(c.shown(300, 1), "new");
  assert.equal(c.shown(301, 1), "new");
  assert.equal(c.outOfOrder, 0);
  // a picture of the replaced timeline after the new one is out of order
  assert.equal(c.shown(5002, 0), "older");
  assert.equal(c.outOfOrder, 1);
  // a load that restored a later count needs no epoch: the tags go forward
  assert.equal(c.shown(9000, 1), "new");
  assert.equal(c.outOfOrder, 1);
});

test("an unknown tag (0: an older core, software, a smoke) counts nothing and reports null", () => {
  const c = createNewFrameCounter();
  assert.equal(c.queued(0), false);
  assert.equal(c.shown(0), "unknown");
  assert.equal(c.shown(undefined), "unknown");
  assert.deepEqual(c.window(500), { newFramesPerSec: null, newFramesProducedPerSec: null });
  assert.equal(c.shownTotal, null);
  assert.equal(c.producedTotal, null);
  assert.equal(c.outOfOrder, null);
  // the presenter's first blank frame (tag 0) between tagged ones changes nothing
  c.shown(3);
  assert.equal(c.shown(0), "unknown");
  assert.equal(c.shown(3), "repeat");
});

test("a boot resets the window, the last tags and the totals, not the lifetime out-of-order count", () => {
  const c = createNewFrameCounter();
  c.queued(10);
  c.shown(10);
  c.shown(9);
  assert.equal(c.outOfOrder, 1);
  c.reset();
  assert.deepEqual(c.window(500), { newFramesPerSec: null, newFramesProducedPerSec: null });
  assert.equal(c.shownTotal, null);
  // the new boot's count starts low again: not out of order after a reset
  assert.equal(c.queued(1), true);
  assert.equal(c.shown(1), "new");
  assert.equal(c.outOfOrder, 1);
  assert.equal(c.shownTotal, 1);
});

test("out of order is an integrity counter, read by validationReadIntegrity", () => {
  assert.ok(INTEGRITY_FATAL.includes("framesOutOfOrder"));
  const read = worker.slice(worker.indexOf("function readWgpuIntegrity()"), worker.indexOf("function harnessGeometryCacheStats()"));
  assert.match(read, /framesOutOfOrder: wgpuNewFrames\.outOfOrder,/);
});

test("the worker reads the tag from SUBMIT_PRESENT and counts at queue and show time", () => {
  assert.match(worker, /import \{ createNewFrameCounter \} from "\.\/wgpu-new-frames\.js";/);
  assert.match(worker, /case WGPU_CMD_OP_SUBMIT_PRESENT:\n\s+backbufferPresentPending = false;\n(?:\s+\/\/.*\n)+\s+const presentFrameTag = u32\[recWord \+ 1\];\n\s+const presentFrameTagEpoch = u32\[recWord \+ 2\];/);
  // vsync: the tag rides on the queued frame, counted when queued and when shown
  assert.match(worker, /queueWgpuVsyncFrame\([^;]*,\n\s+presentFrameTag, presentFrameTagEpoch\);/);
  assert.match(worker, /wgpuVsync\.queueFrame\(\{ coreFrame, shownVi, stream, tick: wgpuVsyncTick, at, tag, tagEpoch \}, \{ hidden \}\);\n\s+wgpuVsyncCountDrops\(before\);\n\s+if \(!frame\) return false;\n.*\n\s+wgpuNewFrames\.queued\(tag, tagEpoch\);/);
  assert.match(worker, /wgpuVsync\.shown\(f\);\n\s+wgpuNewFrames\.shown\(f\.tag, f\.tagEpoch\);/);
  // immediate: shown at the submit
  assert.match(worker, /wgpuNewFrames\.queued\(presentFrameTag, presentFrameTagEpoch\);\n\s+wgpuNewFrames\.shown\(presentFrameTag, presentFrameTagEpoch\);\n\s+recordPresentedFrame\(/);
  // per window, reset at boot, in the frame stats
  assert.match(worker, /\(\{ newFramesPerSec, newFramesProducedPerSec \} = wgpuNewFrames\.window\(profileElapsedMs\)\);/);
  const reset = worker.slice(worker.indexOf("function resetPresentationBuffer()"), worker.indexOf("function readDetailedCoreStat("));
  assert.match(reset, /wgpuNewFrames\.reset\(\);\n\s+newFramesPerSec = null;\n\s+newFramesProducedPerSec = null;/);
  for (const field of ["newFramesPerSec,", "newFramesProducedPerSec,", "newFramesShown: wgpuNewFrames.shownTotal,", "framesOutOfOrder: wgpuNewFrames.outOfOrder,"])
    assert.ok(worker.includes(`    ${field}\n`), field);
  // always on: no harness or metrics gate on the counting sites
  assert.doesNotMatch(worker, /(?:harnessEnabled|collectMetrics|causalMetricsEnabled)[^\n]*wgpuNewFrames/);
});

test("the core tags SubmitPresent with the presenter's frame count and an epoch that moves when it goes back", () => {
  assert.match(patch, /\+  rec\.arg\.u\[0\] = frame_tag;\n\+  rec\.arg\.u\[1\] = tag_epoch;/);
  assert.match(patch, /\+  bool PushSubmitPresent\(u32 frame_tag = 0, u32 tag_epoch = 0\);/);
  assert.match(patch, /g_presenter \? static_cast<u32>\(g_presenter->FrameCount\(\)\) : 0;/);
  assert.match(patch, /if \(frame_tag < s_last_present_frame_tag\)\n\+\s+\+\+s_present_tag_epoch;/);
});

test("the adapter keeps the new-frame fields, null included", () => {
  const adapter = new UpstreamWorkerAdapter();
  assert.equal(adapter.newFramesPerSec, null);
  adapter.applyFrame({ frame: 10, newFramesPerSec: 23.5, newFramesProducedPerSec: 30, newFramesShown: 400, framesOutOfOrder: 0 });
  assert.deepEqual([adapter.newFramesPerSec, adapter.newFramesProducedPerSec, adapter.newFramesShown, adapter.framesOutOfOrder], [23.5, 30, 400, 0]);
  // a worker without tags says null: the old value goes
  adapter.applyFrame({ frame: 11, newFramesPerSec: null, newFramesProducedPerSec: null, newFramesShown: null, framesOutOfOrder: null });
  assert.deepEqual([adapter.newFramesPerSec, adapter.newFramesProducedPerSec, adapter.newFramesShown, adapter.framesOutOfOrder], [null, null, null, null]);
  // an older worker does not send them: nothing changes
  adapter.applyFrame({ frame: 12, newFramesPerSec: 5 });
  adapter.applyFrame({ frame: 13 });
  assert.equal(adapter.newFramesPerSec, 5);
});

test("core-host passes the new-frame fields to onFrame", () => {
  for (const field of ["newFramesPerSec", "newFramesProducedPerSec", "newFramesShown", "framesOutOfOrder"])
    assert.match(host, new RegExp(`${field}: this\\.mode === "dolphin" \\? this\\.adapter\\.${field} \\?\\? null : null,`), field);
});

test("the probes' rate: new frames shown between two readings, null without tags or across a boot", () => {
  assert.equal(newFramesRate({ t: 1000, newShown: 100 }, { t: 3000, newShown: 160 }), 30);
  assert.equal(newFramesRate({ t: 1000, newShown: null }, { t: 3000, newShown: 160 }), null);
  assert.equal(newFramesRate({ t: 1000, newShown: 100 }, { t: 3000, newShown: 5 }), null, "a boot between the readings");
  assert.equal(newFramesRate(null, { t: 3000, newShown: 5 }), null);
  assert.equal(newFramesRate({ t: 1000, newShown: 1 }, { t: 1000, newShown: 1 }), null);
});
