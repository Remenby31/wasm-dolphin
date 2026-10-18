// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// A run asking for a core it does not get fails ("core-mismatch"): the app's
// fallback to main's core must never pass as a measurement of the candidate.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkCore } from "../harness/lib/core-identity.mjs";
import { addCoreCandidate } from "../harness/lib/server.mjs";

const MAIN = "a".repeat(64), CAND = "b".repeat(64);
const url = (q = "") => `http://127.0.0.1:8082/?core=upstream${q}`;

test("the served tree's core, loaded: ok, and the loaded hash is recorded", () => {
  const c = checkCore({ url: url(), defaultSha256: MAIN, fetches: [{ path: "/cores/dolphin/dolphin-core-upstream.wasm", sha256: MAIN }] });
  assert.equal(c.ok, true);
  assert.deepEqual(c.loaded, [MAIN]);
});

test("a requested coreid that is absent: the app falls back to main's core, the run fails", () => {
  // The candidate's preflight 404s, then the worker loads main's core.
  const c = checkCore({
    url: url(`&coreid=sha256:${CAND}`), defaultSha256: MAIN,
    fetches: [{ path: "/cores/dolphin/dolphin-core-upstream.wasm", sha256: MAIN }],
    selection: { fallbackReason: "Candidate core wasm unavailable (HTTP 404)", activeCoreSha256: MAIN }
  });
  assert.equal(c.ok, false);
  assert.match(c.error, /^core-mismatch: loaded aaaaaaaaaaaa instead of bbbbbbbbbbbb \(coreid\)/);
});

test("a fallback reported by the app fails even when no other wasm was fetched", () => {
  const c = checkCore({ url: url(`&coreid=${CAND}`), defaultSha256: MAIN, fetches: [{ sha256: CAND }], selection: { fallbackReason: "hash mismatch" } });
  assert.match(c.error, /fell back/);
  assert.equal(checkCore({ url: url(), defaultSha256: MAIN, fetches: [] }).ok, false);
});

test("a candidate directory is served only under its own hash", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-test-cand-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wasm = Buffer.from("candidate core");
  const sha = createHash("sha256").update(wasm).digest("hex");
  const good = path.join(dir, sha), bad = path.join(dir, CAND);
  for (const d of [good, bad]) {
    mkdirSync(d);
    writeFileSync(path.join(d, "dolphin-core-upstream.wasm"), wasm);
    writeFileSync(path.join(d, "dolphin-core-upstream.js"), "// glue");
  }
  const files = new Map();
  assert.equal(addCoreCandidate(files, good), sha);
  assert.ok(files.has(`/build/core-candidates/${sha}/dolphin-core-upstream.wasm`));
  assert.throws(() => addCoreCandidate(files, bad), /hashes to/);
});
