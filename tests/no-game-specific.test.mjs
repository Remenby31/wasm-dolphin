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

// Titles and recurring short names of commercial GameCube/Wii games.
export const TITLES = [
  "Melee", "Smash Bros", "SSBM", "Mario", "Wario", "Luigi", "Strikers", "Kirby", "Zelda",
  "Wind Waker", "Twilight Princess", "Metroid", "Pikmin", "F-Zero", "Sonic Adventure",
  "Monkey Ball", "Pok[eé]mon", "Donkey Kong", "Sunshine", "Double Dash", "MKDD", "MKWii",
  "Rogue Squadron", "Rogue Leader", "Animal Crossing", "Star Fox", "Resident Evil",
  "Soul ?Calibur", "Tony Hawk", "Burnout", "Need for Speed", "Harvest Moon", "Fire Emblem",
  "Tales of Symphonia", "Viewtiful", "Ikaruga", "Crazy Taxi", "Skies of Arcadia",
  "Timesplitters", "Wave Race", "Paper Mario"
];
// A GameCube/Wii disc ID: system (G, R, D), two title chars, region, maker.
const DISC_ID = /\b(?!GXXE01\b)(?:G[A-Z0-9]{2}[EPJDFSIU][0-9A-Z]{2}|R[A-Z0-9]{2}[EPJ][0-9A-Z]{2}|D43E01)\b/;
const TITLE = new RegExp(`(?:${TITLES.map((t) => `\\b${t}`).join("|")})`, "i");

// What the rule covers: the code shipped and the docs a contributor reads.
const SCOPE = ["src", "docs", "README.md", "CONTRIBUTING.md", "index.html", "patches/dolphin-wasm/*.md"];

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...SCOPE], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter((f) => f && !/\.(png|jpe?g|webp|wasm|bin|sav|iso)$/i.test(f));
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

test("no commercial game title in src, docs or patch notes", () => {
  assert.deepEqual(offenders(TITLE), []);
});

test("no disc ID in src, docs or patch notes (GXXE01 is the placeholder)", () => {
  assert.deepEqual(offenders(DISC_ID), []);
});

test("the patterns catch what they must and spare what they must", () => {
  for (const s of ["Super Smash Bros. Melee", "a melee state", "MKWii world", "GALE01", "RMCE01", "GM4E01"]) {
    assert.ok(TITLE.test(s) || DISC_ID.test(s), s);
  }
  for (const s of ["GXXE01", "GEQUAL compare", "a racing game", "the reference battle", "kart-race", "Dolphin"]) {
    assert.ok(!TITLE.test(s.replace(/\bG(?:EQUAL|REATER)\b/g, "")) && !DISC_ID.test(s.replace(/\bG(?:EQUAL|REATER)\b/g, "")), s);
  }
});
