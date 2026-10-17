// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claim, deletable, OWNER_FILE, release } from "../harness/lib/ownership.mjs";
import { ensureServer, IDENTITY_FILE, sameIdentity, treeIdentity } from "../harness/lib/server.mjs";
import { isDone } from "../harness/lib/session.mjs";

const REPO = path.resolve(import.meta.dirname, "..");

// Review 2026-10-17: two trees with the same app.js were taken for the same
// server, so an A/B could compare the candidate with itself.
test("a server is reused only for the very same tree", async (t) => {
  const exported = mkdtempSync(path.join(os.tmpdir(), "harness-test-tree-"));
  t.after(() => rmSync(exported, { recursive: true, force: true }));
  writeFileSync(path.join(exported, IDENTITY_FILE), JSON.stringify({ ref: "origin/main", commit: "0000000000" }));
  mkdirSync(path.join(exported, "tools"));
  copyFileSync(path.join(REPO, "tools", "serve.mjs"), path.join(exported, "tools", "serve.mjs"));
  const a = treeIdentity(REPO);
  const b = treeIdentity(exported);
  assert.equal(sameIdentity(a, a), true);
  assert.equal(sameIdentity(a, b), false);
  assert.equal(sameIdentity(a, { ...a, dirty: "different" }), false);

  const port = 18000 + (process.pid % 1000);
  const server = await ensureServer({ port, root: REPO });
  t.after(() => server.stop());
  const again = await ensureServer({ port, root: REPO });
  assert.equal(again.owned, false);
  await assert.rejects(() => ensureServer({ port, root: exported }), /in use by another server/);
});

// Review: clean deleted another agent's baseline export after ten minutes, and
// rotation deleted a running campaign.
test("cleanup only deletes finished directories this checkout made", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-test-owned-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(deletable(dir, REPO).ok, false); // no marker: unknown owner
  claim(dir, REPO, "results");
  assert.match(deletable(dir, REPO).why, /in use/);
  release(dir);
  assert.equal(deletable(dir, REPO).ok, true);
  assert.match(deletable(dir, "/some/other/checkout").why, /owned by/);
  writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({ pid: 4242, root: REPO }));
  assert.equal(deletable(dir, REPO, { alive: () => true }).ok, false); // another live process
});

// Review: discs without markers could never finish, so the frame fallback was dead code.
test("a disc without markers is done after enough frames", () => {
  assert.equal(isDone({ status: null }, { frame: 700 }, 600), true);
  assert.equal(isDone({ status: null }, { frame: 100 }, 600), false);
  assert.equal(isDone({ status: "running" }, { frame: 5000 }, 600), false);
  assert.equal(isDone({ status: "pass" }, { frame: 1 }, 600), true);
});
