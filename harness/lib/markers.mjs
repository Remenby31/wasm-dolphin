// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Decoder for the homebrew marker protocol (harness/homebrew/common/marker.h).
// Coordinates are in the 640x480 XFB space and scaled to the captured frame.

export const XFB_W = 640;
export const XFB_H = 480;
export const STATUS_RECT = Object.freeze({ x: 576, y: 16, w: 48, h: 32 });
export const ROWS = 4;

// RGB the decoder expects for each status (from the BT.601 YUV in marker.h).
export const STATUS_COLORS = Object.freeze({
  idle: [0, 0, 255],
  running: [255, 255, 0],
  pass: [0, 255, 0],
  fail: [255, 0, 0]
});

function sampleRect(frame, x, y, w, h) {
  const sx = frame.width / XFB_W, sy = frame.height / XFB_H;
  // Sample the inner half of the rect to stay clear of filtering at the edges.
  const x0 = Math.round((x + w / 4) * sx), x1 = Math.max(x0 + 1, Math.round((x + (3 * w) / 4) * sx));
  const y0 = Math.round((y + h / 4) * sy), y1 = Math.max(y0 + 1, Math.round((y + (3 * h) / 4) * sy));
  let r = 0, g = 0, b = 0, n = 0;
  for (let py = y0; py < y1; py += 1) for (let px = x0; px < x1; px += 1) {
    const i = (py * frame.width + px) * 4;
    r += frame.data[i]; g += frame.data[i + 1]; b += frame.data[i + 2]; n += 1;
  }
  return [r / n, g / n, b / n];
}

// Spread of luma inside a rect: a painted marker is flat, a game picture
// that happens to be yellow or green there usually is not.
function rectSpread(frame, x, y, w, h) {
  const sx = frame.width / XFB_W, sy = frame.height / XFB_H;
  let min = 255, max = 0;
  for (let py = Math.round((y + h / 4) * sy); py < Math.round((y + (3 * h) / 4) * sy); py += 1) {
    for (let px = Math.round((x + w / 4) * sx); px < Math.round((x + (3 * w) / 4) * sx); px += 1) {
      const i = (py * frame.width + px) * 4;
      const l = 0.299 * frame.data[i] + 0.587 * frame.data[i + 1] + 0.114 * frame.data[i + 2];
      if (l < min) min = l;
      if (l > max) max = l;
    }
  }
  return max - min;
}

export function decodeStatus(frame) {
  if (rectSpread(frame, STATUS_RECT.x, STATUS_RECT.y, STATUS_RECT.w, STATUS_RECT.h) > 24) return null;
  const rgb = sampleRect(frame, STATUS_RECT.x, STATUS_RECT.y, STATUS_RECT.w, STATUS_RECT.h);
  let best = null, bestDist = Infinity;
  for (const [name, ref] of Object.entries(STATUS_COLORS)) {
    const d = Math.hypot(rgb[0] - ref[0], rgb[1] - ref[1], rgb[2] - ref[2]);
    if (d < bestDist) { best = name; bestDist = d; }
  }
  // 120 ≈ well inside the gap between any two reference colours.
  return bestDist < 120 ? best : null;
}

export function decodeRow(frame, row) {
  let value = 0;
  let confident = true;
  for (let i = 0; i < 32; i += 1) {
    const [r, g, b] = sampleRect(frame, 32 + i * 18, 384 + row * 20, 14, 14);
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    if (luma > 70 && luma < 185) confident = false;
    // Cells are flat and grey: anything coloured or textured is not a marker.
    if (Math.max(r, g, b) - Math.min(r, g, b) > 40 || rectSpread(frame, 32 + i * 18, 384 + row * 20, 14, 14) > 40) confident = false;
    if (luma >= 128) value |= 1 << (31 - i);
  }
  return { value: value >>> 0, confident };
}

export function decodeMarkers(frame) {
  const status = decodeStatus(frame);
  const rows = [];
  let confident = status !== null;
  for (let r = 0; r < ROWS; r += 1) {
    const row = decodeRow(frame, r);
    rows.push(row.value);
    confident &&= row.confident;
  }
  return { status, rows, confident };
}

export const hex = (v) => `0x${(v >>> 0).toString(16).padStart(8, "0")}`;

// padtest row → controller state (see harness/homebrew/padtest/main.c).
const PAD_BITS = Object.freeze([
  [0, "D_LEFT"], [1, "D_RIGHT"], [2, "D_DOWN"], [3, "D_UP"], [4, "Z"], [5, "R"], [6, "L"],
  [8, "A"], [9, "B"], [10, "X"], [11, "Y"], [12, "START"],
  [13, "STICK_RIGHT"], [14, "STICK_LEFT"], [15, "STICK_UP"], [16, "STICK_DOWN"],
  [17, "C_STICK_RIGHT"], [18, "C_STICK_LEFT"], [19, "C_STICK_UP"], [20, "C_STICK_DOWN"],
  [21, "L_ANALOG"], [22, "R_ANALOG"]
]);

export function decodePadRow(value) {
  if (!(value & 0x80000000)) return null;
  const pressed = PAD_BITS.filter(([bit]) => value & (1 << bit)).map(([, name]) => name);
  return { connected: Boolean(value & (1 << 23)), pressed };
}
