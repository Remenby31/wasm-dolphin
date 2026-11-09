// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Every pinned gxtest failure of compat/machine-expected.json decodes to a
// message of the hwtest's own template, as its notes say.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodable, decode } from "../compat/decode-failures.mjs";

const expected = JSON.parse(readFileSync(new URL("../compat/machine-expected.json", import.meta.url), "utf8")).programs;

test("pinned gxtest failures decode to the hwtest's messages", () => {
  for (const program of decodable()) {
    const hashes = [...new Set(Object.values(expected[program]).flatMap((c) => c.failures.map((f) => f[2])))];
    assert.ok(hashes.length > 0, program);
    const texts = decode(program, hashes);
    for (const h of hashes) assert.ok(texts.has(h), `${program}: ${h} does not decode`);
  }
  const clip = decode("gxtest_clipping", expected.gxtest_clipping.jit.failures.map((f) => f[2]));
  const steps = [...clip.values()].map((t) => Number(t.match(/step (\d+)/)[1]));
  assert.deepEqual(steps, [1, 2, 3, 4, 6, 11, 12]);
});
