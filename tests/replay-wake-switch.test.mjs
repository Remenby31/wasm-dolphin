// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// ?replaywake=1 (research/no-present-2p.md, lever 2): off by default, every hop
// from the page's URL to the replay pump checked (an option the adapter forgot
// to carry was silently dropped before: ?aotsample, ?wasmengine).
test("replaywake: off by default; =1 the full chain, =first, =spaced; anything else off", async () => {
  const { requestedPacing, replayWakeMode } = await import("../src/core-host.js");
  assert.equal(requestedPacing("").replayWake, "off");
  assert.equal(requestedPacing("?replaywake=1").replayWake, "chain");
  assert.equal(requestedPacing("?replaywake=first").replayWake, "first");
  assert.equal(requestedPacing("?replaywake=spaced").replayWake, "spaced");
  for (const other of ["0", "true", "on", "", "chain", "FIRST", null]) assert.equal(replayWakeMode(other), "off", String(other));
});

test("replaywake reaches the worker's init message through the adapter", async (t) => {
  const { requestedPacing } = await import("../src/core-host.js");
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  for (const [query, expected] of [["?replaywake=1", "chain"], ["?replaywake=first", "first"], ["?replaywake=spaced", "spaced"], ["", "off"]]) {
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
  assert.match(worker, /wgpuReplayWake = wgpuReplayWakePolicy\.mode;/);
  // the message path only for a 0 ms delay with the switch on and its mode's
  // fast link available; the timer otherwise
  assert.match(worker, /const message = delay === 0 && wgpuReplayWake !== "off" && webGpuCmdRing !== null &&\s+wgpuReplayWakePolicy\.fast\(/);
  // =first: re-armed when the pump parks on an empty ring
  assert.match(worker, /function parkWgpuReplayPump\(pump, observedWrite\) \{\n  \/\/ [^\n]*\n  wgpuReplayWakePolicy\.parked\(\);/);
  assert.match(worker, /wgpuReplayWakePolicy = createReplayWakePolicy\(replayWake\);/);
  assert.match(worker, /if \(message\) \{\s+wgpuReplayPumpTimer = "message";\s+postWgpuReplayWake\(callback\);\s+return;\s+\}\s+wgpuReplayPumpTimer = setTimeout\(callback, delay\);/);
  // a cancel moves the generation on: a wake already posted runs nothing
  assert.match(worker, /if \(wgpuReplayPumpTimer === "message"\) \{\s+wgpuReplayWakeGeneration \+= 1;\s+wgpuReplayWakeCallback = null;/);
  assert.match(worker, /if \(event\.data !== wgpuReplayWakeGeneration \|\| !wgpuReplayWakeCallback\) return;/);
});

test("replay wake policy: chain always, first once per park, spaced by records or time, off never", async () => {
  const { createReplayWakePolicy } = await import("../src/wgpu-replay-wake.js");
  const chain = createReplayWakePolicy("chain");
  assert.deepEqual([chain.fast(0, 0), chain.fast(1, 0.1)], [true, true]);
  const off = createReplayWakePolicy("bogus");
  assert.equal(off.mode, "off");
  assert.equal(off.fast(0, 0), false);
  const first = createReplayWakePolicy("first");
  assert.equal(first.fast(0, 0), false, "not armed before the ring was found empty");
  first.parked();
  assert.deepEqual([first.fast(10, 1), first.fast(20, 2), first.fast(30, 3)], [true, false, false]);
  first.parked();
  assert.equal(first.fast(40, 4), true);
  const spaced = createReplayWakePolicy("spaced", { records: 64, ms: 0.5 });
  assert.equal(spaced.fast(100, 10), true, "the first is fast");
  assert.equal(spaced.fast(120, 10.2), false, "20 records, 0.2 ms: a timer");
  assert.equal(spaced.fast(164, 10.3), true, "64 records grown: fast");
  assert.equal(spaced.fast(170, 10.81), true, "0.51 ms after the last fast one: fast");
  assert.equal(spaced.fast(171, 10.9), false);
  // the write index wraps (u32)
  const wrap = createReplayWakePolicy("spaced");
  assert.equal(wrap.fast(0xFFFFFFF0, 0), true);
  assert.equal(wrap.fast(0x30, 0.1), true, "0x40 records across the wrap");
});
