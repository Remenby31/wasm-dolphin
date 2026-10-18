// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Reusable multi-controller Gamepad API mock.
//
// Inject installGamepadMock as an init script (page.addInitScript) before the
// app loads; it replaces navigator.getGamepads with up to 4 virtual
// "standard"-mapping pads controlled through window.__harnessGamepads.
// Drive it from Node with setPad(page, index, state) where state uses
// GameCube names (see toStandardGamepad). Works in any page, not just this app.

// Standard-mapping indices (W3C Gamepad spec) for each GameCube control, as
// the app reads them (src/input.js STANDARD_GAMEPAD_BUTTONS).
export const GC_TO_STANDARD_BUTTON = Object.freeze({
  A: 0, B: 1, X: 2, Y: 3, L: 4, R: 5, Z: 8, START: 9,
  D_UP: 12, D_DOWN: 13, D_LEFT: 14, D_RIGHT: 15
});

export const STANDARD_BUTTON_COUNT = 17;

const clampUnit = (v) => Math.max(-1, Math.min(1, Number(v) || 0));

// GameCube-style state → standard gamepad arrays.
//   pressed: ["A", "START", ...]   stick/cstick: [x, y] in -1..1, y up positive
//   l/r: analog trigger 0..1 (a pressed "L"/"R" implies 1)
export function toStandardGamepad(state = {}) {
  const buttons = new Array(STANDARD_BUTTON_COUNT).fill(0);
  for (const name of state.pressed ?? []) {
    const index = GC_TO_STANDARD_BUTTON[name];
    if (index === undefined) throw new Error(`unknown GameCube button ${name}`);
    buttons[index] = 1;
  }
  const l = state.pressed?.includes("L") ? 1 : Math.max(0, Math.min(1, Number(state.l) || 0));
  const r = state.pressed?.includes("R") ? 1 : Math.max(0, Math.min(1, Number(state.r) || 0));
  buttons[6] = l;
  buttons[7] = r;
  const [sx = 0, sy = 0] = state.stick ?? [];
  const [cx = 0, cy = 0] = state.cstick ?? [];
  // Standard mapping: +y is down.
  const axes = [clampUnit(sx), -clampUnit(sy), clampUnit(cx), -clampUnit(cy)].map((v) => v + 0);
  return { buttons, axes };
}

// Runs in the page. Must stay self-contained (it is serialised).
export function installGamepadMock(options = {}) {
  const count = options.count ?? 4;
  const slots = new Array(count).fill(null);
  const makePad = (index, s) => ({
    id: `Harness virtual pad ${index + 1} (STANDARD GAMEPAD Vendor: 0000 Product: 0000)`,
    index,
    connected: true,
    mapping: "standard",
    timestamp: s.timestamp,
    axes: Object.freeze(s.axes.slice()),
    buttons: Object.freeze(s.buttons.map((value) => Object.freeze({ pressed: value >= 0.5, touched: value > 0, value }))),
    vibrationActuator: null,
    hapticActuators: []
  });
  const fire = (type, index) => {
    const pad = slots[index] ? makePad(index, slots[index]) : { index, connected: false, id: "", axes: [], buttons: [] };
    const event = new Event(type);
    Object.defineProperty(event, "gamepad", { value: pad });
    window.dispatchEvent(event);
  };
  const api = {
    count,
    connect(index) {
      if (!slots[index]) {
        slots[index] = { axes: [0, 0, 0, 0], buttons: new Array(17).fill(0), timestamp: performance.now() };
        fire("gamepadconnected", index);
      }
    },
    disconnect(index) {
      if (slots[index]) { slots[index] = null; fire("gamepaddisconnected", index); }
    },
    set(index, { buttons, axes }) {
      api.connect(index);
      const s = slots[index];
      if (buttons) s.buttons = buttons.slice(0, 17).concat(new Array(Math.max(0, 17 - buttons.length)).fill(0));
      if (axes) s.axes = axes.slice(0, 4);
      s.timestamp = performance.now();
    },
    snapshot() {
      return slots.map((s, i) => (s ? { index: i, buttons: s.buttons.slice(), axes: s.axes.slice() } : null));
    }
  };
  const getGamepads = function getGamepads() {
    return slots.map((s, i) => (s ? makePad(i, s) : null));
  };
  Object.defineProperty(Navigator.prototype, "getGamepads", { value: getGamepads, configurable: true, writable: true });
  window.__harnessGamepads = api;
  for (let i = 0; i < (options.connected ?? 0); i += 1) api.connect(i);
}

export async function addGamepadMock(context, options = {}) {
  await context.addInitScript(installGamepadMock, options);
}

export async function setPad(page, index, state) {
  const standard = toStandardGamepad(state);
  await page.evaluate(([i, s]) => window.__harnessGamepads.set(i, s), [index, standard]);
}

export async function releaseAll(page) {
  await page.evaluate(() => {
    const api = window.__harnessGamepads;
    for (let i = 0; i < api.count; i += 1) if (api.snapshot()[i]) api.set(i, { buttons: [], axes: [0, 0, 0, 0] });
  });
}
