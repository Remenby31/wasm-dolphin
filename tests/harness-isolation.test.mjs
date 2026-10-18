// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claim, deletable, OWNER_FILE, release } from "../harness/lib/ownership.mjs";
import { ensureServer, snapshotTree } from "../harness/lib/server.mjs";

const REPO = path.resolve(import.meta.dirname, "..");

function tree(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "harness-test-tree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "tools"));
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "cores"));
  copyFileSync(path.join(REPO, "tools", "serve.mjs"), path.join(root, "tools", "serve.mjs"));
  writeFileSync(path.join(root, "index.html"), "<p>page</p>");
  writeFileSync(path.join(root, "src", "app.js"), "export const v = 1;\n");
  writeFileSync(path.join(root, "cores", "core.bin"), "core-v1");
  return root;
}

// Review round 3: a file changed mid-run was served changed while the run
// recorded the old identity; a candidate/baseline/candidate swap on a shared
// port went unnoticed. Now each run serves an immutable in-memory snapshot
// and never shares a server.
test("round 3: the server serves its start snapshot, whatever happens to the files", async (t) => {
  const root = tree(t);
  const port = 18000 + (process.pid % 1000);
  const server = await ensureServer({ port, root });
  t.after(() => server.stop());
  writeFileSync(path.join(root, "src", "app.js"), "export const v = 2;\n");
  const body = await (await fetch(`${server.base}src/app.js`)).text();
  assert.equal(body, "export const v = 1;\n");
  assert.notEqual((await snapshotTree(root)).hash, server.identity.snapshot);
  assert.equal((await fetch(`${server.base}tools/serve.mjs`)).status, 404); // allowlist kept
  await assert.rejects(() => ensureServer({ port, root }), /busy; the harness never shares/);
});

// Review round 3: an ignored file (prebuilt-jit-cache.bin) was outside the
// identity. The snapshot covers every served byte.
test("round 3: every served file, ignored or not, is in the snapshot hash", async (t) => {
  const root = tree(t);
  const before = await snapshotTree(root);
  writeFileSync(path.join(root, "cores", "core.bin"), "core-v2");
  assert.notEqual((await snapshotTree(root)).hash, before.hash);
});

// Review round 3: two processes acquiring the same --out both succeeded.
test("round 3: two processes racing for one directory: exactly one owns it", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-test-owned-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = `import { claim } from ${JSON.stringify(path.join(REPO, "harness/lib/ownership.mjs"))};
    try { claim(${JSON.stringify(dir)}, "r", "results"); console.log("won"); } catch { console.log("lost"); }`;
  const results = Array.from({ length: 4 }, () => spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).stdout.trim());
  assert.deepEqual(results.sort(), ["lost", "lost", "lost", "won"]);
});

test("a claimed directory is never claimed again, and only its owner releases it", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-test-owned-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(deletable(dir, REPO).ok, false); // no marker: unknown owner
  claim(dir, REPO, "results");
  assert.throws(() => claim(dir, REPO, "results"), /already claimed/);
  assert.match(deletable(dir, REPO).why, /in use/);
  release(dir);
  assert.equal(deletable(dir, REPO).ok, true);
  assert.match(deletable(dir, "/some/other/checkout").why, /owned by/);
  writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({ pid: process.ppid, root: REPO }));
  release(dir); // not ours: must not clear another live pid
  assert.equal(deletable(dir, REPO).ok, false);
});
