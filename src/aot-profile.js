// Execution profile: guest code blocks seen executing in earlier sessions,
// kept in OPFS per disc and merged into the next plan. Only addresses are
// stored ([start, end) pairs), never guest bytes.
//
// File layout (little-endian): "SAOTPRF1", u32 version=1, u32 sessions,
// u32 count, then count x (u32 start, u32 end), ascending, disjoint.

export const PROFILE_MAGIC = "SAOTPRF1";
export const PROFILE_VERSION = 1;
export const PROFILE_DIR = "aot-profile";
// A profile larger than this is truncated on merge (the plan stays a hint).
export const PROFILE_MAX_RANGES = 1 << 20;

// Normalise [start, end) pairs: drop empty or misaligned ones, sort, merge overlaps.
export function normalizeRanges(pairs) {
  const list = [];
  for (const [s, e] of pairs) {
    const start = s >>> 0, end = e >>> 0;
    if (end > start && !(start & 3) && !(end & 3)) list.push([start, end]);
  }
  list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]); // adjacent blocks stay separate: each start is an entry
    else out.push([r[0], r[1]]);
  }
  return out.length > PROFILE_MAX_RANGES ? out.slice(0, PROFILE_MAX_RANGES) : out;
}

export function mergeProfiles(a, b) {
  return {
    sessions: (a?.sessions ?? 0) + (b?.sessions ?? 0),
    blocks: normalizeRanges([...(a?.blocks ?? []), ...(b?.blocks ?? [])])
  };
}

export function encodeProfile({ sessions = 0, blocks }) {
  const ranges = normalizeRanges(blocks);
  const out = new Uint8Array(8 + 12 + ranges.length * 8);
  out.set(new TextEncoder().encode(PROFILE_MAGIC), 0);
  const v = new DataView(out.buffer);
  v.setUint32(8, PROFILE_VERSION, true);
  v.setUint32(12, sessions >>> 0, true);
  v.setUint32(16, ranges.length, true);
  ranges.forEach(([s, e], i) => { v.setUint32(20 + i * 8, s, true); v.setUint32(24 + i * 8, e, true); });
  return out;
}

export function decodeProfile(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < 20 || new TextDecoder().decode(u8.subarray(0, 8)) !== PROFILE_MAGIC) return null;
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (v.getUint32(8, true) !== PROFILE_VERSION) return null;
  const count = v.getUint32(16, true);
  if (20 + count * 8 !== u8.byteLength) return null;
  const blocks = [];
  for (let i = 0; i < count; i++) blocks.push([v.getUint32(20 + i * 8, true), v.getUint32(24 + i * 8, true)]);
  return { sessions: v.getUint32(12, true), blocks: normalizeRanges(blocks) };
}

// Profile key: one file per disc identity (hex string, e.g. the disc
// fingerprint the JIT cache uses). Restricted so it is a safe file name.
function fileName(discKey) {
  const key = String(discKey);
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(key)) throw new Error("aot-profile: invalid disc key");
  return `${key}.bin`;
}

// OPFS-backed store. `root` is a FileSystemDirectoryHandle (navigator.storage.getDirectory()).
export class AotProfileStore {
  constructor(root) {
    this.root = root;
  }

  static async open() {
    return new AotProfileStore(await globalThis.navigator.storage.getDirectory());
  }

  async dir() {
    return this.root.getDirectoryHandle(PROFILE_DIR, { create: true });
  }

  async load(discKey) {
    try {
      const handle = await (await this.dir()).getFileHandle(fileName(discKey));
      const file = await handle.getFile();
      return decodeProfile(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      if (error?.name === "NotFoundError") return null;
      throw error;
    }
  }

  // Merge the blocks of the session that just ran into the stored profile.
  async record(discKey, blocks) {
    const merged = mergeProfiles(await this.load(discKey), { sessions: 1, blocks });
    const handle = await (await this.dir()).getFileHandle(fileName(discKey), { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(encodeProfile(merged));
      await writable.close();
    } catch (error) {
      await writable.abort?.();
      throw error;
    }
    return merged;
  }

  async clear(discKey) {
    try {
      await (await this.dir()).removeEntry(fileName(discKey));
    } catch (error) {
      if (error?.name !== "NotFoundError") throw error;
    }
  }
}

// Block list from the core: flat u32 pairs (start, length in bytes), e.g. a
// dump of the JIT block cache. Turned into [start, end) ranges.
export function blocksFromCoreDump(u32) {
  const out = [];
  for (let i = 0; i + 1 < u32.length; i += 2) out.push([u32[i], u32[i] + u32[i + 1]]);
  return normalizeRanges(out);
}

// Block starts from a PC histogram (sampler). Each sampled PC becomes a
// one-instruction range: discovery grows it into the full block.
export function blocksFromPcSamples(pcs) {
  return normalizeRanges([...pcs].map((pc) => [pc, pc + 4]));
}
