// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Which WebAssembly engine runs this page or worker, for the few choices that
// depend on it (shared by the region recompiler and the module-copy policy):
//   "jsc"           JavaScriptCore (Safari, and every iOS browser): it never
//                   tiers a wasm function past 100,000 bytes of body up to
//                   OMG (maximumOMGCandidateCost)
//   "v8"            Chrome, Edge and other Chromium browsers
//   "spidermonkey"  Firefox (no per-function tier limit: Ion tiering is
//                   decided per module, MaxFunctionBytes is the spec maximum)
//   "unknown"
// Two independent signals, never one alone: a user agent can lie, and engines
// copy each other's APIs (JSC now has Error.captureStackTrace). JSC needs a
// WebKit user agent that is not Blink's AND its own Error object shape (a
// numeric `line`, which neither V8 nor SpiderMonkey sets). ?wasmengine=
// overrides both (tests, benches).
export const WASM_ENGINES = Object.freeze(["jsc", "v8", "spidermonkey", "unknown"]);
export const WASM_ENGINE_PARAM = "wasmengine";

// The error shape the engine gives a fresh Error: JSC sets `line`, SpiderMonkey
// `lineNumber`, V8 neither.
export function errorShape() {
  try {
    const e = new Error("probe");
    return { line: typeof e.line === "number", lineNumber: typeof e.lineNumber === "number" };
  } catch {
    return { line: false, lineNumber: false };
  }
}

export function wasmEngine({
  search = globalThis.location?.search ?? "",
  userAgent = globalThis.navigator?.userAgent ?? "",
  probe = errorShape
} = {}) {
  const forced = new URLSearchParams(search).get(WASM_ENGINE_PARAM);
  if (forced && WASM_ENGINES.includes(forced)) return forced;
  const blink = /\b(?:Chrome|Chromium|Edg|HeadlessChrome)\//.test(userAgent);
  const webkit = /\bAppleWebKit\//.test(userAgent) && !blink;
  const shape = probe();
  if (webkit && shape.line) return "jsc";
  if (shape.lineNumber && /\bFirefox\//.test(userAgent)) return "spidermonkey";
  if (blink && !shape.line && !shape.lineNumber) return "v8";
  return "unknown";
}

// Whether the engine keeps a native cache of compiled modules that a module
// compiled ahead (and kept alive) feeds: V8's. JavaScriptCore and
// SpiderMonkey have none, so a copy kept for it only costs memory there.
// "unknown" answers true: a Chromium with an unusual user agent keeps its
// cache; only an engine known to have none drops the copies.
export function nativeModuleCache(engine) {
  return engine !== "jsc" && engine !== "spidermonkey";
}
