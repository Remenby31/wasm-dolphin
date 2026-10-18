// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { installGamepadMock, toStandardGamepad } from "../harness/lib/gamepad-mock.mjs";
import { BUTTONS, readGamepadInput } from "../src/input.js";

function withFakeWindow(fn) {
  const saved = { window: globalThis.window, Navigator: globalThis.Navigator, Event: globalThis.Event };
  const events = [];
  class FakeNavigator {}
  globalThis.Navigator = FakeNavigator;
  globalThis.window = { dispatchEvent: (e) => events.push(e) };
  try {
    return fn({ navigator: new FakeNavigator(), events });
  } finally {
    Object.assign(globalThis, saved);
  }
}

test("four virtual pads are exposed with standard mapping and connect events", () => {
  withFakeWindow(({ navigator, events }) => {
    installGamepadMock({ count: 4, connected: 2 });
    const pads = navigator.getGamepads();
    assert.equal(pads.length, 4);
    assert.equal(pads[0].mapping, "standard");
    assert.equal(pads[2], null);
    assert.deepEqual(events.map((e) => [e.type, e.gamepad.index]), [["gamepadconnected", 0], ["gamepadconnected", 1]]);
    window.__harnessGamepads.set(3, toStandardGamepad({ pressed: ["START"] }));
    assert.equal(navigator.getGamepads()[3].buttons[9].pressed, true);
    window.__harnessGamepads.disconnect(0);
    assert.equal(navigator.getGamepads()[0], null);
  });
});

test("mock states read back through the app's own gamepad reader", () => {
  withFakeWindow(({ navigator }) => {
    installGamepadMock({ count: 4 });
    const state = { pressed: ["A", "B", "X", "Y", "Z", "START", "D_UP", "D_LEFT", "L"], stick: [1, 0], cstick: [0, -1] };
    window.__harnessGamepads.set(1, toStandardGamepad(state));
    const { pressed, state: pad } = readGamepadInput(navigator.getGamepads()[1]);
    for (const b of ["A", "B", "X", "Y", "Z", "START", "D_UP", "D_LEFT", "L", "STICK_RIGHT", "C_STICK_DOWN"]) {
      assert.ok(pressed.has(b), `${b} not pressed`);
    }
    assert.equal(pad.mask & BUTTONS.R, 0);
    assert.equal(pad.triggerLeft, 0xff);
    assert.ok(pad.stickX > 0xd0);
    assert.ok(pad.cStickY < 0x30);
  });
});

test("unknown GameCube buttons are rejected", () => {
  assert.throws(() => toStandardGamepad({ pressed: ["SELECT"] }), /unknown GameCube button/);
});
