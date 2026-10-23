// Execution profile: guest code blocks seen executing in earlier sessions,
// kept in OPFS per disc and merged into the next plan. Only addresses and
// counts are stored, never guest bytes. It stays on the player's machine:
// nothing reads it but this origin's plan, and it is never sent or shared
// (a shared profile for a commercial disc was set aside: the hint-sheet
// policy, aot-hints.js).
//
// A block is [start, end, seen, flags, weight]: `seen` counts the sessions
// that ran it (saturating at 0xffff), flags bit0 = real mode (address
// translation off), `weight` the guest-PC samples taken in it (version 3;
// halved at each new session, so it follows what the player runs now).
//
// File layout (little-endian): "SAOTPRF2", u32 version=3, u32 sessions,
// 8 bytes gameId (ASCII, zero padded), 8 bytes dolHash (FNV-1a 64, big-endian),
// u32 count, then count x (u32 start, u32 end, u16 seen, u16 flags, u32
// weight), ascending by start. Version 2 (no weight, 12-byte entries) reads
// with weight 0.

export const PROFILE_MAGIC = "SAOTPRF2";
export const PROFILE_VERSION = 3;
export const PROFILE_DIR = "aot-profile";
export const PROFILE_REAL_MODE = 1;
// Beyond this many blocks the least seen are dropped (ties: the most recently
// added are kept last); 1 M blocks is ~40x what a long play session runs.
export const PROFILE_MAX_RANGES = 1 << 20;
const HEADER = 8 + 4 + 4 + 8 + 8 + 4;
const ENTRY = 16;
const ENTRY_V2 = 12;
const MAX_WEIGHT = 0xffffffff;

// Normalise blocks: drop empty or misaligned ones, sort, merge overlapping
// blocks of the same mode (adjacent blocks stay separate: each start is an
// entry). `seen` of a merged block is the largest of its parts.
export function normalizeRanges(blocks, { max = PROFILE_MAX_RANGES } = {}) {
  const list = [];
  for (const b of blocks) {
    const start = b[0] >>> 0, end = b[1] >>> 0;
    if (end > start && !(start & 3) && !(end & 3)) list.push([start, end, Math.min(b[2] ?? 1, 0xffff), (b[3] ?? 0) & 0xffff, Math.min(Math.max(0, Math.round(b[4] ?? 0)), MAX_WEIGHT)]);
  }
  list.sort((a, b) => a[0] - b[0] || a[3] - b[3] || a[1] - b[1]);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r[3] === last[3] && r[0] < last[1]) {
      last[1] = Math.max(last[1], r[1]);
      last[2] = Math.max(last[2], r[2]);
      last[4] = Math.min(last[4] + r[4], MAX_WEIGHT);
    } else {
      out.push(r);
    }
  }
  return out.length > max ? truncate(out, max) : out;
}

// Keep the `max` most seen blocks, in address order.
function truncate(blocks, max) {
  const keep = blocks.map((b, i) => [b[2], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, max).map(([, i]) => i).sort((a, b) => a - b);
  return keep.map((i) => blocks[i]);
}

// Merge a stored profile with the blocks of one session: blocks seen again
// gain one in `seen`. Weights: the stored ones halve when the session is a
// new one (sessions > 0), and the session's add up; a periodic record of
// the same session (sessions 0) only adds.
export function mergeProfiles(stored, session) {
  const key = (b) => `${b[0]}:${b[3] ?? 0}`;
  const decay = (session?.sessions ?? 0) > 0 ? 0.5 : 1;
  const prior = new Map((stored?.blocks ?? []).map((b) => [key(b), b]));
  const fresh = (session?.blocks ?? []).map((b) => {
    const old = prior.get(key(b));
    const seen = (session?.sessions ?? 0) > 0 ? Math.min((old?.[2] ?? 0) + (b[2] ?? 1), 0xffff) : Math.max(old?.[2] ?? 0, b[2] ?? 1);
    return [b[0], b[1], seen, b[3] ?? 0, Math.floor((old?.[4] ?? 0) * decay) + (b[4] ?? 0)];
  });
  const freshKeys = new Set(fresh.map(key));
  const kept = (stored?.blocks ?? []).filter((b) => !freshKeys.has(key(b))).map((b) => [b[0], b[1], b[2], b[3], Math.floor((b[4] ?? 0) * decay)]);
  return {
    gameId: session?.gameId ?? stored?.gameId ?? null,
    dolHash: session?.dolHash ?? stored?.dolHash ?? null,
    sessions: (stored?.sessions ?? 0) + (session?.sessions ?? 0),
    blocks: normalizeRanges([...kept, ...fresh])
  };
}

export function encodeProfile({ sessions = 0, gameId = null, dolHash = null, blocks }) {
  const ranges = normalizeRanges(blocks);
  const out = new Uint8Array(HEADER + ranges.length * ENTRY);
  out.set(new TextEncoder().encode(PROFILE_MAGIC), 0);
  const v = new DataView(out.buffer);
  v.setUint32(8, PROFILE_VERSION, true);
  v.setUint32(12, sessions >>> 0, true);
  if (gameId) out.set(new TextEncoder().encode(String(gameId).slice(0, 8)), 16);
  if (dolHash) {
    if (!/^[0-9a-f]{16}$/.test(dolHash)) throw new Error("aot-profile: dolHash must be 16 hex digits");
    for (let i = 0; i < 8; i++) out[24 + i] = parseInt(dolHash.slice(i * 2, i * 2 + 2), 16);
  }
  v.setUint32(32, ranges.length, true);
  ranges.forEach(([s, e, seen, flags, weight], i) => {
    const o = HEADER + i * ENTRY;
    v.setUint32(o, s, true); v.setUint32(o + 4, e, true); v.setUint16(o + 8, seen, true); v.setUint16(o + 10, flags, true); v.setUint32(o + 12, weight >>> 0, true);
  });
  return out;
}

export function decodeProfile(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < HEADER || new TextDecoder().decode(u8.subarray(0, 8)) !== PROFILE_MAGIC) return null;
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = v.getUint32(8, true);
  if (version !== PROFILE_VERSION && version !== 2) return null;
  const entry = version === 2 ? ENTRY_V2 : ENTRY;
  const count = v.getUint32(32, true);
  if (count > PROFILE_MAX_RANGES || HEADER + count * entry !== u8.byteLength) return null;
  const id = u8.subarray(16, 24);
  const gameId = id[0] ? new TextDecoder("latin1").decode(id.subarray(0, id.indexOf(0) < 0 ? 8 : id.indexOf(0))) : null;
  const hashBytes = u8.subarray(24, 32);
  const dolHash = hashBytes.some((b) => b) ? Array.from(hashBytes, (b) => b.toString(16).padStart(2, "0")).join("") : null;
  const blocks = [];
  for (let i = 0; i < count; i++) {
    const o = HEADER + i * entry;
    blocks.push([v.getUint32(o, true), v.getUint32(o + 4, true), v.getUint16(o + 8, true), v.getUint16(o + 10, true), version === 2 ? 0 : v.getUint32(o + 12, true)]);
  }
  return { sessions: v.getUint32(12, true), gameId, dolHash, blocks: normalizeRanges(blocks) };
}

// Profile key: one file per disc identity (e.g. the disc fingerprint the JIT
// cache uses). Restricted so it is a safe file name.
function fileName(discKey) {
  const key = String(discKey);
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(key)) throw new Error("aot-profile: invalid disc key");
  return `${key}.bin`;
}

// OPFS-backed store. `root` is a FileSystemDirectoryHandle
// (navigator.storage.getDirectory()); `locks` a LockManager (navigator.locks),
// so two tabs recording the same disc do not lose each other's sessions.
export class AotProfileStore {
  constructor(root, { locks = globalThis.navigator?.locks ?? null } = {}) {
    this.root = root;
    this.locks = locks;
  }

  static async open() {
    return new AotProfileStore(await globalThis.navigator.storage.getDirectory());
  }

  async dir() {
    return this.root.getDirectoryHandle(PROFILE_DIR, { create: true });
  }

  async locked(discKey, fn) {
    if (!this.locks) return fn();
    return this.locks.request(`salon-aot-profile:${fileName(discKey)}`, fn);
  }

  // The stored profile, or null when absent, unreadable or recorded for
  // another DOL (same key, different game build).
  async load(discKey, { gameId = null, dolHash = null } = {}) {
    let profile;
    try {
      const handle = await (await this.dir()).getFileHandle(fileName(discKey));
      profile = decodeProfile(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
    } catch (error) {
      if (error?.name === "NotFoundError") return null;
      throw error;
    }
    if (!profile) return null;
    if ((gameId && profile.gameId && profile.gameId !== gameId) || (dolHash && profile.dolHash && profile.dolHash !== dolHash)) return null;
    return profile;
  }

  // Merge the blocks of the session that just ran into the stored profile.
  // A stored profile of another DOL is replaced. newSession: false for a
  // periodic record of a session already counted (weights add, no decay).
  async record(discKey, blocks, { gameId = null, dolHash = null, newSession = true } = {}) {
    return this.locked(discKey, async () => {
      const stored = await this.load(discKey, { gameId, dolHash });
      const merged = mergeProfiles(stored, { sessions: newSession ? 1 : 0, gameId, dolHash, blocks: normalizeRanges(blocks) });
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
    });
  }

  async clear(discKey) {
    return this.locked(discKey, async () => {
      try {
        await (await this.dir()).removeEntry(fileName(discKey));
      } catch (error) {
        if (error?.name !== "NotFoundError") throw error;
      }
    });
  }
}

// Block list from the core (_DolphinWeb_JitDumpBlocks): u32 triplets
// (start, PPC byte length, flags); flags bit2 = real mode. Blocks never
// executed (bit0 clear) are skipped.
export const DUMP_EXECUTED = 1;
export const DUMP_REAL_MODE = 4;
export function blocksFromCoreDump(u32) {
  const out = [];
  for (let i = 0; i + 2 < u32.length; i += 3) {
    const flags = u32[i + 2];
    if (!(flags & DUMP_EXECUTED)) continue;
    out.push([u32[i], u32[i] + u32[i + 1], 1, flags & DUMP_REAL_MODE ? PROFILE_REAL_MODE : 0]);
  }
  return normalizeRanges(out);
}

// Block starts from a PC sampler. Each sampled PC becomes a one-instruction
// block: discovery grows it into the full block. `realMode(pc)` tells which
// samples were taken with translation off (default: below 0x80000000).
// `pcs`: PCs, or [pc, samples] pairs (the samples become the block's weight).
export function blocksFromPcSamples(pcs, { realMode = (pc) => pc < 0x80000000 } = {}) {
  return normalizeRanges([...pcs].map((x) => {
    const [pc, n] = Array.isArray(x) ? x : [x, 0];
    return [pc, pc + 4, 1, realMode(pc) ? PROFILE_REAL_MODE : 0, n];
  }));
}
