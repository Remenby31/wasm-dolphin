// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// ?replaywake=1 (research/no-present-2p.md, lever 2): off by default, every hop
// from the page's URL to the replay pump checked (an option the adapter forgot
// to carry was silently dropped before: ?aotsample, ?wasmengine).
test("replaywake: off by default, ?replaywake=1 only", async () => {
  const { requestedPacing } = await import("../src/core-host.js");
  assert.equal(requestedPacing("").replayWake, false);
  assert.equal(requestedPacing("?replaywake=1").replayWake, true);
  for (const other of ["?replaywake=0", "?replaywake=true", "?replaywake=on", "?replaywake="]) assert.equal(requestedPacing(other).replayWake, false, other);
});

test("replaywake reaches the worker's init message through the adapter", async (t) => {
  const { requestedPacing } = await import("../src/core-host.js");
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  for (const [query, expected] of [["?replaywake=1", true], ["", false]]) {
    const adapter = new UpstreamWorkerAdapter(requestedPacing(query));
    let posted = null;
    adapter.worker = {
      postMessage(message) {
        posted = message;
        queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
      }
    };
    const originalWindow = globalThis.window;
    globalThis.window = { location: { href: `http://127.0.0.1:8080/${query}`, search: query } };
    t.after(() => {
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    });
    await adapter.load();
    assert.equal(posted.payload.replayWake, expected, query || "default");
  }
});

test("replaywake: host and worker; only the 0 ms backlog chain changes, a cancel drops a posted wake", async () => {
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(host, /\n {12}replayWake: this\.pacing\.replayWake,\n/);
  assert.match(worker, /\n {8}replayWake: payload\.replayWake,\n/);
  assert.match(worker, /wgpuReplayWake = replayWake === true;/);
  // the message path only for a 0 ms delay with the switch on; the timer otherwise
  assert.match(worker, /const message = delay === 0 && wgpuReplayWake;/);
  assert.match(worker, /if \(message\) \{\s+wgpuReplayPumpTimer = "message";\s+postWgpuReplayWake\(callback\);\s+return;\s+\}\s+wgpuReplayPumpTimer = setTimeout\(callback, delay\);/);
  // a cancel moves the generation on: a wake already posted runs nothing
  assert.match(worker, /if \(wgpuReplayPumpTimer === "message"\) \{\s+wgpuReplayWakeGeneration \+= 1;\s+wgpuReplayWakeCallback = null;/);
  assert.match(worker, /if \(event\.data !== wgpuReplayWakeGeneration \|\| !wgpuReplayWakeCallback\) return;/);
});
