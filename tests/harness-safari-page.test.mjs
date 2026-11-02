// harness/lib/safari-page.mjs: the disc server Safari reads by HTTP ranges
// (cross-origin isolated page: CORS + CORP), and the parcours' --browser
// safari wiring (source contract: the run boots a remote disc descriptor).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startDiscServer } from "../harness/lib/safari-page.mjs";

test("the disc server answers ranges with CORS and CORP, and nothing else", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "safari-disc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const iso = path.join(dir, "game disc.iso");
  writeFileSync(iso, Buffer.from(Array.from({ length: 64 }, (_, i) => i)));
  const disc = startDiscServer(iso, { port: 0 });
  t.after(() => disc.close());
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(disc.descriptor.name, "game disc.iso");
  assert.equal(disc.descriptor.size, 64);
  assert.match(disc.descriptor.remoteDisc, /^http:\/\/127\.0\.0\.1:\d+\/game%20disc\.iso$/);
});

test("ranges and refusals", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "safari-disc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const iso = path.join(dir, "d.iso");
  writeFileSync(iso, Buffer.from(Array.from({ length: 64 }, (_, i) => i)));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const disc = startDiscServer(iso, { port });
  t.after(() => disc.close());
  await new Promise((r) => setTimeout(r, 50));
  const res = await fetch(disc.descriptor.remoteDisc, { headers: { range: "bytes=4-7" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 4-7/64");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [4, 5, 6, 7]);
  assert.equal((await fetch(disc.descriptor.remoteDisc)).status, 416, "no range, no bytes");
  assert.equal((await fetch(`http://127.0.0.1:${port}/other.iso`, { headers: { range: "bytes=0-1" } })).status, 404, "only the disc");
  assert.equal((await fetch(disc.descriptor.remoteDisc, { headers: { range: "bytes=60-99" } })).headers.get("content-range"), "bytes 60-63/64");
});

test("parcours --browser safari boots the disc descriptor, never a file", () => {
  const src = readFileSync(new URL("../harness/probes/parcours.mjs", import.meta.url), "utf8");
  assert.match(src, /browser: \{ type: "string", default: "chrome" \}/);
  assert.match(src, /--browser safari runs on macOS only/);
  assert.match(src, /if \(safari\) await bootRemoteDisc\(page, \{ url: `\$\{server\.base\}\?\$\{o\.query\}`, descriptor: o\.safari\.descriptor/);
  assert.match(src, /startDiscServer\(iso, \{ port: o\.port \+ 2 \}\)/);
  assert.match(src, /if \(safari\) await safari\.close\(\)/);
});
