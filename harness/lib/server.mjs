// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Serve a tree on 127.0.0.1:port from inside the harness process, with that
// tree's own tools/serve.mjs request handler, plus /__harness_identity so a
// server already on the port is reused only if it serves the very same tree
// (root, commit and local changes), never just "a tree with the same app.js".
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const IDENTITY_PATH = "/__harness_identity";
export const IDENTITY_FILE = ".harness-identity.json";

// Exported trees (git archive) carry their identity in IDENTITY_FILE;
// checkouts get it from git, with a digest of uncommitted changes.
export function treeIdentity(root) {
  const resolved = path.resolve(root);
  const file = path.join(resolved, IDENTITY_FILE);
  if (existsSync(file)) return { root: resolved, ...JSON.parse(readFileSync(file, "utf8")) };
  const git = (...args) => execFileSync("git", ["-C", resolved, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  const commit = git("rev-parse", "HEAD").trim();
  const changes = git("diff", "HEAD", "--", "index.html", "src", "cores", "tools");
  return { root: resolved, commit, dirty: changes ? createHash("sha256").update(changes).digest("hex").slice(0, 16) : null };
}

export function sameIdentity(a, b) {
  return Boolean(a && b) && a.root === b.root && a.commit === b.commit && (a.dirty ?? null) === (b.dirty ?? null);
}

async function probeIdentity(base) {
  try {
    const res = await fetch(base + IDENTITY_PATH.slice(1));
    return res.ok ? await res.json() : { foreign: true };
  } catch {
    return null;
  }
}

export async function ensureServer({ port, root }) {
  const base = `http://127.0.0.1:${port}/`;
  const identity = treeIdentity(root);
  const serveModule = path.join(identity.root, "tools", "serve.mjs");
  const { createRequestHandler } = await import(pathToFileURL(serveModule).href);
  if (typeof createRequestHandler !== "function") throw new Error(`${serveModule} has no createRequestHandler (tree too old for the harness)`);
  const handler = createRequestHandler(identity.root);
  const server = createServer((req, res) => {
    if (req.url === IDENTITY_PATH) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(identity));
      return;
    }
    handler(req, res);
  });
  const listening = await new Promise((resolve, reject) => {
    server.once("error", (e) => (e.code === "EADDRINUSE" ? resolve(false) : reject(e)));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (!listening) {
    const other = await probeIdentity(base);
    if (!sameIdentity(other, identity)) {
      throw new Error(`port ${port} is in use by another server (${other?.foreign ? "not the harness" : `${other?.root}@${other?.commit}`}); stop it or pick another --port`);
    }
    return { base, root: identity.root, identity, owned: false, stop: async () => {} };
  }
  return {
    base,
    root: identity.root,
    identity,
    owned: true,
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })
  };
}
