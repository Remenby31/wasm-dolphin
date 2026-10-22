// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const run = (script, args) => spawnSync(process.execPath, [path.join(ROOT, "harness/probes", script), ...args], { encoding: "utf8", timeout: 20000 });

test("profile probe: the jitdump never goes inside the repository; wasm-hot says how to call it", () => {
  const inside = run("profile.mjs", ["--iso", "x.iso", "--out", path.join(ROOT, "harness", "results", "p")]);
  assert.equal(inside.status, 2);
  assert.match(inside.stderr, /must live outside the repository/);
  const usage = run("profile.mjs", []);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: profile\.mjs/);
  const hot = run("wasm-hot.mjs", []);
  assert.equal(hot.status, 2);
  assert.match(hot.stderr, /usage: wasm-hot\.mjs/);
});
