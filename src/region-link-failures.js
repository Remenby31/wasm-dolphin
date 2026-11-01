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
// - regionLinkOther: anything else (out of memory while compiling or
//   instantiating). Not fatal: an engine out of memory is transient, the
//   region is tried again (aot-cache, the core's handle -1), and a device
//   under memory pressure gets there without anything being wrong.
// Each module counts once, under its key, whichever path saw it first (the
// first launch's compile, the cache's load, the CPU thread's instantiation).

export const REGION_LINK_KEYS = Object.freeze(["regionLinkImportType", "regionLinkValidation", "regionLinkOther"]);
export const REGION_LINK_FATAL = Object.freeze(["regionLinkImportType", "regionLinkValidation"]);

const nameOf = (error) => {
  if (typeof WebAssembly !== "undefined") {
    if (error instanceof WebAssembly.LinkError) return "LinkError";
    if (error instanceof WebAssembly.CompileError) return "CompileError";
  }
  return String(error?.name ?? "");
};

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
  if (name === "CompileError" || name === "WebAssembly.CompileError") return "regionLinkValidation";
  if (name === "LinkError" || name === "WebAssembly.LinkError") {
    // V8: 'Import #15 "env" "fma": imported function does not match the
    // expected type'; JSC: 'imported function ... signature doesn't match'.
    return /import|signature/i.test(String(failure?.message ?? "")) ? "regionLinkImportType" : "regionLinkOther";
  }
  return "regionLinkOther";
}

export function createRegionLinkFailures() {
  const counts = Object.fromEntries(REGION_LINK_KEYS.map((k) => [k, 0]));
  const seen = new Set();
  return {
    // Returns the counter it moved, or null (a key already counted).
    record(key, failure) {
      const id = key == null || key === "" ? null : String(key);
      if (id !== null) {
        if (seen.has(id)) return null;
        seen.add(id);
      }
      const cause = regionLinkCause(failure);
      counts[cause] += 1;
      return cause;
    },
    snapshot() {
      return { ...counts };
    }
  };
}
