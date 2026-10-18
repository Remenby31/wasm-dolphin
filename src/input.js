export const BUTTONS = Object.freeze({
  A: 1 << 0,
  B: 1 << 1,
  X: 1 << 2,
  Y: 1 << 3,
  START: 1 << 4,
  L: 1 << 5,
  R: 1 << 6,
  Z: 1 << 7,
  D_UP: 1 << 8,
  D_DOWN: 1 << 9,
  D_LEFT: 1 << 10,
  D_RIGHT: 1 << 11,
  STICK_UP: 1 << 12,
  STICK_DOWN: 1 << 13,
  STICK_LEFT: 1 << 14,
  STICK_RIGHT: 1 << 15,
  C_STICK_UP: 1 << 16,
  C_STICK_DOWN: 1 << 17,
  C_STICK_LEFT: 1 << 18,
  C_STICK_RIGHT: 1 << 19
});

export const CONTROL_LABELS = Object.freeze([
  "A",
  "B",
  "X",
  "Y",
  "START",
  "L",
  "R",
  "Z",
  "D_UP",
  "D_DOWN",
  "D_LEFT",
  "D_RIGHT",
  "STICK_UP",
  "STICK_DOWN",
  "STICK_LEFT",
  "STICK_RIGHT",
  "C_STICK_UP",
  "C_STICK_DOWN",
  "C_STICK_LEFT",
  "C_STICK_RIGHT"
]);

export const DEFAULT_KEY_BINDINGS = Object.freeze({
  KeyX: "A",
  KeyZ: "B",
  KeyV: "X",
  KeyB: "Y",
  Enter: "START",
  KeyQ: "L",
  KeyE: "R",
  KeyC: "Z",
  ArrowUp: "D_UP",
  ArrowDown: "D_DOWN",
  ArrowLeft: "D_LEFT",
  ArrowRight: "D_RIGHT",
  KeyW: "STICK_UP",
  KeyS: "STICK_DOWN",
  KeyA: "STICK_LEFT",
  KeyD: "STICK_RIGHT",
  KeyI: "C_STICK_UP",
  KeyK: "C_STICK_DOWN",
  KeyJ: "C_STICK_LEFT",
  KeyL: "C_STICK_RIGHT"
});

const STANDARD_GAMEPAD_BUTTONS = Object.freeze({
  0: "A",
  1: "B",
  2: "X",
  3: "Y",
  4: "L",
  5: "R",
  8: "Z",
  9: "START",
  12: "D_UP",
  13: "D_DOWN",
  14: "D_LEFT",
  15: "D_RIGHT"
});

export const DEFAULT_PAD_STATE = Object.freeze({
  mask: 0,
  stickX: 0x80,
  stickY: 0x80,
  cStickX: 0x80,
  cStickY: 0x80,
  triggerLeft: 0,
  triggerRight: 0,
  analogA: 0,
  analogB: 0
});

const GAMEPAD_STATE_FIELDS = Object.freeze([
  "mask",
  "stickX",
  "stickY",
  "cStickX",
  "cStickY",
  "triggerLeft",
  "triggerRight",
  "analogA",
  "analogB"
]);

export function resolveKeyboardButton(code, bindings = DEFAULT_KEY_BINDINGS) {
  return bindings[code] ?? null;
}

export function updatePressedSet(pressed, button, isPressed) {
  const next = new Set(pressed);

  if (!button) {
    return next;
  }

  if (isPressed) {
    next.add(button);
  } else {
    next.delete(button);
  }

  return next;
}

export function buttonMaskFromPressed(pressed) {
  let mask = 0;

  for (const button of pressed) {
    mask |= BUTTONS[button] ?? 0;
  }

  return mask >>> 0;
}

// §28ci gamepad deadzones, split into two scales:
//   ANALOG: small, so real-use axis motion reads smoothly through to the
//     emulated stick byte. Too-large here and slow stick movements feel
//     "snapped" / digital.
//   DIGITAL: large, so drift on worn Xbox sticks (commonly idles at
//     0.3-0.45 magnitude) doesn't fire phantom STICK_UP / C_STICK_*
//     pressed events. Those are the events that drive menu navigation
//     and the C-stick camera, so they must be drift-tolerant.
// User-reported symptoms in Chrome (2026-05-25): c-stick moving the
// screen and up-button stuck pressed at rest — both fixed by raising the
// digital threshold past typical Xbox drift.
const DEFAULT_GAMEPAD_ANALOG_DEADZONE = 0.18;

// Stick geometry of a genuine controller, as Dolphin emulates it
// (Core/HW/GCPadEmu.h, InputCommon OctagonStickGate): an octagonal gate whose
// vertices (cardinals and diagonals) sit at 0.794 (main) and 0.722 (C-stick)
// of the 127 steps around the 0x80 centre, i.e. ±101 and ±92 at full tilt.
export const MAIN_STICK_GATE_RADIUS = 0.7937125;
export const C_STICK_GATE_RADIUS = 0.7221375;
const DEFAULT_GAMEPAD_DIGITAL_DEADZONE = 0.55;

export const PAD_PORT_COUNT = 4;

export function isPadPort(port) {
  return Number.isInteger(port) && port >= 0 && port < PAD_PORT_COUNT;
}

export function selectPreferredGamepad(gamepads) {
  let fallback = null;
  let preferred = null;
  let preferredButtonCount = -1;
  const length = Number(gamepads?.length) || 0;

  for (let index = 0; index < length; index += 1) {
    const gamepad = gamepads[index];
    if (!gamepad) {
      continue;
    }
    fallback ??= gamepad;
    if (gamepad.mapping !== "standard") {
      continue;
    }

    const buttonCount = Number(gamepad.buttons?.length) || 0;
    if (!preferred || buttonCount > preferredButtonCount) {
      preferred = gamepad;
      preferredButtonCount = buttonCount;
    }
  }

  return preferred || fallback;
}

export function gamepadInputsEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.pressed?.size !== right.pressed?.size) {
    return false;
  }

  for (const button of left.pressed) {
    if (!right.pressed.has(button)) {
      return false;
    }
  }
  for (const field of GAMEPAD_STATE_FIELDS) {
    if (left.state?.[field] !== right.state?.[field]) {
      return false;
    }
  }
  return true;
}

export function pressedFromGamepad(
  gamepad,
  digitalThreshold = DEFAULT_GAMEPAD_DIGITAL_DEADZONE
) {
  return readGamepadInput(gamepad, digitalThreshold).pressed;
}

export function readGamepadInput(
  gamepad,
  digitalThreshold = DEFAULT_GAMEPAD_DIGITAL_DEADZONE,
  analogDeadzone = DEFAULT_GAMEPAD_ANALOG_DEADZONE
) {
  const pressed = new Set();
  const state = { ...DEFAULT_PAD_STATE };

  if (!gamepad) {
    return { pressed, state };
  }

  for (const [index, button] of Object.entries(STANDARD_GAMEPAD_BUTTONS)) {
    const padButton = gamepad.buttons[Number(index)];
    if (padButton?.pressed) {
      pressed.add(button);
      state.mask |= BUTTONS[button] ?? 0;
    }
  }

  const leftTrigger = gamepad.buttons[6]?.value ?? (gamepad.buttons[4]?.pressed ? 1 : 0);
  const rightTrigger = gamepad.buttons[7]?.value ?? (gamepad.buttons[5]?.pressed ? 1 : 0);
  state.triggerLeft = unitToByte(leftTrigger);
  state.triggerRight = unitToByte(rightTrigger);
  if (state.triggerLeft >= 0x80) {
    pressed.add("L");
    state.mask |= BUTTONS.L;
  }
  if (state.triggerRight >= 0x80) {
    pressed.add("R");
    state.mask |= BUTTONS.R;
  }

  if (gamepad.buttons[0]?.pressed) state.analogA = 0xff;
  if (gamepad.buttons[1]?.pressed) state.analogB = 0xff;

  const [leftX = 0, leftY = 0, rightX = 0, rightY = 0] = gamepad.axes;
  // Standard mapping has +y down; the GameCube has +y up.
  [state.stickX, state.stickY] = stickToPadBytes(leftX, -leftY, MAIN_STICK_GATE_RADIUS, analogDeadzone);
  [state.cStickX, state.cStickY] = stickToPadBytes(rightX, -rightY, C_STICK_GATE_RADIUS, analogDeadzone);

  if (leftX <= -digitalThreshold) pressed.add("STICK_LEFT");
  if (leftX >= digitalThreshold) pressed.add("STICK_RIGHT");
  if (leftY <= -digitalThreshold) pressed.add("STICK_UP");
  if (leftY >= digitalThreshold) pressed.add("STICK_DOWN");
  if (rightX <= -digitalThreshold) pressed.add("C_STICK_LEFT");
  if (rightX >= digitalThreshold) pressed.add("C_STICK_RIGHT");
  if (rightY <= -digitalThreshold) pressed.add("C_STICK_UP");
  if (rightY >= digitalThreshold) pressed.add("C_STICK_DOWN");

  return { pressed, state };
}

export function mergePressedSets(...sets) {
  const merged = new Set();

  for (const set of sets) {
    for (const button of set) {
      merged.add(button);
    }
  }

  return merged;
}

export function formatControlLabel(label) {
  return label.replaceAll("_", " ");
}

export function inputStateFromPressed(pressed, analogState = null) {
  const state = analogState ? { ...DEFAULT_PAD_STATE, ...analogState } : { ...DEFAULT_PAD_STATE };
  state.mask = buttonMaskFromPressed(pressed) | (state.mask >>> 0);

  applyDigitalStick(state, pressed, "STICK", "stickX", "stickY", MAIN_STICK_GATE_RADIUS);
  applyDigitalStick(state, pressed, "C_STICK", "cStickX", "cStickY", C_STICK_GATE_RADIUS);

  if (pressed.has("L")) state.triggerLeft = 0xff;
  if (pressed.has("R")) state.triggerRight = 0xff;
  if (pressed.has("A")) state.analogA = 0xff;
  if (pressed.has("B")) state.analogB = 0xff;

  return state;
}

// Digital directions (keys, touch) drive a stick only while its analog axes
// rest, so they never clobber a real stick; two keys make a diagonal.
function applyDigitalStick(state, pressed, prefix, fieldX, fieldY, gateRadius) {
  if (state[fieldX] !== 0x80 || state[fieldY] !== 0x80) {
    return;
  }
  const x = digitalAxis(pressed, `${prefix}_LEFT`, `${prefix}_RIGHT`);
  const y = digitalAxis(pressed, `${prefix}_DOWN`, `${prefix}_UP`);
  if (x || y) {
    [state[fieldX], state[fieldY]] = stickToPadBytes(x, y, gateRadius, 0);
  }
}

function digitalAxis(pressed, negativeButton, positiveButton) {
  return (pressed.has(positiveButton) ? 1 : 0) - (pressed.has(negativeButton) ? 1 : 0);
}

// Host stick (x right, y up, unit square) → GameCube stick bytes, as Dolphin
// reshapes it: clamp to the unit circle, radial deadzone with the remaining
// travel rescaled to 0..1 (so drift past the deadzone starts at the centre),
// then scale to the octagonal gate at that angle.
export function stickToPadBytes(x, y, gateRadius, deadzone = 0) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [0x80, 0x80];
  const distance = Math.min(1, Math.hypot(x, y));
  if (distance === 0 || distance <= deadzone) return [0x80, 0x80];
  const travel = (distance - deadzone) / (1 - deadzone);
  const angle = Math.atan2(y, x);
  const radius = travel * gateRadius * octagonGateRadiusAtAngle(angle);
  return [stickByte(radius * Math.cos(angle)), stickByte(radius * Math.sin(angle))];
}

// 1 at the vertices (every 45°), cos(22.5°) mid-edge.
function octagonGateRadiusAtAngle(angle) {
  const side = Math.PI / 4;
  const halfInteriorAngle = (3 * Math.PI) / 8;
  const local = ((angle % side) + side) % side;
  return Math.sin(halfInteriorAngle) / Math.sin(Math.PI - local - halfInteriorAngle);
}

function stickByte(unit) {
  return clampByte(Math.round(0x80 + unit * 127));
}

function unitToByte(value) {
  return clampByte(Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 0xff));
}

function clampByte(value) {
  return Math.max(0, Math.min(0xff, value | 0));
}

// Gamepad API pads → GameCube ports, in connection order. `ports` is the
// previous assignment (array of PAD_PORT_COUNT gamepad indexes or null). A pad
// keeps its port while it stays connected; a new pad takes the lowest free
// port, so a pad unplugged and plugged back in finds its port again if nobody
// took it. Pads with the W3C "standard" mapping are the ones assigned; a
// non-standard device only gets a port when no standard pad is present (it may
// be a phantom HID device with pinned axes, see selectPreferredGamepad).
export function assignGamepadPorts(ports, gamepads) {
  const present = [];
  const length = Number(gamepads?.length) || 0;
  for (let index = 0; index < length; index += 1) {
    const gamepad = gamepads[index];
    if (gamepad && gamepad.connected !== false) present.push(gamepad);
  }
  const standard = present.filter((gamepad) => gamepad.mapping === "standard");
  const eligible = new Set((standard.length ? standard : present).map((gamepad) => gamepad.index));

  const next = Array.from({ length: PAD_PORT_COUNT }, (_, port) =>
    eligible.has(ports?.[port]) ? ports[port] : null
  );
  // Chrome gives a new pad the lowest free index, so index order is the
  // connection order among the pads not yet assigned.
  for (const index of [...eligible].sort((a, b) => a - b)) {
    if (next.includes(index)) continue;
    const free = next.indexOf(null);
    if (free < 0) break;
    next[free] = index;
  }
  return next;
}

// What each port should send: { connected, state, pressed }. `gamepadInputs`
// maps a gamepad index to readGamepadInput(); the keyboard (and touch) pressed
// set drives `keyboardPort` (P1 by default, null for none) on top of whatever
// pad shares it. A port with neither is unplugged.
export function composePortInputs({ ports, gamepadInputs, keyboardPressed = new Set(), keyboardPort = 0 }) {
  return Array.from({ length: PAD_PORT_COUNT }, (_, port) => {
    const gamepadInput = ports[port] == null ? null : gamepadInputs.get(ports[port]) ?? null;
    const hasKeyboard = port === keyboardPort;
    if (!gamepadInput && !hasKeyboard) {
      return { connected: false, state: { ...DEFAULT_PAD_STATE }, pressed: new Set() };
    }
    const pressed = hasKeyboard
      ? mergePressedSets(keyboardPressed, gamepadInput?.pressed ?? [])
      : new Set(gamepadInput.pressed);
    return { connected: true, state: inputStateFromPressed(pressed, gamepadInput?.state ?? null), pressed };
  });
}
