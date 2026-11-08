// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Decoder for the report rows compat/homebrew/hwtests-report.cpp paints in
// the XFB (cell geometry of harness/homebrew/common/marker.h, rows from
// y = 16). Read from an exact native-size capture; returned only when the
// checksum row matches.

export const REPORT_ROWS = 26;
const Y = 16;
const MAGIC = 0x48575431;

function fnv(values) {
  let h = 2166136261;
  for (const v of values) for (const shift of [24, 16, 8, 0]) {
    h ^= (v >>> shift) & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
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
  for (let i = 0; i < 32; i += 1) if (cellLuma(frame, 32 + i * 18, Y + row * 16) >= 128) value |= 1 << (31 - i);
  return value >>> 0;
}

/** @returns {null | {done, tests, testsPassed, subtests, subtestsPassed, failures: {test, line, msgHash}[]}} */
export function decodeReport(frame) {
  if (!frame?.data || frame.width < 32 + 32 * 18 || frame.height < Y + (REPORT_ROWS + 1) * 16) return null;
  const rows = Array.from({ length: REPORT_ROWS }, (_, r) => readRow(frame, r));
  if (readRow(frame, REPORT_ROWS) !== fnv(rows) || rows[0] !== MAGIC) return null;
  const n = Math.min(rows[5], 10);
  return {
    done: (rows[1] & 0xff) === 1,
    tests: rows[1] >>> 8,
    testsPassed: rows[2],
    subtests: rows[3],
    subtestsPassed: rows[4],
    failures: Array.from({ length: n }, (_, i) => ({
      test: rows[6 + 2 * i] >>> 24, line: rows[6 + 2 * i] & 0xffffff,
      msgHash: rows[7 + 2 * i].toString(16).padStart(8, "0")
    }))
  };
}

// The encoder, for tests: an RGBA frame holding these rows.
export function paintReport(rows, width = 640, height = 480) {
  const data = new Uint8Array(width * height * 4);
  const all = [...rows, fnv(rows)];
  all.forEach((v, r) => {
    for (let i = 0; i < 32; i++) {
      const on = (v >>> (31 - i)) & 1 ? 235 : 16;
      for (let y = Y + r * 16; y < Y + r * 16 + 12; y++) for (let x = 32 + i * 18; x < 32 + i * 18 + 14; x++) {
        const k = (y * width + x) * 4;
        data[k] = data[k + 1] = data[k + 2] = on; data[k + 3] = 255;
      }
    }
  });
  return { width, height, data };
}
