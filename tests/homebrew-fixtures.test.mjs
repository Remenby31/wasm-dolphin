// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

// The committed homebrew fixtures are the bytes their SHA256SUMS names, and
// harness/homebrew/rebuild-fixtures.sh rebuilds them identically from source.
test("homebrew fixtures match their committed SHA-256", () => {
  const dir = new URL("../harness/homebrew/fixtures/", import.meta.url);
  const sums = readFileSync(new URL("SHA256SUMS", dir), "utf8").trim().split("\n").map((l) => l.trim().split(/\s+/));
  assert.ok(sums.length >= 1);
  for (const [sha, name] of sums) {
    const bytes = readFileSync(new URL(name, dir));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha, name);
    // A GameCube DOL: 7 text + 11 data section offsets, then a 0x100-byte header.
    assert.ok(bytes.length > 0x100, `${name} too small for a DOL`);
  }
});
