import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { asDiscBlob, isRemoteDisc, remoteDiscAllowed } from "../src/remote-disc.js";
import { fileReader } from "../src/aot-recomp.js";

const disc = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);
// A synchronous XHR double that serves `disc` by Range (status, Content-Range
// and body overridable), and records the ranges asked.
export function rangeServer(bytes = disc, { status = 206, contentRange = null } = {}) {
  const seen = [];
  const request = () => {
    const x = { headers: {} };
    x.open = (method, url, sync) => Object.assign(x, { method, url, sync });
    x.setRequestHeader = (k, v) => { x.headers[k] = v; };
    x.getResponseHeader = (k) => (k === "Content-Range" ? x.contentRange : null);
    x.send = () => {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(x.headers.Range);
      seen.push([Number(a), Number(b)]);
      x.status = status;
      x.contentRange = contentRange ?? `bytes ${a}-${b}/${bytes.length}`;
      x.response = bytes.slice(Number(a), Number(b) + 1).buffer;
    };
    return x;
  };
  return { request, seen };
}
const desc = { remoteDisc: "http://127.0.0.1:8303/disc/d.iso", name: "d.iso", size: disc.length };

test("remote disc: a File passes through, a descriptor reads its ranges synchronously", async () => {
  const file = new Blob([disc]);
  assert.equal(asDiscBlob(file), file);
  assert.equal(isRemoteDisc(desc), true);
  assert.equal(isRemoteDisc(file), false);
  const s = rangeServer();
  const blob = asDiscBlob(desc, { request: s.request });
  assert.equal(blob.size, 1000);
  assert.deepEqual([...new Uint8Array(await blob.slice(10, 14).arrayBuffer())], [10, 11, 12, 13]);
  assert.deepEqual(s.seen, [[10, 13]]);
  // Clamped to the disc, negative from the end, NaN as 0, empty without a request.
  assert.equal((await blob.slice(990, 5000).arrayBuffer()).byteLength, 10);
  assert.equal((await blob.slice(-4).arrayBuffer()).byteLength, 4);
  assert.equal((await blob.slice(Number.NaN, 3).arrayBuffer()).byteLength, 3);
  assert.equal((await blob.slice("x", 2).arrayBuffer()).byteLength, 2);
  assert.equal((await blob.slice(5, 5).arrayBuffer()).byteLength, 0);
  assert.equal(s.seen.length, 5);
});

test("remote disc: a server that ignores Range, or answers another range, is an error, not a wrong read", () => {
  assert.throws(() => asDiscBlob(desc, { request: rangeServer(disc, { status: 200 }).request }).slice(0, 4), /answered 200/);
  assert.throws(() => asDiscBlob(desc, { request: rangeServer(disc, { contentRange: "bytes 4-7/1000" }).request }).slice(0, 4), /bytes 4-7/);
  assert.throws(() => asDiscBlob(desc, { request: rangeServer(disc, { contentRange: "" }).request }).slice(0, 4), /no Content-Range/);
});

test("remote disc: only this machine's server, unless the harness hooks are on", () => {
  for (const url of ["http://127.0.0.1:8303/d.iso", "http://localhost/d.iso", "http://[::1]:1/d.iso"]) assert.equal(remoteDiscAllowed({ remoteDisc: url }), true, url);
  for (const url of ["https://example.com/d.iso", "http://192.168.1.2/d.iso", "http://127.0.0.1.example.com/d.iso", "http://localhost@evil.test/d.iso", "file:///tmp/d.iso", "not a url"]) {
    assert.equal(remoteDiscAllowed({ remoteDisc: url }), false, url);
    assert.throws(() => asDiscBlob({ ...desc, remoteDisc: url }, { request: rangeServer().request }), /refused/, url);
  }
  assert.equal(remoteDiscAllowed({ remoteDisc: "https://example.com/d.iso" }, { anyHost: true }), true);
  assert.equal(remoteDiscAllowed({ remoteDisc: "file:///tmp/d.iso" }, { anyHost: true }), false);
});

test("remote disc: the worker mounts with the harness's host rule and hands the plan worker the descriptor, not its Blob-like", () => {
  const worker = readFileSync(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /const mountedDescriptor = file;\n  file = asDiscBlob\(file, \{ anyHost: harnessEnabled \}\);/);
  assert.match(worker, /await prepareAotFirstLaunch\(mountedDescriptor, \{ kind: aotKind \}\);/);
  // The Blob-like does not clone: posting it to the plan worker would fail.
  assert.throws(() => structuredClone(asDiscBlob(desc, { request: rangeServer().request })), /DataCloneError|could not be cloned/);
  assert.deepEqual(structuredClone(desc), desc);
});

test("remote disc: the AOT planner's reader takes a plain File", async () => {
  const read = fileReader(new Blob([disc]));
  assert.deepEqual([...(await read(2, 3))], [2, 3, 4]);
});
