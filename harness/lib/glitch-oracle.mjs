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

// The tolerant comparison, for WebKit only (never the default oracle: Chrome
// against Chrome stays 0 pixel apart). Safari has no dual-source blending, so
// its fallback rounds blended edges a few levels apart from Chrome's (real
// Safari 26 vs Chrome, IR 2, 2026-11-01: 4 % of pixels 1 to 3 levels apart,
// 8 of 1.09 M above 3, the largest 17, all on blended edges). A WebKit frame
// passes when no channel is more than maxLevel apart from the Chrome
// reference and at most overShare of its pixels are more than overLevel
// apart. Same size required (the same internal resolution).
export const WEBKIT_TOLERANCE = Object.freeze({ maxLevel: 16, overLevel: 3, overShare: 0.001 });

// "max=16,over=0.1%" (either key may be left out: its default stays).
export function parseWebkitTolerance(spec) {
  const t = { ...WEBKIT_TOLERANCE };
  for (const part of String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(max|over)=(\d+(?:\.\d+)?)(%?)$/.exec(part);
    if (!m) throw new Error(`--webkit-tolerance: "${part}" is not max=<levels> or over=<percent>%`);
    const n = Number(m[2]);
    if (m[1] === "max") {
      if (m[3] || !Number.isInteger(n) || n < t.overLevel || n > 255) throw new Error(`--webkit-tolerance: max is a level from ${t.overLevel} to 255`);
      t.maxLevel = n;
    } else {
      if (!m[3] || n > 100) throw new Error("--webkit-tolerance: over is a percentage (over=0.1%)");
      t.overShare = n / 100;
    }
  }
  return t;
}

// One WebKit frame against the reference: the largest channel difference,
// the pixels more than overLevel apart, and whether it passes.
export function tolerantFrameVerdict(reference, frame, tolerance = WEBKIT_TOLERANCE) {
  if (reference.width !== frame.width || reference.height !== frame.height) {
    return { pass: false, failure: `size ${frame.width}x${frame.height} vs the reference's ${reference.width}x${reference.height} (not the same internal resolution)` };
  }
  const n = reference.width * reference.height;
  let max = 0, differ = 0, over = 0;
  for (let i = 0; i < n * 4; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c += 1) d = Math.max(d, Math.abs(reference.data[i + c] - frame.data[i + c]));
    if (d) differ += 1;
    if (d > tolerance.overLevel) over += 1;
    if (d > max) max = d;
  }
  const overShare = over / n;
  const failures = [];
  if (max > tolerance.maxLevel) failures.push(`a channel ${max} levels apart (max ${tolerance.maxLevel})`);
  if (overShare > tolerance.overShare) failures.push(`${over} px more than ${tolerance.overLevel} levels apart (${(100 * overShare).toFixed(3)} % > ${(100 * tolerance.overShare).toFixed(3)} %)`);
  return { pass: failures.length === 0, max, differ, over, overShare, failure: failures.join(", ") || null };
}
