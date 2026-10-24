import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { litFraction } from "../harness/probes/presenter-context-loss.mjs";
import { encodePng } from "../harness/lib/png.mjs";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// A WebGL presenter whose context is lost: restored → the blitter rebuilt;
// never restored → the page hands the worker a new canvas, presented in 2D.
test("the worker keeps the WebGL presenter restorable and asks for a new canvas when it is not", async () => {
  const w = await read("../src/upstream-discio-worker.js");
  assert.match(w, /addEventListener\("webglcontextlost", \(event\) => \{[\s\S]{0,120}event\.preventDefault\(\);\n\s*renderGlLost = true;/);
  assert.match(w, /addEventListener\("webglcontextrestored", \(\) => \{[\s\S]{0,400}renderGlState = createSoftwareBlitter\(renderGl\);\n\s*renderGlLost = false;/);
  assert.match(w, /if \(canvas === renderCanvas && renderGlLost\) self\.postMessage\(\{ type: "presenter-canvas-lost" \}\);/);
  assert.match(w, /await setupSoftwarePresenter\(canvas, "2d"\);/);
  // Draws are skipped while the context is lost.
  assert.equal((w.match(/!renderGlState \|\| renderGlLost \|\|/g) ?? []).length, 2);
  assert.match(w, /case "validationLoseWebGlContext": \{\n[^\n]*\n[^\n]*\n\s*if \(!harnessEnabled\) return/);
});

test("the adapter relays the lost presenter to the page, which hands over a fresh canvas", async () => {
  const a = await read("../src/upstream-worker-adapter.js");
  assert.match(a, /if \(message\?\.type === "presenter-canvas-lost"\) \{\n\s*this\.replaceLostPresenterCanvas\(\);/);
  assert.match(a, /this\.request\("replacePresenterCanvas", \{ canvas \}, \[canvas\]\)/);
  const h = await read("../src/core-host.js");
  assert.match(h, /replacePresenterCanvas: replaceCanvasForWorker,/);
});

test("litFraction counts the pixels that are not near-black", () => {
  const data = new Uint8Array(4 * 4);
  data.set([255, 255, 255, 255], 0); data.set([10, 10, 10, 255], 4); data.set([0, 200, 0, 255], 8); data.set([0, 0, 0, 255], 12);
  assert.equal(litFraction(encodePng({ width: 2, height: 2, data })), 0.5);
});
