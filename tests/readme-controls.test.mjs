// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// The README's Controls table once listed X/Y on S/A, which are stick keys.
// Derive each documented row from the actual bindings so the two cannot drift.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEFAULT_KEY_BINDINGS } from "../src/input.js";

const ROWS = {
  "A / B / X / Y": ["A", "B", "X", "Y"],
  Start: ["START"],
  "L / R / Z": ["L", "R", "Z"],
  "Main stick": ["STICK_UP", "STICK_LEFT", "STICK_DOWN", "STICK_RIGHT"],
  "C-stick": ["C_STICK_UP", "C_STICK_LEFT", "C_STICK_DOWN", "C_STICK_RIGHT"]
};

function keyFor(button) {
  const codes = Object.keys(DEFAULT_KEY_BINDINGS).filter((code) => DEFAULT_KEY_BINDINGS[code] === button);
  assert.equal(codes.length, 1, `${button} has exactly one default key`);
  return codes[0].replace(/^Key/, "");
}

test("README Controls table matches the default key bindings", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.slice(readme.indexOf("## Controls"));
  const documented = new Map();
  for (const [, label, keys] of section.matchAll(/^\| ([^|]+?) \| ([^|]+?) \|$/gm)) {
    documented.set(label, keys);
  }

  for (const [label, buttons] of Object.entries(ROWS)) {
    const expected = buttons.map((button) => `\`${keyFor(button)}\``).join(", ");
    assert.equal(documented.get(label), expected, label);
  }
  for (const direction of ["UP", "DOWN", "LEFT", "RIGHT"]) {
    assert.equal(DEFAULT_KEY_BINDINGS[`Arrow${direction[0]}${direction.slice(1).toLowerCase()}`], `D_${direction}`);
  }
  assert.equal(documented.get("D-pad"), "Arrow keys");
});
