import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  BLOCK_SIZE,
  buildRawCard,
  checkSaveState,
  DENTRY_SIZE,
  gciFileName,
  gciFolderPath,
  memcardChecksums,
  parseGci,
  parseRawCard,
  parseSaveStateHeader,
  sniffMemcardFile,
  STATE_COOKIE_BASE,
  STATE_VERSION
} from "../src/memcard.js";
import { readVendorFileSync, sourceContractTest, vendorSourceRoot } from "./helpers/source-contract.mjs";

const readVendorSource = (path) => readVendorFileSync(join(vendorSourceRoot, path));

function gci({ game = "GTST", maker = "01", name = "test save", blocks = 2, fill = 1 } = {}) {
  const bytes = new Uint8Array(DENTRY_SIZE + blocks * BLOCK_SIZE).fill(fill);
  bytes.fill(0xff, 0, DENTRY_SIZE);
  bytes.set(new TextEncoder().encode(game), 0);
  bytes.set(new TextEncoder().encode(maker), 4);
  bytes.fill(0, 8, 40);
  bytes.set(new TextEncoder().encode(name), 8);
  bytes[0x36] = 0;
  bytes[0x37] = 0;
  bytes[0x38] = 0;
  bytes[0x39] = blocks;
  for (let b = 0; b < blocks; b += 1) bytes[DENTRY_SIZE + b * BLOCK_SIZE] = 0x40 + b;
  return bytes;
}

test("checksums match the constants of Dolphin's empty directory", () => {
  // Directory(): 127 entries and padding of 0xFF, update counter 0, and the
  // hard-coded checksum pair 0xF003 / 0.
  const dir = new Uint8Array(BLOCK_SIZE).fill(0xff);
  dir[0x1ffa] = 0;
  dir[0x1ffb] = 0;
  assert.deepEqual(memcardChecksums(dir, 0, 0x1ffc), [0xf003, 0]);
});

test("a GCI is checked against its own directory entry", () => {
  assert.deepEqual(
    (({ gameCode, makerCode, fileName, blockCount }) => ({ gameCode, makerCode, fileName, blockCount }))(parseGci(gci())),
    { gameCode: "GTST", makerCode: "01", fileName: "test save", blockCount: 2 }
  );
  assert.throws(() => parseGci(gci().subarray(0, DENTRY_SIZE + BLOCK_SIZE)), /announces 2 blocks, file holds 1/);
  assert.throws(() => parseGci(new Uint8Array(DENTRY_SIZE + BLOCK_SIZE).fill(0xff)), /empty directory entry/);
  assert.equal(gciFileName(parseGci(gci({ name: "a/b:c" }))), "01-GTST-a_b_c.gci");
});

test("raw card export and import round-trip every save, block chains included", () => {
  const saves = [gci({ blocks: 3, fill: 7 }), gci({ game: "GOTH", name: "other", blocks: 1, fill: 9 })];
  const card = buildRawCard(saves, { formatTime: 0x123456789n });
  assert.equal(card.byteLength, 16 * 16 * BLOCK_SIZE);
  assert.equal(sniffMemcardFile(card), "raw");
  assert.equal(sniffMemcardFile(saves[0]), "gci");

  const { sizeMbits, saves: back } = parseRawCard(card);
  assert.equal(sizeMbits, 16);
  assert.equal(back.length, 2);
  assert.deepEqual([back[0].firstBlock, back[1].firstBlock], [5, 8]);
  // A GCI carries its first block; everything else is byte-identical.
  for (let i = 0; i < saves.length; i += 1) {
    const expected = saves[i].slice();
    expected[0x37] = back[i].firstBlock;
    assert.deepEqual(back[i].bytes, expected);
  }
  // Free count and last allocated block, as Dolphin's BlockAlloc keeps them.
  const bat = card.subarray(3 * BLOCK_SIZE);
  assert.equal((bat[6] << 8) | bat[7], 251 - 4);
  assert.equal((bat[8] << 8) | bat[9], 8);
});

test("a damaged or foreign raw card is refused", () => {
  const card = buildRawCard([gci()]);
  const damaged = card.slice();
  damaged[1 * BLOCK_SIZE + 0x10] ^= 1; // directory copy 1
  damaged[2 * BLOCK_SIZE + 0x10] ^= 1; // directory copy 2
  assert.throws(() => parseRawCard(damaged), /directory or allocation table is corrupt/);
  // One good directory copy is enough, as on the console.
  const oneCopy = card.slice();
  oneCopy[1 * BLOCK_SIZE + 0x10] ^= 1;
  assert.equal(parseRawCard(oneCopy).saves.length, 1);
  assert.throws(() => parseRawCard(card.subarray(0, card.length - BLOCK_SIZE)), /header says 16 Mbit/);
  assert.throws(() => buildRawCard([gci({ blocks: 200 }), gci({ blocks: 60 })]), /need 260 blocks/);
});

test("the GCI folder follows Dolphin's region directories", () => {
  assert.equal(gciFolderPath("/dolphin-user", "NTSC-U", "A"), "/dolphin-user/GC/USA/Card A");
  assert.equal(gciFolderPath("/dolphin-user", "PAL", "B"), "/dolphin-user/GC/EUR/Card B");
  assert.equal(gciFolderPath("/dolphin-user", "NTSC-J"), "/dolphin-user/GC/JAP/Card A");
  assert.equal(gciFolderPath("/dolphin-user", "Unknown"), "/dolphin-user/GC/USA/Card A");
  assert.throws(() => gciFolderPath("/dolphin-user", "PAL", "C"), /slot must be A or B/);
});

function stateBytes({ gameId = "GTST01", version = STATE_VERSION, versionString = "Dolphin web" } = {}) {
  const text = new TextEncoder().encode(versionString);
  const bytes = new Uint8Array(32 + text.length + 16 + 8);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(gameId.padEnd(6, "\0")), 0);
  view.setFloat64(16, 1234.5, true);
  view.setUint32(24, STATE_COOKIE_BASE + version, true);
  view.setUint32(28, text.length, true);
  bytes.set(text, 32);
  return bytes;
}

test("a save state is refused for another game or another state version", () => {
  assert.deepEqual(parseSaveStateHeader(stateBytes()), {
    gameId: "GTST01",
    stateVersion: STATE_VERSION,
    versionString: "Dolphin web",
    savedAt: 1234.5
  });
  assert.equal(checkSaveState(stateBytes(), "GTST01").gameId, "GTST01");
  // A .dol boots as game "00000000"; the header keeps six characters.
  assert.equal(checkSaveState(stateBytes({ gameId: "000000" }), "00000000").gameId, "000000");
  assert.throws(() => checkSaveState(stateBytes(), "GOTH01"), /belongs to game GTST01, the running game is GOTH01/);
  assert.throws(() => checkSaveState(stateBytes({ version: 188 }), "GTST01"), /version 188 \(Dolphin web\) does not match/);
  assert.throws(() => checkSaveState(new Uint8Array(10), "GTST01"), /too short/);
});

sourceContractTest("memcard.js layouts match the vendored Dolphin", () => {
  const state = readVendorSource("Core/State.cpp");
  assert.match(state, new RegExp(`constexpr u32 STATE_VERSION = ${STATE_VERSION};`));
  assert.match(state, /constexpr u32 COOKIE_BASE = 0xBAADBABE;/);
  const memcard = readVendorSource("Core/HW/GCMemcard/GCMemcard.h");
  assert.match(memcard, /constexpr u32 BLOCK_SIZE = 0x2000;/);
  assert.match(memcard, /constexpr u8 DIRLEN = 0x7F;/);
  assert.match(memcard, /constexpr u32 MC_FST_BLOCKS = 0x05;/);
});
