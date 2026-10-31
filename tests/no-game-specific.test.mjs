// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Program rule: nothing specific to a commercial game, in code or in the
// living docs. No title, no disc ID: a behaviour that only one game needs is
// a bug report, not a branch. GXXE01 is the placeholder ID tests may use.
// Git history keeps the older per-game material; this guards the tree.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

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
// Not text, or this guard itself. tests/native/static-exit-links and
// tests/helpers/aot-core-equivalence.mjs name core symbols that patch 0196
// removes; they leave this list with it.
const SKIP = [/\.(png|jpe?g|webp|wasm|bin|sav|iso|gz|zip)$/i, /^tests\/no-game-specific\.test\.mjs$/,
  /^tests\/native\/static-exit-links\//, /^tests\/helpers\/aot-core-equivalence\.mjs$/];

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
