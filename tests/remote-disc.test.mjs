import assert from "node:assert/strict";
import test from "node:test";

import { asDiscBlob, isRemoteDisc } from "../src/remote-disc.js";
import { fileReader } from "../src/aot-recomp.js";

const disc = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);
// A synchronous XHR double that serves `disc` by Range, and counts requests.
function server(status = 206) {
  const seen = [];
  const request = () => {
    const x = { headers: {} };
    x.open = (method, url, sync) => Object.assign(x, { method, url, sync });
    x.setRequestHeader = (k, v) => { x.headers[k] = v; };
    x.send = () => {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(x.headers.Range);
      seen.push([Number(a), Number(b)]);
      x.status = status;
      x.response = disc.slice(Number(a), Number(b) + 1).buffer;
    };
    return x;
  };
  return { request, seen };
}
const desc = { remoteDisc: "http://127.0.0.1:1/disc", name: "d.iso", size: disc.length };

test("remote disc: a File passes through, a descriptor reads its ranges synchronously", async () => {
  const file = new Blob([disc]);
  assert.equal(asDiscBlob(file), file);
  assert.equal(isRemoteDisc(desc), true);
  assert.equal(isRemoteDisc(file), false);
  const s = server();
  const blob = asDiscBlob(desc, { request: s.request });
  assert.equal(blob.size, 1000);
  assert.deepEqual([...new Uint8Array(await blob.slice(10, 14).arrayBuffer())], [10, 11, 12, 13]);
  assert.deepEqual(s.seen, [[10, 13]]);
  // Clamped to the disc, negative from the end, empty without a request.
  assert.equal((await blob.slice(990, 5000).arrayBuffer()).byteLength, 10);
  assert.equal((await blob.slice(-4).arrayBuffer()).byteLength, 4);
  assert.equal((await blob.slice(5, 5).arrayBuffer()).byteLength, 0);
  assert.equal(s.seen.length, 3);
});

test("remote disc: a server that ignores Range is an error, not a wrong read", () => {
  const blob = asDiscBlob(desc, { request: server(200).request });
  assert.throws(() => blob.slice(0, 4), /answered 200/);
});

test("remote disc: the AOT planner's reader takes a plain File", async () => {
  const read = fileReader(new Blob([disc]));
  assert.deepEqual([...(await read(2, 3))], [2, 3, 4]);
});
