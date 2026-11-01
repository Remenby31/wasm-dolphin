// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Region modules that never ran because the engine refused them, by cause.
// A region module the engine does not accept is not an error the session
// sees: its pcs stay on the block JIT and the run goes on, slower. Patch 0196
// once reported the wrong signature for one helper (fma) and every region
// calling it failed to validate; region calls fell to a third with nothing
// failing (2026-11-01). These counters make such a loss visible, and fatal in
// the integrity gate (src/wgpu-integrity.js INTEGRITY_FATAL):
// - regionLinkImportType: a LinkError on an import (the module declares a
//   helper with a type the core's function does not have);
// - regionLinkValidation: a CompileError (the bytes do not validate: a call
//   to a helper with the wrong arguments, a malformed module);
// - regionLinkSize: a CompileError for a function the engine will not take
//   at its size (JSC and V8 cap a function body). Not fatal: an engine limit
//   on a large region, the region's pcs stay on the block JIT; counted so a
//   jump shows;
// - regionLinkOther: anything else (out of memory while compiling or
//   instantiating). Not fatal: an engine out of memory is transient, the
//   region is tried again (aot-cache, the core's handle -1), and a device
//   under memory pressure gets there without anything being wrong.
// A failure to read a module (network, cache storage) is not counted: the
// engine never saw it.
// A module counts at most once per cause, under its key, whichever path saw
// it (the first launch's compile, the cache's load, the CPU thread's
// instantiation): an out of memory first never hides a refusal after it.

export const REGION_LINK_KEYS = Object.freeze(["regionLinkImportType", "regionLinkValidation", "regionLinkSize", "regionLinkOther"]);
export const REGION_LINK_FATAL = Object.freeze(["regionLinkImportType", "regionLinkValidation"]);

const nameOf = (error) => {
  if (typeof WebAssembly !== "undefined") {
    if (error instanceof WebAssembly.LinkError) return "LinkError";
    if (error instanceof WebAssembly.CompileError) return "CompileError";
  }
  return String(error?.name ?? "");
};

// The engines' refusals of a function by its size:
//   V8 (module-decoder): "size 9000000 > maximum function size (7654321)",
//     also "local count too large" for its locals;
//   JSC (WasmSectionParser / WasmFunctionParser): "Code function's size N is
//     too big", "Function's number of locals is too big";
//   SpiderMonkey: "function body too big", "too many locals".
const SIZE_REFUSAL = /maximum function size|function'?s size .*too big|function body too big|local count too large|number of locals is too big|too many locals/i;

// The counter of a failure: an Error (or { name, message } as a message
// carries it), or the reason string compileFailureReason gives ("compile",
// "link", "oom").
export function regionLinkCause(failure) {
  if (typeof failure === "string") {
    if (failure === "compile" || failure === "engine-reject") return "regionLinkValidation";
    if (failure === "link") return "regionLinkImportType";
    return "regionLinkOther";
  }
  const name = nameOf(failure);
  if (name === "CompileError" || name === "WebAssembly.CompileError") {
    return SIZE_REFUSAL.test(String(failure?.message ?? "")) ? "regionLinkSize" : "regionLinkValidation";
  }
  if (name === "LinkError" || name === "WebAssembly.LinkError") {
    // V8: 'Import #15 "env" "fma": imported function does not match the
    // expected type'; JSC: 'imported function ... signature doesn't match'.
    return /import|signature/i.test(String(failure?.message ?? "")) ? "regionLinkImportType" : "regionLinkOther";
  }
  return "regionLinkOther";
}

export function createRegionLinkFailures() {
  const counts = Object.fromEntries(REGION_LINK_KEYS.map((k) => [k, 0]));
  const seen = new Set(); // "cause key"
  return {
    // Returns the counter it moved, or null (that key already counted there).
    record(key, failure) {
      const cause = regionLinkCause(failure);
      const id = key == null || key === "" ? null : `${cause} ${key}`;
      if (id !== null) {
        if (seen.has(id)) return null;
        seen.add(id);
      }
      counts[cause] += 1;
      return cause;
    },
    snapshot() {
      return { ...counts };
    }
  };
}
