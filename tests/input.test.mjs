import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BUTTONS,
  C_STICK_GATE_RADIUS,
  DEFAULT_PAD_STATE,
  MAIN_STICK_GATE_RADIUS,
  assignGamepadPorts,
  composePortInputs,
  stickToPadBytes,
  buttonMaskFromPressed,
  formatControlLabel,
  inputStateFromPressed,
  mergePressedSets,
  pressedFromGamepad,
  readGamepadInput,
  resolveKeyboardButton,
  gamepadInputsEqual,
  selectPreferredGamepad,
  updatePressedSet
} from "../src/input.js";

test("keyboard bindings resolve GameCube-style controls", () => {
  assert.equal(resolveKeyboardButton("KeyX"), "A");
  assert.equal(resolveKeyboardButton("KeyZ"), "B");
  assert.equal(resolveKeyboardButton("KeyW"), "STICK_UP");
  assert.equal(resolveKeyboardButton("KeyA"), "STICK_LEFT");
  assert.equal(resolveKeyboardButton("KeyS"), "STICK_DOWN");
  assert.equal(resolveKeyboardButton("KeyD"), "STICK_RIGHT");
  assert.equal(resolveKeyboardButton("Enter"), "START");
  assert.equal(resolveKeyboardButton("Escape"), null);
});

test("pressed sets convert to a stable bit mask", () => {
  const pressed = new Set(["A", "B", "D_UP"]);
  assert.equal(buttonMaskFromPressed(pressed), BUTTONS.A | BUTTONS.B | BUTTONS.D_UP);
});

test("pressed set updates are immutable", () => {
  const original = new Set(["A"]);
  const next = updatePressedSet(original, "B", true);
  const released = updatePressedSet(next, "A", false);

  assert.deepEqual([...original], ["A"]);
  assert.equal(next.has("B"), true);
  assert.equal(released.has("A"), false);
});

test("gamepad buttons and axes map into pressed controls", () => {
  const gamepad = {
    axes: [0.75, -0.75, -0.75, 0.75],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false }))
  };
  gamepad.buttons[0].pressed = true;
  gamepad.buttons[9].pressed = true;
  gamepad.buttons[6].value = 0.6;

  const pressed = pressedFromGamepad(gamepad);

  assert.equal(pressed.has("A"), true);
  assert.equal(pressed.has("START"), true);
  assert.equal(pressed.has("L"), true);
  assert.equal(pressed.has("STICK_RIGHT"), true);
  assert.equal(pressed.has("STICK_UP"), true);
  assert.equal(pressed.has("C_STICK_LEFT"), true);
  assert.equal(pressed.has("C_STICK_DOWN"), true);
});

test("gamepad input exposes analog GameCube pad state", () => {
  const gamepad = {
    axes: [1, -1, -0.5, 0.5],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }))
  };
  gamepad.buttons[0].pressed = true;
  gamepad.buttons[7].value = 0.75;

  const { pressed, state } = readGamepadInput(gamepad);

  assert.equal(pressed.has("A"), true);
  assert.equal(pressed.has("R"), true);
  assert.equal(state.mask & BUTTONS.A, BUTTONS.A);
  assert.equal(state.analogA, 0xff);
  assert.equal(state.triggerRight, 0xbf);
  // Full diagonal lands on the octagonal gate's vertex (71, 71), not on a
  // square corner outside the gate.
  assert.equal(state.stickX, 0x80 + 71);
  assert.equal(state.stickY, 0x80 + 71);
  assert.equal(state.cStickX, 0x80 - 42);
  assert.equal(state.cStickY, 0x80 - 42);
});

test("analog movement below the digital deadzone stays analog-only", () => {
  const gamepad = {
    axes: [0.5, -0.5, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }))
  };

  const { pressed, state } = readGamepadInput(gamepad);

  assert.equal(pressed.has("STICK_RIGHT"), false);
  assert.equal(pressed.has("STICK_UP"), false);
  assert.ok(state.stickX > DEFAULT_PAD_STATE.stickX);
  assert.ok(state.stickY > DEFAULT_PAD_STATE.stickY);
});

test("preferred gamepad selection avoids phantom non-standard devices", () => {
  const phantom = { mapping: "", buttons: Array(32) };
  const firstStandard = { mapping: "standard", buttons: Array(12) };
  const fullStandard = { mapping: "standard", buttons: Array(17) };

  assert.equal(selectPreferredGamepad([phantom, firstStandard, fullStandard]), fullStandard);
  assert.equal(selectPreferredGamepad([phantom, null]), phantom);
  assert.equal(selectPreferredGamepad([null]), null);
});

test("gamepad equality follows the quantized state sent to Dolphin", () => {
  const neutralPad = {
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }))
  };
  const same = readGamepadInput(neutralPad);
  const equivalent = readGamepadInput(neutralPad);
  const moved = readGamepadInput({ ...neutralPad, axes: [0.75, 0, 0, 0] });

  assert.equal(gamepadInputsEqual(same, equivalent), true);
  assert.equal(gamepadInputsEqual(same, moved), false);
  assert.equal(gamepadInputsEqual(null, null), true);
  assert.equal(gamepadInputsEqual(null, same), false);
});

test("gamepad polling suppresses unchanged sync work with a legacy control", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /legacygamepadpoll/);
  assert.match(source, /assignGamepadPorts\(gamepadPorts, pads\)/);
  assert.match(source, /gamepadInputsEqual\(lastGamepadInputs\.get\(index\), input\)/);
});

test("digital input produces neutral analog defaults with pressed extremes", () => {
  const state = inputStateFromPressed(new Set(["STICK_LEFT", "C_STICK_UP", "B"]));

  assert.equal(state.mask, BUTTONS.STICK_LEFT | BUTTONS.C_STICK_UP | BUTTONS.B);
  assert.equal(state.stickX, 0x80 - 101);
  assert.equal(state.stickY, DEFAULT_PAD_STATE.stickY);
  assert.equal(state.cStickX, DEFAULT_PAD_STATE.cStickX);
  assert.equal(state.cStickY, 0x80 + 92);
  assert.equal(state.analogB, 0xff);
});

test("pressed sets merge without duplicates", () => {
  const merged = mergePressedSets(new Set(["A"]), new Set(["A", "B"]));
  assert.deepEqual([...merged], ["A", "B"]);
});

test("control labels are display-friendly", () => {
  assert.equal(formatControlLabel("D_UP"), "D UP");
});

const pad = (index, axes = [0, 0, 0, 0], mapping = "standard") => ({
  index,
  mapping,
  connected: true,
  axes,
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
});

test("sticks reach the gate of a genuine controller: ±101 main, ±92 C", () => {
  assert.deepEqual(stickToPadBytes(1, 0, MAIN_STICK_GATE_RADIUS), [0x80 + 101, 0x80]);
  assert.deepEqual(stickToPadBytes(0, -1, MAIN_STICK_GATE_RADIUS), [0x80, 0x80 - 101]);
  assert.deepEqual(stickToPadBytes(-1, 0, C_STICK_GATE_RADIUS), [0x80 - 92, 0x80]);
  // A square corner is clamped to the circle, then to the octagon vertex.
  assert.deepEqual(stickToPadBytes(1, 1, MAIN_STICK_GATE_RADIUS), [0x80 + 71, 0x80 + 71]);
  // Mid-edge of the octagon (22.5°) is cos(22.5°) of the vertex radius.
  const [x, y] = stickToPadBytes(Math.cos(Math.PI / 8), Math.sin(Math.PI / 8), MAIN_STICK_GATE_RADIUS);
  assert.equal(Math.round(Math.hypot(x - 0x80, y - 0x80)), Math.round(101 * Math.cos(Math.PI / 8)));
});

test("the stick deadzone is radial and the travel past it starts at the centre", () => {
  const deadzone = 0.18;
  assert.deepEqual(stickToPadBytes(0.12, 0.12, MAIN_STICK_GATE_RADIUS, deadzone), [0x80, 0x80]);
  assert.deepEqual(stickToPadBytes(0.19, 0, MAIN_STICK_GATE_RADIUS, deadzone), [0x80 + 1, 0x80]);
  assert.deepEqual(stickToPadBytes(1, 0, MAIN_STICK_GATE_RADIUS, deadzone), [0x80 + 101, 0x80]);
  // Monotonic between the deadzone and full tilt.
  let previous = 0x80;
  for (let x = 0.2; x <= 1; x += 0.05) {
    const [byte] = stickToPadBytes(x, 0, MAIN_STICK_GATE_RADIUS, deadzone);
    assert.ok(byte >= previous, `x=${x}`);
    previous = byte;
  }
  assert.deepEqual(stickToPadBytes(NaN, 0, MAIN_STICK_GATE_RADIUS), [0x80, 0x80]);
});

test("a deflected analog stick is never overridden by its digital direction", () => {
  const { pressed, state } = readGamepadInput(pad(0, [0.7, 0, 0, 0]));
  assert.ok(pressed.has("STICK_RIGHT"));
  const sent = inputStateFromPressed(pressed, state);
  assert.equal(sent.stickX, state.stickX);
  assert.ok(sent.stickX < 0x80 + 101);
  // Two digital directions make a diagonal on the gate.
  const keys = inputStateFromPressed(new Set(["STICK_RIGHT", "STICK_UP"]));
  assert.deepEqual([keys.stickX, keys.stickY], [0x80 + 71, 0x80 + 71]);
});

test("gamepads take ports in connection order and keep them while plugged", () => {
  let ports = assignGamepadPorts(null, [pad(0), pad(1)]);
  assert.deepEqual(ports, [0, 1, null, null]);
  ports = assignGamepadPorts(ports, [pad(0), pad(1), pad(2), pad(3)]);
  assert.deepEqual(ports, [0, 1, 2, 3]);
  // Unplugging pad 1 frees P2 only; the others keep theirs.
  ports = assignGamepadPorts(ports, [pad(0), null, pad(2), pad(3)]);
  assert.deepEqual(ports, [0, null, 2, 3]);
  // The next pad takes the lowest free port.
  ports = assignGamepadPorts(ports, [pad(0), pad(1), pad(2), pad(3)]);
  assert.deepEqual(ports, [0, 1, 2, 3]);
  // A fifth pad waits for a free port.
  assert.deepEqual(assignGamepadPorts(ports, [pad(0), pad(1), pad(2), pad(3), pad(4)]), [0, 1, 2, 3]);
  assert.deepEqual(assignGamepadPorts(ports, []), [null, null, null, null]);
});

test("a phantom non-standard device only gets a port when no standard pad is there", () => {
  const phantom = pad(0, [-1, -1, -1, -1], "");
  assert.deepEqual(assignGamepadPorts(null, [phantom, pad(1)]), [1, null, null, null]);
  assert.deepEqual(assignGamepadPorts(null, [phantom]), [0, null, null, null]);
});

test("each port carries its own pad; the keyboard joins P1; empty ports are unplugged", () => {
  const pads = [pad(0), pad(1, [0, 0, 1, 0])];
  pads[0].buttons[0] = { pressed: true, value: 1 };
  const ports = assignGamepadPorts(null, pads);
  const gamepadInputs = new Map(pads.map((gamepad) => [gamepad.index, readGamepadInput(gamepad)]));
  const inputs = composePortInputs({ ports, gamepadInputs, keyboardPressed: new Set(["START"]) });

  assert.deepEqual(inputs.map((input) => input.connected), [true, true, false, false]);
  assert.equal(inputs[0].state.mask, BUTTONS.A | BUTTONS.START);
  assert.equal(inputs[1].state.mask & (BUTTONS.A | BUTTONS.START), 0);
  assert.equal(inputs[1].state.cStickX, 0x80 + 92);
  assert.equal(inputs[0].state.cStickX, 0x80);
  assert.deepEqual(inputs[2].state, DEFAULT_PAD_STATE);

  // Keyboard alone keeps P1 plugged; moved to P3 it plugs P3 instead.
  const keyboardOnly = composePortInputs({ ports: [null, null, null, null], gamepadInputs: new Map() });
  assert.deepEqual(keyboardOnly.map((input) => input.connected), [true, false, false, false]);
  const moved = composePortInputs({ ports: [null, null, null, null], gamepadInputs: new Map(), keyboardPort: 2 });
  assert.deepEqual(moved.map((input) => input.connected), [false, false, true, false]);
});
