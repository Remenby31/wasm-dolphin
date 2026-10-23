// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SCENE_PROTOCOLS, sceneProtocolCheck } from "../harness/lib/matrix.mjs";

test("heavy scene protocol: warmup 1, emulated window 6 (8 at most), region stats over the window", () => {
  const p = SCENE_PROTOCOLS["heavy-intro-13s.sav"];
  assert.deepEqual([p.warmup, p.emulatedWindow, p.maxWindowSec, p.regionStatsInWindow, p.hold], [1, 6, 8, true, null]);
  const ok = sceneProtocolCheck("heavy-intro-13s.sav", { warmup: 1, window: 6, emulated: true, hold: null, regionSample: 64, regionStatsInWindow: true });
  assert.deepEqual([ok.errors, ok.warnings], [[], []]);
  const ew20 = sceneProtocolCheck("heavy-intro-13s.sav", { warmup: 25, window: 20, emulated: true, hold: "KeyX" });
  assert.match(ew20.errors[0], /a 20 s window leaves the heavy phase \(at most 8/);
  assert.equal(ew20.warnings.length, 2);
  assert.match(sceneProtocolCheck("heavy-intro-13s.sav", { warmup: 1, window: 6, emulated: false }).warnings[0], /host-time window/);
  // Other scenes: no protocol, nothing said.
  assert.deepEqual(sceneProtocolCheck("race-after.sav", { warmup: 25, window: 20, emulated: true }), { protocol: null, errors: [], warnings: [] });
});

test("race-perf refuses a heavy-scene window over 8 s", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "scene-protocol-"));
  const state = path.join(dir, "heavy-intro-13s.sav");
  writeFileSync(state, "stand-in");
  const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../harness/probes/race-perf.mjs"), "--iso", state, "--state", state, "--port", "1",
    "--query", "core=upstream&video=wgpu&speed=1", "--emulated-window", "20", "--warmup", "25"], {
    encoding: "utf8", timeout: 20000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CI"))
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /scene protocol: heavy-intro-13s\.sav: a 20 s window leaves the heavy phase/);
});
