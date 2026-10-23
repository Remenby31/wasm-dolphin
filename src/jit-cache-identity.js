// Persistent PPC->WASM cache identity. These domains are part of the storage
// contract: changing either requires an IndexedDB/prebuilt format migration.
export const JIT_CACHE_ENTRY_KEY_SCHEMA = "wasm-block-sha256-v1";
export const JIT_CACHE_CORE_FINGERPRINT_SCHEMA = "dolphin-core-sha256-v1";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("JIT cache payload must be an ArrayBuffer or typed array");
}

export async function sha256Hex(value) {
  const bytes = asBytes(value);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function canonicalWasmBlockKey(bytes) {
  return `${JIT_CACHE_ENTRY_KEY_SCHEMA}:${await sha256Hex(bytes)}`;
}

export async function verifyCanonicalWasmBlockKey(claimedKey, bytes) {
  if (typeof claimedKey !== "string") return false;
  const prefix = `${JIT_CACHE_ENTRY_KEY_SCHEMA}:`;
  if (!claimedKey.startsWith(prefix) || !SHA256_HEX_RE.test(claimedKey.slice(prefix.length))) {
    return false;
  }
  return claimedKey === await canonicalWasmBlockKey(bytes);
}

export function canonicalCoreFingerprint(verifiedSha256) {
  const normalized = String(verifiedSha256 || "").toLowerCase();
  if (!SHA256_HEX_RE.test(normalized)) {
    throw new Error("Core fingerprint requires an exact verified SHA-256 digest");
  }
  return `${JIT_CACHE_CORE_FINGERPRINT_SCHEMA}:${normalized}`;
}

export function classifyJitCacheIdentity({
  storedFingerprint,
  storedEntryKeySchema,
  currentFingerprint
}) {
  if (!currentFingerprint) return { reset: true, reason: "missing-current-fingerprint" };
  if (!storedFingerprint) return { reset: true, reason: "missing-stored-fingerprint" };
  if (storedFingerprint !== currentFingerprint) return { reset: true, reason: "fingerprint-mismatch" };
  if (!storedEntryKeySchema) return { reset: true, reason: "missing-entry-key-schema" };
  if (storedEntryKeySchema !== JIT_CACHE_ENTRY_KEY_SCHEMA) {
    return { reset: true, reason: "entry-key-schema-mismatch" };
  }
  return { reset: false, reason: "match" };
}


// Ahead-of-time region cache (plan piste 3, P6). An entry is trusted only
// under the exact (disc, core, compiler, JIT flags) it was compiled for: the
// four make up the cache's identity, and the cache's name is derived from it,
// so a mismatch on any of them never even opens the same cache.
export const AOT_DISC_KEY_SCHEMA = "disc-sha256-v1";
// A booted .dol (no disc; e.g. a homebrew): its own namespace, the SHA-256 of
// the whole file, so it never meets a disc's key.
export const AOT_DOL_KEY_SCHEMA = "dol-sha256-v1";
export const AOT_CACHE_SCHEMA = "salon-aot-v1";
export const AOT_CACHE_NAME_PREFIX = "salon-aot-v1-";
// Blocks are content-addressed (their key is the SHA-256 of their bytes), so
// one block store serves every disc of a core.
export const AOT_ANY_DISC_KEY = `${AOT_DISC_KEY_SCHEMA}:any`;

const DISC_HEADER_BYTES = 0x440;
const DISC_KEY_RE = /^(?:disc-sha256-v1:(?:[0-9a-f]{64}|any)|dol-sha256-v1:[0-9a-f]{64})$/;
const COMPILER_VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;
// Entry keys travel in URLs and file names: no "/", "?", "#" or "%".
const AOT_ENTRY_KEY_RE = /^[A-Za-z0-9._:+-]{1,200}$/;

function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

// SHA-256 of the disc header (0x440 bytes), the boot DOL and the FST: what
// the console boots from, readable in a few reads without hashing the image.
// RELs and the apploader are left out; every region is verified against its
// own fingerprint before use, so a stale entry is rejected, never run.
export async function canonicalDiscKey({ header, dol, fst }) {
  const h = asBytes(header);
  if (h.byteLength !== DISC_HEADER_BYTES) throw new Error(`disc key needs the ${DISC_HEADER_BYTES}-byte disc header`);
  return `${AOT_DISC_KEY_SCHEMA}:${await sha256Hex(concatBytes([h, asBytes(dol), asBytes(fst)]))}`;
}

// The key of a booted .dol: the SHA-256 of the file.
export async function canonicalDolKey(dol) {
  return `${AOT_DOL_KEY_SCHEMA}:${await sha256Hex(asBytes(dol))}`;
}

// The hex part alone, for names that only accept [0-9A-Za-z_-].
export function discKeyHex(discKey) {
  const key = String(discKey || "");
  if (!DISC_KEY_RE.test(key)) throw new Error(`not a disc key: ${key || "<missing>"}`);
  return key.slice(key.indexOf(":") + 1);
}

export function isAotEntryKey(key) {
  return typeof key === "string" && AOT_ENTRY_KEY_RE.test(key);
}

// coreHash: the verified core SHA-256, bare or as canonicalCoreFingerprint().
export function aotCacheIdentity({ discKey, coreHash, compilerVersion, flagsMask }) {
  if (!DISC_KEY_RE.test(String(discKey || ""))) throw new Error("AOT cache identity requires a disc key");
  const core = String(coreHash || "").toLowerCase();
  const coreFingerprint = core.startsWith(`${JIT_CACHE_CORE_FINGERPRINT_SCHEMA}:`) ? core : canonicalCoreFingerprint(core);
  canonicalCoreFingerprint(coreFingerprint.slice(JIT_CACHE_CORE_FINGERPRINT_SCHEMA.length + 1));
  if (!COMPILER_VERSION_RE.test(String(compilerVersion || ""))) throw new Error("AOT cache identity requires a compiler version");
  if (!Number.isInteger(flagsMask) || flagsMask < 0 || flagsMask > 0xffffffff) {
    throw new Error("AOT cache identity requires a 32-bit JIT flags mask");
  }
  return {
    schema: AOT_CACHE_SCHEMA,
    discKey: String(discKey),
    coreFingerprint,
    compilerVersion: String(compilerVersion),
    flagsMask
  };
}

export function aotIdentityString(identity) {
  const { schema, discKey, coreFingerprint, compilerVersion, flagsMask } = identity;
  return JSON.stringify({ schema, discKey, coreFingerprint, compilerVersion, flagsMask });
}

export async function aotCacheName(identity) {
  const digest = await sha256Hex(new TextEncoder().encode(aotIdentityString(identity)));
  return `${AOT_CACHE_NAME_PREFIX}${digest.slice(0, 40)}`;
}

// The identity stored in a cache against the one asked for. The name already
// encodes it; this catches a cache whose stored identity was lost or edited.
export function classifyAotCacheIdentity({ stored, current }) {
  if (!current) return { reset: true, reason: "missing-current-identity" };
  if (!stored) return { reset: true, reason: "missing-stored-identity" };
  for (const field of ["schema", "discKey", "coreFingerprint", "compilerVersion", "flagsMask"]) {
    if (stored[field] !== current[field]) return { reset: true, reason: `${field}-mismatch` };
  }
  return { reset: false, reason: "match" };
}
