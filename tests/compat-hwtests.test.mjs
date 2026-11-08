// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// The ported hardware tests (compat/) on the core in cores/dolphin: every
// check matches the console's value on the interpreter and the JIT, except
// the failures compat/expected-failures.json lists. In core-build.yml this
// runs on the pull request's own core.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { judge, runSuites } from "../compat/run.mjs";
import { loadOracleCore } from "./helpers/jit-oracle.mjs";

const coreWasm = new URL("../cores/dolphin/dolphin-core-upstream.wasm", import.meta.url);
const core = existsSync(coreWasm) ? await loadOracleCore() : null;
const skip = core ? false : "no core with the JIT oracle in cores/dolphin";
const expected = JSON.parse(readFileSync(new URL("../compat/expected-failures.json", import.meta.url), "utf8"));

test("ported hwtests: no failure outside compat/expected-failures.json, none listed that passes", { skip }, async () => {
  core.setFprf(false);
  const records = await runSuites(core);
  assert.ok(records.length > 29000, `only ${records.length} checks`);
  assert.ok(records.filter((r) => r.jit.status === "pass").length > 23000, "the JIT ran too few checks");
  assert.deepEqual(judge(records, expected.failures), []);
});

test("judge: an unlisted failure and a listed pass are both problems", () => {
  const rec = (id, interp, jit) => ({ id, interp: { status: interp, got: "1", expected: "2" }, jit: { status: jit } });
  const problems = judge([rec("a", "fail", "pass"), rec("b", "pass", "n/c"), rec("c", "fail", "fail")],
    [{ id: "b", tiers: ["interp"] }, { id: "c", tiers: ["interp", "jit"] }]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /unexpected fail \[interp\] a/);
  assert.match(problems[1], /now passes \[interp\] b/);
});

test("judge: a family of failures must keep its exact count", () => {
  const rec = (id, s) => ({ id, interp: { status: s }, jit: { status: "n/c" } });
  const records = [rec("f/x 1", "fail"), rec("f/x 2", "pass"), rec("f/x 3", "fail")];
  assert.deepEqual(judge(records, [{ match: "^f/x ", tiers: ["interp"], count: { interp: 2 } }]), []);
  assert.match(judge(records, [{ match: "^f/x ", tiers: ["interp"], count: { interp: 3 } }])[0], /2 failures, .* says 3/);
});
