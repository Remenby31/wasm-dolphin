// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_GPU_SPIN_MICROS, MAX_GPU_SPIN_MICROS, parseGpuSpinMicros } from "../src/core-host.js";

// ?gpuspin (patch 0098): absent means the default; -1 the old busy loop; an
// integer in range is taken; anything else is refused with a warning, never
// read as 0 (sleep at once, -3 % on the CPU thread).
test("gpuspin: default, opt-out, integers in range", () => {
  assert.equal(parseGpuSpinMicros(null), DEFAULT_GPU_SPIN_MICROS);
  assert.equal(parseGpuSpinMicros("-1"), -1);
  assert.equal(parseGpuSpinMicros("0"), 0);
  assert.equal(parseGpuSpinMicros("100"), 100);
  assert.equal(parseGpuSpinMicros(String(MAX_GPU_SPIN_MICROS)), MAX_GPU_SPIN_MICROS);
});

test("gpuspin: blank, padded, float, exponent, negative or out of range fall back with a warning", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  for (const raw of ["", " ", " 50", "50 ", "2.5", "1e3", "-2", "0x10", String(MAX_GPU_SPIN_MICROS + 1)]) {
    assert.equal(parseGpuSpinMicros(raw), DEFAULT_GPU_SPIN_MICROS, JSON.stringify(raw));
  }
  assert.equal(warn.mock.callCount(), 9);
});
