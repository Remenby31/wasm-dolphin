// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Program rule: nothing specific to a commercial game, in code or in the
// living docs. No title, no disc ID: a behaviour that only one game needs is
// a bug report, not a branch. GXXE01 is the placeholder ID tests may use.
// Git history keeps the older per-game material; this guards the tree.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { sourceContractTest, vendorSourceRoot } from "./helpers/source-contract.mjs";

const ROOT = new URL("..", import.meta.url);

// Titles of commercial GameCube/Wii games, as full names (or names that are
// never ordinary words): "Sunshine" or "Burnout" alone are English words,
// "Super Mario Sunshine" and "Burnout 3" are titles.
export const TITLES = [
  "Melee", "Smash Bros", "SSBM", "Mario", "Wario", "Luigi", "Kirby", "Zelda", "Wind Waker",
  "Twilight Princess", "Metroid", "Pikmin", "F-Zero", "Sonic Adventure", "Sonic Heroes",
  "Monkey Ball", "Pok[eé]mon", "Donkey Kong", "Double Dash", "MKDD", "MKWii", "Rogue Squadron",
  "Rogue Leader", "Animal Crossing", "Star Fox", "Resident Evil", "Soul ?Calibur",
  "Tony Hawk", "Burnout [23]", "Need for Speed", "Harvest Moon", "Fire Emblem",
  "Tales of Symphonia", "Viewtiful Joe", "Ikaruga", "Crazy Taxi", "Skies of Arcadia",
  "Timesplitters", "Wave Race", "Wii Sports", "Xenoblade", "Luigi's Mansion"
];
// A GameCube/Wii disc ID: system (G, D for GameCube; R, S for Wii), two
// title characters, a region (E, P, J, D, F, S, I, U) and a two-character
// maker code.
const DISC_ID = /\b(?!GXXE01\b)(?:[GDRS][A-Z0-9]{2}[EPJDFSIU](?:01|[0-9][0-9A-Z]|[A-Z][0-9]|AF|DX|8P|41|52|69|78|7D))\b/;
const TITLE = new RegExp(`(?:${TITLES.map((t) => `\\b${t}`).join("|")})`, "i");

// What the rule covers: the code shipped and the docs a contributor reads.
const SCOPE = ["src", "docs", "tools", "tests", "harness", "README.md", "CONTRIBUTING.md", "index.html",
  "patches/dolphin-wasm/*.md"];
// Not text, or this guard itself.
const SKIP = [/\.(png|jpe?g|webp|wasm|bin|sav|iso|gz|zip)$/i, /^tests\/no-game-specific\.test\.mjs$/];

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...SCOPE], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter((f) => f && !SKIP.some((re) => re.test(f)));
}

function offenders(pattern) {
  const hits = [];
  for (const file of trackedFiles()) {
    const lines = readFileSync(new URL(file, ROOT), "utf8").split("\n");
    lines.forEach((line, i) => {
      // GEQUAL/GREATER and friends are GX compare names, not disc IDs.
      if (pattern.test(line.replace(/\bG(?:EQUAL|REATER)\b/g, ""))) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return hits;
}

test("no commercial game title in src, tools, tests, harness, docs or patch notes", () => {
  assert.deepEqual(offenders(TITLE), []);
});

test("no disc ID in src, tools, tests, harness, docs or patch notes (GXXE01 is the placeholder)", () => {
  assert.deepEqual(offenders(DISC_ID), []);
});

test("the patterns catch what they must and spare what they must", () => {
  for (const s of ["Super Smash Bros. Melee", "a melee state", "MKWii world", "Burnout 3", "GALE01", "RMCE01", "GM4E01", "SOUE01", "RSBE01", "GKYF01", "DTZD01"]) {
    assert.ok(TITLE.test(s) || DISC_ID.test(s), s);
  }
  for (const s of ["GXXE01", "GEQUAL compare", "a racing game", "the reference battle", "kart-race", "Dolphin", "sunshine", "burnout", "RGBA8", "SHA256"]) {
    assert.ok(!TITLE.test(s.replace(/\bG(?:EQUAL|REATER)\b/g, "")) && !DISC_ID.test(s.replace(/\bG(?:EQUAL|REATER)\b/g, "")), s);
  }
});

// The patched core (vendor/dolphin/Source after the locked series) is held to
// the same rule. Upstream Dolphin's own comments name games, so titles are
// checked on what the series adds: the lines of `git diff <upstream base>`
// and the files the series creates. The fixed guest addresses of the per-game
// code patch 0196 removed must not come back anywhere in Source/: the fast
// paths' entry points and data, the OS interrupt routines as one game links
// them (OSDisable/Enable/RestoreInterrupts, 0x80347364-0x803473ac) and a
// post-load wedge probe (0x80335e90-0x80335ea4).
const words = (first, last) => Array.from({ length: (last - first) / 4 + 1 }, (_, i) => first + 4 * i);
export const REMOVED_GUEST_ADDRESSES = [
  0x8037699c, 0x80339b4c, 0x800195d0, 0x8001cc84, 0x80019894, 0x801a4da8, 0x801a4db8,
  0x8035ca24, 0x804c1f7b, 0x804a75e0, 0x80433328, 0x80433324, 0x804329f0,
  ...words(0x80347364, 0x803473ac), ...words(0x80335e90, 0x80335ea4)
];
const GUEST_ADDRESS = new RegExp(
  `\\b0x(?:${REMOVED_GUEST_ADDRESSES.map((a) => a.toString(16).padStart(8, "0")).join("|")})\\b`, "i");
const VENDOR = join(vendorSourceRoot, "../..");
const TEXT_SOURCE = /\.(?:c|cc|cpp|h|hpp|inc|inl|mm|txt|cmake|js)$/i;

function vendorGit(args) {
  return execFileSync("git", ["-C", VENDOR, ...args], { encoding: "utf8", maxBuffer: 1 << 30 });
}

function seriesAddedLines() {
  const lock = JSON.parse(readFileSync(new URL("provenance/dolphin-source.lock.json", ROOT), "utf8"));
  const base = lock.upstream.commit;
  const lines = [];
  let file = "";
  for (const line of vendorGit(["diff", "--no-color", "--no-ext-diff", "-U0", base, "--", "Source"]).split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(6);
    else if (line.startsWith("+")) lines.push({ file, text: line.slice(1) });
  }
  const created = vendorGit(["ls-files", "--others", "--exclude-standard", "-z", "--", "Source"]).split("\0").filter(Boolean);
  for (const path of created.filter((p) => TEXT_SOURCE.test(p))) {
    for (const text of readFileSync(join(VENDOR, path), "utf8").split("\n")) lines.push({ file: path, text });
  }
  return lines;
}

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (TEXT_SOURCE.test(entry.name)) yield path;
  }
}

sourceContractTest("the locked series adds no commercial game title to the core source", () => {
  const added = seriesAddedLines();
  assert.ok(added.length > 1000, `the series' added lines were read (${added.length})`);
  const hits = added.filter(({ text }) => TITLE.test(text)).map(({ file, text }) => `${file}: ${text.trim().slice(0, 120)}`);
  assert.deepEqual(hits, []);
});

sourceContractTest("no fixed guest address of a removed per-game fast path in the core source", () => {
  const hits = [];
  for (const path of sourceFiles(join(VENDOR, "Source"))) {
    readFileSync(path, "utf8").split("\n").forEach((line, i) => {
      if (GUEST_ADDRESS.test(line)) hits.push(`${path.slice(VENDOR.length + 1)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, []);
});
