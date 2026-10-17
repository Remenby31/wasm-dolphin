// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Small, dependency-free statistics used to summarise repeated runs.

export function finite(values) {
  return values.filter((v) => typeof v === "number" && Number.isFinite(v));
}

export function mean(values) {
  const v = finite(values);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function median(values) {
  const v = finite(values).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Sample standard deviation (n - 1); 0 for a single value, null for none.
export function stdev(values) {
  const v = finite(values);
  if (!v.length) return null;
  if (v.length === 1) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

// Nearest-rank percentile, p in [0, 100].
export function percentile(values, p) {
  const v = finite(values).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[rank];
}

export function round(value, digits = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function describe(values, digits = 1) {
  const v = finite(values);
  return {
    n: v.length,
    median: round(median(v), digits),
    mean: round(mean(v), digits),
    stdev: round(stdev(v), digits),
    min: v.length ? round(Math.min(...v), digits) : null,
    max: v.length ? round(Math.max(...v), digits) : null
  };
}
