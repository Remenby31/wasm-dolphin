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

import { EventEmitter } from "node:events";
import { createServer } from "node:net";

import { checkCore, coreFetchOf, recordCoreFetches } from "../harness/lib/core-identity.mjs";
import { addCoreCandidate, ensureServer } from "../harness/lib/server.mjs";

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

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// A browser context as recordCoreFetches sees it: requestfinished events.
class FakeContext extends EventEmitter {
  async load(url) {
    const response = await fetch(url);
    await response.arrayBuffer();
    this.emit("requestfinished", { url: () => url });
  }
}

test("two concurrent sessions on one server each see only their own core", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-test-concurrent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wasm = Buffer.from("candidate core for the concurrency test");
  const sha = createHash("sha256").update(wasm).digest("hex");
  mkdirSync(path.join(dir, sha));
  writeFileSync(path.join(dir, sha, "dolphin-core-upstream.wasm"), wasm);
  writeFileSync(path.join(dir, sha, "dolphin-core-upstream.js"), "// glue");
  const server = await ensureServer({ port: await freePort(), root: path.resolve(import.meta.dirname, ".."), coreCandidates: [path.join(dir, sha)] });
  t.after(() => server.stop());
  assert.ok(server.defaultCoreSha256, "the served tree has a core");

  const urlA = `${server.base}?core=upstream`;
  const urlB = `${server.base}?core=upstream&coreid=sha256:${sha}`;
  const a = new FakeContext(), b = new FakeContext();
  const fetchesA = recordCoreFetches(a, server), fetchesB = recordCoreFetches(b, server);
  // Interleaved as two sessions started together: both in flight at once,
  // plus requests that are not cores and one from another origin.
  await Promise.all([
    a.load(new URL("cores/dolphin/dolphin-core-upstream.wasm", server.base).href),
    b.load(new URL(`build/core-candidates/${sha}/dolphin-core-upstream.wasm`, server.base).href),
    a.load(new URL("index.html", server.base).href),
    b.load(new URL(`build/core-candidates/${sha}/dolphin-core-upstream.js`, server.base).href)
  ]);
  assert.equal(coreFetchOf("http://elsewhere.invalid/cores/dolphin/dolphin-core-upstream.wasm", server), null);

  const coreA = checkCore({ url: urlA, defaultSha256: server.defaultCoreSha256, fetches: fetchesA });
  const coreB = checkCore({ url: urlB, defaultSha256: server.defaultCoreSha256, fetches: fetchesB });
  assert.ok(coreA.ok, coreA.error);
  assert.ok(coreB.ok, coreB.error);
  assert.deepEqual(coreA.loaded, [server.defaultCoreSha256]);
  assert.deepEqual(coreB.loaded, [sha]);
  // The server's own log holds both sessions' cores: attributing by its order
  // (the previous check) made each session see the other's and fail.
  assert.equal(new Set(server.coreFetches.map((f) => f.sha256)).size, 2);
  assert.equal(checkCore({ url: urlB, defaultSha256: server.defaultCoreSha256, fetches: server.coreFetches }).ok, false);
});
