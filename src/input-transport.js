// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// One seqlock-protected block per GameCube port, back to back in one SAB.
// Block slots: 0=mask, 1=stickX, 2=stickY, 3=cStickX, 4=cStickY,
//   5=triggerLeft, 6=triggerRight, 7=analogA, 8=analogB,
//   9=generation (per port, bumped on every published change),
//   10=Date.now() low 32 bits for input-age telemetry,
//   11=odd/even sequence: odd while the writer changes the block,
//   12=connected (1 plugged in, 0 unplugged), 13-15 reserved.
export const INPUT_PORT_COUNT = 4;
export const INPUT_PORT_SLOT_COUNT = 16;
export const INPUT_STATE_SLOT_COUNT = INPUT_PORT_COUNT * INPUT_PORT_SLOT_COUNT;
export const INPUT_STATE_SEQUENCE_SLOT = 11;
export const INPUT_STATE_CONNECTED_SLOT = 12;

export function compareInputGenerations(candidate, current) {
  const delta = ((Number(candidate) >>> 0) - (Number(current) >>> 0)) >>> 0;
  if (delta === 0) return 0;
  return delta < 0x8000_0000 ? 1 : -1;
}

// state.connected defaults to true: publishing a state plugs the port in.
export function writeInputStateSnapshot(view, state = {}, port = 0) {
  const base = requireInputStateView(view, port);
  const sequenceSlot = base + INPUT_STATE_SEQUENCE_SLOT;
  const previousSequence = Atomics.load(view, sequenceSlot) >>> 0;
  const writeSequence = ((previousSequence + 1) | 1) >>> 0;
  Atomics.store(view, sequenceSlot, writeSequence | 0);
  Atomics.store(view, base + 0, Number(state.mask) | 0);
  Atomics.store(view, base + 1, Number(state.stickX) | 0);
  Atomics.store(view, base + 2, Number(state.stickY) | 0);
  Atomics.store(view, base + 3, Number(state.cStickX) | 0);
  Atomics.store(view, base + 4, Number(state.cStickY) | 0);
  Atomics.store(view, base + 5, Number(state.triggerLeft) | 0);
  Atomics.store(view, base + 6, Number(state.triggerRight) | 0);
  Atomics.store(view, base + 7, Number(state.analogA) | 0);
  Atomics.store(view, base + 8, Number(state.analogB) | 0);
  Atomics.store(view, base + INPUT_STATE_CONNECTED_SLOT, state.connected === false ? 0 : 1);
  Atomics.store(view, base + 10, Number(state.sentAtEpochMs) | 0);
  Atomics.store(view, base + 9, Number(state.inputGeneration) | 0);
  Atomics.store(view, sequenceSlot, (writeSequence + 1) | 0);
}

export function readInputStateSnapshot(view, { maxAttempts = 3, port = 0 } = {}) {
  const base = requireInputStateView(view, port);
  const sequenceSlot = base + INPUT_STATE_SEQUENCE_SLOT;
  const attempts = Math.max(1, Math.trunc(Number(maxAttempts) || 1));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const sequenceBefore = Atomics.load(view, sequenceSlot) >>> 0;
    if (sequenceBefore & 1) {
      return { attempts: attempt, snapshot: null, status: "writer-active" };
    }
    const snapshot = {
      mask: Atomics.load(view, base + 0) >>> 0,
      stickX: Atomics.load(view, base + 1),
      stickY: Atomics.load(view, base + 2),
      cStickX: Atomics.load(view, base + 3),
      cStickY: Atomics.load(view, base + 4),
      triggerLeft: Atomics.load(view, base + 5),
      triggerRight: Atomics.load(view, base + 6),
      analogA: Atomics.load(view, base + 7),
      analogB: Atomics.load(view, base + 8),
      connected: Atomics.load(view, base + INPUT_STATE_CONNECTED_SLOT) !== 0,
      inputGeneration: Atomics.load(view, base + 9) >>> 0,
      sentAtEpochMsLow: Atomics.load(view, base + 10) >>> 0
    };
    const sequenceAfter = Atomics.load(view, sequenceSlot) >>> 0;
    if (sequenceBefore === sequenceAfter && !(sequenceAfter & 1)) {
      return { attempts: attempt, snapshot, status: "ok" };
    }
  }
  return { attempts, snapshot: null, status: "unstable" };
}

function requireInputStateView(view, port) {
  if (!Number.isInteger(port) || port < 0 || port >= INPUT_PORT_COUNT) {
    throw new RangeError(`input port must be 0-${INPUT_PORT_COUNT - 1}, got ${port}`);
  }
  if (!(view instanceof Int32Array) || view.length < INPUT_STATE_SLOT_COUNT) {
    throw new TypeError(`input state transport requires ${INPUT_STATE_SLOT_COUNT} Int32 slots`);
  }
  return port * INPUT_PORT_SLOT_COUNT;
}
