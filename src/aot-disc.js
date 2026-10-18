// Locate the executable files of a GameCube disc image: the boot DOL and the
// REL modules of the file system. `read(offset, length)` returns (or resolves
// to) a Uint8Array; it is the only access to the disc, so the same code runs
// on a File in the browser and on a file descriptor in Node.

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

export const APPLOADER_ADDRESS = 0x81200000;

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
  const dol = await read(dolOffset, dolSize);

  // Apploader: run by the boot sequence before the DOL, loaded at 0x81200000.
  let apploader = null;
  const appHeader = await read(0x2440, 0x20);
  const appEntry = be32(appHeader, 0x10), appSize = be32(appHeader, 0x14) + be32(appHeader, 0x18); // code + trailer
  if (appSize > 0 && appSize < 1 << 20 && appEntry >= APPLOADER_ADDRESS && appEntry < APPLOADER_ADDRESS + appSize) {
    apploader = { address: APPLOADER_ADDRESS, entry: appEntry, bytes: await read(0x2460, appSize) };
  }

  const rels = [];
  if (fstSize > 12 && fstSize < 64 << 20) {
    const fst = await read(fstOffset, fstSize);
    for (const file of walkFst(fst)) {
      if (relFilter(file.path)) rels.push({ ...file, bytes: await read(file.offset, file.size) });
    }
  }
  return { gameId, dol, apploader, rels };
}

// Files of an FST: { path, offset, size }.
export function walkFst(fst) {
  const count = be32(fst, 8);
  const stringBase = count * 12;
  const name = (off) => {
    let end = stringBase + off;
    while (end < fst.length && fst[end] !== 0) end++;
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
    if (word >>> 24) dirs.push({ end: be32(fst, e + 8), prefix: `${path}/` });
    else out.push({ path, offset: be32(fst, e + 4), size: be32(fst, e + 8) });
  }
  return out;
}
