// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// GameCube memory card and save-state files, as far as import/export needs
// them. The core keeps each card as a GCI folder (one .gci per save, see
// Config::MAIN_SLOT_A in dolphin_web_core.cpp); this module converts between
// that folder and a raw card image (.raw), checks a .gci before it goes in,
// and reads the header of a Dolphin save state to refuse one made for
// another game or another state version before the core does.
//
// Layouts follow Source/Core/Core/HW/GCMemcard/GCMemcard.h: block 0 header,
// blocks 1-2 directory, 3-4 block allocation table, data from block 5.

export const BLOCK_SIZE = 0x2000;
export const DENTRY_SIZE = 0x40;
export const DIRECTORY_ENTRIES = 127;
export const SYSTEM_BLOCKS = 5;
export const MBIT_TO_BLOCKS = 16;
export const DEFAULT_CARD_MBITS = 16; // "Memory Card 251"
const UNINITIALIZED = 0xffffffff;

const HEADER_CHECKSUM_END = 0x1fc;
const DIR_UPDATE_COUNTER = 0x1ffa;
const DIR_CHECKSUM = 0x1ffc;
const BAT_UPDATE_COUNTER = 4;
const BAT_FREE_BLOCKS = 6;
const BAT_LAST_ALLOCATED = 8;
const BAT_MAP = 10;

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const s16 = (b, o) => (u16(b, o) << 16) >> 16;
function put16(b, o, v) {
  b[o] = (v >>> 8) & 0xff;
  b[o + 1] = v & 0xff;
}
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

// Dolphin's CalculateMemcardChecksums: sums of big-endian u16 words and of
// their complements, 0xFFFF folded to 0.
export function memcardChecksums(bytes, start, end) {
  let sum = 0;
  let inv = 0;
  for (let i = start; i < end; i += 2) {
    const word = u16(bytes, i);
    sum = (sum + word) & 0xffff;
    inv = (inv + (word ^ 0xffff)) & 0xffff;
  }
  return [sum === 0xffff ? 0 : sum, inv === 0xffff ? 0 : inv];
}

function checksumsMatch(bytes, start, end, at) {
  const [sum, inv] = memcardChecksums(bytes, start, end);
  return u16(bytes, at) === sum && u16(bytes, at + 2) === inv;
}

function writeChecksums(bytes, start, end, at) {
  const [sum, inv] = memcardChecksums(bytes, start, end);
  put16(bytes, at, sum);
  put16(bytes, at + 2, inv);
}

// What a directory entry says about its save.
export function describeDentry(entry) {
  return {
    gameCode: ascii(entry, 0, 4),
    makerCode: ascii(entry, 4, 2),
    fileName: ascii(entry, 8, 32).replace(/\0.*$/s, ""),
    modificationTime: u32(entry, 0x28),
    firstBlock: u16(entry, 0x36),
    blockCount: u16(entry, 0x38)
  };
}

// A .gci is a directory entry followed by exactly the blocks it announces.
export function parseGci(bytes) {
  if (bytes.byteLength < DENTRY_SIZE + BLOCK_SIZE) throw new Error("Not a GCI file: too short");
  const info = describeDentry(bytes);
  if (u32(bytes, 0) === UNINITIALIZED) throw new Error("Not a GCI file: empty directory entry");
  if (!/^[\x20-\x7e]{4}$/.test(info.gameCode) || !/^[\x20-\x7e]{2}$/.test(info.makerCode)) {
    throw new Error("Not a GCI file: game or maker code is not printable");
  }
  if (info.blockCount === 0 || bytes.byteLength !== DENTRY_SIZE + info.blockCount * BLOCK_SIZE) {
    throw new Error(
      `Not a GCI file: entry announces ${info.blockCount} blocks, file holds ${(bytes.byteLength - DENTRY_SIZE) / BLOCK_SIZE}`
    );
  }
  return info;
}

// Dolphin's GenerateDefaultGCIFilename, minus its escaping of the rare
// characters a file name cannot hold (we replace them).
export function gciFileName(info) {
  const clean = (s) => s.replace(/[^A-Za-z0-9._ -]/g, "_");
  return `${clean(info.makerCode)}-${clean(info.gameCode)}-${clean(info.fileName) || "save"}.gci`;
}

function activeCopy(card, first, second, counterOffset) {
  const a = card.subarray(first * BLOCK_SIZE, (first + 1) * BLOCK_SIZE);
  const b = card.subarray(second * BLOCK_SIZE, (second + 1) * BLOCK_SIZE);
  return s16(a, counterOffset) >= s16(b, counterOffset) ? [a, b] : [b, a];
}

// Every save on a raw card image, as .gci bytes.
export function parseRawCard(card) {
  if (card.byteLength < SYSTEM_BLOCKS * BLOCK_SIZE || card.byteLength % BLOCK_SIZE !== 0) {
    throw new Error("Not a raw memory card: size is not a whole number of 8 KiB blocks");
  }
  const sizeMbits = u16(card, 0x22);
  if (sizeMbits * MBIT_TO_BLOCKS * BLOCK_SIZE !== card.byteLength) {
    throw new Error(`Not a raw memory card: header says ${sizeMbits} Mbit, file is ${card.byteLength} bytes`);
  }
  if (!checksumsMatch(card, 0, HEADER_CHECKSUM_END, HEADER_CHECKSUM_END)) {
    throw new Error("Raw memory card header checksum mismatch");
  }
  const dirs = activeCopy(card, 1, 2, DIR_UPDATE_COUNTER);
  const dir = dirs.find((d) => checksumsMatch(d, 0, DIR_CHECKSUM, DIR_CHECKSUM));
  const bats = activeCopy(card, 3, 4, BAT_UPDATE_COUNTER);
  const bat = bats.find((b) => checksumsMatch(b, BAT_UPDATE_COUNTER, BLOCK_SIZE, 0));
  if (!dir || !bat) throw new Error("Raw memory card directory or allocation table is corrupt");

  const totalBlocks = card.byteLength / BLOCK_SIZE;
  const saves = [];
  for (let index = 0; index < DIRECTORY_ENTRIES; index += 1) {
    const entry = dir.subarray(index * DENTRY_SIZE, (index + 1) * DENTRY_SIZE);
    if (u32(entry, 0) === UNINITIALIZED) continue;
    const info = describeDentry(entry);
    const gci = new Uint8Array(DENTRY_SIZE + info.blockCount * BLOCK_SIZE);
    gci.set(entry, 0);
    let block = info.firstBlock;
    for (let i = 0; i < info.blockCount; i += 1) {
      if (block < SYSTEM_BLOCKS || block >= totalBlocks) {
        throw new Error(`Save ${info.gameCode} "${info.fileName}" points outside the card (block ${block})`);
      }
      gci.set(card.subarray(block * BLOCK_SIZE, (block + 1) * BLOCK_SIZE), DENTRY_SIZE + i * BLOCK_SIZE);
      block = u16(bat, BAT_MAP + (block - SYSTEM_BLOCKS) * 2);
    }
    saves.push({ ...info, bytes: gci });
  }
  return { sizeMbits, saves };
}

// Dolphin's InitializeHeaderData serial derivation from a zero flash ID.
function writeHeader(card, sizeMbits, formatTime) {
  const header = card.subarray(0, BLOCK_SIZE);
  header.fill(0xff);
  let rand = formatTime;
  const step = (r) => ((r * 0x41c64e6dn + 0x3039n) & 0xffffffffffffffffn) >> 16n;
  for (let i = 0; i < 12; i += 1) {
    rand = step(rand);
    header[i] = Number(rand & 0xffn);
    rand = step(rand) & 0x7fffn;
  }
  new DataView(header.buffer, header.byteOffset).setBigUint64(12, formatTime, false);
  header.fill(0, 20, 34); // SRAM bias, language, DTV status, device ID
  put16(header, 0x22, sizeMbits);
  put16(header, 0x24, 0); // ANSI encoding
  writeChecksums(header, 0, HEADER_CHECKSUM_END, HEADER_CHECKSUM_END);
}

// A raw card holding `gcis` (Uint8Array each), files laid out contiguously
// in the given order, both directory and BAT copies identical.
export function buildRawCard(gcis, { sizeMbits = DEFAULT_CARD_MBITS, formatTime = 0n } = {}) {
  const totalBlocks = sizeMbits * MBIT_TO_BLOCKS;
  if (gcis.length > DIRECTORY_ENTRIES) throw new Error(`A card holds at most ${DIRECTORY_ENTRIES} saves`);
  const needed = gcis.reduce((total, gci) => total + parseGci(gci).blockCount, 0);
  if (needed > totalBlocks - SYSTEM_BLOCKS) {
    throw new Error(`Saves need ${needed} blocks, a ${sizeMbits} Mbit card has ${totalBlocks - SYSTEM_BLOCKS}`);
  }

  const card = new Uint8Array(totalBlocks * BLOCK_SIZE).fill(0xff);
  writeHeader(card, sizeMbits, BigInt(formatTime));
  const dir = new Uint8Array(BLOCK_SIZE).fill(0xff);
  const bat = new Uint8Array(BLOCK_SIZE).fill(0);
  let next = SYSTEM_BLOCKS;
  gcis.forEach((gci, index) => {
    const { blockCount } = parseGci(gci);
    const entry = gci.slice(0, DENTRY_SIZE);
    put16(entry, 0x36, next);
    dir.set(entry, index * DENTRY_SIZE);
    for (let i = 0; i < blockCount; i += 1) {
      const block = next + i;
      card.set(gci.subarray(DENTRY_SIZE + i * BLOCK_SIZE, DENTRY_SIZE + (i + 1) * BLOCK_SIZE), block * BLOCK_SIZE);
      put16(bat, BAT_MAP + (block - SYSTEM_BLOCKS) * 2, i + 1 === blockCount ? 0xffff : block + 1);
    }
    next += blockCount;
  });
  put16(dir, DIR_UPDATE_COUNTER, 0);
  writeChecksums(dir, 0, DIR_CHECKSUM, DIR_CHECKSUM);
  put16(bat, BAT_UPDATE_COUNTER, 0);
  put16(bat, BAT_FREE_BLOCKS, totalBlocks - SYSTEM_BLOCKS - needed);
  put16(bat, BAT_LAST_ALLOCATED, next - 1);
  writeChecksums(bat, BAT_UPDATE_COUNTER, BLOCK_SIZE, 0);
  for (const copy of [1, 2]) card.set(dir, copy * BLOCK_SIZE);
  for (const copy of [3, 4]) card.set(bat, copy * BLOCK_SIZE);
  return card;
}

// The GCI folder Dolphin opens for a slot: GC/<region>/Card <slot>.
export function regionDirectory(region) {
  switch (region) {
    case "NTSC-J":
    case "NTSC-K":
      return "JAP";
    case "PAL":
      return "EUR";
    default:
      return "USA";
  }
}

export function gciFolderPath(root, region, slot = "A") {
  if (slot !== "A" && slot !== "B") throw new Error(`Memory card slot must be A or B, got ${slot}`);
  return `${root}/GC/${regionDirectory(region)}/Card ${slot}`;
}

// Dolphin save states (Core/State.cpp). STATE_VERSION is the one this core
// was built with; Dolphin refuses any other.
export const STATE_VERSION = 189;
export const STATE_COOKIE_BASE = 0xbaadbabe;
const STATE_LEGACY_HEADER = 24;

export function parseSaveStateHeader(bytes) {
  if (bytes.byteLength < STATE_LEGACY_HEADER + 8) throw new Error("Not a save state: too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const gameId = ascii(bytes, 0, 6).replace(/\0.*$/s, "");
  if (view.getUint32(8, true) !== 0) throw new Error("Save state uses the legacy LZO format");
  const cookie = view.getUint32(24, true);
  const versionLength = view.getUint32(28, true);
  if (versionLength > 256 || 32 + versionLength + 16 > bytes.byteLength) {
    throw new Error("Not a save state: version string runs past the file");
  }
  const versionString = new TextDecoder().decode(bytes.subarray(32, 32 + versionLength));
  return {
    gameId,
    stateVersion: (cookie - STATE_COOKIE_BASE) >>> 0,
    versionString,
    // Bytes 16-24 hold the save time; everything else is the same for
    // two saves of the same machine state.
    savedAt: view.getFloat64(16, true)
  };
}

// Throws unless `bytes` is a state Dolphin will accept for `gameId`.
export function checkSaveState(bytes, gameId) {
  const header = parseSaveStateHeader(bytes);
  if (header.stateVersion !== STATE_VERSION) {
    throw new Error(
      `Save state version ${header.stateVersion} (${header.versionString || "unknown build"}) does not match this core's ${STATE_VERSION}`
    );
  }
  if (gameId && header.gameId !== String(gameId).slice(0, 6)) {
    throw new Error(`Save state belongs to game ${header.gameId}, the running game is ${String(gameId).slice(0, 6)}`);
  }
  return header;
}

// Raw card or single save, told apart by size and content.
export function sniffMemcardFile(bytes) {
  if (bytes.byteLength % BLOCK_SIZE === DENTRY_SIZE) return "gci";
  if (bytes.byteLength % BLOCK_SIZE === 0 && bytes.byteLength >= SYSTEM_BLOCKS * BLOCK_SIZE) return "raw";
  throw new Error(`Not a memory card file (${bytes.byteLength} bytes is neither a .gci nor a .raw size)`);
}
