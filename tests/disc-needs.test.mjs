// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// What a disc's settings ask of the renderer, read before the boot: the
// worker asks Dolphin's own game config (GameConfigValue, the embedded
// GameSettings INIs) for the mounted disc's ID and revision, and the answer
// reaches the host page through the adapter and core-host, which copy the
// mount reply field by field.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the worker reads the disc's BBoxEnable after the mount and before the boot", async () => {
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /getRevision: optionalCwrap\("GetRevision", "number", \[\]\)/);
  assert.match(worker, /gameConfigValue: optionalCwrap\("GameConfigValue", "number", \["string", "number", "string"\]\)/);
  assert.match(worker, /api\.gameConfigValue\(gameId, revision, "BBoxEnable"\) === 1/);
  const body = worker.slice(worker.indexOf("async function mountFile("));
  const mount = body.indexOf("api.mountDisc(path)");
  const needs = body.indexOf("discNeeds = mountedDiscNeeds()");
  const boot = body.indexOf("api.bootDisc(path)");
  assert.ok(mount >= 0 && mount < needs && needs < boot, "mount, then the disc's needs, then the boot");
  assert.match(body, /needs: bootKind === "disc" \? \{ \.\.\.discNeeds \} : \{ boundingBox: false \}/);
});

test("the adapter and core-host carry the needs to the host page", async () => {
  assert.match(await read("../src/upstream-worker-adapter.js"), /needs: response\.needs \?\? \{ boundingBox: false \}/);
  assert.match(await read("../src/core-host.js"), /this\.game\.needs = mounted\.needs \?\? \{ boundingBox: false \}/);
});

test("the core answers BBoxEnable from its game config and exposes the disc's revision", async () => {
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  assert.match(core, /int GameConfigValue\(const char\* game_id, int revision, const char\* setting\)/);
  assert.match(core, /name == "BBoxEnable" +\? \(Config::Get\(Config::GFX_HACK_BBOX_ENABLE\)/);
  const discio = await read("../core/upstream/dolphin_web_discio.cpp");
  assert.match(discio, /int GetRevision\(\)\n\{\n  if \(!s_disc\)\n    return -1;/);
});
