// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claim, deletable, OWNER_FILE, release } from "../harness/lib/ownership.mjs";
import { ensureServer, IDENTITY_FILE, sameIdentity, treeIdentity } from "../harness/lib/server.mjs";
import { decodeMarkers } from "../harness/lib/markers.mjs";
import { assertPaused, isDone } from "../harness/lib/session.mjs";

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
  assert.equal(isDone({ status: "running", confident: true }, { frame: 5000 }, 600), false);
  assert.equal(isDone({ status: "pass", confident: true }, { frame: 1 }, 600), true);
});

// ---- Review round 2 (2026-10-18) ----

test("round 2: a reused server that is swapped for another tree is caught at the next check", async (t) => {
  const exported = mkdtempSync(path.join(os.tmpdir(), "harness-test-tree-"));
  t.after(() => rmSync(exported, { recursive: true, force: true }));
  writeFileSync(path.join(exported, IDENTITY_FILE), JSON.stringify({ ref: "origin/main", commit: "1111111111" }));
  mkdirSync(path.join(exported, "tools"));
  copyFileSync(path.join(REPO, "tools", "serve.mjs"), path.join(exported, "tools", "serve.mjs"));
  const port = 19000 + (process.pid % 1000);
  const a = await ensureServer({ port, root: REPO });
  const b = await ensureServer({ port, root: REPO }); // B reuses A's server
  assert.equal(b.owned, false);
  await b.verify();
  await a.stop();
  const baseline = await ensureServer({ port, root: exported }); // A now serves another tree
  t.after(() => baseline.stop());
  await assert.rejects(() => b.verify(), /identity changed/);
});

test("round 2: untracked served files are part of the tree identity", (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "harness-test-git-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  git("init", "-q");
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "app.js"), "import './helper.js';\n");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
  writeFileSync(path.join(repo, "src", "helper.js"), "export const a = 1;\n");
  const one = treeIdentity(repo);
  writeFileSync(path.join(repo, "src", "helper.js"), "export const a = 2;\n");
  const two = treeIdentity(repo);
  assert.notEqual(one.dirty, null);
  assert.equal(sameIdentity(one, two), false);
});

test("round 2: two live processes never share or release each other's campaign", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-test-owned-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({ pid: process.ppid, root: REPO })); // a live other process
  assert.throws(() => claim(dir, REPO, "results"), /already owned/);
  release(dir); // not ours: must not clear the other pid
  assert.equal(deletable(dir, REPO).ok, false);
});

test("round 2: a refused pause is an error, not a capture at an unknown frame", () => {
  assert.throws(() => assertPaused({ paused: false, coreStateName: "Running" }), /did not pause/);
  assert.throws(() => assertPaused({ error: "no answer" }), /did not pause/);
  assert.doesNotThrow(() => assertPaused({ paused: true }));
});

test("round 2: an ordinary yellow or green corner is not a marker", () => {
  const W = 640, H = 480;
  const frame = (rgb, textured) => {
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      const k = textured && (x + y) % 7 === 0 ? 0.6 : 1;
      data.set([rgb[0] * k, rgb[1] * k, rgb[2] * k, 255], (y * W + x) * 4);
    }
    return { width: W, height: H, data };
  };
  for (const rgb of [[255, 255, 0], [0, 255, 0]]) {
    for (const textured of [false, true]) {
      const m = decodeMarkers(frame(rgb, textured));
      assert.equal(m.confident, false);
      // Without trustworthy markers the run ends on its frame count.
      assert.equal(isDone(m, { frame: 60 }, 600), false);
      assert.equal(isDone(m, { frame: 600 }, 600), true);
    }
  }
});
