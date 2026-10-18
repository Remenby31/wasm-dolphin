// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// What a picked file is: a disc image for DiscIO, or a bare executable
// (.dol/.elf) that BootParameters::GenerateFromFile boots on its own. Dolphin
// picks the executable path from the extension, so the extension decides
// here too; the header is checked so a mislabelled file fails with a
// sentence instead of a core that never starts.

import { parseDolHeader } from "./dol.js";

export const BOOT_FILE_HEAD_BYTES = 0x100;
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const ELFCLASS32 = 1;
const ELFDATA2MSB = 2;
const EM_PPC = 20;

export function bootFileKind(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".dol")) return "dol";
  if (lower.endsWith(".elf")) return "elf";
  return "disc";
}

// Throws unless `head` (the first BOOT_FILE_HEAD_BYTES of a file of
// `size` bytes) is an executable the GameCube can run.
export function checkExecutable(kind, head, size) {
  if (kind === "elf") {
    if (!ELF_MAGIC.every((value, i) => head[i] === value)) throw new Error("Not an ELF file: bad magic");
    if (head[4] !== ELFCLASS32 || head[5] !== ELFDATA2MSB) {
      throw new Error("ELF file is not 32-bit big-endian, as GameCube executables are");
    }
    const machine = (head[18] << 8) | head[19];
    if (machine !== EM_PPC) throw new Error(`ELF file targets machine ${machine}, not PowerPC`);
    return { kind, entryPoint: ((head[24] << 24) | (head[25] << 16) | (head[26] << 8) | head[27]) >>> 0 };
  }
  if (kind === "dol") {
    const dol = parseDolHeader(head);
    if (dol.loadSections.length === 0) throw new Error("DOL file has no sections to load");
    for (const section of dol.loadSections) {
      if (section.fileOffset < BOOT_FILE_HEAD_BYTES || section.fileOffset + section.size > size) {
        throw new Error(`DOL ${section.kind} section ${section.index} lies outside the file`);
      }
    }
    if ((dol.entryPoint & 0xf0000000) >>> 0 !== 0x80000000) {
      throw new Error(`DOL entry point 0x${dol.entryPoint.toString(16)} is not in GameCube RAM`);
    }
    return { kind, entryPoint: dol.entryPoint };
  }
  throw new Error(`${kind} is not an executable`);
}
