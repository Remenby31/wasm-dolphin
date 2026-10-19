// Per-game hint sheets for ahead-of-time discovery: optional, data only.
// A sheet names addresses (extra entry points, ranges that are not code,
// jump tables discovery cannot bound, dynamic code) for one exact DOL. It
// never contains guest bytes or code: the parser accepts numbers, address
// ranges and short notes, and rejects anything else.
//
// No sheet for a commercial game is published in this repository; users load
// their own (file picker or URL) and the format is documented in docs/aot-plan.md.

export const HINTS_SCHEMA = "salon-aot-hints/1";
const MAX_ITEMS = 65536;
const MAX_NOTE = 120;
const KEYS = new Set(["schema", "name", "match", "entryPoints", "notCode", "jumpTables", "dynamicCode", "notes"]);

const isAddr = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff && (v & 3) === 0;
// Addresses may be written as numbers or "0x8000abcd" strings.
function addr(v, where) {
  const n = typeof v === "string" && /^0x[0-9a-fA-F]{1,8}$/.test(v) ? parseInt(v, 16) : v;
  if (!isAddr(n)) throw new Error(`aot-hints: ${where} is not a word-aligned 32-bit address`);
  return n >>> 0;
}
function list(v, where) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_ITEMS) throw new Error(`aot-hints: ${where} must be an array of at most ${MAX_ITEMS} items`);
  return v;
}
function range(v, where) {
  if (!Array.isArray(v) || v.length !== 2) throw new Error(`aot-hints: ${where} must be [start, end]`);
  const s = addr(v[0], where), e = addr(v[1], where);
  if (e <= s) throw new Error(`aot-hints: ${where} is empty`);
  return [s, e];
}
function note(v, where) {
  if (v === undefined) return null;
  if (typeof v !== "string" || v.length > MAX_NOTE) throw new Error(`aot-hints: ${where} must be a string of at most ${MAX_NOTE} characters`);
  return v;
}

// Parse and validate a sheet (JSON text or object). Returns a normalised copy.
export function parseHints(input) {
  const raw = typeof input === "string" ? JSON.parse(input) : input;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("aot-hints: not an object");
  if (raw.schema !== HINTS_SCHEMA) throw new Error(`aot-hints: schema ${raw.schema} unsupported`);
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) throw new Error(`aot-hints: unknown field ${k}`);
  const match = raw.match;
  if (!match || typeof match !== "object") throw new Error("aot-hints: match is required");
  if (typeof match.gameId !== "string" || !/^[0-9A-Z]{6}$/.test(match.gameId)) throw new Error("aot-hints: match.gameId must be a 6-character disc ID");
  if (typeof match.dolHash !== "string" || !/^[0-9a-f]{16}$/.test(match.dolHash)) throw new Error("aot-hints: match.dolHash must be the 16-hex FNV-1a 64 of the DOL");
  return {
    schema: HINTS_SCHEMA,
    name: note(raw.name, "name"),
    match: { gameId: match.gameId, dolHash: match.dolHash },
    entryPoints: list(raw.entryPoints, "entryPoints").map((v, i) => addr(v, `entryPoints[${i}]`)),
    notCode: list(raw.notCode, "notCode").map((v, i) => range(v, `notCode[${i}]`)),
    jumpTables: list(raw.jumpTables, "jumpTables").map((t, i) => {
      if (!t || typeof t !== "object") throw new Error(`aot-hints: jumpTables[${i}] must be an object`);
      const count = t.count;
      if (!Number.isInteger(count) || count < 1 || count > 4096) throw new Error(`aot-hints: jumpTables[${i}].count must be 1..4096`);
      const kind = t.kind ?? "abs";
      if (kind !== "abs" && kind !== "rel") throw new Error(`aot-hints: jumpTables[${i}].kind must be "abs" or "rel"`);
      return { site: addr(t.site, `jumpTables[${i}].site`), table: addr(t.table, `jumpTables[${i}].table`), count, kind };
    }),
    dynamicCode: list(raw.dynamicCode, "dynamicCode").map((v, i) => range(v, `dynamicCode[${i}]`)),
    notes: note(raw.notes, "notes")
  };
}

// Does the sheet apply to this disc? Hints for another build are ignored.
export function hintsMatch(hints, { gameId, dolHash }) {
  return Boolean(hints && hints.match.gameId === gameId && hints.match.dolHash === dolHash);
}

// Load a sheet from a File/Blob (file picker) or a URL. Returns null when it
// does not match the disc; throws when it is malformed.
export async function loadHints(source, disc, { fetchImpl = globalThis.fetch } = {}) {
  let text;
  if (typeof source === "string") {
    const response = await fetchImpl(source);
    if (!response.ok) throw new Error(`aot-hints: ${response.status} fetching hints`);
    text = await response.text();
  } else {
    text = await source.text();
  }
  if (text.length > 4 << 20) throw new Error("aot-hints: sheet larger than 4 MiB");
  const hints = parseHints(text);
  return hintsMatch(hints, disc) ? hints : null;
}
