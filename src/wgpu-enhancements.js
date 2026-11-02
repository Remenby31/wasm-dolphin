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

// The highest internal resolution an adapter is trusted with. GPU memory
// grows with N² (EFB colour and depth, XFB copies, scaled EFB copies: several
// hundred MB more at 4x than at 1x in a render-to-texture game) and WebGPU
// tells nothing about it, so the ceiling goes by adapter class:
// - no adapter, or a CPU one (fallback, SwiftShader): 1;
// - a texture limit below 640N (the EFB and backbuffer width): the limit;
// - a small machine (navigator.deviceMemory, GB, rounded: ≤ 2 → 1, ≤ 4 → 2);
// - an adapter that offers buffers under 1 GiB (Chrome's lower limit tiers),
//   a mobile GPU vendor (Chrome's names), an integrated Intel GPU, or an
//   Apple GPU without navigator.deviceMemory on a touch device (an iPhone or
//   an iPad, the iPad's desktop mode included) or where touch is unknown: 2;
// - anything else: 4.
// Intel: Dawn's names (gpu_info.json, a hyphen only after a word that does
// not end in a digit): integrated "gen-9", "gen-11", "gen-12lp", "xe-lpg",
// "xe-2lpg", "xe-3lpg", "xe-3lpg-xs" (an "lp", or "gen-*"); discrete Arc
// "gen-12hp" (Alchemist), "xe-2hpg" (Battlemage). Unknown or no architecture
// is not taken for an integrated GPU.
// Safari and Firefox expose no navigator.deviceMemory, and an iPad asks for
// desktop sites with a Mac's user agent, so neither tells a Mac from an iPad.
// navigator.maxTouchPoints does: 0 on every Mac (Safari, Firefox and Chrome
// on macOS), 1 or more on an iPhone and an iPad, desktop mode included (5).
// It exists on the page only (not in a worker): the page reads it and passes
// it to the worker (pageMaxTouchPoints). An Apple GPU without deviceMemory
// is a Mac only with maxTouchPoints 0 (then it goes by the same rules as
// Chrome on a Mac); with touch points, or without the reading (a worker
// whose page passed none, a non-integer), it stays at 2. The adapter limits
// were not taken: WebKit's (maxBufferSize 2147483644 on an M-series Mac)
// are not documented per platform, and a cautious signal that is sometimes
// absent beats a guessed one.
// `adapter` is a GPUAdapter or { info, limits, isFallbackAdapter }.
// Returns { ceiling, reason }; the core-host and the worker clamp every
// scale to it (docs/internal-resolution.md).
const MOBILE_GPU_VENDORS = new Set(["qualcomm", "arm", "img-tec", "imagination", "samsung", "broadcom", "mediatek", "huawei", "verisilicon"]);

export function integratedIntelArchitecture(architecture) {
  const a = String(architecture ?? "").toLowerCase();
  return /lp/.test(a) || (a.startsWith("gen-") && !a.endsWith("hp"));
}

export function internalResolutionCeiling(adapter, { deviceMemory, maxTouchPoints } = {}) {
  const max = INTERNAL_RESOLUTIONS.at(-1);
  if (!adapter) return { ceiling: 1, reason: "no-adapter" };
  const info = adapter.info ?? {};
  const vendor = String(info.vendor ?? "").toLowerCase();
  const architecture = String(info.architecture ?? "").toLowerCase();
  if (adapter.isFallbackAdapter || info.isFallbackAdapter || architecture === "swiftshader") {
    return { ceiling: 1, reason: "cpu-adapter" };
  }
  let ceiling = max;
  let reason = "adapter";
  const lower = (n, why) => {
    if (n < ceiling) { ceiling = Math.max(1, n); reason = why; }
  };
  const textureMax = Number(adapter.limits?.maxTextureDimension2D);
  if (textureMax > 0) lower(Math.floor(textureMax / 640), "texture-limit");
  const memory = Number(deviceMemory);
  if (memory > 0) lower(memory <= 2 ? 1 : memory <= 4 ? 2 : max, "device-memory");
  const bufferMax = Number(adapter.limits?.maxBufferSize);
  if (bufferMax > 0 && bufferMax < 2 ** 30) lower(2, "small-adapter");
  if (MOBILE_GPU_VENDORS.has(vendor)) lower(2, "mobile-gpu");
  if (vendor === "intel" && integratedIntelArchitecture(architecture)) lower(2, "integrated-gpu");
  if (vendor === "apple" && !(memory > 0)) {
    const touch = Number.isInteger(maxTouchPoints) && maxTouchPoints >= 0 ? maxTouchPoints : null;
    if (touch === null) lower(2, "apple-without-memory");
    else if (touch > 0) lower(2, "apple-touch");
  }
  return { ceiling, reason };
}

// A scale normalized and held to a ceiling (1 when the ceiling is unknown or
// invalid: never above what was checked).
export function clampInternalResolution(value, ceiling = INTERNAL_RESOLUTIONS.at(-1)) {
  return Math.min(normalizeInternalResolution(value), normalizeInternalResolution(ceiling));
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

// ?ir=2&aniso=16&widescreen=1. A missing or invalid value keeps the default
// (native, the game's anisotropy, 4:3).
export function requestedEnhancements(search) {
  const params = new URLSearchParams(search || "");
  return {
    internalResolution: normalizeInternalResolution(params.get("ir") ?? 1),
    maxAnisotropy: anisotropyToCore(params.get("aniso")),
    widescreen: params.get("widescreen") === "1",
  };
}

// The worker's setEnhancements message, as the core takes it: [scale 1-4,
// log2 anisotropy or -1]. The page sends the scale and the log2 already
// normalized (core-host); anything else falls back to the defaults. The
// worker holds the scale to its adapter's ceiling.
export function enhancementCoreArgs(payload = {}, ceiling = INTERNAL_RESOLUTIONS.at(-1)) {
  const log2 = payload?.maxAnisotropy;
  return [
    clampInternalResolution(payload?.internalResolution, ceiling),
    Number.isInteger(log2) && log2 >= 0 && log2 <= 4 ? log2 : -1
  ];
}

// Size the presented canvas (Dolphin's backbuffer) and reconfigure its WebGPU
// context. `gpu` is the worker's renderGpu ({ context, device, format,
// canvasWidth, canvasHeight }), `usage` the canvas texture usage. Same size:
// nothing, since reconfiguring drops the current texture. Returns whether it
// resized.
export function resizeCanvasBackbuffer(canvas, gpu, width, height, usage) {
  if (!canvas || !gpu || !(width > 0) || !(height > 0)) return false;
  if (canvas.width === width && canvas.height === height &&
      gpu.canvasWidth === width && gpu.canvasHeight === height) return false;
  canvas.width = width;
  canvas.height = height;
  gpu.context.configure({ device: gpu.device, format: gpu.format, alphaMode: "opaque", usage });
  gpu.canvasWidth = width;
  gpu.canvasHeight = height;
  return true;
}

// The backbuffer a new boot's core starts from (WebGPUGfx announces only the
// sizes that differ from it, patch 0168).
export const BOOT_BACKBUFFER = Object.freeze([640, 480]);

// A worker reused for another disc keeps the canvas of the previous session,
// which may be at another scale: the size to bring it back to before the
// boot, or null when it already is the boot size.
export function bootBackbufferResize(canvas) {
  if (!canvas) return null;
  const [w, h] = BOOT_BACKBUFFER;
  return canvas.width === w && canvas.height === h ? null : [w, h];
}

// A CPU frame (bytes) drawn to the WebGPU canvas resizes it to the frame. On
// the hardware path that frame is the demo scene's 320x240 (or the cached
// copy the tick repaint draws again), and once the backbuffer was sized (the
// core's announce, or the one-shot growth at the first fb0 pass) nothing
// sizes it back: the session played and streamed at 320x240 (2026-10-28, 5 of
// 51 salon sessions at ir=3, the frame arriving between the 1920x1440 resize
// and the command ring's first present). Such a frame is dropped.
export function cpuFrameYieldsToHardware({ hardware, backbufferSized, ringOwnsCanvas }) {
  return Boolean(hardware && (backbufferSized || ringOwnsCanvas));
}
