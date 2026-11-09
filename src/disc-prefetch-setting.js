// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The disc prefetch (patch 0155, src/disc-readahead.js): ?discprefetch=1 on,
// ?discprefetch=0 off, else on only where it was measured: a Chromium browser
// with the WebGPU video backend (2P parcours A/B, protocol 706f260e, Mac:
// startup-second losses 15.5 -> 10.5 frames a run, menu smoothness p5
// 93.3 -> 96.7, no phase worse). Firefox and Safari keep it off until
// measured: on WebKit (Playwright, software) it did nothing (FileReaderSync
// goes through the network process), elsewhere it is not measured.
export function discPrefetchSetting(param, { chromium = false, webgpuVideo = false } = {}) {
  if (param === "1") return true;
  if (param === "0") return false;
  return chromium && webgpuVideo;
}

// Chromium: its brands say so (Chrome, Edge, Opera, ...); Firefox and Safari
// have no navigator.userAgentData.
export function isChromium(nav = globalThis.navigator) {
  const brands = nav?.userAgentData?.brands;
  return Array.isArray(brands) && brands.some((b) => /Chromium/i.test(String(b?.brand ?? "")));
}
