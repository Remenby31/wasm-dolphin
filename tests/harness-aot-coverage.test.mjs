import assert from "node:assert/strict";
import test from "node:test";

import { coverage } from "../harness/probes/aot-coverage.mjs";

test("aot coverage probe: distinct PCs first, dynamic ranges count", () => {
  const plan = { modules: [{ blocks: { start: [0x80003100], end: [0x80003110] } }], dynamic: [{ start: 0x80009000, end: 0x80009004 }] };
  const r = coverage(plan, [[0x80003100, 100], [0x80003104, 1], [0x80009000, 1], [0x8000a000, 1]]);
  assert.deepEqual([r.distinct, r.distinctPct, r.missed], [4, 75, 1]);
  assert.equal(r.samplesPct, 99.029);
});
