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

// Dot-prefixed paths (.git, .env, .omx scratch, ...) are never served, with
// these exceptions. The perf gate stages its save-state fixture here and loads
// it over HTTP (tools/perf-regression-gate.mjs).
const defaultAllowedDotPaths = [".omx/perf-fixtures"];

// The path of `target` inside `base`, as forward-slash segments, or null when
// it lies outside. A bare startsWith(base) is wrong: "/srv/app-secrets" starts
// with "/srv/app".
function containedPath(base, target) {
  const rel = relative(base, target);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function isHiddenPath(rel, allowedDotPaths) {
  if (!rel.split("/").some((segment) => segment.startsWith("."))) return false;
  return !allowedDotPaths.some((allowed) => rel.startsWith(`${allowed}/`));
}

/**
 * Map a request URL to a regular file under `root`, or null for anything that
 * must be a 404: malformed encoding, traversal, a symlink leaving the root,
 * hidden files, directories without an index, or anything that is not a file.
 */
export function createPathResolver(root, { allowedDotPaths = defaultAllowedDotPaths } = {}) {
  const realRoot = realpathSync(resolve(root));

  // Both the requested path and its canonical target must stay inside the
  // root and be visible: the first catches "..", the second catches symlinks.
  const visible = (path) => {
    const rel = containedPath(realRoot, path);
    return rel !== null && !isHiddenPath(rel, allowedDotPaths);
  };

  return function resolveRequestPath(url) {
    try {
      const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
      if (pathname.includes("\0")) return null;
      let candidate = resolve(realRoot, `.${pathname}`);
      if (!visible(candidate)) return null;
      if (statSync(candidate).isDirectory()) candidate = join(candidate, "index.html");
      const real = realpathSync(candidate);
      if (!visible(candidate) || !visible(real) || !statSync(real).isFile()) return null;
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
