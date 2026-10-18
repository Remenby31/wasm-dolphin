// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Dolphin save-state files for tests, shaped like State::SaveToFileSync's
// output: legacy header, version header and string, extended header, then
// the payload, LZ4-compressed in one chunk or stored as is. The payload
// starts like State::DoState's (console flag, MEM1 and MEM2 sizes), runs to
// `size` bytes and ends with `marker`, so two fixtures tell apart.
import { STATE_COOKIE_BASE, STATE_VERSION } from "../../src/memcard.js";

export const GC_STATE_SIZE = 0x1800000 + 64;

function lengthBytes(extra) {
  const out = [];
  while (extra >= 255) {
    out.push(255);
    extra -= 255;
  }
  out.push(extra);
  return out;
}

export function makeStateFile({
  gameId = "GTST01",
  version = STATE_VERSION,
  versionString = "Dolphin test",
  size = GC_STATE_SIZE,
  marker = [1, 2, 3, 4, 5],
  mem1 = 0x1800000,
  consoleFlag = 0,
  compression = "lz4",
  payload = null
} = {}) {
  const head = new Uint8Array(9);
  head[0] = consoleFlag;
  new DataView(head.buffer).setUint32(1, mem1, true);
  let body;
  if (compression === "none") {
    body = payload ?? (() => {
      const raw = new Uint8Array(size);
      raw.set(head, 0);
      raw.set(marker, size - marker.length);
      return raw;
    })();
  } else {
    // [9 literals][match of offset 1 repeating 0] then [marker literals].
    const matchLength = size - head.length - marker.length;
    const first = [0x90 | 15, ...head, 1, 0, ...lengthBytes(matchLength - 4 - 15)];
    const last = [marker.length << 4, ...marker];
    const block = new Uint8Array([...first, ...last]);
    body = new Uint8Array(4 + block.length);
    new DataView(body.buffer).setInt32(0, block.length, true);
    body.set(block, 4);
  }
  const text = new TextEncoder().encode(versionString);
  const out = new Uint8Array(32 + text.length + 16 + body.length);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(gameId.slice(0, 6)), 0);
  view.setFloat64(16, 1234.5, true);
  view.setUint32(24, STATE_COOKIE_BASE + version, true);
  view.setUint32(28, text.length, true);
  out.set(text, 32);
  const ext = 32 + text.length;
  view.setUint16(ext, 1, true);
  view.setUint16(ext + 2, compression === "none" ? 0 : 1, true);
  view.setBigUint64(ext + 8, BigInt(compression === "none" ? body.length : size), true);
  out.set(body, ext + 16);
  return out;
}

// The review's 49 bytes: right game and state version, a one-byte payload.
export function tinyStateFile(gameId = "GTST01") {
  return makeStateFile({ gameId, versionString: "", compression: "none", payload: new Uint8Array([0]) });
}
