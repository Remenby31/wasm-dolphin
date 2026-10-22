// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { axShares, consistentAxRead, decodeAxStats } from "../harness/lib/ax-hle-stats.mjs";
import { summarizeAx } from "../harness/probes/ax-hle.mjs";

// A v1 struct as the worker copies it.
function axBytes({ version = 1, size = 64, on = 1, mailMs = 0, mails = 0, mailMaxMs = 0, windowMs = 0 } = {}) {
  const view = new DataView(new ArrayBuffer(64));
  view.setUint32(0, version, true);
  view.setUint32(4, size, true);
  view.setUint32(8, on, true);
  [mailMs, mails, mailMaxMs, windowMs].forEach((v, i) => view.setFloat64(16 + 8 * i, v, true));
  return Array.from(new Uint8Array(view.buffer));
}

test("AX stats: layout v1 decoded; other versions, short structs and impossible values refused", () => {
  const s = decodeAxStats(axBytes({ mailMs: 400, mails: 4000, mailMaxMs: 0.9, windowMs: 20000 }));
  assert.deepEqual(s, { version: 1, sizeBytes: 64, on: true, mailMs: 400, mails: 4000, mailMaxMs: 0.9, windowMs: 20000 });
  assert.match(decodeAxStats(axBytes({ version: 2 })).error, /layout version 2/);
  assert.match(decodeAxStats(axBytes({ size: 32 })).error, /needs 64/);
  assert.match(decodeAxStats(axBytes().slice(0, 40)).error, /40 copied/);
  assert.match(decodeAxStats(axBytes({ mailMs: -1 })).error, /mailMs = -1/);
  assert.match(decodeAxStats(axBytes({ mailMs: 30000, mails: 1, mailMaxMs: 1, windowMs: 20000 })).error, /do not add up/);
  // Torn: a counter went backwards between the two copies.
  const a = decodeAxStats(axBytes({ mailMs: 400, mails: 4000, mailMaxMs: 0.9, windowMs: 20000 }));
  const b = decodeAxStats(axBytes({ mailMs: 2, mails: 10, mailMaxMs: 0.2, windowMs: 50 }));
  assert.match(consistentAxRead(a, b).error, /torn read \(mailMs, mails, windowMs/);
  assert.equal(consistentAxRead(a, a), a);
});

test("AX stats: share of the window and of the CPU thread's busy time", () => {
  const s = decodeAxStats(axBytes({ mailMs: 400, mails: 4000, mailMaxMs: 0.9, windowMs: 20000 }));
  const race = axShares(s, 100);
  assert.equal(race.shareOfWindow, 0.02);
  assert.equal(race.shareOfActive, 0.02);
  assert.equal(race.msPerSecond, 20);
  assert.equal(race.mailsPerSecond, 200);
  assert.equal(race.meanMailUs, 100);
  // A capped menu: the CPU thread busy half the time, the share doubles.
  assert.equal(axShares(s, 50).shareOfActive, 0.04);
  assert.equal(axShares(s, null).shareOfActive, null);
  assert.match(axShares(decodeAxStats(axBytes({ on: 0 }))).error, /not on/);
  assert.match(axShares(decodeAxStats(axBytes({ mails: 0, windowMs: 100 }))).error, /0 mail/);
});

test("AX probe summary: medians of the good runs, the others listed with why", () => {
  const run = (share, extra = {}) => ({ ax: { shareOfWindow: share, shareOfActive: share, msPerSecond: share * 1000, mailsPerSecond: 200, meanMailUs: 100, mailMaxMs: 1 }, ...extra });
  const s = summarizeAx([run(0.02), run(0.04), run(0.5, { overloaded: true }), { error: "savestate load failed" }, run(0.03)]);
  assert.equal(s.goodRuns, 3);
  assert.equal(s.shareOfActive.median, 0.03);
  assert.deepEqual(s.failed, [{ run: 3, why: "overloaded" }, { run: 4, why: "savestate load failed" }]);
});

test("patch 0099: the AX counter sits in the mailbox write only, a plain flag when off", () => {
  const patch = readFileSync(path.join(import.meta.dirname, "../patches/dolphin-wasm/snapshot/0099-ax-hle-timing.patch"), "utf8");
  assert.deepEqual([...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]), ["Source/Core/Core/HW/DSPHLE/DSPHLE.cpp"]);
  assert.match(patch, /extern "C" EMSCRIPTEN_KEEPALIVE u32 DolphinWeb_AxHleStats\(int reset\)/);
  assert.match(patch, /static_assert\(sizeof\(AxHleStats\) == 64\)/);
  // Off: one relaxed load of the request per mail, then a plain bool.
  assert.match(patch, /s_ax_stats_request\.load\(std::memory_order_relaxed\) >= 0\) \[\[unlikely\]\]/);
  assert.match(patch, /if \(s_ax_stats\.on\) \[\[unlikely\]\]/);
});
