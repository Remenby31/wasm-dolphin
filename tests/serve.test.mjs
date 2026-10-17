// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createRequestHandler } from "../tools/serve.mjs";

// Layout: <base>/site is the served root, <base>/site-secrets is a sibling whose
// name shares the root's prefix (the startsWith-without-separator hole).
const base = mkdtempSync(join(tmpdir(), "serve-test-"));
const root = join(base, "site");
const files = {
  "index.html": "<!doctype html>home",
  "app.js": "export {};",
  "core.wasm": "\0asm",
  "docs/index.html": "docs",
  "assets/readme.txt": "plain",
  ".env": "SECRET=1",
  ".git/config": "[core]",
  "assets/.hidden": "hidden",
  ".omx/perf-fixtures/state.sav": "fixture",
  ".omx/notes.md": "scratch"
};
for (const [path, body] of Object.entries(files)) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), body);
}
mkdirSync(join(base, "site-secrets"));
writeFileSync(join(base, "site-secrets/key.txt"), "outside");
writeFileSync(join(base, "outside.txt"), "outside");

let symlinks = true;
try {
  symlinkSync(join(base, "outside.txt"), join(root, "escape.txt"));
  symlinkSync(join(base, "site-secrets"), join(root, "escape-dir"));
  symlinkSync(join(root, ".env"), join(root, "env.txt"));
  symlinkSync(join(root, "app.js"), join(root, "alias.js"));
} catch {
  symlinks = false; // Windows without developer mode.
}

let server;
let port;
before(async () => {
  server = createServer(createRequestHandler(root));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(base, { recursive: true, force: true });
});

// Raw request: the path goes on the wire untouched, unlike fetch(), which
// would normalize "..", so this is what an attacker can actually send.
function get(path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("serves assets with their MIME type and cross-origin isolation headers", async () => {
  for (const [path, type, body] of [
    ["/", "text/html; charset=utf-8", files["index.html"]],
    ["/app.js", "text/javascript; charset=utf-8", files["app.js"]],
    ["/core.wasm", "application/wasm", files["core.wasm"]],
    ["/docs/", "text/html; charset=utf-8", files["docs/index.html"]],
    ["/assets/read%6De.txt", "application/octet-stream", files["assets/readme.txt"]]
  ]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers["content-type"], type, path);
    assert.equal(response.headers["cross-origin-opener-policy"], "same-origin", path);
    assert.equal(response.headers["cross-origin-embedder-policy"], "require-corp", path);
    assert.equal(response.body, body, path);
  }
});

test("traversal out of the root is a 404, encoded or not", async () => {
  for (const path of [
    "/../outside.txt",
    "/..%2foutside.txt",
    "/%2e%2e/outside.txt",
    "/%2e%2e%2foutside.txt",
    "/docs/..%2f..%2foutside.txt",
    "/..%5coutside.txt",
    "/../site-secrets/key.txt",
    "/..%2fsite-secrets%2fkey.txt"
  ]) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.body, /outside/, path);
  }
});

test("dotfiles and dot-directories are never served", async () => {
  for (const path of ["/.env", "/.git/config", "/assets/.hidden", "/%2eenv", "/.omx/notes.md", "/.git/"]) {
    assert.equal((await get(path)).status, 404, path);
  }
});

test("the perf gate's staged fixture directory stays reachable", async () => {
  const response = await get("/.omx/perf-fixtures/state.sav");
  assert.equal(response.status, 200);
  assert.equal(response.body, "fixture");
});

test("malformed URLs are a 404 and the server keeps running", async () => {
  for (const path of ["/%", "/%E0%A4%A", "/app.js%00.html", "/%ZZ"]) {
    assert.equal((await get(path)).status, 404, path);
  }
  assert.equal((await get("/app.js")).status, 200);
});

test("symlinks may not leave the root or unmask a dotfile", { skip: !symlinks && "symlinks unavailable" }, async () => {
  assert.equal((await get("/escape.txt")).status, 404);
  assert.equal((await get("/escape-dir/key.txt")).status, 404);
  assert.equal((await get("/env.txt")).status, 404);
  const alias = await get("/alias.js");
  assert.equal(alias.status, 200);
  assert.equal(alias.body, files["app.js"]);
});

test("a directory without an index is a 404, not a crash", async () => {
  assert.equal((await get("/assets/")).status, 404);
});

test("HEAD has headers and no body; other methods are refused", async () => {
  const head = await get("/app.js", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(head.body, "");
  const post = await get("/app.js", "POST");
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
});
