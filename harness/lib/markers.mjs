// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Decoder for the marker rows of harness/homebrew/common/marker.h, read from
// an exact native-size XFB capture (no scaling). The checksum row decides:
// rows are returned only when it matches, otherwise the capture is
// unreadable. Nothing is guessed from colours.

export const ROWS = 4;

function fnv(values) {
  let h = 2166136261;
  for (const v of values) {
    for (const shift of [24, 16, 8, 0]) {
      h ^= (v >>> shift) & 0xff;
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h >>> 0;
}

function cellLuma(frame, x, y) {
  let sum = 0;
  for (let dy = 3; dy < 9; dy += 1) for (let dx = 4; dx < 10; dx += 1) {
    const i = ((y + dy) * frame.width + (x + dx)) * 4;
    sum += 0.299 * frame.data[i] + 0.587 * frame.data[i + 1] + 0.114 * frame.data[i + 2];
  }
  return sum / 36;
}

function readRow(frame, row) {
  let value = 0;
  for (let i = 0; i < 32; i += 1) if (cellLuma(frame, 32 + i * 18, 384 + row * 16) >= 128) value |= 1 << (31 - i);
  return value >>> 0;
}

// { ok, rows } with ok === false when the frame is too small or the checksum
// row does not match.
export function decodeRows(frame) {
  if (!frame || frame.width < 32 + 32 * 18 || frame.height < 384 + (ROWS + 1) * 16) return { ok: false, rows: null };
  const rows = Array.from({ length: ROWS }, (_, r) => readRow(frame, r));
  const ok = readRow(frame, ROWS) === fnv(rows);
  return { ok, rows: ok ? rows : null };
}

// Paint rows exactly like marker.h (white / black cells), for tests.
export function paintRows(frame, rows) {
  const all = [...rows, fnv(rows)];
  all.forEach((value, r) => {
    for (let i = 0; i < 32; i += 1) {
      const v = (value >>> (31 - i)) & 1 ? 255 : 0;
      for (let y = 384 + r * 16; y < 384 + r * 16 + 12; y += 1) for (let x = 32 + i * 18; x < 32 + i * 18 + 14; x += 1) {
        frame.data.set([v, v, v, 255], (y * frame.width + x) * 4);
      }
    }
  });
  return frame;
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
