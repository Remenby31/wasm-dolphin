import assert from "node:assert/strict";
import test from "node:test";

import { readInputStateSnapshot } from "../src/input-transport.js";
import { UpstreamWorkerAdapter } from "../src/upstream-worker-adapter.js";

function adapterWithWorker() {
  const posted = [];
  const adapter = new UpstreamWorkerAdapter();
  adapter.worker = { postMessage: (message) => posted.push(message) };
  return { adapter, posted };
}

const state = (mask, stickX = 0x80) => ({
  mask, stickX, stickY: 0x80, cStickX: 0x80, cStickY: 0x80,
  triggerLeft: 0, triggerRight: 0, analogA: 0, analogB: 0
});

test("each port is published in its own SAB block and message, with its own generation", () => {
  const { adapter, posted } = adapterWithWorker();
  adapter.loaded = true;
  adapter.setPadState(0, state(1));
  adapter.setPadState(3, state(2, 0xe5));
  adapter.setPadState(3, state(2, 0xe5));

  const p0 = readInputStateSnapshot(adapter.inputStateView, { port: 0 }).snapshot;
  const p3 = readInputStateSnapshot(adapter.inputStateView, { port: 3 }).snapshot;
  assert.deepEqual([p0.mask, p0.connected, p0.inputGeneration], [1, true, 1]);
  assert.deepEqual([p3.mask, p3.stickX, p3.connected, p3.inputGeneration], [2, 0xe5, true, 1]);
  assert.equal(readInputStateSnapshot(adapter.inputStateView, { port: 1 }).snapshot.inputGeneration, 0);
  // The unchanged repeat is not sent again.
  assert.deepEqual(posted.map((m) => [m.type, m.payload.port, m.payload.mask]), [
    ["setInputState", 0, 1],
    ["setInputState", 3, 2]
  ]);
  // Input telemetry still follows port 0 only.
  assert.equal(adapter.inputTelemetry.mainGeneration, 1);
  assert.equal(adapter.inputTelemetry.mainPostCount, 1);
});

test("unplugging a port publishes a neutral, disconnected state; a pad plugged back starts neutral", () => {
  const { adapter, posted } = adapterWithWorker();
  adapter.loaded = true;
  adapter.setPadState(1, state(8));
  adapter.connectPad(1, false);
  let p1 = readInputStateSnapshot(adapter.inputStateView, { port: 1 }).snapshot;
  assert.deepEqual([p1.connected, p1.mask, p1.inputGeneration], [false, 0, 2]);
  adapter.connectPad(1, false);
  assert.equal(posted.length, 2);
  adapter.connectPad(1, true);
  p1 = readInputStateSnapshot(adapter.inputStateView, { port: 1 }).snapshot;
  assert.deepEqual([p1.connected, p1.mask, p1.inputGeneration], [true, 0, 3]);
  // Out-of-range ports are ignored.
  adapter.setPadState(4, state(1));
  adapter.connectPad(-1, true);
  adapter.setPadState("1", state(1));
  assert.equal(posted.length, 3);
  // Fields left out are neutral, not zero.
  adapter.setPadState(2, { mask: 1 });
  const p2 = readInputStateSnapshot(adapter.inputStateView, { port: 2 }).snapshot;
  assert.deepEqual([p2.mask, p2.stickX, p2.cStickY, p2.triggerLeft], [1, 0x80, 0x80, 0]);
});

test("states set before the worker is loaded are published once it is", () => {
  const { adapter, posted } = adapterWithWorker();
  adapter.connectPad(2, true);
  adapter.setPadState(1, state(4));
  assert.equal(posted.length, 0);
  adapter.loaded = true;
  adapter.publishRequestedPadStates();
  assert.deepEqual(posted.map((m) => [m.payload.port, m.payload.connected, m.payload.mask]), [
    [1, true, 4],
    [2, true, 0]
  ]);
  // The legacy single-pad call is port 0.
  adapter.setInputState(state(16));
  assert.deepEqual([posted.at(-1).payload.port, posted.at(-1).payload.mask], [0, 16]);
});

test("a pad state that is not finite numbers is rejected before it reaches the core", () => {
  const { adapter, posted } = adapterWithWorker();
  adapter.loaded = true;
  for (const bad of [{ stickX: NaN }, { cStickY: Infinity }, { triggerLeft: "255" }, { mask: -1 }, { mask: 1.5 }]) {
    assert.throws(() => adapter.setPadState(1, bad), /pad state (\w+) must be/);
  }
  assert.throws(() => adapter.setPadState(1, 7), TypeError);
  assert.equal(posted.length, 0);
  // undefined is "left out": neutral, never a full deflection; bytes are clamped.
  adapter.setPadState(1, { stickX: undefined, stickY: 300, cStickX: -4, triggerLeft: 12.6 });
  const p1 = readInputStateSnapshot(adapter.inputStateView, { port: 1 }).snapshot;
  assert.deepEqual([p1.stickX, p1.stickY, p1.cStickX, p1.triggerLeft], [0x80, 0xff, 0, 13]);
});

test("the main-thread adapter (ogl proxy) drives all four ports and unplugs them", async () => {
  const { UpstreamMainThreadAdapter } = await import("../src/upstream-main-thread-adapter.js");
  const adapter = new UpstreamMainThreadAdapter({ canvas: null });
  const calls = [];
  // Requests before the core is loaded are kept, then applied on load.
  adapter.setPadState(2, state(4));
  adapter.connectPad(0, false);
  adapter.api = { setPadState: (port, s) => calls.push([port, s.connected, s.mask, s.inputGeneration]) };
  for (const port of adapter.padPorts.requestedPorts()) adapter.applyPadState(port);
  adapter.setPadState(3, state(8));
  adapter.connectPad(3, false);
  adapter.setInputState(state(1));
  assert.deepEqual(calls, [
    [0, false, 0, 1],
    [2, true, 4, 1],
    [3, true, 8, 1],
    [3, false, 0, 2],
    [0, true, 1, 2]
  ]);
  assert.throws(() => adapter.setPadState(1, { stickY: NaN }), TypeError);
  // A core without SetPadState still gets port 1 through SetInputState.
  const legacy = [];
  adapter.api = { setInputState: (s) => legacy.push(s.mask) };
  adapter.setPadState(0, state(2));
  adapter.setPadState(1, state(2));
  assert.deepEqual(legacy, [2]);
});
