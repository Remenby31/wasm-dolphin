// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { isPipeFault, onUncaught } from "../harness/lib/browser.mjs";
import { runPlan } from "../harness/cli.mjs";
import { infraCrashGate } from "../harness/lib/gate.mjs";
import { summarizeTtff } from "../harness/lib/ttff.mjs";
import { summarizeP7 } from "../harness/lib/aot-progress.mjs";

// The fault seen on 2026-10-19: Playwright's pipe transport parses an empty
// message in its own timer callback.
const PIPE_STACK = "SyntaxError: Unexpected end of JSON input\n    at JSON.parse (<anonymous>)\n    at Immediate.<anonymous> (/opt/homebrew/lib/node_modules/@playwright/cli/node_modules/playwright-core/lib/coreBundle.js:36519:44)";
function pipeError() {
  const e = new SyntaxError("Unexpected end of JSON input");
  e.stack = PIPE_STACK;
  return e;
}

test("pipe guard: only Playwright's empty-message fault is recognised", () => {
  assert.equal(isPipeFault(pipeError()), true);
  const own = new SyntaxError("Unexpected end of JSON input"); // a harness JSON.parse of its own
  assert.equal(isPipeFault(own), false);
  assert.equal(isPipeFault(new Error("Target closed")), false);
});

test("pipe guard: the open browsers are marked and closed; anything else exits", async () => {
  const closed = [];
  const ctx = (id) => ({ id, pipeFault: null, close: async () => { closed.push(id); } });
  const contexts = new Set([ctx(1), ctx(2)]);
  const [a, b] = [...contexts];
  const fault = onUncaught(pipeError(), { contexts, exit: () => assert.fail("must not exit") });
  assert.equal(fault.contexts, 2);
  assert.equal(a.pipeFault, fault);
  assert.equal(b.pipeFault, fault);
  assert.equal(contexts.size, 0);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(closed, [1, 2]);
  let exited = null;
  onUncaught(new TypeError("boom"), { contexts, exit: (e) => { exited = e; } });
  assert.match(String(exited), /boom/);
});

// The guard in a real process: the fault thrown from a timer, outside any
// harness code, leaves the process alive; any other error still ends it.
function child(throwWhat) {
  const browser = pathToFileURL(path.resolve("harness/lib/browser.mjs")).href;
  const code = `
    const { installPipeGuard } = await import(${JSON.stringify(browser)});
    installPipeGuard();
    setImmediate(() => {
      const e = new ${throwWhat}("Unexpected end of JSON input");
      e.stack = ${JSON.stringify(PIPE_STACK)};
      throw e;
    });
    setTimeout(() => { console.log("alive"); process.exit(0); }, 100);`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 20000 });
}

test("pipe guard: a real process survives the fault and still dies on other errors", () => {
  const ok = child("SyntaxError");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /alive/);
  assert.match(ok.stderr, /infra: Chrome's CDP pipe sent an unreadable message/);
  const bad = child("TypeError");
  assert.equal(bad.status, 1);
  assert.doesNotMatch(bad.stdout, /alive/);
});

test("runPlan: a CDP pipe fault is an infra crash, the cell runs once more, other runs kept", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pipe-guard-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const infraLog = path.join(dir, "infra.jsonl");
  const item = (run) => ({ label: `g__c__r${run}`, run, game: { id: "g" }, config: { id: "c" } });
  const calls = [];
  const measure = async (it, label) => {
    calls.push(label);
    if (label === "g__c__r2") return { label, summary: {}, errors: [], pipeFault: { message: "Unexpected end of JSON input" } };
    if (label === "g__c__r3" || label === "g__c__r3-retry") return { label, summary: {}, errors: [], pipeFault: { message: "x" } };
    return { label, summary: { speed: 100 }, errors: [] };
  };
  const records = await runPlan([item(1), item(2), item(3)], { values: {}, spec: {}, dir, specDir: dir, log: () => {}, measure, infraLog });
  assert.deepEqual(calls, ["g__c__r1", "g__c__r2", "g__c__r2-retry", "g__c__r3", "g__c__r3-retry"]);
  assert.equal(records.length, 3);
  assert.equal(records[0].infraCrash, null);
  assert.deepEqual(records[1].infraCrash, { label: "g__c__r2", kind: "cdp-pipe", evidence: "Unexpected end of JSON input", errors: [] });
  assert.equal(records[1].label, "g__c__r2-retry");
  assert.equal(records[2].infraCrash.repeated, true);
  assert.equal(readFileSync(infraLog, "utf8").trim().split("\n").length, 2);
  // Pipe faults never count against a side, unlike renderer crashes.
  const gate = infraCrashGate([], records);
  assert.equal(gate.ok, true);
  assert.match(gate.rows.find((r) => r.check === "infraCrash r3").candidate, /CDP pipe fault, again: unjudged/);
});

test("probes: launches the harness lost Chrome in are left out and listed, not failures", () => {
  const ok = (ms) => ({ firstContentMs: ms, firstPresentMs: ms, error: null });
  const s = summarizeTtff([{ run: 1, cold: ok(5000), warm: ok(3000) }, { run: 2, cold: { infraCrash: "pipe", error: null }, warm: ok(4000) }]);
  assert.deepEqual(s.cold.infra, [{ run: 2, why: "pipe" }]);
  assert.deepEqual(s.cold.failed, []);
  assert.equal(s.pass, true);
  assert.equal(summarizeTtff([{ run: 1, cold: { infraCrash: "pipe" }, warm: { infraCrash: "pipe" } }]).pass, null);
  const p7 = summarizeP7([{ run: 1, first: { infraCrash: "pipe" } }]);
  assert.equal(p7, null);
});
