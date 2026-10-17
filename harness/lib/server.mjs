// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Serve a tree on 127.0.0.1:port from an immutable in-memory snapshot.
//
// At start every file the tree's own tools/serve.mjs would serve (its
// allowlist, ignored files included) is read into memory and hashed. Requests
// are answered from that snapshot only, so what a run measured is exactly
// the snapshot hash it records, whatever happens to the files afterwards.
// The server belongs to the harness process that started it and is never
// shared: a busy port is an error, not something to reuse.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const IDENTITY_FILE = ".harness-identity.json";

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"]
]);

// Everything under these the tree's resolver may serve; the resolver decides.
const SCAN_ROOTS = ["index.html", "src", "cores", ".omx/perf-fixtures"];

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return;
  const st = statSync(abs);
  if (st.isDirectory()) for (const name of readdirSync(abs).sort()) walk(root, path.posix.join(rel, name), out);
  else if (st.isFile()) out.push(rel);
}

// Apply in-memory patches to served text files (the selftest's mutants):
// { file, find, replace } must match exactly once; { file, append } appends.
export function applyPatches(files, patches = []) {
  for (const p of patches) {
    const key = `/${p.file}`;
    const text = files.get(key)?.toString("utf8");
    if (text == null) throw new Error(`patch target ${p.file} is not served`);
    let next;
    if (p.append != null) next = text + p.append;
    else {
      const at = text.indexOf(p.find);
      if (at === -1 || text.indexOf(p.find, at + 1) !== -1) throw new Error(`patch for ${p.file} must match exactly once: ${JSON.stringify(p.find).slice(0, 80)}`);
      next = text.slice(0, at) + p.replace + text.slice(at + p.find.length);
    }
    files.set(key, Buffer.from(next, "utf8"));
  }
  return files;
}

// Content-addressed snapshot of what `root` serves (after `patches`).
export async function snapshotTree(root, { patches = [] } = {}) {
  const resolved = path.resolve(root);
  const { createPathResolver } = await import(pathToFileURL(path.join(resolved, "tools", "serve.mjs")).href);
  if (typeof createPathResolver !== "function") throw new Error(`${resolved}/tools/serve.mjs has no createPathResolver (tree too old for the harness)`);
  const resolve = createPathResolver(resolved);
  const candidates = [];
  for (const r of SCAN_ROOTS) walk(resolved, r, candidates);
  for (const name of readdirSync(resolved)) if (/^__[\w.-]+\.sav$/.test(name)) candidates.push(name);
  const files = new Map();
  const hash = createHash("sha256");
  for (const rel of candidates.sort()) {
    const real = resolve(`/${rel}`);
    if (!real) continue;
    const bytes = readFileSync(real);
    files.set(`/${rel}`, bytes);
  }
  applyPatches(files, patches);
  for (const [key, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    hash.update(`${key.slice(1)}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  if (!files.has("/index.html")) throw new Error(`${resolved} serves no index.html`);
  return { root: resolved, files, hash: hash.digest("hex"), source: { ...sourceInfo(resolved), ...(patches.length ? { patches: patches.length } : {}) } };
}

// Where the snapshot came from, for the record only (identity is the hash).
function sourceInfo(root) {
  const file = path.join(root, IDENTITY_FILE);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  try {
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--", ...SCAN_ROOTS, "tools"], { encoding: "utf8" }).length > 0;
    return { commit, dirty };
  } catch {
    return {};
  }
}

export function snapshotHandler(snapshot) {
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
      pathname = null;
    }
    if (pathname === "/") pathname = "/index.html";
    const bytes = pathname && snapshot.files.get(pathname);
    if (!bytes) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME.get(path.extname(pathname)) ?? "application/octet-stream",
      "content-length": bytes.length,
      "cache-control": "no-store",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp"
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  };
}

export async function ensureServer({ port, root, patches = [] }) {
  const snapshot = await snapshotTree(root, { patches });
  const server = createServer(snapshotHandler(snapshot));
  await new Promise((resolve, reject) => {
    server.once("error", (e) =>
      reject(e.code === "EADDRINUSE" ? new Error(`port ${port} is busy; the harness never shares a server, stop the other one or pick another --port`) : e)
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    base: `http://127.0.0.1:${port}/`,
    root: snapshot.root,
    identity: { snapshot: snapshot.hash, files: snapshot.files.size, ...snapshot.source },
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })
  };
}
