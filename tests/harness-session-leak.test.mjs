// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// openSession never leaks Chrome: a missing disc fails before any launch, and
// a failure after launch closes the context and frees the profile.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openSession } from "../harness/lib/session.mjs";

test("openSession: a missing disc fails fast without launching Chrome", async () => {
  let launched = false;
  const started = Date.now();
  await assert.rejects(
    openSession({ base: "http://127.0.0.1:1/", query: "", iso: "/nonexistent/missing-disc.iso", launch: async () => { launched = true; } }),
    /disc image not found/
  );
  assert.equal(launched, false);
  assert.ok(Date.now() - started < 1000, "should fail at once");
});

test("openSession: a failure after launch closes Chrome and frees the profile", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-test-leak-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const iso = path.join(dir, "disc.iso");
  writeFileSync(iso, "");
  let closed = 0;
  let profile = null;
  const page = { on() {}, goto: async () => { throw new Error("navigation failed"); } };
  const launch = async ({ profileDir }) => {
    profile = profileDir;
    return { addInitScript: async () => {}, pages: () => [page], close: async () => { closed += 1; } };
  };
  await assert.rejects(openSession({ base: "http://127.0.0.1:1/", query: "", iso, launch }), /navigation failed/);
  assert.equal(closed, 1);
  assert.ok(profile && !existsSync(profile), "profile dir removed");
});
