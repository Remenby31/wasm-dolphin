// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

const noop = () => {};

export function handleWgpuDeviceLoss({
  activeDevice,
  lostDevice,
  info = null,
  recordError = noop,
  markFatal = noop,
  cancelReplay = noop,
  clearReplayState = noop,
  invalidateGeometry = noop,
  clearActiveDevice = noop,
  setBackend = noop,
  postStatus = noop,
} = {}) {
  const detail = String(info?.message || info?.reason || "unknown");
  if (!lostDevice || activeDevice !== lostDevice) {
    return { handled: false, detail };
  }

  recordError("device-lost", detail);
  markFatal("device-lost", detail);
  cancelReplay();
  clearReplayState();
  invalidateGeometry();
  clearActiveDevice();
  setBackend("webgpu-lost");
  postStatus(`WebGPU device lost: ${detail}`);
  return { handled: true, detail };
}

// Every scope the worker's markWgpuReplayFatal is called with, but the
// device loss (posted by its own handler), and the reason the page gets.
// Each one leaves the command ring FAILED for good: the game would go on
// blind with a frozen picture. The page hears of it as of a lost device.
export const WGPU_FATAL_PAGE_REASONS = Object.freeze({
  "submit-error": "submit-error",
  "staging-seal": "staging-seal",
  "staging-capacity": "staging-capacity",
  "staging-copy": "staging-copy",
  "staging-remap": "staging-remap",
  "destroy-order": "destroy-order",
  "semantic-capture-ack": "semantic-capture-ack",
  "webgpu-command-ring-ownership": "ring-ownership",
  "webgpu-command-ring-attach": "ring-attach",
});

export function wgpuFatalPageReason(scope) {
  return WGPU_FATAL_PAGE_REASONS[scope] ?? String(scope || "unknown");
}

// One `wgpu-device-lost` message per renderer session (per device), the
// first cause wins: a device lost after a replay error, or the reverse,
// does not restart the page twice.
export function createWgpuFatalReporter(post = noop) {
  let reported = null;
  return {
    get reported() { return reported; },
    reset() { reported = null; },
    report({ internalResolution = 1, reason = "unknown", detail = "" } = {}) {
      if (reported) return false;
      reported = { internalResolution, reason: String(reason), detail: String(detail ?? "") };
      post({ type: "wgpu-device-lost", ...reported });
      return true;
    },
  };
}
