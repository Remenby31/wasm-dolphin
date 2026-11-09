// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The harness's presents ring (validationReadTimeline) costs 640 KiB: it is
// allocated only when the harness is enabled, never for a player.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);

test("presents ring: none for a player; allocated when the harness is enabled; recorded with each present's frame tag", async (t) => {
  const originalSelf = globalThis.self;
  globalThis.self = { location: { href: "http://127.0.0.1:8080/" }, addEventListener() {}, postMessage() {} };
  t.after(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });
  const worker = await import(`${workerUrl.href}?present-ring=${Date.now()}`);
  assert.equal(worker.harnessPresentRingForTest(), null, "the product path allocates no ring");
  assert.equal(worker.harnessProducedRingForTest(), null, "nor the produced ring");
  worker.recordPresentedFrameForTest(1);
  assert.equal(worker.harnessPresentRingForTest(), null, "a present without the harness allocates none");
  worker.setHarnessEnabledForTest(true);
  t.after(() => worker.setHarnessEnabledForTest(false));
  assert.equal(worker.harnessPresentRingForTest()?.length, 16384 * 5);
  assert.equal(worker.harnessProducedRingForTest()?.length, 16384);
});

test("presents ring (source): allocated only by harnessPresentRingOn, from the harness's enable; no ring reads as unavailable, never zeros", async () => {
  const src = await readFile(workerUrl, "utf8");
  assert.match(src, /^let harnessPresentRing = null;$/m);
  assert.equal(src.match(/new Float64Array\(HARNESS_PRESENT_RING \* HARNESS_PRESENT_STRIDE\)/g)?.length, 1);
  assert.match(src, /function harnessPresentRingOn\(\) \{\n  harnessPresentRing \?\?= new Float64Array/);
  assert.equal(src.match(/harnessPresentRingOn\(\);/g)?.length, 2, "the enable message and the test switch only");
  assert.match(src, /case "validationEnableHarness":\n[^]*?harnessEnabled = true;\n\s*harnessPresentRingOn\(\);/);
  assert.match(src, /if \(!harnessPresentRing\) return \{ error: "presents timeline unavailable/);
  assert.match(src, /if \(harnessEnabled && harnessPresentRing\) \{/);
  // both WebGPU present paths record the frame's tag
  assert.match(src, /recordPresentedFrame\(f\.coreFrame, f\.shownVi, f\.tag, f\.tagEpoch\)/);
  assert.match(src, /recordPresentedFrame\(api\?\.getFrame\?\.\(\) \?\? 0, wgpuExactCapture\.currentBoot\(\), presentFrameTag, presentFrameTagEpoch\)/);
});
