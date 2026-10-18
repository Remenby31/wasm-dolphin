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
// Card sizes a GameCube knows, Memory Card 59 to 2043 (4 to 128 Mbit).
export const CARD_MBITS = Object.freeze([4, 8, 16, 32, 64, 128]);
export const MAX_CARD_BYTES = 128 * MBIT_TO_BLOCKS * BLOCK_SIZE;
export const MAX_SAVE_BLOCKS = 128 * MBIT_TO_BLOCKS - SYSTEM_BLOCKS;
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
  if (info.blockCount === 0 || info.blockCount > MAX_SAVE_BLOCKS ||
      bytes.byteLength !== DENTRY_SIZE + info.blockCount * BLOCK_SIZE) {
    throw new Error(
      `Not a GCI file: entry announces ${info.blockCount} blocks, file holds ${(bytes.byteLength - DENTRY_SIZE) / BLOCK_SIZE}`
    );
  }
  return info;
}

// What tells two saves apart on a card: game code, maker code and the
// 32-byte file name field (Dolphin refuses two entries that share them).
export function saveIdentity(info) {
  return `${info.gameCode}\u0000${info.makerCode}\u0000${info.fileName}`;
}

// A file name for a save, one-to-one with its identity: every character
// outside [A-Za-z0-9._ ] (the "-" separator and "%" included) is written as
// %XX of its byte, so "a/b" and "a:b" stay two files. The layout follows
// Dolphin's GenerateDefaultGCIFilename (maker-game-name.gci).
export function gciFileName(info) {
  const escape = (text) =>
    [...text].map((ch) => (/[A-Za-z0-9._ ]/.test(ch) ? ch : `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)).join("");
  return `${escape(info.makerCode)}-${escape(info.gameCode)}-${escape(info.fileName)}.gci`;
}

function activeCopy(card, first, second, counterOffset) {
  const a = card.subarray(first * BLOCK_SIZE, (first + 1) * BLOCK_SIZE);
  const b = card.subarray(second * BLOCK_SIZE, (second + 1) * BLOCK_SIZE);
  return s16(a, counterOffset) >= s16(b, counterOffset) ? [a, b] : [b, a];
}

// Every save on a raw card image, as .gci bytes. The whole card is checked
// before anything is allocated: a known card size, checksums, entries whose
// block chains stay on the card, end exactly at their announced length and
// share no block with another chain (which also rules out cycles).
export function parseRawCard(card) {
  if (card.byteLength > MAX_CARD_BYTES) {
    throw new Error(`Not a raw memory card: ${card.byteLength} bytes is larger than any card`);
  }
  if (card.byteLength < SYSTEM_BLOCKS * BLOCK_SIZE || card.byteLength % BLOCK_SIZE !== 0) {
    throw new Error("Not a raw memory card: size is not a whole number of 8 KiB blocks");
  }
  const sizeMbits = u16(card, 0x22);
  if (!CARD_MBITS.includes(sizeMbits) || sizeMbits * MBIT_TO_BLOCKS * BLOCK_SIZE !== card.byteLength) {
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
  const owner = new Map();
  const identities = new Set();
  const entries = [];
  for (let index = 0; index < DIRECTORY_ENTRIES; index += 1) {
    const entry = dir.subarray(index * DENTRY_SIZE, (index + 1) * DENTRY_SIZE);
    if (u32(entry, 0) === UNINITIALIZED) continue;
    const info = describeDentry(entry);
    const label = `Save ${index} (${info.gameCode} "${info.fileName}")`;
    if (info.blockCount === 0 || info.blockCount > totalBlocks - SYSTEM_BLOCKS) {
      throw new Error(`${label} announces ${info.blockCount} blocks on a ${totalBlocks - SYSTEM_BLOCKS}-block card`);
    }
    const identity = saveIdentity(info);
    if (identities.has(identity)) throw new Error(`${label} appears twice in the directory`);
    identities.add(identity);
    const chain = [];
    let block = info.firstBlock;
    for (let i = 0; i < info.blockCount; i += 1) {
      if (block < SYSTEM_BLOCKS || block >= totalBlocks) {
        throw new Error(`${label} points outside the card (block ${block})`);
      }
      if (owner.has(block)) {
        throw new Error(`${label} reuses block ${block} (already in save ${owner.get(block)}): the allocation table loops or cross-links`);
      }
      owner.set(block, index);
      chain.push(block);
      block = u16(bat, BAT_MAP + (block - SYSTEM_BLOCKS) * 2);
    }
    if (block !== 0xffff) {
      throw new Error(`${label} does not end after its ${info.blockCount} blocks (next ${block})`);
    }
    entries.push({ info, entry, chain });
  }

  const saves = entries.map(({ info, entry, chain }) => {
    const gci = new Uint8Array(DENTRY_SIZE + chain.length * BLOCK_SIZE);
    gci.set(entry, 0);
    chain.forEach((b, i) => gci.set(card.subarray(b * BLOCK_SIZE, (b + 1) * BLOCK_SIZE), DENTRY_SIZE + i * BLOCK_SIZE));
    return { ...info, bytes: gci };
  });
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

export const MAX_STATE_BYTES = 256 * 1024 * 1024;
const EXTENDED_HEADER_VERSION = 1;
const LZ4_MAX_INPUT_SIZE = 0x7e000000;

// LZ4 block decoding into dst[at..limit), bounds-checked on both sides.
// Returns the bytes written, or throws on a malformed block.
function lz4DecodeBlock(src, dst, at, limit) {
  let s = 0;
  let d = at;
  const fail = (why) => {
    throw new Error(`Save state data is corrupt (LZ4: ${why})`);
  };
  while (s < src.length) {
    const token = src[s++];
    let literals = token >> 4;
    if (literals === 15) {
      let b;
      do {
        if (s >= src.length) fail("literal length runs past the block");
        b = src[s++];
        literals += b;
      } while (b === 255);
    }
    if (s + literals > src.length || d + literals > limit) fail("literals run past a buffer");
    dst.set(src.subarray(s, s + literals), d);
    s += literals;
    d += literals;
    if (s === src.length) break;
    if (s + 2 > src.length) fail("match offset runs past the block");
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0 || d - offset < at) fail("match offset points before the output");
    let length = token & 15;
    if (length === 15) {
      let b;
      do {
        if (s >= src.length) fail("match length runs past the block");
        b = src[s++];
        length += b;
      } while (b === 255);
    }
    length += 4;
    if (d + length > limit) fail("match runs past the output");
    for (let i = 0; i < length; i += 1, d += 1) dst[d] = dst[d - offset];
  }
  return d - at;
}

// What State::DoState reads first: the Wii flag (one byte) and the MEM1 and
// MEM2 sizes. GameCube and Wii consoles both have 24 MiB of MEM1. The rest
// of the payload is every subsystem's DoState and can only be checked by
// loading it into the core.
export const STATE_MIN_PAYLOAD_BYTES = 0x1800000;
function checkStatePayloadStart(payload) {
  if (payload.byteLength < STATE_MIN_PAYLOAD_BYTES) {
    throw new Error(`Save state data is ${payload.byteLength} bytes, too small to hold the console's 24 MiB of RAM`);
  }
  if (payload[0] > 1) throw new Error("Save state data does not start like a Dolphin state (console flag)");
  const mem1 = new DataView(payload.buffer, payload.byteOffset, 9).getUint32(1, true);
  if (mem1 !== 0x1800000) {
    throw new Error(`Save state data does not start like a Dolphin state (MEM1 size 0x${mem1.toString(16)})`);
  }
}

// Everything Dolphin's LoadFileStateData checks before using a state, done
// here first: headers, the extended header, and the payload decompressed
// to exactly the announced size. Returns the header and payload size.
export function validateSaveStateData(bytes) {
  if (bytes.byteLength > MAX_STATE_BYTES) throw new Error(`Save state is larger than ${MAX_STATE_BYTES} bytes`);
  const header = parseSaveStateHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versionLength = view.getUint32(28, true);
  const base = 32 + versionLength;
  if (base + 16 > bytes.byteLength) throw new Error("Save state ends inside its extended header");
  const headerVersion = view.getUint16(base, true);
  const compression = view.getUint16(base + 2, true);
  const payloadOffset = view.getUint32(base + 4, true);
  const size = Number(view.getBigUint64(base + 8, true));
  if (headerVersion !== EXTENDED_HEADER_VERSION) throw new Error(`Save state extended header version ${headerVersion} is unknown`);
  if (payloadOffset !== 0) throw new Error(`Save state payload offset ${payloadOffset} is not supported`);
  let at = base + 16;
  if (compression === 0) {
    checkStatePayloadStart(bytes.subarray(at));
    return { ...header, compression: "none", payloadBytes: bytes.byteLength - at };
  }
  if (compression !== 1) throw new Error(`Save state compression ${compression} is unknown`);
  if (!(size > 0) || size > MAX_STATE_BYTES * 4) throw new Error(`Save state announces ${size} bytes of data`);
  const out = new Uint8Array(size);
  let produced = 0;
  while (produced < size) {
    if (at + 4 > bytes.byteLength) throw new Error(`Save state data ends after ${produced} of ${size} bytes`);
    const length = view.getInt32(at, true);
    at += 4;
    if (length <= 0 || at + length > bytes.byteLength) throw new Error(`Save state chunk of ${length} bytes runs past the file`);
    const limit = produced + Math.min(LZ4_MAX_INPUT_SIZE, size - produced);
    produced += lz4DecodeBlock(bytes.subarray(at, at + length), out, produced, limit);
    at += length;
  }
  if (at !== bytes.byteLength) throw new Error(`Save state has ${bytes.byteLength - at} bytes after its data`);
  checkStatePayloadStart(out);
  return { ...header, compression: "lz4", payloadBytes: size };
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
