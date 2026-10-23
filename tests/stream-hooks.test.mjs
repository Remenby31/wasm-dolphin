import assert from "node:assert/strict";
import test from "node:test";

import { DIRECT_PAD_LAYOUT, DIRECT_PAD_PORTS, DIRECT_PAD_SLOTS, SLOT } from "../src/direct-pad.js";
import { readInputStateSnapshot } from "../src/input-transport.js";
import { StreamCapture } from "../src/stream-capture.js";
import { UpstreamWorkerAdapter } from "../src/upstream-worker-adapter.js";

const state = (mask, stickX = 0x80) => ({
  mask, stickX, stickY: 0x80, cStickX: 0x80, cStickY: 0x80,
  triggerLeft: 0, triggerRight: 0, analogA: 0, analogB: 0
});

// An adapter with a core's direct block (a plain SAB here) and a worker stub.
function adapterWithBlock() {
  const posted = [];
  const adapter = new UpstreamWorkerAdapter();
  adapter.worker = { postMessage: (message) => posted.push(message) };
  adapter.loaded = true;
  const memory = new SharedArrayBuffer(8192);
  adapter.attachDirectPad({ buffer: memory, offset: 1024, layout: DIRECT_PAD_LAYOUT });
  const block = new Int32Array(memory, 1024, DIRECT_PAD_PORTS * DIRECT_PAD_SLOTS);
  const slot = (port, name) => block[port * DIRECT_PAD_SLOTS + SLOT[name]];
  return { adapter, posted, slot };
}

test("local input never goes through the direct block (streaming off by default)", () => {
  const { adapter, posted, slot } = adapterWithBlock();
  adapter.setPadState(0, state(1));
  adapter.setPadState(2, state(4));
  for (const port of [0, 1, 2, 3]) assert.equal(slot(port, "ENABLED"), 0, `port ${port}`);
  // The presentation-loop path, with its generation, is untouched.
  assert.equal(readInputStateSnapshot(adapter.inputStateView, { port: 0 }).snapshot.inputGeneration, 1);
  assert.equal(posted.filter((m) => m.type === "setInputState").length, 2);
  assert.equal(adapter.tapPad(0, 1), false);
});

test("a remote state needs a port given to a guest, plugged in, a newer sequence and a valid state", () => {
  const { adapter, posted, slot } = adapterWithBlock();
  assert.equal(adapter.setRemotePadState(1, state(1), { inputSeq: 1, rxTime: 5 }), false, "not given to a guest");
  assert.equal(adapter.enableRemotePad(1, true), true);
  assert.equal(adapter.setRemotePadState(1, state(1), { inputSeq: 1, rxTime: 5 }), false, "port unplugged");
  adapter.connectPad(1, true);
  const before = posted.length;
  assert.equal(adapter.setRemotePadState(1, state(1), { inputSeq: 7, rxTime: 5 }), true);
  assert.deepEqual([slot(1, "ENABLED"), slot(1, "MASK"), slot(1, "INPUT_SEQ")], [1, 1, 7]);
  // No message per remote state: the block (and the SAB) carry it.
  assert.equal(posted.length, before);
  assert.equal(adapter.setRemotePadState(1, state(2), { inputSeq: 6 }), false, "older sequence");
  assert.equal(adapter.setRemotePadState(1, state(2), { inputSeq: 7 }), false, "same sequence");
  assert.equal(adapter.setRemotePadState(1, { mask: NaN }, { inputSeq: 8 }), false, "invalid state, no throw");
  assert.equal(adapter.setRemotePadState(1, state(2), { inputSeq: 0xffff + 9 }), true, "u16 wrap");
  assert.equal(slot(1, "MASK"), 2);
  assert.equal(adapter.tapPad(1, 1), true);
  assert.equal(slot(1, "TAPS"), 1);
  // Several presses of a button revealed at once go in as counts.
  assert.equal(adapter.tapPad(1, [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), true);
  assert.deepEqual([slot(1, "TAPS") & 0xf, (slot(1, "TAPS_HIGH") >>> 12) & 0xf], [3, 1]);
});

test("a packet in flight after the guest was unplugged never plugs it back in", () => {
  const { adapter } = adapterWithBlock();
  adapter.enableRemotePad(2, true);
  adapter.connectPad(2, true);
  assert.equal(adapter.setRemotePadState(2, state(1), { inputSeq: 1 }), true);
  adapter.connectPad(2, false);
  assert.equal(adapter.setRemotePadState(2, state(1), { inputSeq: 2 }), false);
  assert.equal(adapter.tapPad(2, 1), false);
  assert.equal(adapter.padPorts.ports[2].connected, false);
});

test("taking a port back stops the direct block; the host's own writes carry no guest sequence", () => {
  const { adapter, slot } = adapterWithBlock();
  adapter.enableRemotePad(3, true);
  adapter.connectPad(3, true);
  adapter.setRemotePadState(3, state(1), { inputSeq: 40, rxTime: 9 });
  adapter.setPadState(3, state(0)); // the host neutralises the port
  assert.equal(slot(3, "INPUT_SEQ"), 0);
  adapter.enableRemotePad(3, false);
  assert.equal(slot(3, "ENABLED"), 0);
  assert.equal(adapter.setRemotePadState(3, state(1), { inputSeq: 41 }), false);
});

class FakeFrame {
  static closed = 0;
  constructor(source, init) {
    this.source = source;
    this.init = init;
  }
  close() {
    FakeFrame.closed += 1;
  }
}

function captureWith(writer) {
  const capture = new StreamCapture({ now: () => 10, VideoFrameImpl: FakeFrame });
  capture.attach({ getWriter: () => writer });
  return capture;
}

test("worker capture drops frames the consumer cannot take, never queues", () => {
  const written = [];
  const writer = { desiredSize: 1, write: async (f) => written.push(f), close: async () => {}, closed: new Promise(() => {}) };
  const capture = captureWith(writer);
  const rgba = new Uint8Array(4 * 4 * 4);
  capture.offerBytes(rgba, 4, 4, 1);
  writer.desiredSize = 0;
  capture.offerBytes(rgba, 4, 4, 2);
  assert.equal(written.length, 1);
  assert.equal(written[0].init.format, "RGBX");
  assert.deepEqual([capture.stats.frames, capture.stats.dropped], [1, 1]);
  capture.offerBytes(rgba.subarray(0, 8), 4, 4, 3); // too short: ignored
  assert.equal(capture.stats.frames, 1);
});

test("a rejected write closes the frame and stops the capture", async () => {
  const writer = { desiredSize: 1, write: () => Promise.reject(new Error("track stopped")), close: async () => {}, closed: new Promise(() => {}) };
  const capture = captureWith(writer);
  FakeFrame.closed = 0;
  capture.offerBytes(new Uint8Array(64), 4, 4, 1);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(FakeFrame.closed, 1);
  assert.equal(capture.active, false);
  capture.offerBytes(new Uint8Array(64), 4, 4, 2);
  assert.equal(capture.stats.frames, 1);
});
