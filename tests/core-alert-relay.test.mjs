// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The core's alert relay (BrowserMsgHandler: PanicAlert → page console and
// status) is rate limited like the worker's status relay: on 2026-10-21 a
// core looping on an MMU "Invalid read" sent a million lines in 31 s, each
// one through Chrome's browser process (7-14 GB, the disc worker stalled).

import assert from "node:assert/strict";
import test from "node:test";

import { loadAotCore } from "./helpers/aot-core-equivalence.mjs";

const core = await loadAotCore();
const m = core?.module;
const skip = !(typeof m?._AlertRelayForTest === "function") && "core without the alert relay limit";

function relayed(fn) {
  const lines = [];
  const saved = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    fn();
  } finally {
    console.error = saved;
  }
  return lines;
}
const totals = () => {
  const p = m._malloc(12);
  try {
    m._AlertRelayStats(p);
    return Array.from(new Uint32Array(m.HEAPU8.buffer, p, 3));
  } finally {
    m._free(p);
  }
};

test("a looping alert is relayed once, its repeats folded into one count", { skip }, () => {
  const [, folded0] = totals();
  const lines = relayed(() => m._AlertRelayForTest(100000, 0));
  assert.ok(lines.length <= 3, `${lines.length} lines relayed for 100 000 identical alerts`);
  assert.match(lines[0], /^Warning: Invalid read from 0xbd420186/);
  assert.equal(totals()[1] - folded0, 100000 - 1);
  // The next different alert relays the pending count first.
  const next = relayed(() => m._AlertRelayForTest(1, 1));
  assert.match(next[0], /^… repeated \d+ times?: Warning: Invalid read from 0xbd420186/);
  assert.match(next.at(-1), /^Warning: Invalid read from 0$/);
});

test("different alerts are capped per second, the rest counted", { skip }, () => {
  const [, , dropped0] = totals();
  const lines = relayed(() => m._AlertRelayForTest(5000, 1));
  assert.ok(lines.length <= 201, `${lines.length} lines relayed for 5 000 different alerts in under a second`);
  assert.ok(totals()[2] - dropped0 >= 4700, "the others are counted as not relayed");
});
