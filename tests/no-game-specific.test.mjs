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
// and the files the series creates.
//
// Guest addresses likewise: a constant 0x80xxxxxx (MEM1, cached view) in a
// line the series adds is a fixed place in some game's code or data unless it
// is listed here with its reason. Patch 0196 removed the ones a game's link
// layout put there (fast paths, OS routines, a wedge probe).
export const GUEST_ADDRESS_ALLOWED = Object.freeze([
  // the base of MEM1's cached view: masks and the view's offset (Mem1ViewOffset)
  { from: 0x80000000, to: 0x80000000, why: "MEM1 cached view base" },
  // the OS globals area of low memory (GameCube OS ABI, 0x80000000-0x800000ff):
  // the self-tests use its words as pointer values
  { from: 0x80000020, to: 0x800000ff, why: "OS globals area" },
  // the BAT value of the JIT oracle's set-up: 0x80000000 cached, 256 MiB
  { from: 0x80001fff, to: 0x80001fff, why: "BAT register value (self-test)" },
  // the self-tests' own code: the oracle's sentinel return address and the
  // code it writes at 0x80003000 (never a game's)
  { from: 0x80002000, to: 0x80002000, why: "self-test sentinel" },
  { from: 0x80003000, to: 0x80003fff, why: "self-test code" },
  // upstream Interpreter's dcbz/dcbi low-memory bound, mirrored by the JIT
  { from: 0x80008000, to: 0x80008000, why: "dcache bound mirrored from upstream" },
  // the JIT oracle's scratch memory
  { from: 0x80100000, to: 0x80100000, why: "self-test scratch" }
]);
const GUEST_ADDRESS = /\b0x(80[0-9a-f]{6})(?![0-9a-f])/gi;

// "file: address in line" for each address in `lines` ({ file, text }) the
// allowlist does not cover.
export function guestAddressOffenders(lines) {
  const hits = [];
  for (const { file, text } of lines) {
    for (const m of text.matchAll(GUEST_ADDRESS)) {
      const value = Number.parseInt(m[1], 16);
      if (!GUEST_ADDRESS_ALLOWED.some((a) => value >= a.from && value <= a.to)) {
        hits.push(`${file}: 0x${m[1].toLowerCase()} in ${text.trim().slice(0, 100)}`);
      }
    }
  }
  return hits;
}

test("the guest address pattern catches any MEM1 constant and spares the allowlist", () => {
  const line = (text) => [{ file: "f.cpp", text }];
  for (const text of ["if (ppc_state.pc == 0x80335E98u)", "constexpr u32 loop_end = 0x8035cb38;", "{0x800192a0, 0x7c0802a6},",
    "x = 0X8001CC84ULL;", "// bl 0x80019894"]) {
    assert.equal(guestAddressOffenders(line(text)).length, 1, text);
  }
  for (const text of ["(address ^ 0x80000000u)", "gpr[2] = 0x80000020;", "ppc.spr[base] = 0x80001fff;", "op.address = 0x80003100;",
    "address < 0x80008000", "SCRATCH_VA = 0x80100000;", "0x8000000000ull", "0x7fffffff", "0xcc008000", "0x8000"]) {
    assert.deepEqual(guestAddressOffenders(line(text)), [], text);
  }
});
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

sourceContractTest("the locked series adds no commercial game title to the core source", () => {
  const added = seriesAddedLines();
  assert.ok(added.length > 1000, `the series' added lines were read (${added.length})`);
  const hits = added.filter(({ text }) => TITLE.test(text)).map(({ file, text }) => `${file}: ${text.trim().slice(0, 120)}`);
  assert.deepEqual(hits, []);
});

sourceContractTest("the locked series adds no guest address outside the allowlist", () => {
  const added = seriesAddedLines();
  assert.ok(added.length > 1000, `the series' added lines were read (${added.length})`);
  assert.deepEqual(guestAddressOffenders(added), []);
});
