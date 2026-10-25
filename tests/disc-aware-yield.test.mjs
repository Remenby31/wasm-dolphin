// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { discAwareYield } from "../src/aot-orchestrator.js";

// A fake clock: sleep advances it; reads land at the times given.
function clock(reads) {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    lastReadAt: () => Math.max(-Infinity, ...reads.filter((r) => r <= t)),
    yieldNow: async () => {}
  };
}

test("a translation slice waits while the disc is being read, and starts once reads are quiet", async () => {
  const c = clock([0, 10, 20, 30, 40]); // a burst of reads every 10 ms up to 40 ms
  await discAwareYield({ ...c, quietMs: 15 })();
  assert.ok(c.now() >= 55, `resumed at ${c.now()} ms, before the burst was quiet`);
});

test("no recent read: no wait; a never-ending burst: bounded by maxWaitMs", async () => {
  const quiet = clock([-100]);
  await discAwareYield({ ...quiet, quietMs: 15 })();
  assert.equal(quiet.now(), 0);
  const busy = clock(Array.from({ length: 1000 }, (_, i) => i * 5));
  await discAwareYield({ ...busy, quietMs: 15, maxWaitMs: 100 })();
  assert.ok(busy.now() >= 100 && busy.now() < 130);
});

test("the worker notes every disc read and gives it to the region translator's yield", async () => {
  const w = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(w, /if \(discReadaheadEnabled\) readDiscAhead\(resolveWorkerFs\(moduleInstance\)\);\n\s*noteDiscReads\(resolveWorkerFs\(moduleInstance\)\);/);
  assert.match(w, /lastDiscReadAt = performance\.now\(\);/);
  assert.match(w, /yieldNow: discAwareYield\(\{ lastReadAt: \(\) => lastDiscReadAt \}\)/);
});
