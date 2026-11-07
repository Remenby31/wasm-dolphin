// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// QA harness only (glitch-meter G4): the presented pictures in order, small
// enough to keep a few seconds of them. Off unless the harness starts it
// (validationFlickerWatch); then each present is sampled: SIGNATURE_ROWS
// rows of the presented rectangle read back from the GPU, every
// SIGNATURE_STEP-th pixel kept as luma. harness/lib/flicker.mjs looks for a
// picture that comes and goes (A, B, A): the frame a pass lost, a stale
// buffer, an older image shown again. Readbacks are asynchronous; at most
// MAX_IN_FLIGHT wait at once, a present past that is a gap (no triple spans
// it), as is one whose rectangle changed size.
export const SIGNATURE_ROWS = 48;
export const SIGNATURE_STEP = 2;
export const MAX_IN_FLIGHT = 6;
export const MAX_FRAMES = 1200;
// The replay ops counted between two presents (command-stream op numbers,
// src/upstream-discio-worker.js WGPU_CMD_OP_*): what fed each picture.
export const COUNTED_OPS = Object.freeze({ 8: "uploadTexture", 12: "beginPass", 19: "draw", 20: "drawIndexed", 24: "blitTexture", 25: "clearRect", 28: "copyToStaging" });
const emptyOps = () => Object.fromEntries(Object.values(COUNTED_OPS).map((k) => [k, 0]));

// Luma (BT.601, 8 bits) of every `step`-th pixel of each sampled row.
// `bytes` holds `rows` rows of `bytesPerRow`, `width` RGBA (or BGRA) pixels.
export function lumaSignature(bytes, width, rows, bytesPerRow, bgra, step = SIGNATURE_STEP) {
  const cols = Math.ceil(width / step);
  const out = new Uint8Array(cols * rows);
  const [ri, bi] = bgra ? [2, 0] : [0, 2];
  for (let r = 0; r < rows; r += 1) {
    const base = r * bytesPerRow;
    for (let c = 0; c < cols; c += 1) {
      const i = base + c * step * 4;
      out[r * cols + c] = (bytes[i + ri] * 77 + bytes[i + 1] * 150 + bytes[i + bi] * 29) >> 8;
    }
  }
  return { cols, rows, data: out };
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// `onPresent(readback, vi)` at each present; `readback()` returns (a promise
// of) a signature { cols, rows, data }; `vi`: the VI output since the load
// that present shows (a capture's fromLoad index), null when untagged;
// `source`: the texture id and rectangle the present sampled.
export function createFlickerRecorder({ now = () => performance.now(), maxFrames = MAX_FRAMES } = {}) {
  let state = null;
  return {
    get active() { return state != null; },
    start() {
      state = { t0: now(), presents: 0, inFlight: 0, frames: [], gaps: 0, errors: 0, lastError: null, full: false, ops: emptyOps() };
    },
    // A replay op: counted toward the next present.
    noteOp(op) {
      const name = COUNTED_OPS[op];
      if (name && state) state.ops[name] += 1;
    },
    onPresent(readback, vi = null, source = null) {
      if (!state) return;
      const s = state;
      const seq = s.presents++;
      if (s.frames.length >= maxFrames) { s.full = true; return; }
      const frame = { seq, at: Math.round(now() - s.t0), vi, source, ops: s.ops, sig: null };
      s.ops = emptyOps();
      s.frames.push(frame);
      if (s.inFlight >= MAX_IN_FLIGHT) { s.gaps += 1; return; }
      let p;
      try { p = readback(); } catch (error) { p = Promise.reject(error); }
      s.inFlight += 1;
      Promise.resolve(p).then((sig) => { if (state === s) frame.sig = sig; }, (error) => {
        if (state !== s) return;
        s.errors += 1;
        s.lastError = String(error?.message || error).slice(0, 200);
      }).finally(() => { if (state === s) s.inFlight -= 1; });
    },
    // Waits (bounded) for readbacks in flight, then hands every sampled
    // present back in order: { seq, at (ms), b64 } or { seq, at, gap: true }.
    async stop({ waitMs = 2000 } = {}) {
      const s = state;
      if (!s) return { error: "flicker watch was not started" };
      const end = now() + waitMs;
      while (s.inFlight > 0 && now() < end) await new Promise((r) => setTimeout(r, 20));
      state = null;
      const shape = s.frames.find((f) => f.sig)?.sig;
      const frames = s.frames.map((f) => (f.sig && shape && f.sig.cols === shape.cols && f.sig.rows === shape.rows
        ? { seq: f.seq, at: f.at, vi: f.vi, source: f.source, ops: f.ops, b64: toBase64(f.sig.data) }
        : { seq: f.seq, at: f.at, vi: f.vi, source: f.source, ops: f.ops, gap: true }));
      return {
        windowMs: Math.round(now() - s.t0), presents: s.presents, kept: frames.filter((f) => !f.gap).length,
        gaps: frames.filter((f) => f.gap).length, errors: s.errors, lastError: s.lastError, full: s.full,
        cols: shape?.cols ?? 0, rows: shape?.rows ?? 0, frames
      };
    }
  };
}
