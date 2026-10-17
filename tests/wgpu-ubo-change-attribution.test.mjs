// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

import { parseWgpuProducerStateStats } from "../src/wgpu-pass-state-cache.js";

const patchPath = new URL(
  "../patches/dolphin-wasm/snapshot/0043-webgpu-ubo-change-attribution.patch",
  import.meta.url
);

function producerStats(suffix = "", includeHeader = true) {
  return `wgstate:1 pipe:0 bg:0,0,0 vb:0 ib:0 wgdrop:0 ` +
    `wgubo:1 wgubometrics:1 ulook:0,0,0 uhit:0,0,0 uexp:0,0,0 ` +
    `usupcall:0,0,0 usupbyte:0,0,0 ` +
    `${includeHeader ? "ubodiff:1,1,7,3 " : ""}${suffix}`;
}

test("producer parser exports complete per-class UBO change vectors", () => {
  const parsed = parseWgpuProducerStateStats(producerStats(
    "uchgcall:3,4,5 uchgfull:12336,6144,320 uchgbyte:120,80,32 " +
    "ubaseline:1,1,1 ubasebyte:4112,1536,64 " +
    "u16byte:288,176,64 u16range:7,6,2 " +
    "u256byte:2304,2048,320 u256range:4,3,2"
  ));

  assert.deepEqual(parsed.uboChangeClassOrder, ["vs", "ps", "gs"]);
  assert.equal(parsed.uboChangeAvailable, true);
  assert.equal(parsed.uboChangeEnabled, true);
  assert.equal(parsed.uboChangeEpoch, 7);
  assert.deepEqual(parsed.uboChangeUploadCalls, [3, 4, 5]);
  assert.deepEqual(parsed.uboChangeFullBytes, [12336, 6144, 320]);
  assert.deepEqual(parsed.uboChangedBytes, [120, 80, 32]);
  assert.deepEqual(parsed.uboChangeBaselineFullCount, [1, 1, 1]);
  assert.deepEqual(parsed.uboChangeBaselineFullBytes, [4112, 1536, 64]);
  assert.deepEqual(parsed.uboDirty16Bytes, [288, 176, 64]);
  assert.deepEqual(parsed.uboDirty16Ranges, [7, 6, 2]);
  assert.deepEqual(parsed.uboDirty256Bytes, [2304, 2048, 320]);
  assert.deepEqual(parsed.uboDirty256Ranges, [4, 3, 2]);
});

test("missing or malformed UBO change vectors fail closed to zero triples", () => {
  const missing = parseWgpuProducerStateStats(producerStats("", false));
  const malformed = parseWgpuProducerStateStats(producerStats(
    "uchgcall:1,2 uchgfull:x,2,3 uchgbyte:1,-2,3"
  ));

  for (const parsed of [missing, malformed]) {
    assert.equal(parsed.uboChangeAvailable, false);
    assert.equal(parsed.uboChangeEnabled, false);
    assert.deepEqual(parsed.uboChangeUploadCalls, [0, 0, 0]);
    assert.deepEqual(parsed.uboChangeFullBytes, [0, 0, 0]);
    assert.deepEqual(parsed.uboChangedBytes, [0, 0, 0]);
  }
});

sourceContractTest("native UBO change instrumentation is metrics-gated and bounded to payload bytes", async () => {
  const [source, applied] = await Promise.all([
    readFile(patchPath, "utf8"),
    readFile(new URL(
      "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp",
      import.meta.url
    ), "utf8"),
  ]);

  assert.match(source,
    /if \(!s_ubo_cache_metrics_enabled\.load\(std::memory_order_relaxed\)\)\s*\+?\s*return;/);
  assert.match(source, /ubodiff:1,/);
  assert.match(source, /static_assert\(ValidateUboChangeAnalyzer\(\)\)/);
  assert.match(source, /for \(u32 block_start = 0; block_start < size; block_start \+= 16\)/);
  assert.match(source, /const u32 region_end = std::min\(region_start \+ 256, size\)/);
  for (const [index, manager] of [[0, "vsm"], [1, "psm"], [2, "gsm"]]) {
    assert.match(source, new RegExp(
      `RecordUboPayloadChange\\(${index}, change_analysis, sizeof\\(${manager}\\.constants\\)\\)`
    ));
  }
  assert.match(applied,
    /m_vs_off = ubo_cache_enabled[\s\S]*?RecordUboPayloadChange\(0,[\s\S]*?std::memcpy\(m_vs_shadow/);
  assert.match(source, /m_ubo_publication_serial != publication_serial_before/);
  assert.doesNotMatch(source, /^\+.*PushUploadBuffer/m);
  assert.doesNotMatch(source, /^\+.*AllocUboSlice/m);
});

test("mapped wait attribution guards stale remap completion across core loads", async () => {
  const worker = await readFile(
    new URL("../src/upstream-discio-worker.js", import.meta.url),
    "utf8"
  );
  assert.match(worker, /case "load":[\s\S]*?wgpuMappedStagingGeneration \+= 1/);
  assert.match(worker, /const generation = wgpuMappedStagingGeneration/);
  assert.match(worker, /const attribution = wgpuUploadAttribution/);
  assert.match(worker,
    /if \(generation !== wgpuMappedStagingGeneration\) return;[\s\S]*?attribution\.recordCapacityWaitDuration/);
  assert.match(worker, /markWgpuMappedCapacityWait\(uploadRole\)/);
  assert.match(worker,
    /markWgpuMappedCapacityWait\(WGPU_UPLOAD_ROLE\.TEXTURE_ADJACENT\)/);
});
