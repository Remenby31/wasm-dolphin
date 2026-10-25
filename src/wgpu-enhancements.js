// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// Rendering enhancements of the WebGPU path (patch 0168): internal resolution
// (Dolphin's EFB scale, 1 to 4 times native) and anisotropic filtering. The
// page reads them from ?ir= and ?aniso=, the worker passes them to the core at
// boot and through DolphinWeb_SetEnhancements while a game runs.

export const INTERNAL_RESOLUTIONS = Object.freeze([1, 2, 3, 4]);
export const ANISOTROPY_LEVELS = Object.freeze([1, 2, 4, 8, 16]);

// 1 to 4; anything else is native.
export function normalizeInternalResolution(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : 1;
}

// The core takes log2 of the maximum anisotropy (Dolphin's
// AnisotropicFilteringMode: 0 = 1x .. 4 = 16x), or -1 to leave what the game
// asks for. 1x forces anisotropy off, as in Dolphin.
export function anisotropyToCore(value) {
  const n = Number(value);
  const index = ANISOTROPY_LEVELS.indexOf(n);
  return index >= 0 ? index : -1;
}

export function anisotropyFromCore(mode) {
  return Number.isInteger(mode) && mode >= 0 && mode <= 4 ? ANISOTROPY_LEVELS[mode] : 0;
}

// ?ir=2&aniso=16. A missing or invalid value keeps the default (native, the
// game's anisotropy).
export function requestedEnhancements(search) {
  const params = new URLSearchParams(search || "");
  return {
    internalResolution: normalizeInternalResolution(params.get("ir") ?? 1),
    maxAnisotropy: anisotropyToCore(params.get("aniso")),
  };
}
