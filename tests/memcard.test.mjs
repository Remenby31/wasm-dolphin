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
  saveIdentity,
  validateSaveStateData,
  sniffMemcardFile,
  STATE_COOKIE_BASE,
  STATE_VERSION
} from "../src/memcard.js";
import { readVendorFileSync, sourceContractTest, vendorSourceRoot } from "./helpers/source-contract.mjs";
import { GC_STATE_SIZE, makeStateFile, tinyStateFile } from "./helpers/save-state-fixture.mjs";

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
  assert.equal(gciFileName(parseGci(gci({ name: "a/b:c" }))), "01-GTST-a%2Fb%3Ac.gci");
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
  // A .dol boots as game "ID-<file name>"; the header keeps six characters.
  assert.equal(checkSaveState(stateBytes({ gameId: "ID-gxS" }), "ID-gxSprites").gameId, "ID-gxS");
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

test("two saves whose names differ only in unusual characters get two files", () => {
  const names = ["a/b", "a:b", "a_b", "a%2Fb", "a-b"].map((name) => gciFileName(parseGci(gci({ name }))));
  assert.equal(new Set(names).size, names.length, names.join(" "));
  assert.notEqual(saveIdentity(parseGci(gci({ name: "a/b" }))), saveIdentity(parseGci(gci({ name: "a:b" }))));
});

// A card whose single save's BAT entries are rewritten after the fact.
function cardWithChain(blocks, rewrite) {
  const card = buildRawCard([gci({ blocks })]);
  for (const copy of [3, 4]) {
    const bat = card.subarray(copy * BLOCK_SIZE, (copy + 1) * BLOCK_SIZE);
    rewrite(bat);
    // Re-sign the table so only the chain is wrong.
    let sum = 0;
    let inv = 0;
    for (let i = 4; i < BLOCK_SIZE; i += 2) {
      const w = (bat[i] << 8) | bat[i + 1];
      sum = (sum + w) & 0xffff;
      inv = (inv + (w ^ 0xffff)) & 0xffff;
    }
    bat[0] = sum >> 8; bat[1] = sum & 0xff; bat[2] = inv >> 8; bat[3] = inv & 0xff;
  }
  return card;
}
const setBat = (bat, block, next) => { bat[10 + (block - 5) * 2] = next >> 8; bat[11 + (block - 5) * 2] = next & 0xff; };

test("a raw card whose allocation table loops is refused before anything is allocated", () => {
  const looping = cardWithChain(3, (bat) => setBat(bat, 6, 5)); // 5 -> 6 -> 5
  assert.throws(() => parseRawCard(looping), /reuses block 5 .*loops or cross-links/);
  const short = cardWithChain(3, (bat) => setBat(bat, 6, 0xffff)); // ends after 2 of 3
  assert.throws(() => parseRawCard(short), /reuses block|points outside|does not end/);
  const long = cardWithChain(2, (bat) => setBat(bat, 6, 7)); // does not stop after 2
  assert.throws(() => parseRawCard(long), /does not end after its 2 blocks \(next 7\)/);
});

const MAX_RAW_TOO_BIG = 128 * 16 * BLOCK_SIZE + BLOCK_SIZE;

test("a directory entry announcing more blocks than the card holds is refused", () => {
  const card = buildRawCard([gci({ blocks: 1 })]);
  for (const copy of [1, 2]) {
    const dir = card.subarray(copy * BLOCK_SIZE, (copy + 1) * BLOCK_SIZE);
    dir[0x38] = 0xff; dir[0x39] = 0xff;
    const [sum, inv] = memcardChecksums(dir, 0, 0x1ffc);
    dir[0x1ffc] = sum >> 8; dir[0x1ffd] = sum & 0xff; dir[0x1ffe] = inv >> 8; dir[0x1fff] = inv & 0xff;
  }
  assert.throws(() => parseRawCard(card), /announces 65535 blocks on a 251-block card/);
  assert.throws(() => parseRawCard(new Uint8Array(MAX_RAW_TOO_BIG)), /larger than any card/);
});

// A state with an LZ4 payload of literals only (token = length << 4).
function lz4State({ payload = new Uint8Array([1, 2, 3, 4, 5]), announced = payload.length, gameId = "GTST01" } = {}) {
  const head = stateBytes({ gameId }).subarray(0, 32 + "Dolphin web".length);
  const ext = new Uint8Array(16);
  const ev = new DataView(ext.buffer);
  ev.setUint16(0, 1, true);
  ev.setUint16(2, 1, true);
  ev.setBigUint64(8, BigInt(announced), true);
  const block = new Uint8Array([payload.length << 4, ...payload]);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setInt32(0, block.length, true);
  return new Uint8Array([...head, ...ext, ...len, ...block]);
}

test("a save state is decompressed in full before it is trusted", () => {
  assert.equal(validateSaveStateData(makeStateFile()).payloadBytes, GC_STATE_SIZE);
  assert.equal(validateSaveStateData(makeStateFile({ compression: "none" })).compression, "none");
  // The review's cases: right game and version, then 48 or 49 bytes in all.
  const header48 = stateBytes({ versionString: "" }).subarray(0, 48);
  assert.doesNotThrow(() => checkSaveState(header48, "GTST01"), "the header alone looks fine");
  assert.throws(() => validateSaveStateData(header48), /extended header version 0 is unknown/);
  const tiny = tinyStateFile();
  assert.equal(tiny.byteLength, 49);
  assert.doesNotThrow(() => checkSaveState(tiny, "GTST01"));
  assert.throws(() => validateSaveStateData(tiny), /1 bytes, too small to hold the console's 24 MiB of RAM/);
  // A payload of the right size that does not start like State::DoState's.
  assert.throws(() => validateSaveStateData(makeStateFile({ mem1: 0x4000000 })), /MEM1 size 0x4000000/);
  assert.throws(() => validateSaveStateData(makeStateFile({ consoleFlag: 7 })), /console flag/);
  assert.throws(() => validateSaveStateData(lz4State({ announced: 9 })), /data ends after 5 of 9 bytes/);
  const truncated = lz4State();
  assert.throws(() => validateSaveStateData(truncated.subarray(0, truncated.length - 2)), /runs past the file/);
  const badOffset = lz4State({ payload: new Uint8Array([1, 2, 3]) });
  badOffset[badOffset.length - 4] = 0x11; // token: 1 literal then a match
  badOffset[badOffset.length - 2] = 0x09; // offset 9: before the output
  badOffset[badOffset.length - 1] = 0x00;
  assert.throws(() => validateSaveStateData(badOffset), /LZ4/);
});
