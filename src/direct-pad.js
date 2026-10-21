// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// Page side of the direct pad block (core/upstream/dolphin_web_direct_pad.h):
// the main thread writes each port's state straight into the core's shared
// memory, where the SI poll reads it, instead of waiting for the worker's
// presentation loop to copy it in. The core writes back what each poll read
// and the rumble state the game set. Same layout as the header; the core
// reports its layout version and a mismatch disables the path.

export const DIRECT_PAD_LAYOUT = 1;
export const DIRECT_PAD_PORTS = 4;
export const DIRECT_PAD_SLOTS = 36;
export const DIRECT_PAD_BUTTONS = 12;

export const SLOT = Object.freeze({
  SEQ: 0,
  ENABLED: 1,
  CONNECTED: 2,
  MASK: 3,
  AXES0: 4,
  AXES1: 5,
  TAPS: 6,
  INPUT_SEQ: 7,
  RX_TIME: 8,
  APPLIED_SEQ: 10,
  POLL_COUNT: 11,
  APPLIED_RX_TIME: 12,
  POLL_TIME: 14,
  RUMBLE: 16,
  RUMBLE_GEN: 17,
  PRESSES: 18,
  REPORTED_MASK: 30,
  EDGE_POLL_TIME: 32
});

const byte = (v) => Math.max(0, Math.min(0xff, Math.round(Number(v) || 0)));

/** performance.timeOrigin + now(): the clock emscripten_get_now() uses in the core's threads. */
export const epochNow = () => performance.timeOrigin + performance.now();

export class DirectPad {
  // buffer: the core's memory (SharedArrayBuffer); offset: DolphinWeb_DirectPadBlock().
  constructor(buffer, offset, layout) {
    if (!(buffer instanceof SharedArrayBuffer)) throw new TypeError("direct pad needs the core's shared memory");
    if (layout !== DIRECT_PAD_LAYOUT) throw new RangeError(`direct pad layout ${layout}, expected ${DIRECT_PAD_LAYOUT}`);
    if (offset % 8 || offset + DIRECT_PAD_PORTS * DIRECT_PAD_SLOTS * 4 > buffer.byteLength) {
      throw new RangeError(`direct pad block at ${offset} is misaligned or out of bounds`);
    }
    this.i32 = new Int32Array(buffer, offset, DIRECT_PAD_PORTS * DIRECT_PAD_SLOTS);
    this.f64 = new Float64Array(buffer, offset, (DIRECT_PAD_PORTS * DIRECT_PAD_SLOTS) / 2);
  }

  base(port) {
    if (!Number.isInteger(port) || port < 0 || port >= DIRECT_PAD_PORTS) throw new RangeError(`port ${port}`);
    return port * DIRECT_PAD_SLOTS;
  }

  // state: the input.js layout; meta: { inputSeq, rxTime } (rxTime from epochNow()).
  write(port, state, { connected = true, inputSeq = 0, rxTime = epochNow() } = {}) {
    const b = this.base(port);
    const v = this.i32;
    const seq = (Atomics.load(v, b + SLOT.SEQ) + 1) | 1;
    Atomics.store(v, b + SLOT.SEQ, seq);
    Atomics.store(v, b + SLOT.CONNECTED, connected ? 1 : 0);
    Atomics.store(v, b + SLOT.MASK, connected ? Number(state?.mask) >>> 0 : 0);
    const s = connected ? state ?? {} : {};
    Atomics.store(v, b + SLOT.AXES0,
      byte(s.stickX ?? 0x80) | (byte(s.stickY ?? 0x80) << 8) | (byte(s.cStickX ?? 0x80) << 16) | (byte(s.cStickY ?? 0x80) << 24));
    Atomics.store(v, b + SLOT.AXES1,
      byte(s.triggerLeft) | (byte(s.triggerRight) << 8) | (byte(s.analogA) << 16) | (byte(s.analogB) << 24));
    Atomics.store(v, b + SLOT.INPUT_SEQ, inputSeq | 0);
    this.f64[(b + SLOT.RX_TIME) / 2] = rxTime;
    Atomics.store(v, b + SLOT.SEQ, (seq + 1) | 0);
    Atomics.store(v, b + SLOT.ENABLED, 1);
  }

  // Buttons pressed since the last poll, held until a poll of a later frame read them.
  tap(port, buttons) {
    const bits = buttons & ((1 << DIRECT_PAD_BUTTONS) - 1);
    if (bits) Atomics.or(this.i32, this.base(port) + SLOT.TAPS, bits);
  }

  // What the core's polls of this port read last.
  read(port) {
    const b = this.base(port);
    const v = this.i32;
    const pollCount = Atomics.load(v, b + SLOT.POLL_COUNT) >>> 0;
    const presses = [];
    for (let i = 0; i < DIRECT_PAD_BUTTONS; i += 1) presses.push(Atomics.load(v, b + SLOT.PRESSES + i) >>> 0);
    return {
      pollCount,
      appliedSeq: Atomics.load(v, b + SLOT.APPLIED_SEQ) >>> 0,
      appliedRxTime: this.f64[(b + SLOT.APPLIED_RX_TIME) / 2],
      pollTime: this.f64[(b + SLOT.POLL_TIME) / 2],
      rumble: Atomics.load(v, b + SLOT.RUMBLE),
      rumbleGeneration: Atomics.load(v, b + SLOT.RUMBLE_GEN) >>> 0,
      reportedMask: Atomics.load(v, b + SLOT.REPORTED_MASK) >>> 0,
      edgePollTime: this.f64[(b + SLOT.EDGE_POLL_TIME) / 2],
      presses
    };
  }
}
