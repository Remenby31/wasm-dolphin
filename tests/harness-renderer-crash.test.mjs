// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// A Chrome renderer crash ("Target crashed") in a cell is run once more:
// not again → infra-crash (not blocking); again → the crash check fails.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPlan } from "../harness/cli.mjs";
import { runChecks } from "../harness/lib/correctness.mjs";
import { correctnessGate, infraCrashGate, mergeGates } from "../harness/lib/gate.mjs";
import { summarizeMatrix } from "../harness/lib/matrix.mjs";

const item = { game: { id: "g", iso: "g.iso" }, config: { id: "c" }, run: 1, label: "g__c__r1" };
const ok = (label) => ({ label, summary: { speed: 100 }, crashed: false, errors: [], capture: { file: null } });
const crash = (label) => ({ label, summary: {}, crashed: true, rendererCrash: true, errors: [{ type: "crash", text: "page crashed" }], capture: { error: "renderer crashed" } });

async function plan(t, outcomes) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-test-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const infraLog = path.join(dir, "infra.jsonl");
  const labels = [];
  const records = await runPlan([item], {
    values: {}, spec: {}, dir, infraLog, log: () => {},
    measure: async (_, label) => { labels.push(label); return outcomes.shift()(label); }
  });
  return { records, labels, infraLog };
}

test("a renderer crash that does not happen again is an infra crash, counted, not a crash", async (t) => {
  const { records, labels, infraLog } = await plan(t, [crash, ok]);
  assert.deepEqual(labels, ["g__c__r1", "g__c__r1-retry"]);
  assert.equal(records[0].crashed, false);
  assert.ok(records[0].infraCrash);
  assert.equal(runChecks(records[0]).crash.status, "pass");
  assert.equal(readFileSync(infraLog, "utf8").trim().split("\n").length, 1);
});

test("a renderer crash that happens again fails the crash check, and blocks on the candidate only", async (t) => {
  const { records } = await plan(t, [crash, crash]);
  assert.equal(records[0].crashed, true);
  assert.equal(records[0].rendererCrashRepeated, true);
  const cand = records.map((r) => ({ ...r, checks: runChecks(r) }));
  const base = [{ ...item, game: "g", config: "c", run: 1, summary: { speed: 100 }, crashed: false, errors: [], checks: runChecks({ summary: { speed: 100 }, crashed: false, errors: [] }) }];
  const g = mergeGates(correctnessGate(summarizeMatrix(base), summarizeMatrix(cand)), infraCrashGate(base, cand));
  assert.equal(g.ok, false);
  assert.ok(g.blocking.some((r) => r.check === "crash" && r.status === "regressed"));
});

test("infra crashes are reported, not blocking, unless only the candidate has two or more", () => {
  const r = (run, infra) => ({ game: "g", config: "c", run, infraCrash: infra ? { evidence: "x" } : null });
  const one = infraCrashGate([r(1)], [r(1, true)]);
  assert.equal(one.ok, true);
  assert.equal(one.rows[0].status, "infra-crash");
  assert.equal(infraCrashGate([r(1, true)], [r(1, true), r(2, true)]).ok, true);
  assert.equal(infraCrashGate([r(1)], [r(1, true), r(2, true)]).ok, false);
  assert.equal(infraCrashGate([], []).ok, true);
});
