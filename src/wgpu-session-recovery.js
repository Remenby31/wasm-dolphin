// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// ?wgpurecover=1: keep the session when the WebGPU device is lost
// (docs/wgpu-session-fallback.md). A lost device does not lose the game: the
// worker, guest RAM and the core survive, only the picture is gone. Before
// the page restarts the engine, pause the core where the device went and
// keep a save state of that moment in memory; the page boots again (one
// scale lower, or on the software renderer) and loads it.

const DEFAULT_TIMEOUT_MS = 20_000;

export function requestedWgpuSessionRecover(search = "") {
  return new URLSearchParams(search).get("wgpurecover") === "1";
}

function withTimeout(promise, ms, what) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const message = (error) => String(error?.message || error);

// adapter: the worker adapter (lifecycle("pause"), exportSaveState()).
// Resolves, never rejects, with what the page needs to resume:
// { paused, state: ArrayBuffer | null, stateGameId, stateError }.
// A pause that fails does not stop the save: a state a few frames later
// still beats a reboot from the title screen.
export async function captureSessionAfterDeviceLoss(adapter, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const errors = [];
  let paused = false;
  try {
    await withTimeout(adapter.lifecycle("pause"), timeoutMs, "pause");
    paused = true;
  } catch (error) {
    errors.push(`pause: ${message(error)}`);
  }
  let state = null;
  let stateGameId = "";
  try {
    const saved = await withTimeout(adapter.exportSaveState({ slot: 0 }), timeoutMs, "save state");
    if (!(saved?.bytes instanceof ArrayBuffer) || saved.bytes.byteLength === 0) {
      throw new Error("the worker returned no bytes");
    }
    state = saved.bytes;
    stateGameId = String(saved.gameId ?? "");
  } catch (error) {
    errors.push(`save state: ${message(error)}`);
  }
  return { paused, state, stateGameId, stateError: errors.join("; ") };
}
