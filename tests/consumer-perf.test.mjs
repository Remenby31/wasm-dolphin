// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// SOURCE-CONTRACT test for the consumer-machine runner (docs/consumer-perf.md):
// the parts that make it run off macOS, and keep the disc and the savestate
// on the machine.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateSteps } from "../harness/lib/steps.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const runner = read("harness/probes/consumer-perf.mjs");
const racePerf = read("harness/probes/race-perf.mjs");
const browser = read("harness/lib/browser.mjs");

test("the race steps are a valid step script", () => {
  validateSteps(JSON.parse(read("harness/probes/local-race-steps.json")));
});

test("race-perf runs as a script on every platform", () => {
  // A file:// string built by hand never matches on Windows (drive letter, backslashes).
  assert.match(racePerf, /import\.meta\.url === pathToFileURL\(process\.argv\[1\] \?\? ""\)\.href/);
  assert.match(racePerf, /process\.platform === "linux"[\s\S]*"-L"/);
  assert.match(browser, /shell: process\.platform === "win32"/);
  assert.match(browser, /process\.env\.HARNESS_CHROME_ARGS/);
});

test("the savestate lives in a fresh temporary directory, deleted on every exit path", () => {
  assert.match(runner, /const scratch = mkdtempSync\(path\.join\(os\.tmpdir\(\), "gc-consumer-"\)\);\nconst results = \{\};\ntry \{/);
  assert.match(runner, /\} finally \{\n  rmSync\(scratch, \{ recursive: true, force: true \}\);\n\}/);
  assert.match(runner, /const state = path\.join\(scratch, "race\.sav"\);/);
  // The disc is read where it is: never copied by the runner.
  assert.doesNotMatch(runner, /copyFileSync|cpSync|createReadStream/);
  assert.match(runner, /if \(process\.env\.CI\) throw/);
});
