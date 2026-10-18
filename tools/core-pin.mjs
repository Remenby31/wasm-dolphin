// The core hash the browser verifies before running a core is the export
// DEFAULT_UPSTREAM_CORE_SHA256 of src/upstream-worker-protocol.js. Read it the
// way the browser does, by evaluating the module (it has no imports), and
// rewrite it only where the evaluated value comes from: a regular expression
// alone can be pointed at a commented-out copy of the declaration.

const DECLARATION = /^export const DEFAULT_UPSTREAM_CORE_SHA256 = "([0-9a-f]{64})";$/gm;

export async function evaluatedCoreHash(source) {
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const value = (await import(url)).DEFAULT_UPSTREAM_CORE_SHA256;
  if (!/^[0-9a-f]{64}$/.test(value ?? "")) throw new Error("DEFAULT_UPSTREAM_CORE_SHA256 is not a SHA-256");
  return value;
}

// The one top-level declaration, checked against the evaluated export.
async function locate(source) {
  const matches = [...source.matchAll(DECLARATION)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one line "export const DEFAULT_UPSTREAM_CORE_SHA256 = \\"<sha256>\\";", ` +
      `found ${matches.length}`);
  }
  const value = await evaluatedCoreHash(source);
  if (matches[0][1] !== value) {
    throw new Error("the DEFAULT_UPSTREAM_CORE_SHA256 declaration found is not the exported value");
  }
  return matches[0];
}

export async function pinnedCoreHash(source) {
  return (await locate(source))[1];
}

export async function withPinnedCoreHash(source, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`not a SHA-256: ${hash}`);
  const match = await locate(source);
  const start = match.index + match[0].indexOf(match[1]);
  const updated = source.slice(0, start) + hash + source.slice(start + 64);
  if (await evaluatedCoreHash(updated) !== hash) throw new Error("rewriting the core pin did not change the export");
  return updated;
}
