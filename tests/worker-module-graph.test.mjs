import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

// The static module graph of a module worker, from its entry file.
function workerGraph(entry) {
  const seen = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    const text = readFileSync(file, "utf8");
    seen.set(file, text);
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']/gms)) {
      if (m[1].endsWith(".js")) visit(path.resolve(path.dirname(file), m[1]));
    }
  };
  visit(path.join(src, entry));
  return seen;
}

// WebKit (Safari 26.6) fails a module worker whose static graph holds a JSON
// module, with an empty error event, and loses the worker's first messages
// while a top-level await settles: the discio worker never started under
// Safari and the site fell back to its demo mode (src/default-core.js).
test("the discio worker's module graph has no JSON module and no top-level await", () => {
  const graph = workerGraph("upstream-discio-worker.js");
  assert.ok(graph.size > 20, `graph of ${graph.size} modules`);
  for (const [file, text] of graph) {
    const name = path.relative(src, file);
    assert.doesNotMatch(text, /\bwith\s*\{\s*type\s*:\s*["']json["']/, `${name}: JSON module`);
    assert.doesNotMatch(text, /^(?:(?:export )?(?:const|let|var) [^=\n]*= *\(?|\(?)await\b/m, `${name}: top-level await`);
  }
  assert.ok(!graph.has(path.join(src, "default-core.js")), "default-core.js is for pages only");
});
