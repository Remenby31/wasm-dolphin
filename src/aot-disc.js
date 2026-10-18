// Locate the executable files of a GameCube disc image: the boot DOL and the
// REL modules of the file system. `read(offset, length)` returns (or resolves
// to) a Uint8Array; it is the only access to the disc, so the same code runs
// on a File in the browser and on a file descriptor in Node.

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

export const APPLOADER_ADDRESS = 0x81200000;
// Everything read from the disc is bounded: a hostile image must not make the
// analysis allocate or loop without limit. Main RAM is 24 MiB, so no
// executable of a real disc is larger.
export const MAX_EXECUTABLE_BYTES = 24 << 20;
export const MAX_FST_BYTES = 16 << 20;
export const MAX_RELS = 256;
export const MAX_REL_TOTAL_BYTES = 64 << 20;

export async function readDiscExecutables(read, { relFilter = (name) => /\.rel$/i.test(name) } = {}) {
  const header = await read(0, 0x440);
  const gameId = String.fromCharCode(...header.subarray(0, 6));
  const dolOffset = be32(header, 0x420);
  const fstOffset = be32(header, 0x424);
  const fstSize = be32(header, 0x428);

  const dolHeader = await read(dolOffset, 0x100);
  let dolSize = 0x100;
  for (let i = 0; i < 18; i++) {
    const off = be32(dolHeader, i * 4), size = be32(dolHeader, 0x90 + i * 4);
    if (size) dolSize = Math.max(dolSize, off + size);
  }
  if (dolSize > MAX_EXECUTABLE_BYTES) throw new Error(`boot DOL larger than ${MAX_EXECUTABLE_BYTES} bytes`);
  const dol = await read(dolOffset, dolSize);

  // Apploader: run by the boot sequence before the DOL, loaded at 0x81200000.
  let apploader = null;
  const appHeader = await read(0x2440, 0x20);
  const appEntry = be32(appHeader, 0x10), appSize = be32(appHeader, 0x14) + be32(appHeader, 0x18); // code + trailer
  if (appSize > 0 && appSize < 1 << 20 && appEntry >= APPLOADER_ADDRESS && appEntry < APPLOADER_ADDRESS + appSize) {
    apploader = { address: APPLOADER_ADDRESS, entry: appEntry, bytes: await read(0x2460, appSize) };
  }

  const rels = [];
  if (fstSize > 12 && fstSize <= MAX_FST_BYTES) {
    const fst = await read(fstOffset, fstSize);
    let total = 0;
    for (const file of walkFst(fst)) {
      if (!relFilter(file.path)) continue;
      // Oversized or excess modules are left to the JIT.
      if (rels.length >= MAX_RELS || file.size > MAX_EXECUTABLE_BYTES || total + file.size > MAX_REL_TOTAL_BYTES) continue;
      total += file.size;
      rels.push({ ...file, bytes: await read(file.offset, file.size) });
    }
  }
  return { gameId, dol, apploader, rels };
}

const MAX_NAME = 255;
const MAX_DEPTH = 32;

// Files of an FST: { path, offset, size }.
export function walkFst(fst) {
  if (fst.length < 12) return [];
  // The entry count is bounded by the table that has to hold the entries.
  const count = Math.min(be32(fst, 8), Math.floor(fst.length / 12));
  const stringBase = count * 12;
  const name = (off) => {
    let end = stringBase + off;
    const limit = Math.min(fst.length, end + MAX_NAME);
    while (end < limit && fst[end] !== 0) end++;
    return new TextDecoder("latin1").decode(fst.subarray(stringBase + off, end));
  };
  const out = [];
  const dirs = [{ end: count, prefix: "" }];
  for (let i = 1; i < count; i++) {
    while (dirs.length > 1 && i >= dirs[dirs.length - 1].end) dirs.pop();
    const e = i * 12;
    const word = be32(fst, e);
    const prefix = dirs[dirs.length - 1].prefix;
    const path = prefix + name(word & 0xffffff);
    if (word >>> 24) {
      // A directory ends after itself and inside its parent; depth is bounded.
      const end = Math.min(be32(fst, e + 8), dirs[dirs.length - 1].end);
      if (end > i + 1 && dirs.length < MAX_DEPTH) dirs.push({ end, prefix: `${path}/` });
    }
    else out.push({ path, offset: be32(fst, e + 4), size: be32(fst, e + 8) });
  }
  return out;
}
