// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Dolphin's per-game settings for the core build (patch 0097). The web build
// embedded only Data/Sys/Wii, so GameConfigLoader never found a game's INI and
// no per-game setting applied. This keeps the GameCube discs' files
// (allowlist.discIds) and, in them, only the keys tools/gamesettings-allowlist.json
// lists, then writes the result where the core embeds it
// (--embed-file <dir>@/dolphin-sys/GameSettings).
//
// Deterministic: files in name order, sections and keys in allowlist order,
// LF line endings, no timestamps; a file left with no key is not written. The
// same sources give the same bytes on any machine (CI rebuilds the core from
// its source archive and compares).
//
//   node tools/gamesettings-filter.mjs <source dir> <output dir>

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ALLOWLIST = fileURLToPath(new URL("./gamesettings-allowlist.json", import.meta.url));

export function loadAllowlist(path = DEFAULT_ALLOWLIST) {
  const list = JSON.parse(readFileSync(path, "utf8"));
  if (list.version !== 1 || !Array.isArray(list.keys) || typeof list.discIds !== "string") {
    throw new Error(`${path}: not a version 1 allowlist`);
  }
  for (const entry of list.keys) {
    if (!entry.section || !entry.key || !entry.why) throw new Error(`${path}: every key needs section, key and why`);
  }
  return list;
}

// One INI line as Common::IniFile::Load reads it: a section header when the
// untrimmed line starts with '[' (the name runs to the first ']', untrimmed;
// no ']', no header), else a key line: '#' first is a comment, '$' '+' '*'
// first or no '=' a raw line, otherwise key = trimmed text before the first
// '=', value = trimmed text after it without surrounding quotes.
function readIni(text) {
  const out = [];
  let section = null;
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  for (let raw of lines) {
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    if (!raw) continue;
    if (raw[0] === "[") {
      const end = raw.indexOf("]");
      if (end >= 0) section = raw.slice(1, end);
      continue;
    }
    if (section === null || raw[0] === "#" || "$+*".includes(raw[0])) continue;
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    const key = raw.slice(0, eq).trim();
    let value = raw.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out.push({ section, key, value });
  }
  return out;
}

// GameConfigLoader maps the legacy section "Core" (exact) and "Dolphin.Core"
// (System.Section, Main's system is named "Dolphin") to Main/Core. The filter
// keeps a key only under those exact spellings. A line whose key matches an
// allowlisted key in any other spelling or section (core, mmu, [Main.Core],
// [Video]...) stops the build: Dolphin's handling of those depends on the
// order the disc's files merge in, so a person decides.
const SECTION_SPELLINGS = { Core: ["Core", "Dolphin.Core"] };

// The allowed keys of one INI text, as the INI the core embeds, or null when
// none is there. A later line of the same key wins, as in Dolphin's IniFile.
export function filterIni(text, allowlist, name = "<ini>") {
  const found = new Map();
  for (const { section, key, value } of readIni(text)) {
    for (const k of allowlist.keys) {
      if (key.toLowerCase() !== k.key.toLowerCase()) continue;
      const spellings = SECTION_SPELLINGS[k.section] ?? [k.section];
      if (key === k.key && spellings.includes(section)) {
        found.set(`${k.section}\u0000${k.key}`, value);
      } else {
        throw new Error(`${name}: "${key}" under [${section}] is not a spelling the filter knows for [${k.section}] ${k.key}`);
      }
    }
  }
  if (!found.size) return null;
  let out = "";
  let current = null;
  for (const { section: s, key } of allowlist.keys) {
    const value = found.get(`${s}\u0000${key}`);
    if (value === undefined) continue;
    if (s !== current) {
      out += `[${s}]\n`;
      current = s;
    }
    out += `${key} = ${value}\n`;
  }
  return out;
}

// Filters every disc file of `sourceDir` into `outputDir` (emptied first).
// Returns the files written, in name order.
export function buildGameSettings(sourceDir, outputDir, allowlist = loadAllowlist()) {
  const discIds = new RegExp(allowlist.discIds);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const written = [];
  const names = readdirSync(sourceDir).filter((n) => n.endsWith(".ini") && discIds.test(n)).sort();
  for (const name of names) {
    const out = filterIni(readFileSync(join(sourceDir, name), "utf8"), allowlist, name);
    if (out === null) continue;
    writeFileSync(join(outputDir, name), out);
    written.push(name);
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) {
    console.error("usage: node tools/gamesettings-filter.mjs <source dir> <output dir>");
    process.exit(2);
  }
  const written = buildGameSettings(resolve(source), resolve(output));
  console.log(`gamesettings: ${written.length} files kept`);
}
