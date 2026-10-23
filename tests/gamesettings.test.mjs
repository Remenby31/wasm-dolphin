// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Dolphin's per-game settings in the core (patch 0097): the build keeps the
// GameCube discs' INIs with only the allowlisted keys and embeds them where
// GameConfigLoader reads them. Synthetic discs only (TST01, TSTE01, ...).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildGameSettings, filterIni, loadAllowlist } from "../tools/gamesettings-filter.mjs";
import { loadAotCore } from "./helpers/aot-core-equivalence.mjs";

// The shipped allowlist's keys, for fixtures named like test discs.
const allowlist = { ...loadAllowlist(), discIds: "^T" };

const FULL = [
  "# TST01 - a test disc",
  "[Core]",
  "# Values set here will override the main Dolphin settings.",
  "CPUThread = False",
  "MMU = True",
  "FPRF = True",
  "[OnFrame]",
  "[ActionReplay]",
  "$Some Code",
  "01234567 89ABCDEF",
  "[Video_Settings]",
  "SafeTextureCacheColorSamples = 512",
  ""
].join("\r\n");

test("the filter keeps only allowlisted keys, LF, in allowlist order", () => {
  assert.equal(filterIni(FULL, allowlist), "[Core]\nMMU = True\nFPRF = True\n[Video_Settings]\nSafeTextureCacheColorSamples = 512\n");
});

test("a file with no allowlisted key gives nothing; comments, codes and other keys never pass", () => {
  assert.equal(filterIni("[Core]\n[OnFrame]\n[ActionReplay]\n$Code\n01234567 89ABCDEF\n", allowlist), null);
  assert.equal(filterIni("[Core]\n# MMU = True\n", allowlist), null, "a comment");
  assert.equal(filterIni("[ActionReplay]\n$MMU = True\n", allowlist), null, "a raw code line");
  assert.equal(filterIni("MMU = True\n", allowlist), null, "no section yet: Dolphin ignores it");
});

test("section headers as Dolphin reads them: untrimmed '[' first, the name up to the first ']'", () => {
  assert.equal(filterIni("[Core] ; x\nMMU = True\n", allowlist), "[Core]\nMMU = True\n", "text after ']' ignored");
  assert.equal(filterIni("[Core]\n  [Video_Settings]\nMMU = True\n", allowlist), "[Core]\nMMU = True\n", "an indented line is no header");
  assert.throws(() => filterIni("[Core]\n[Video_Settings] ; x\nMMU = True\n", allowlist), /Video_Settings/, "a header with text after ']' still starts a section");
});

test("[Dolphin.Core] and [Graphics.Settings] are the other spellings Dolphin maps; values lose their quotes", () => {
  assert.equal(filterIni('[Dolphin.Core]\nMMU = "False"\n', allowlist), "[Core]\nMMU = False\n");
  assert.equal(filterIni("[Graphics.Settings]\nSafeTextureCacheColorSamples = 0\n", allowlist), "[Video_Settings]\nSafeTextureCacheColorSamples = 0\n");
  assert.equal(filterIni("[Graphics.Hacks]\nXFBToTextureEnable = False\n", allowlist), "[Video_Hacks]\nXFBToTextureEnable = False\n");
});

test("an empty value is kept: Dolphin reads it as no value, the default", () => {
  assert.equal(filterIni("[Video_Settings]\nSafeTextureCacheColorSamples = \n", allowlist), "[Video_Settings]\nSafeTextureCacheColorSamples = \n");
});

test("any other spelling or section of an allowlisted key stops the build", () => {
  for (const ini of ["[core]\nMMU = False\n", "[Core]\nmmu = False\n", "[Main.Core]\nMMU = False\n", "[Video]\nMMU = True\n",
    "[video_settings]\nSafeTextureCacheColorSamples = 0\n", "[GFX.Settings]\nSafeTextureCacheColorSamples = 0\n", "[Video_Hacks]\nSafeTextureCacheColorSamples = 0\n",
    "[video_hacks]\nXFBToTextureEnable = False\n", "[Video_Settings]\nXFBToTextureEnable = False\n"]) {
    assert.throws(() => filterIni(ini, allowlist, "TST99.ini"), /TST99\.ini/, JSON.stringify(ini));
  }
});

test("a later line of the same key wins, as in Dolphin's IniFile", () => {
  assert.equal(filterIni("[Core]\nMMU = True\nMMU = False\n", allowlist), "[Core]\nMMU = False\n");
});

test("the build is deterministic: same sources, same files and bytes, in name order", () => {
  const src = mkdtempSync(join(tmpdir(), "gs-src-"));
  writeFileSync(join(src, "TST02.ini"), "[Core]\nCPUThread = False\n");
  writeFileSync(join(src, "TST01.ini"), FULL);
  writeFileSync(join(src, "RST01.ini"), "[Core]\nMMU = True\n"); // not a disc of the list
  writeFileSync(join(src, "TST01r1.ini"), "﻿[Core]\r\nMMU = False\r\n");
  const runs = [0, 1].map(() => {
    const out = mkdtempSync(join(tmpdir(), "gs-out-"));
    const written = buildGameSettings(src, out, allowlist);
    return { written, files: readdirSync(out).sort().map((n) => [n, readFileSync(join(out, n))]) };
  });
  assert.deepEqual(runs[0].written, ["TST01.ini", "TST01r1.ini"]);
  assert.deepEqual(runs[0].files, runs[1].files);
  assert.equal(runs[0].files[0][1].toString(), "[Core]\nMMU = True\nFPRF = True\n[Video_Settings]\nSafeTextureCacheColorSamples = 512\n");
  assert.equal(runs[0].files[1][1].toString(), "[Core]\nMMU = False\n");
});

test("the shipped allowlist: version 1, a reason per key, GameCube discs only", () => {
  const shipped = loadAllowlist();
  assert.equal(shipped.version, 1);
  assert.ok(shipped.keys.length > 0);
  for (const k of shipped.keys) assert.ok(k.section && k.key && k.why.length > 20, `${k.section}.${k.key} has a reason`);
  assert.equal(shipped.discIds, "^[GDPU]");
});

test("Dolphin's own folder passes the filter and gives only allowlisted keys", (t) => {
  const src = fileURLToPath(new URL("../vendor/dolphin/Data/Sys/GameSettings", import.meta.url));
  let entries;
  try {
    entries = readdirSync(src);
  } catch {
    t.skip("no vendor tree");
    return;
  }
  assert.ok(entries.length > 0);
  const out = mkdtempSync(join(tmpdir(), "gs-dolphin-"));
  const shipped = loadAllowlist();
  const written = buildGameSettings(src, out, shipped);
  assert.ok(written.length > 0);
  const allowed = new Set(shipped.keys.map((k) => k.key));
  for (const name of written) {
    for (const line of readFileSync(join(out, name), "utf8").split("\n")) {
      if (!line || line.startsWith("[")) continue;
      assert.ok(allowed.has(line.split(" = ")[0]), `${line} is allowlisted`);
    }
  }
});

const core = await loadAotCore();
// A core that does not know the newest allowlisted setting answers -2 for it.
const knowsXfb = () => core.module.ccall("GameConfigValueForTest", "number", ["string", "number", "string"], ["XYZE01", 0, "FPRF"]) !== -2;
const coreSkip = core && typeof core.module._GameConfigValueForTest === "function" && knowsXfb() ? false : "the core predates FPRF in the allowlist (patch 0121; CI builds this branch's core)";

test("the core embeds the filtered INIs, and its game config applies them in Dolphin's order", { skip: coreSkip }, () => {
  const m = core.module;
  const dir = "/dolphin-sys/GameSettings";
  const embedded = m.FS.readdir(dir).filter((n) => n.endsWith(".ini"));
  assert.ok(embedded.length > 0, "the build embedded the filtered INIs");
  for (const name of embedded) {
    const text = m.FS.readFile(`${dir}/${name}`, { encoding: "utf8" });
    assert.ok(text.length > 0, name);
    assert.match(text, /^(\[Core\]\n(MMU = (True|False)\n)?(FPRF = (True|False)\n)?)?(\[Video_Settings\]\nSafeTextureCacheColorSamples = \d*\n)?(\[Video_Hacks\]\nXFBToTextureEnable = (True|False)\n)?$/, name);
  }
  // Synthetic discs: ID3, then ID6, then ID6rN, the later file winning.
  const fixtures = {
    "TST.ini": "[Core]\nMMU = True\nFPRF = True\n[Video_Settings]\nSafeTextureCacheColorSamples = 512\n[Video_Hacks]\nXFBToTextureEnable = False\n",
    "TSTE01r1.ini": "[Core]\nMMU = False\n[Video_Settings]\nSafeTextureCacheColorSamples = 0\n"
  };
  for (const [name, text] of Object.entries(fixtures)) m.FS.writeFile(`${dir}/${name}`, text);
  try {
    const value = (id, revision, setting) => m.ccall("GameConfigValueForTest", "number", ["string", "number", "string"], [id, revision, setting]);
    assert.equal(value("TSTE01", 0, "MMU"), 1, "the ID3 file sets the MMU");
    assert.equal(value("TSTE01", 1, "MMU"), 0, "revision 1's file turns it off again");
    assert.equal(value("XYZE01", 0, "MMU"), 0, "a disc without an INI keeps the default");
    assert.equal(value("TSTE01", 0, "SafeTextureCacheColorSamples"), 512, "the ID3 file sets the samples");
    assert.equal(value("TSTE01", 1, "SafeTextureCacheColorSamples"), 0, "revision 1's file: all samples");
    assert.equal(value("XYZE01", 0, "SafeTextureCacheColorSamples"), 128, "Dolphin's default");
    assert.equal(value("TSTE01", 0, "XFBToTextureEnable"), 0, "the ID3 file keeps the XFB copy to RAM");
    assert.equal(value("TSTE01", 0, "FPRF"), 1, "the ID3 file turns FPRF on");
    assert.equal(value("XYZE01", 0, "FPRF"), 0, "Dolphin's default: FPRF off");
    assert.equal(value("XYZE01", 0, "XFBToTextureEnable"), 1, "Dolphin's default skips it");
    assert.equal(value("TSTE01", 0, "CPUThread"), -2, "only allowlisted settings");
  } finally {
    for (const name of Object.keys(fixtures)) m.FS.unlink(`${dir}/${name}`);
  }
});
