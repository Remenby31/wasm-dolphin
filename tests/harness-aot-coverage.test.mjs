import assert from "node:assert/strict";
import test from "node:test";

import { coverage, pcLocationFromBody, pcLocationFromCore } from "../harness/probes/aot-coverage.mjs";

test("aot coverage probe: PC location decoded from the GetPPCPC body", () => {
  // ... i32.const 0xa32710; i32.load; i32.load offset=0x242190 ...
  const body = Uint8Array.from([0x01, 0x41, 0x90, 0xce, 0x8c, 0x05, 0x28, 0x02, 0x00, 0x28, 0x02, 0x90, 0xc3, 0x90, 0x01, 0x0b]);
  assert.deepEqual(pcLocationFromBody(body), { ptr: 0xa32710, offset: 0x242190 });
  assert.equal(pcLocationFromBody(Uint8Array.from([0x41, 0x00, 0x0b, 0, 0, 0, 0, 0, 0])), null);
});

test("aot coverage probe: the committed core has a readable PC location", () => {
  const loc = pcLocationFromCore(new URL("../cores/dolphin", import.meta.url).pathname);
  assert.ok(loc.ptr > 0 && loc.offset > 0);
});

test("aot coverage probe: distinct PCs first, low memory counted as missed", () => {
  const plan = { modules: [{ blocks: { start: [0x80003100], end: [0x80003110] } }], dynamic: [] };
  const r = coverage(plan, [[0x80003100, 10, 100], [0x80003104, 1, 1], [0x500, 5, 5], [0x80009000, 1, 1]]);
  assert.deepEqual([r.distinct, r.distinctPct, r.missed, r.missedLowMem], [4, 50, 2, 1]);
});
