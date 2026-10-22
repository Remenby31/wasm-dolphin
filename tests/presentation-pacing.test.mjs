import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FRESH_FRAME_DELIVERY,
  freshFrameDeliveryForPacing,
  legacyTickQueueRequested,
} from "../src/presentation-pacing.js";

test("fresh-frame delivery keeps direct and smooth stable while tick is immediate by default", () => {
  for (const legacyTickQueue of [false, true]) {
    assert.equal(
      freshFrameDeliveryForPacing("direct", legacyTickQueue),
      FRESH_FRAME_DELIVERY.IMMEDIATE,
    );
    assert.equal(
      freshFrameDeliveryForPacing("smooth", legacyTickQueue),
      FRESH_FRAME_DELIVERY.QUEUED,
    );
  }

  assert.equal(
    freshFrameDeliveryForPacing("tick", false),
    FRESH_FRAME_DELIVERY.IMMEDIATE,
  );
  assert.equal(
    freshFrameDeliveryForPacing("tick", true),
    FRESH_FRAME_DELIVERY.QUEUED,
  );
});

test("legacytickqueue is an explicit URL rollback only", () => {
  assert.equal(legacyTickQueueRequested(""), false);
  assert.equal(legacyTickQueueRequested("?pacing=tick"), false);
  assert.equal(legacyTickQueueRequested("?legacytickqueue=0"), false);
  assert.equal(legacyTickQueueRequested("?legacytickqueue=true"), false);
  assert.equal(legacyTickQueueRequested("?legacytickqueue=1"), true);
  assert.equal(legacyTickQueueRequested("pacing=tick&legacytickqueue=1"), true);
});

test("host, adapter, and worker carry one rollback bit without changing pacing strings", async () => {
  const [host, adapter, worker] = await Promise.all([
    readFile(new URL("../src/core-host.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8"),
  ]);

  assert.match(host, /legacyTickQueueRequested\(window\.location\.search\)/);
  assert.match(host, /legacyTickQueue: this\.legacyTickQueue/);
  assert.match(adapter, /this\.legacyTickQueue = Boolean\(legacyTickQueue\)/);
  assert.match(adapter, /legacyTickQueue: this\.legacyTickQueue/);
  assert.match(worker, /legacyTickQueue: payload\.legacyTickQueue/);
  assert.match(worker, /freshFrameDeliveryForPacing\(presentationPacingMode, legacyTickQueue\)/);
});

test("tick retains its duplicate repaint loop independently of fresh-frame routing", async () => {
  const worker = await readFile(
    new URL("../src/upstream-discio-worker.js", import.meta.url),
    "utf8",
  );

  assert.match(
    worker,
    /if \(presentationPacingMode === "tick"\) \{\s*startTickRepaintLoop\(\);\s*\}/s,
  );
  assert.match(worker, /tickRepaintCount \+= 1/);
  assert.match(
    worker,
    /_tickRepaintTimer = setInterval\(\(\) => \{[\s\S]*?if \(cmdRingOwnsCanvas\) return;/,
  );
  assert.match(
    worker,
    /data\.type !== "webgpu-show-image"[\s\S]*?if \(cmdRingOwnsCanvas\) return;/,
  );
});

test("worker causal telemetry distinguishes route counts and queue depth/age distributions", async () => {
  const worker = await readFile(
    new URL("../src/upstream-discio-worker.js", import.meta.url),
    "utf8",
  );

  assert.match(worker, /immediateFreshFrameCount \+= 1/);
  assert.match(worker, /queuedFreshFrameCount \+= 1/);
  assert.match(
    worker,
    /presentationQueueDepthHighWater = Math\.max\(presentationQueueDepthHighWater, frameQueue\.length\)/,
  );
  assert.match(worker, /presentationQueueAgeTotalMs \+= presentationQueueAgeMs/);
  assert.match(worker, /presentationQueueAgeSamples \+= 1/);
  assert.match(
    worker,
    /presentationQueueAgeMaxMs = Math\.max\(presentationQueueAgeMaxMs, presentationQueueAgeMs\)/,
  );
  for (const field of [
    "freshFrameDelivery",
    "legacyTickQueue",
    "immediateFreshFrameCount",
    "queuedFreshFrameCount",
    "tickRepaintCount",
    "queueDepthHighWater",
    "queueAgeAverageMs",
    "queueAgeMaxMs",
  ]) {
    assert.match(worker, new RegExp(`\\b${field}\\b`), `${field} must be emitted`);
  }
});

test("hardware WGPU presents publish cadence only after a successful submission", async () => {
  const worker = await readFile(
    new URL("../src/upstream-discio-worker.js", import.meta.url),
    "utf8",
  );

  assert.match(
    worker,
    /const submittedPresent = presentAlreadySubmitted \|\| submitEnc\("present"\);[\s\S]*?if \(!submittedPresent\) \{[\s\S]*?recordPresentRejected[\s\S]*?break;[\s\S]*?\}[\s\S]*?cmdRingOwnsCanvas = true;[\s\S]*?recordPresentedFrame\(api\?\.getFrame\?\.\(\) \?\? 0, wgpuExactCapture\.currentBoot\(\)\);/,
  );
});
