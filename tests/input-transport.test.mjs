import assert from "node:assert/strict";
import test from "node:test";

import {
  INPUT_PORT_COUNT,
  INPUT_PORT_SLOT_COUNT,
  INPUT_STATE_SLOT_COUNT,
  compareInputGenerations,
  readInputStateSnapshot,
  writeInputStateSnapshot
} from "../src/input-transport.js";

const newView = () => new Int32Array(new SharedArrayBuffer(INPUT_STATE_SLOT_COUNT * 4));

test("input generation ordering is wrap-safe and rejects stale delivery", () => {
  assert.equal(compareInputGenerations(7, 7), 0);
  assert.equal(compareInputGenerations(8, 7), 1);
  assert.equal(compareInputGenerations(7, 8), -1);
  assert.equal(compareInputGenerations(1, 0xffff_ffff), 1);
  assert.equal(compareInputGenerations(0xffff_ffff, 1), -1);
});

test("input SAB writer publishes an even sequence around one coherent snapshot", () => {
  const view = newView();
  writeInputStateSnapshot(view, {
    mask: 0x101,
    stickX: 130,
    stickY: 126,
    cStickX: 140,
    cStickY: 120,
    triggerLeft: 1,
    triggerRight: 2,
    analogA: 255,
    analogB: 3,
    inputGeneration: 9,
    sentAtEpochMs: 0x1234_5678
  });

  assert.equal(Atomics.load(view, 11) & 1, 0);
  assert.deepEqual(readInputStateSnapshot(view).snapshot, {
    mask: 0x101,
    stickX: 130,
    stickY: 126,
    cStickX: 140,
    cStickY: 120,
    triggerLeft: 1,
    triggerRight: 2,
    analogA: 255,
    analogB: 3,
    connected: true,
    inputGeneration: 9,
    sentAtEpochMsLow: 0x1234_5678
  });
});

test("input SAB reader refuses an in-progress writer", () => {
  const view = newView();
  Atomics.store(view, 11, 3);
  const result = readInputStateSnapshot(view);
  assert.equal(result.snapshot, null);
  assert.equal(result.status, "writer-active");
});

test("input SAB sequence wraps from max odd to zero without publishing odd", () => {
  const view = newView();
  Atomics.store(view, 11, -2);
  writeInputStateSnapshot(view, { inputGeneration: 1 });
  assert.equal(Atomics.load(view, 11) >>> 0, 0);
  assert.equal(readInputStateSnapshot(view).snapshot.inputGeneration, 1);
});

test("input SAB carries four independent ports, each with its own sequence", () => {
  const view = newView();
  assert.equal(INPUT_PORT_COUNT, 4);
  for (let port = 0; port < INPUT_PORT_COUNT; port += 1) {
    writeInputStateSnapshot(view, { mask: 1 << port, stickX: 0x80 + port, inputGeneration: 10 + port }, port);
  }
  // A writer in progress on port 2 blocks only port 2.
  Atomics.store(view, 2 * INPUT_PORT_SLOT_COUNT + 11, 7);
  for (let port = 0; port < INPUT_PORT_COUNT; port += 1) {
    const result = readInputStateSnapshot(view, { port });
    if (port === 2) {
      assert.equal(result.status, "writer-active");
      continue;
    }
    assert.equal(result.snapshot.mask, 1 << port);
    assert.equal(result.snapshot.stickX, 0x80 + port);
    assert.equal(result.snapshot.inputGeneration, 10 + port);
    assert.equal(result.snapshot.connected, true);
  }
});

test("input SAB publishes an unplugged port and starts every port unplugged", () => {
  const view = newView();
  assert.equal(readInputStateSnapshot(view, { port: 3 }).snapshot.connected, false);
  assert.equal(readInputStateSnapshot(view, { port: 3 }).snapshot.inputGeneration, 0);
  writeInputStateSnapshot(view, { mask: 1, inputGeneration: 1 }, 3);
  writeInputStateSnapshot(view, { connected: false, inputGeneration: 2 }, 3);
  const snapshot = readInputStateSnapshot(view, { port: 3 }).snapshot;
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.mask, 0);
  assert.equal(snapshot.inputGeneration, 2);
});

test("input SAB refuses ports outside 0-3 and a view too small for four ports", () => {
  const view = newView();
  assert.throws(() => writeInputStateSnapshot(view, {}, 4), RangeError);
  assert.throws(() => readInputStateSnapshot(view, { port: -1 }), RangeError);
  assert.throws(() => readInputStateSnapshot(new Int32Array(new SharedArrayBuffer(48))), TypeError);
});

test("pad states are validated, clamped and deduplicated per port", async () => {
  const { PadPortRequests, normalizePadState, NEUTRAL_PAD_STATE } = await import("../src/input-transport.js");
  assert.deepEqual(normalizePadState({}), NEUTRAL_PAD_STATE);
  assert.throws(() => normalizePadState({ analogA: NaN }), /analogA must be a finite number, got NaN/);
  assert.throws(() => normalizePadState({ mask: 2 ** 32 }), RangeError);
  assert.throws(() => normalizePadState(null), TypeError);
  const pads = new PadPortRequests();
  assert.ok(pads.request(1, { mask: 1 }));
  assert.equal(pads.request(1, { mask: 1, stickX: 0x80 }), null);
  assert.equal(pads.request(4, {}), null);
  assert.deepEqual(pads.requestedPorts(), [1]);
  assert.equal(pads.nextGeneration(1), 1);
});
