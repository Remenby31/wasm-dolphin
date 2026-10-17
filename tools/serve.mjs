import { spawn } from "node:child_process";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const shouldOpen = args.includes("--open");
const portArgument = args.find((argument) => /^\d+$/.test(argument));
const preferredPort = Number(process.env.PORT || portArgument || 8080);
const host = process.env.HOST || "127.0.0.1";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"]
]);

// What the server exposes, as an allowlist rather than a denylist: the page,
// the app's modules and the core build it loads, and the save-state fixtures
// the perf tooling fetches. Everything else in the checkout (tools/, docs/,
// package.json, .git, ...) is a 404.
//
// A denylist of "hidden" names cannot be complete. On NTFS, GET /GIT~1/config
// is .git/config under its 8.3 short name: no dot anywhere in the path, and
// realpath keeps the alias, so a dotfile rule never fires. An allowlist fails
// closed on every such alias instead.
//
// Entries are a file ("index.html"), a directory prefix ending in "/", or a
// RegExp for a whole path. Under a directory prefix, dot-prefixed names stay
// hidden (src/.DS_Store), unless the prefix itself names them.
const defaultServedPaths = Object.freeze([
  "index.html",
  "src/",
  "cores/",
  // Staged by tools/perf-regression-gate.mjs, then fetched over HTTP.
  ".omx/perf-fixtures/",
  // SAVE_STATE_URL defaults of the tools/_run-*.mjs drivers (/__battle.sav, ...).
  /^__[\w.-]+\.sav$/
]);

// "GIT~1", "PROGRA~2": the shape of a Windows 8.3 short name. No served file
// is named like this, and resolving one would bypass the allowlist below it.
const SHORT_NAME_SEGMENT = /~\d/;

// The path of `target` inside `base`, as forward-slash segments, or null when
// it lies outside. A bare startsWith(base) is wrong: "/srv/app-secrets" starts
// with "/srv/app".
function containedPath(base, target) {
  const rel = relative(base, target);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function isServedPath(rel, servedPaths) {
  const segments = rel.split("/");
  if (segments.some((segment) => SHORT_NAME_SEGMENT.test(segment))) return false;
  return servedPaths.some((entry) => {
    if (entry instanceof RegExp) return entry.test(rel);
    if (!entry.endsWith("/")) return rel === entry;
    if (!rel.startsWith(entry)) return false;
    return !rel.slice(entry.length).split("/").some((segment) => segment.startsWith("."));
  });
}

/**
 * Map a request URL to a regular file under `root`, or null for anything that
 * must be a 404: malformed encoding, traversal, a symlink leaving the root,
 * anything outside the served allowlist, or anything that is not a file.
 */
export function createPathResolver(root, { servedPaths = defaultServedPaths } = {}) {
  // The native realpath expands 8.3 short names on Windows; the JS one keeps
  // them. The allowlist does not depend on it, but canonical names are what
  // it should be compared against.
  const canonical = realpathSync.native;
  const realRoot = canonical(resolve(root));

  // Both the requested path and its canonical target must be served: the
  // first catches ".." and aliases, the second catches symlinks.
  const served = (path) => {
    const rel = containedPath(realRoot, path);
    return rel !== null && isServedPath(rel, servedPaths);
  };

  return function resolveRequestPath(url) {
    try {
      const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
      if (pathname.includes("\0")) return null;
      let candidate = resolve(realRoot, `.${pathname}`);
      if (containedPath(realRoot, candidate) === null) return null;
      if (statSync(candidate).isDirectory()) candidate = join(candidate, "index.html");
      if (!served(candidate)) return null;
      const real = canonical(candidate);
      if (!served(real) || !statSync(real).isFile()) return null;
      return real;
    } catch {
      // URIError, missing file, permission denied, ELOOP: all plain 404s.
      return null;
    }
  };
}

export function createRequestHandler(root, options) {
  const resolveRequestPath = createPathResolver(root, options);
  return (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
      response.end("Method not allowed");
      return;
    }

    const filePath = resolveRequestPath(request.url || "/");
    if (!filePath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const contentType = mimeTypes.get(extname(filePath)) ?? "application/octet-stream";
    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp"
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    // A read error after the headers went out cannot become a 404 any more;
    // drop the connection instead of letting the error take the server down.
    createReadStream(filePath)
      .on("error", () => response.destroy())
      .pipe(response);
  };
}

const server = createServer(createRequestHandler(process.cwd()));

// Open the page in the user's browser. Best effort by design: a failure here
// must not take the server down, because the printed URL still works.
function openInBrowser(url) {
  const command =
    process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };

  try {
    const child = spawn(command.file, command.args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No launcher available; the URL above is the fallback.
  }
}

function listen(port) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE") {
      listen(port + 1);
      return;
    }
    throw error;
  });

  server.listen(port, host, () => {
    const address = server.address();
    const url = `http://${host}:${address.port}/`;
    console.log(`wasm-dolphin running at ${url}`);
    console.log("Open it in Chrome, then drag a disc image onto the page.");
    if (shouldOpen) {
      openInBrowser(url);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  listen(preferredPort);
}

export { server, listen };
