// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The mapped staging defaults a real browser gets, from its user agent and
// its engine's Error shape (src/wasm-engine.js): every JavaScriptCore browser
// (Safari on macOS and iOS, and any iOS browser) gets JSC's smaller slots;
// V8 and SpiderMonkey keep 16 MiB and their own transport.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { wasmEngine } from "../src/wasm-engine.js";
import {
  defaultWgpuMappedStagingSlotCount,
  defaultWgpuMappedStagingSlotMib,
  defaultWgpuUploadTransport,
  JSC_STAGING_SLOT_COUNT,
  JSC_STAGING_SLOT_MIB,
  requestedWgpuMappedStagingSlotCount,
  requestedWgpuMappedStagingSlotMib,
} from "../src/wgpu-replay-diagnostics.js";

const JSC = () => ({ line: true, lineNumber: false });
const V8 = () => ({ line: false, lineNumber: false });
const SPIDERMONKEY = () => ({ line: false, lineNumber: true });

const BROWSERS = [
  ["Safari macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", JSC, "jsc"],
  ["Safari iOS", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1", JSC, "jsc"],
  ["Chrome iOS", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1", JSC, "jsc"],
  ["Firefox iOS", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15", JSC, "jsc"],
  ["Chrome macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", V8, "v8"],
  ["Chrome Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", V8, "v8"],
  ["Chrome Android", "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36", V8, "v8"],
  ["Edge Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", V8, "v8"],
  ["Firefox Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0", SPIDERMONKEY, "spidermonkey"],
];

for (const [name, userAgent, probe, engine] of BROWSERS) {
  test(`${name}: mapped staging defaults`, () => {
    const detected = wasmEngine({ search: "", userAgent, probe });
    assert.equal(detected, engine);
    const mib = requestedWgpuMappedStagingSlotMib("", defaultWgpuMappedStagingSlotMib(detected));
    const slots = requestedWgpuMappedStagingSlotCount("", defaultWgpuMappedStagingSlotCount(detected));
    if (engine === "jsc") {
      assert.equal(defaultWgpuUploadTransport(detected), "mapped");
      assert.equal(mib, JSC_STAGING_SLOT_MIB);
      assert.equal(slots, JSC_STAGING_SLOT_COUNT);
    } else {
      // Unchanged: queue transport, and 16 MiB x 3 if mapped is forced.
      assert.equal(defaultWgpuUploadTransport(detected), "queue");
      assert.equal(mib, 16);
      assert.equal(slots, 3);
    }
    // The page parameters still override the default.
    assert.equal(requestedWgpuMappedStagingSlotMib("?wgpustagingslotmib=16", defaultWgpuMappedStagingSlotMib(detected)), 16);
    assert.equal(requestedWgpuMappedStagingSlotCount("?wgpustagingslots=8", defaultWgpuMappedStagingSlotCount(detected)), 8);
  });
}

test("JSC's slots hold the largest upload seen in the iPhone race (2 MiB)", () => {
  assert.ok(JSC_STAGING_SLOT_MIB >= 2);
  assert.ok(JSC_STAGING_SLOT_COUNT >= 3 && JSC_STAGING_SLOT_COUNT <= 8);
});

// The pixel guard: harness/matrices/local-staging-slot.json replays the race
// single-threaded with JSC's defaults and with JSC's former 16 MiB x 4, and the
// harness requires the same renderer's captures to be the same bytes
// (render-check: sameRenderer => "identical"). This pins the guard's shape.
test("the staging pixel guard compares JSC's defaults with 16 MiB slots, byte for byte", () => {
  const spec = JSON.parse(readFileSync(new URL("../harness/matrices/local-staging-slot.json", import.meta.url), "utf8"));
  const byId = Object.fromEntries(spec.configs.map((c) => [c.id, c]));
  const reference = byId[spec.reference];
  const candidate = byId["jsc-defaults"];
  assert.ok(reference && candidate);
  for (const c of [reference, candidate]) {
    assert.equal(c.preset, "wgpu");
    assert.equal(c.set.cpu, "single");
    assert.equal(c.set.wasmengine, "jsc");
    assert.equal(c.set.wgpuuploadtransport, undefined);
  }
  assert.equal(reference.set.wgpustagingslotmib, "16");
  assert.equal(reference.set.wgpustagingslots, "4");
  assert.equal(candidate.set.wgpustagingslotmib, undefined);
  assert.equal(candidate.set.wgpustagingslots, undefined);
  assert.equal(spec.renderMatch, undefined);
});
