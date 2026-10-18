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
export async function snapshotTree(root, { patches = [], coreCandidates = [] } = {}) {
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
  for (const dir of coreCandidateDirs(resolved, coreCandidates)) addCoreCandidate(files, dir);
  applyPatches(files, patches);
  for (const [key, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    hash.update(`${key.slice(1)}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  if (!files.has("/index.html")) throw new Error(`${resolved} serves no index.html`);
  return { root: resolved, files, hash: hash.digest("hex"), source: { ...sourceInfo(resolved), ...(patches.length ? { patches: patches.length } : {}) } };
}

// Candidate cores (?coreid=sha256:…) are served from
// /build/core-candidates/<sha>/: the tree's own build/core-candidates/*/
// and any directory passed explicitly (--core-candidate). The app's server
// allowlist does not cover them, so the harness adds them itself, and only
// when the directory's wasm hashes to its name.
const CANDIDATE_FILES = /^dolphin-core-upstream\.(?:js|wasm|build\.json)$/;
function coreCandidateDirs(root, explicit) {
  const base = path.join(root, "build", "core-candidates");
  const own = existsSync(base) ? readdirSync(base).map((d) => path.join(base, d)).filter((d) => existsSync(path.join(d, "dolphin-core-upstream.wasm"))) : [];
  return [...own, ...explicit.map((d) => path.resolve(d))];
}

export function addCoreCandidate(files, dir) {
  const wasm = path.join(dir, "dolphin-core-upstream.wasm");
  if (!existsSync(wasm)) throw new Error(`core candidate ${dir} has no dolphin-core-upstream.wasm`);
  const sha = createHash("sha256").update(readFileSync(wasm)).digest("hex");
  const name = path.basename(dir).toLowerCase().replace(/^sha256:/, "");
  if (/^[0-9a-f]{64}$/.test(name) && name !== sha) throw new Error(`core candidate ${dir}: its wasm hashes to ${sha}, not to its directory name`);
  for (const f of readdirSync(dir)) if (CANDIDATE_FILES.test(f)) files.set(`/build/core-candidates/${sha}/${f}`, readFileSync(path.join(dir, f)));
  return sha;
}

// sha256 of every core wasm in the snapshot, by served path.
export function coreHashes(files) {
  const out = new Map();
  for (const [key, bytes] of files) if (key.endsWith("/dolphin-core-upstream.wasm")) out.set(key, createHash("sha256").update(bytes).digest("hex"));
  return out;
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

export function snapshotHandler(snapshot, { onServe = null } = {}) {
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
    if (req.method === "GET") onServe?.(pathname);
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

export async function ensureServer({ port, root, patches = [], coreCandidates = [] }) {
  const snapshot = await snapshotTree(root, { patches, coreCandidates });
  const cores = coreHashes(snapshot.files);
  // Every core wasm this server handed out, in order (what was really loaded).
  const coreFetches = [];
  const server = createServer(snapshotHandler(snapshot, { onServe: (p) => { if (cores.has(p)) coreFetches.push({ path: p, sha256: cores.get(p) }); } }));
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
    defaultCoreSha256: cores.get("/cores/dolphin/dolphin-core-upstream.wasm") ?? null,
    coreFetches,
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })
  };
}
