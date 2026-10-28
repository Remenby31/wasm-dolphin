// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// ?wgpurecover=1: keep the session when the WebGPU device is lost
// (docs/wgpu-session-fallback.md). A lost device does not lose the game: the
// worker, guest RAM and the core survive, only the picture is gone. The
// worker pauses the core as soon as the device goes; before the page
// restarts the engine, keep a save state of that moment in memory; the page
// boots again (one scale lower, or on the software renderer) and loads it.

// Each step's limit: at most 25 s from the loss to the page's event, and
// a "recovering" event at the start.
export const PAUSE_TIMEOUT_MS = 5_000;
export const SAVE_TIMEOUT_MS = 20_000;

export function requestedWgpuSessionRecover(search = "") {
  return new URLSearchParams(search).get("wgpurecover") === "1";
}

class StepTimeout extends Error {}

function withTimeout(promise, ms, what) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const message = (error) => String(error?.message || error);

// adapter: the worker adapter (lifecycle("pause"), exportSaveState()).
// workerPause: the worker's own pause at the loss ({ state, changed } or
// { error }), from the wgpu-device-lost message; without it (an older
// worker) the core is paused from here.
// Resolves, never rejects, with what the page needs to resume:
// { paused, pauseChanged, state: ArrayBuffer | null, stateGameId, stateError }.
// pauseChanged false: the player had already paused the game, keep it
// paused after the restart. A refused pause still saves (a state a few
// frames later beats the title screen); a pause that never answered does
// not, the worker is not answering.
export async function captureSessionAfterDeviceLoss(adapter, {
  workerPause = null,
  pauseTimeoutMs = PAUSE_TIMEOUT_MS,
  saveTimeoutMs = SAVE_TIMEOUT_MS,
} = {}) {
  const errors = [];
  let paused = false;
  let pauseChanged = false;
  let save = true;
  if (workerPause) {
    if (workerPause.error) {
      errors.push(`pause: ${workerPause.error}`);
    } else {
      paused = true;
      pauseChanged = workerPause.changed !== false;
    }
  } else {
    try {
      const response = await withTimeout(adapter.lifecycle("pause"), pauseTimeoutMs, "pause");
      paused = true;
      pauseChanged = response?.changed !== false;
    } catch (error) {
      errors.push(`pause: ${message(error)}`);
      if (error instanceof StepTimeout) save = false;
    }
  }
  let state = null;
  let stateGameId = "";
  if (save) {
    try {
      const saved = await withTimeout(adapter.exportSaveState({ slot: 0 }), saveTimeoutMs, "save state");
      if (!(saved?.bytes instanceof ArrayBuffer) || saved.bytes.byteLength === 0) {
        throw new Error("the worker returned no bytes");
      }
      state = saved.bytes;
      stateGameId = String(saved.gameId ?? "");
    } catch (error) {
      errors.push(`save state: ${message(error)}`);
    }
  } else {
    errors.push("save state: skipped, the worker did not answer the pause");
  }
  return { paused, pauseChanged, state, stateGameId, stateError: errors.join("; ") };
}
