// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Patch 0215: the region stats' publication (a copy and sort of the miss map
// and the transition counts) is bounded in host time, at most once per
// 250 ms, and done at once when a request is applied. Every 64 slices it cost
// the CPU thread from 6 % to 19 % of its host time over a minute of race.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const PATCH = "../patches/dolphin-wasm/snapshot/0215-region-stats-publish-rate.patch";

// The patch's new side of ApplyRegionStatsRequest, from its hunk.
function applyRequestBody(patch) {
  const lines = patch.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++") && (l.startsWith(" ") || l.startsWith("+")));
  const text = lines.map((l) => l.slice(1)).join("\n");
  const at = text.indexOf("    s_region_stats_on = true;");
  return text.slice(at, text.indexOf("\n}", at) + 2);
}

test("0215: a publication per 250 ms of host time at most, and one when a request is applied", () => {
  const patch = read(PATCH);
  assert.match(patch, /\+constexpr auto REGION_STATS_PUBLISH_MS = std::chrono::milliseconds\(250\);/);
  const body = applyRequestBody(patch);
  // the request path publishes and stamps the time
  assert.match(body, /s_region_stats_on = true;\n    PublishRegionStats\(\);\n    s_region_stats_published_at = std::chrono::steady_clock::now\(\);/);
  // the slice path: the clock read every 64 slices, the publication behind the time gate only
  assert.match(body, /else if \(s_region_stats_on && \(\+\+s_publish_counter & 63\) == 0\)\n  \{\n    const auto now = std::chrono::steady_clock::now\(\);\n    if \(now - s_region_stats_published_at >= REGION_STATS_PUBLISH_MS\)\n    \{\n      s_region_stats_published_at = now;\n      PublishRegionStats\(\);\n    \}\n  \}/);
  assert.equal(body.match(/PublishRegionStats\(\);/g).length, 2, "two publications: the request's and the gated one");
  // nothing else in the series publishes per slice count any more
  assert.doesNotMatch(patch, /^\+.*& 63\) == 0\)\n\+?\s*\{\n\+?\s*PublishRegionStats/m);
});

test("0215: the bound in publications per second, from the gate (at most 1000 / 250 + the requests)", () => {
  const patch = read(PATCH);
  const ms = Number(/milliseconds\((\d+)\)/.exec(patch)[1]);
  assert.ok(1000 / ms <= 5, `${1000 / ms} publications a second at most`);
});

test("0215: in the locked series after 0214; the docs name the fields that can be 250 ms old", () => {
  const lock = JSON.parse(read("../provenance/dolphin-source.lock.json"));
  const paths = lock.patches.map((p) => p.path);
  const at = paths.indexOf("patches/dolphin-wasm/snapshot/0215-region-stats-publish-rate.patch");
  assert.ok(at > paths.indexOf("patches/dolphin-wasm/snapshot/0214-harness-swap-ring.patch") && at > 0);
  const doc = read("../harness/lib/jit-region-stats.mjs");
  assert.match(doc, /Since 0215 the core publishes at most once per 250 ms of host time/);
  for (const f of ["installFallbacks", "regionsQueued", "entriesMapped", "regionsEnabled", "topMiss", "miss table", "transition tops"]) assert.ok(doc.includes(f), f);
  assert.match(read("../harness/probes/race-perf.mjs"), /Since 0215 the tops and gauges/);
  assert.match(read("../harness/probes/cpu-window.mjs"), /since 0215 the core publishes the region/);
});
