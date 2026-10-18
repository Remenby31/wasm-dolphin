// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Which core a run really used. The app falls back to main's core when a
// requested candidate (?coreid=sha256:…) cannot be loaded; a judge must
// never attribute a measurement to the wrong binary, so the harness compares
// the bytes its server handed out with what the run asked for, and fails
// with "core-mismatch" instead of measuring.

// The core a URL asks for: its coreid, or the served tree's own core.
export function expectedCore(url, defaultSha256) {
  const requested = new URL(url).searchParams.get("coreid");
  if (!requested) return { sha256: defaultSha256, source: "served tree" };
  return { sha256: requested.toLowerCase().replace(/^sha256:/, ""), source: "coreid" };
}

// The core wasm a request of one page fetched from `server`, or null. Fetches
// are attributed per request, through the browser context that made them, never
// by their order in the server's log: sessions running at the same time on one
// server each see only their own core.
export function coreFetchOf(url, server) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== new URL(server.base).origin) return null;
  const sha256 = server.coreSha256?.(u.pathname) ?? null;
  return sha256 ? { path: u.pathname, sha256 } : null;
}

// Every core wasm the pages and workers of `context` (a Playwright browser
// context) fetched from `server`, in order. Dedicated workers' requests (the
// emulator worker loads the core) belong to their page's context.
export function recordCoreFetches(context, server) {
  const fetches = [];
  context.on("requestfinished", (request) => {
    const fetched = coreFetchOf(request.url(), server);
    if (fetched) fetches.push(fetched);
  });
  return fetches;
}

// fetches: core wasm this session fetched (path, sha256);
// selection: the adapter's coreSelectionTelemetry() (may be null).
export function checkCore({ url, defaultSha256, fetches, selection = null }) {
  const expected = expectedCore(url, defaultSha256);
  const loaded = [...new Set(fetches.map((f) => f.sha256))];
  const out = { expected: expected.sha256, expectedFrom: expected.source, loaded, fallbackReason: selection?.fallbackReason ?? null, activeCoreSha256: selection?.activeCoreSha256 ?? null };
  let error = null;
  if (!expected.sha256) error = "no expected core (the served tree has no cores/dolphin/dolphin-core-upstream.wasm)";
  else if (!loaded.length) error = "no core wasm was fetched from the harness server";
  else if (loaded.some((s) => s !== expected.sha256)) error = `loaded ${loaded.map((s) => s.slice(0, 12)).join(", ")} instead of ${expected.sha256.slice(0, 12)} (${expected.source})`;
  else if (out.fallbackReason) error = `the app fell back: ${out.fallbackReason}`;
  return { ...out, ok: !error, error: error && `core-mismatch: ${error}` };
}
