// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Glitch-meter G3, the deterministic oracle: in cpu=single, the core's XFB at
// a given VI after a state load is bit-exact from one run to the next (Spark,
// 2026-10-31: 18 VIs × 4 visits, 0 difference). So the default rendering,
// with every WebGPU cache and grouping on, must give the very same pixels as
// a reference with all of them off. Any difference is a picture the caches
// got wrong: the run fails and both images are kept.

// The switches the reference turns off: content caches and upload groupings
// whose only job is to save work, never to change a pixel.
export const ORACLE_REFERENCE_PARAMS = Object.freeze({
  wgpugeomcache: "0",
  wgpugeompack: "0",
  wgpugeomrange: "0",
  wgpuubopack: "0",
  wgpuubocache: "0",
  wgpubgcache: "0",
  wgpustatecache: "0"
});

// The query of the reference: the default's, every switch above forced off.
export function referenceQuery(query) {
  const params = new URLSearchParams(String(query ?? ""));
  for (const [k, v] of Object.entries(ORACLE_REFERENCE_PARAMS)) params.set(k, v);
  return params.toString();
}

// The oracle needs the deterministic CPU: in cpu=dual two runs already differ.
export function oracleQueryError(query) {
  const params = new URLSearchParams(String(query ?? ""));
  if (params.get("cpu") !== "single") return "--exact needs cpu=single (cpu=dual is not deterministic)";
  if (params.get("video") !== "wgpu") return "--exact compares WebGPU renderings: video=wgpu";
  return null;
}

// What the replay reports it runs (validationReadIntegrity's sibling,
// rendererDiagnostics.runtimeConfig): the switches still on in a reference,
// by name. An empty list is a real reference; a field the worker does not
// report is named too (never assumed off).
export function referenceSwitchesOn(runtimeConfig) {
  if (!runtimeConfig) return ["runtime config unread"];
  const on = [];
  const check = (name, value, off) => {
    if (value === undefined) on.push(`${name} (not reported)`);
    else if (value !== off) on.push(name);
  };
  check("geometryCacheMode", runtimeConfig.geometryCacheMode, 0);
  check("geometryPackEnabled", runtimeConfig.geometryPackEnabled, false);
  check("geometryRangeEnabled", runtimeConfig.geometryRangeEnabled, false);
  check("uboPackEnabled", runtimeConfig.uboPackEnabled, false);
  check("uboCacheEnabled", runtimeConfig.uboCacheEnabled, false);
  check("bindGroupCacheEnabled", runtimeConfig.bindGroupCacheEnabled, false);
  check("stateCacheEnabled", runtimeConfig.stateCacheEnabled, false);
  return on;
}

// The verdict over the visits ({ side: "base" (reference) | "candidate"
// (default), hashes: { vi: sha256 } }): per VI, the reference must agree with
// itself, and every default visit must give the reference's hash.
export function exactVerdict(visits, vis) {
  const rows = vis.map((vi) => {
    const of = (side) => visits.filter((v) => v.side === side && v.hashes?.[vi]).map((v) => v.hashes[vi]);
    const reference = [...new Set(of("base"))];
    const candidate = of("candidate");
    const missing = !reference.length || !candidate.length;
    const unstable = reference.length > 1;
    const mismatches = unstable || missing ? [] : candidate.filter((h) => h !== reference[0]).length;
    return { vi, reference: reference[0] ?? null, missing, unstable, mismatches: unstable || missing ? null : mismatches };
  });
  const failures = rows.filter((r) => r.missing || r.unstable || r.mismatches > 0).map((r) =>
    r.missing ? `VI ${r.vi}: no reference or default frame` :
      r.unstable ? `VI ${r.vi}: the reference itself differs between visits (not deterministic)` :
        `VI ${r.vi}: ${r.mismatches} default visit(s) differ from the reference`);
  return { rows, failures, pass: failures.length === 0 };
}

// A visible difference image: |a - b| per channel, amplified ×8, alpha 255.
export function diffFrame(a, b) {
  const width = Math.min(a.width, b.width), height = Math.min(a.height, b.height);
  const data = new Uint8Array(width * height * 4);
  let pixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4, o = (y * width + x) * 4;
      let any = false;
      for (let c = 0; c < 3; c += 1) {
        const d = Math.abs(a.data[i + c] - b.data[j + c]);
        data[o + c] = Math.min(255, d * 8);
        if (d) any = true;
      }
      data[o + 3] = 255;
      if (any) pixels += 1;
    }
  }
  return { width, height, data, pixels };
}
