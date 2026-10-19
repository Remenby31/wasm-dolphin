import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { CONF_POINTER, CONF_PROFILE } from "../src/aot-discovery.js";
import { walkFst } from "../src/aot-disc.js";
import {
  AotProfileStore, blocksFromCoreDump, blocksFromPcSamples, decodeProfile, encodeProfile, mergeProfiles, normalizeRanges
} from "../src/aot-profile.js";
import { hintsMatch, loadHints, parseHints } from "../src/aot-hints.js";
import { imageFromDol } from "../src/aot-image.js";
import {
  PLAN_BINARY_MAGIC, PLAN_SCHEMA, encodePlanRegions, fnv1a64Hex, orderedRegions, planDol, regionHash, validatePlan
} from "../src/aot-plan.js";
import { planDisc } from "../src/aot-recomp.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";

const TEXT = 0x80003100;

// entry calls f; `hidden` is only reached through a register loaded from
// memory at run time, so only a profile or a hint can reveal it.
function program() {
  const t = assemble(TEXT, [
    "entry", (pc, l) => asm.bl(pc, l.f), asm.lwz(12, 13, -0x100), asm.mtctr(12), asm.bctrl(), asm.blr(),
    "f", asm.li(3, 1), asm.blr(),
    "hidden", asm.li(3, 9), asm.addi(3, 3, 1), asm.blr()
  ]);
  return { dol: buildDol({ textAddr: TEXT, text: t.words, entry: t.labels.entry }), l: t.labels };
}

test("aot plan: FNV-1a 64 reference vectors", () => {
  assert.equal(fnv1a64Hex(new Uint8Array()), "cbf29ce484222325");
  assert.equal(fnv1a64Hex(new TextEncoder().encode("a")), "af63dc4c8601ec8c");
  assert.equal(fnv1a64Hex(new TextEncoder().encode("foobar")), "85944171f73967e8");
});

test("aot plan: regions carry ranges and a fingerprint that follows the code", () => {
  const { dol, l } = program();
  const { image, entryPoint } = imageFromDol(dol);
  const plan = validatePlan(planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } }));
  assert.equal(plan.schema, PLAN_SCHEMA);
  const [m] = plan.modules;
  const f = m.functions.find((x) => x.entry === l.f);
  assert.deepEqual(f.ranges, [[l.f, l.f + 8]]);
  assert.equal(f.hash, regionHash((a) => image.read32(a), f.ranges));
  assert.match(f.sha256, /^[0-9a-f]{64}$/);
  assert.equal(f.sha256, createHash("sha256").update(Buffer.from([0x38, 0x60, 0x00, 0x01, 0x4e, 0x80, 0x00, 0x20])).digest("hex"), "sha256 of li r3,1; blr");
  // Same ranges over modified memory: another fingerprint, so the region is dropped.
  const patched = (a) => (a === l.f ? asm.li(3, 2) : image.read32(a));
  assert.notEqual(regionHash(patched, f.ranges), f.hash);
  assert.ok(!m.functions.some((x) => x.entry === l.hidden), "unreachable without profile");
  assert.equal(m.indirectSites.find((s) => s.kind === "bctrl").resolved, null, "a register loaded from memory is left to the JIT");

  const bin = encodePlanRegions(plan);
  assert.equal(new TextDecoder().decode(bin.subarray(0, 8)), PLAN_BINARY_MAGIC);
  const v = new DataView(bin.buffer);
  assert.equal(v.getUint32(12, true), m.functions.length);
});

test("aot plan: rejects malformed plans", () => {
  const { dol } = program();
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint });
  assert.throws(() => validatePlan({ ...plan, schema: "x" }), /schema/);
  const broken = structuredClone(plan);
  broken.modules[0].blocks.end[0] = broken.modules[0].blocks.start[0];
  assert.throws(() => validatePlan(broken), /bad block/);
});

test("aot profile: blocks from a previous session become entries; real-mode code stays dynamic", () => {
  const { dol, l } = program();
  const { image, entryPoint } = imageFromDol(dol);
  // Core dump triplets (start, length, flags): executed, executed in real mode, compiled but never run.
  const dump = new Uint32Array([l.hidden, 12, 1, 0x00000500, 0x100, 1 | 4, l.f, 8, 2]);
  const profile = { sessions: 1, blocks: blocksFromCoreDump(dump) };
  assert.equal(profile.blocks.length, 2, "never-executed blocks are not profiled");
  const plan = validatePlan(planDol({ image, entryPoint, profile, options: { gapFill: false } }));
  const f = plan.modules[0].functions.find((x) => x.entry === l.hidden);
  assert.equal(f.confidence, CONF_PROFILE);
  assert.deepEqual(f.sources, ["profile"]);
  assert.equal(f.profileHits, 1);
  assert.deepEqual(plan.dynamic, [{ start: 0x500, end: 0x600, mode: "real", source: "profile" }]);
});

test("aot profile: a block inside a known function does not split it (review P1-1)", () => {
  const { dol, l } = program();
  const { image, entryPoint } = imageFromDol(dol);
  const base = planDol({ image, entryPoint, options: { gapFill: false } }).modules[0];
  // Interpreter-like sampler: every instruction of the program seen.
  const pcs = [];
  for (let a = TEXT; a < l.hidden; a += 4) pcs.push(a);
  const withProfile = planDol({ image, entryPoint, profile: { sessions: 1, blocks: blocksFromPcSamples(pcs) }, options: { gapFill: false } }).modules[0];
  assert.deepEqual(withProfile.functions.map((f) => f.entry), base.functions.map((f) => f.entry));
  assert.deepEqual(withProfile.blocks.start, base.blocks.start);
  assert.ok(withProfile.functions.find((f) => f.entry === l.f).profileHits > 0, "the hits still count for ordering");
});

test("aot profile: a profile block that decodes as junk is not trusted", () => {
  const t = assemble(TEXT, ["entry", asm.blr(), "junk", 0x07000000, asm.blr()]);
  const dol = buildDol({ textAddr: TEXT, text: t.words, entry: t.labels.entry });
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, profile: { sessions: 1, blocks: [[t.labels.junk, t.labels.junk + 4]] }, options: { gapFill: false } });
  assert.ok(!plan.modules[0].blocks.start.includes(t.labels.junk));
});

test("aot profile: binary round trip, identity, merge counts and truncation", () => {
  const p = { sessions: 2, gameId: "TEST01", dolHash: "0123456789abcdef", blocks: [[0x80003100, 0x80003110, 2, 0], [0x80003110, 0x80003120, 1, 0], [0x80004000, 0x80004008, 1, 0], [0x500, 0x600, 1, 1]] };
  const back = decodeProfile(encodeProfile(p));
  assert.deepEqual(back, { ...p, blocks: [[0x500, 0x600, 1, 1], ...p.blocks.slice(0, 3)] }, "adjacent blocks keep their own start");
  assert.equal(decodeProfile(new Uint8Array(30)), null);
  const merged = mergeProfiles(p, { sessions: 1, blocks: [[0x80004000, 0x80004008], [0x80005000, 0x80005004]] });
  assert.equal(merged.sessions, 3);
  assert.deepEqual(merged.blocks.find((b) => b[0] === 0x80004000), [0x80004000, 0x80004008, 2, 0], "seen again: one more session");
  const many = Array.from({ length: 10 }, (_, i) => [0x80003000 + i * 8, 0x80003004 + i * 8, i === 7 ? 5 : 1, 0]);
  const kept = normalizeRanges(many, { max: 3 });
  assert.equal(kept.length, 3);
  assert.ok(kept.some((b) => b[0] === 0x80003038), "the most seen block survives truncation");
});

test("aot profile: OPFS store is keyed, locked and refuses another DOL", async () => {
  const lockNames = [];
  const locks = { request: async (name, fn) => { lockNames.push(name); return fn(); } };
  const store = new AotProfileStore(fakeOpfs(), { locks });
  const id = { gameId: "TEST01", dolHash: "0123456789abcdef" };
  assert.equal(await store.load("abc", id), null);
  await store.record("abc", [[0x80003100, 0x80003110]], id);
  const second = await store.record("abc", [[0x80004000, 0x80004004]], id);
  assert.equal(second.sessions, 2);
  assert.deepEqual((await store.load("abc", id)).blocks.map((b) => b[0]), [0x80003100, 0x80004000]);
  assert.equal(await store.load("abc", { ...id, dolHash: "fedcba9876543210" }), null, "another build of the game");
  const replaced = await store.record("abc", [[0x80006000, 0x80006004]], { ...id, dolHash: "fedcba9876543210" });
  assert.equal(replaced.sessions, 1, "a profile of another DOL is replaced, not merged");
  assert.ok(lockNames.length >= 3 && lockNames.every((n) => n === "salon-aot-profile:abc.bin"));
  await assert.rejects(store.load("../x"), /invalid disc key/);
  await store.clear("abc");
  assert.equal(await store.load("abc"), null);
});

test("aot hints: data-only sheet, matched to one DOL, adds entries and excludes ranges", async () => {
  const { dol, l } = program();
  const dolHash = fnv1a64Hex(dol);
  const sheet = {
    schema: "salon-aot-hints/1",
    name: "test sheet",
    match: { gameId: "TEST01", dolHash },
    entryPoints: [`0x${l.hidden.toString(16)}`],
    notCode: [[l.f, l.f + 8]]
  };
  const hints = parseHints(JSON.stringify(sheet));
  assert.ok(hintsMatch(hints, { gameId: "TEST01", dolHash }));
  assert.ok(!hintsMatch(hints, { gameId: "TEST01", dolHash: "0".repeat(16) }));
  assert.throws(() => parseHints({ ...sheet, code: "AAAA" }), /unknown field code/);
  assert.throws(() => parseHints({ ...sheet, entryPoints: [0x80003101] }), /word-aligned/);
  assert.throws(() => parseHints({ ...sheet, entryPoints: [[1, 2, 3]] }), /address/);
  assert.equal(await loadHints({ text: async () => JSON.stringify(sheet) }, { gameId: "OTHER1", dolHash }), null);

  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, hints, options: { gapFill: false } });
  const entries = new Map(plan.modules[0].functions.map((f) => [f.entry, f]));
  assert.equal(entries.get(l.hidden).confidence, CONF_POINTER, "a sheet is walked on trial, like a code pointer");
  assert.ok(!entries.has(l.f), "a notCode range is never walked");
});

test("aot disc: DOL, apploader and RELs located through the FST", async () => {
  const { dol, l } = program();
  const disc = syntheticDisc(dol, [{ name: "mod.rel", bytes: new Uint8Array(0x48) }]);
  const read = (o, n) => disc.subarray(o, o + n);
  assert.deepEqual(walkFst(disc.subarray(0x3000)).map((f) => f.path), ["sub/mod.rel", "x.bin"]);
  const plan = await planDisc(read, { options: { gapFill: false } });
  assert.equal(plan.disc.gameId, "TEST01");
  assert.ok(plan.modules[0].functions.some((f) => f.entry === l.f));
  assert.equal(plan.modules[1].kind, "apploader");
  assert.equal(plan.rels.length, 1);
  assert.equal(plan.rels[0].name, "sub/mod.rel");
});

// Disc: header, apploader at 0x2440 (entry: blr), FST at 0x3000 with
// /sub/mod.rel and /x.bin, DOL at 0x4000.
function syntheticDisc(dol, rels) {
  const out = new Uint8Array(0x8000 + dol.length);
  const v = new DataView(out.buffer);
  out.set(new TextEncoder().encode("TEST01"), 0);
  v.setUint32(0x420, 0x4000, false);
  v.setUint32(0x424, 0x3000, false);
  v.setUint32(0x2450, 0x81200000, false);
  v.setUint32(0x2454, 4, false);
  v.setUint32(0x2460, asm.blr(), false);
  // FST: root, dir "sub" (entries 1..2), file mod.rel, file x.bin
  const names = "sub\0mod.rel\0x.bin\0";
  const entries = [[0x01000000, 0, 4], [0x01000000, 0, 3], [4, 0x6000, rels[0].bytes.length], [12, 0x7000, 4]];
  entries.forEach(([w, off, size], i) => {
    v.setUint32(0x3000 + i * 12, w, false); v.setUint32(0x3004 + i * 12, off, false); v.setUint32(0x3008 + i * 12, size, false);
  });
  v.setUint32(0x3008, 4, false); // root: entry count
  out.set(new TextEncoder().encode(names), 0x3000 + entries.length * 12);
  v.setUint32(0x428, entries.length * 12 + names.length, false);
  out.set(rels[0].bytes, 0x6000);
  out.set(dol, 0x8000);
  v.setUint32(0x420, 0x8000, false);
  return out;
}

// In-memory stand-in for the OPFS directory API used by AotProfileStore.
function fakeOpfs() {
  const notFound = () => Object.assign(new Error("missing"), { name: "NotFoundError" });
  const dir = () => {
    const files = new Map(), dirs = new Map();
    return {
      async getDirectoryHandle(name, { create } = {}) {
        if (!dirs.has(name)) { if (!create) throw notFound(); dirs.set(name, dir()); }
        return dirs.get(name);
      },
      async getFileHandle(name, { create } = {}) {
        if (!files.has(name) && !create) throw notFound();
        if (!files.has(name)) files.set(name, new Uint8Array());
        return {
          getFile: async () => ({ arrayBuffer: async () => files.get(name).slice().buffer }),
          createWritable: async () => {
            let pending = null;
            return { write: async (b) => { pending = new Uint8Array(b); }, close: async () => { files.set(name, pending); }, abort: async () => {} };
          }
        };
      },
      async removeEntry(name) {
        if (!files.delete(name)) throw notFound();
      }
    };
  };
  return dir();
}

test("aot plan: validatePlan checks every column (review P2-8)", () => {
  const { dol, l } = program();
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, profile: { sessions: 1, blocks: [[0x500, 0x600, 1, 1]] } });
  validatePlan(plan);
  const bad = (mutate, re) => { const p = structuredClone(plan); mutate(p); assert.throws(() => validatePlan(p), re); };
  bad((p) => { p.modules[0].edges.from[0] = -1; }, /bad edge/);
  bad((p) => { p.modules[0].edges.to[0] = 1.5; }, /bad edge/);
  bad((p) => { p.modules[0].blocks.func[0] = 99; }, /owner/);
  bad((p) => { p.modules[0].functions[0].ranges = [[l.f + 8, l.f + 16], [l.f, l.f + 8]]; }, /unsorted|outside/);
  bad((p) => { p.modules[0].functions[0].extraEntries = [0x90000000]; }, /extra entry/);
  bad((p) => { p.dynamic[0].mode = "kernel"; }, /dynamic/);
  bad((p) => { p.rels = [{ kind: "rel", relId: 1, moduleHash: "x", sections: [] }]; }, /bad rel/);
  bad((p) => { delete p.dynamic; }, /arrays/);
});

test("aot plan: binary regions in compile order, with flags and outside entries", () => {
  const { dol, l } = program();
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, profile: { sessions: 1, blocks: [[l.f, l.f + 4, 3, 0]] }, options: { gapFill: false } });
  const order = orderedRegions(plan).map((r) => r.f.entry);
  assert.equal(order[0], l.f, "profiled regions come first");
  const bin = encodePlanRegions(plan);
  const v = new DataView(bin.buffer);
  assert.equal(v.getUint32(8, true), 1);
  assert.equal(v.getUint32(12, true), order.length);
  // First region: module, entry, confidence, flags, hashHi, hashLo, rangeCount, ranges, extraCount.
  assert.equal(v.getUint32(24, true), l.f);
  assert.equal(v.getUint32(32, true), 0, "flags: virtual mode");
  const ranges = v.getUint32(44, true);
  assert.equal(v.getUint32(48 + ranges * 8, true), 0, "no outside entries");
  let o = 20, words = 0;
  for (let i = 0; i < order.length; i++) { const rc = v.getUint32(o + 24, true); const ec = v.getUint32(o + 28 + rc * 8, true); o += 32 + rc * 8 + ec * 4; words++; }
  assert.equal(o, bin.length, "the layout accounts for every byte");
});

test("aot disc: hostile headers are bounded (review P1-2, P2-7)", async () => {
  const fst = new Uint8Array(24);
  new DataView(fst.buffer).setUint32(8, 0xffffffff);
  assert.deepEqual(walkFst(fst).length, 1, "the entry count is capped by the table size");
  // A directory claiming to end past its parent, names without terminator.
  const loop = new Uint8Array(12 * 3 + 4000).fill(0x41);
  const lv = new DataView(loop.buffer);
  lv.setUint32(0, 0x01000000); lv.setUint32(8, 3);
  lv.setUint32(12, 0x01000000); lv.setUint32(20, 0xffffffff);
  lv.setUint32(24, 0); lv.setUint32(28, 0); lv.setUint32(32, 4);
  const files = walkFst(loop);
  assert.equal(files.length, 1);
  assert.ok(files[0].path.length < 600, "names are bounded");

  const { dol } = program();
  const disc = syntheticDisc(dol, [{ name: "mod.rel", bytes: new Uint8Array(0x48) }]);
  new DataView(disc.buffer).setUint32(0x8000 + 0x90, 0x7fffffff); // text0 size: 2 GiB
  let asked = 0;
  await assert.rejects(planDisc((o, n) => { asked = Math.max(asked, n); return disc.subarray(o, o + n); }), /larger than/);
  assert.ok(asked < 1 << 20, "nothing large was read");
});

test("aot disc: a REL that cannot be parsed is left to the JIT", async () => {
  const { dol } = program();
  const bogus = new Uint8Array(0x48);
  new DataView(bogus.buffer).setUint32(0x0c, 300); // section count out of range
  const plan = await planDisc((o, n) => syntheticDisc(dol, [{ name: "mod.rel", bytes: bogus }]).subarray(o, o + n));
  assert.match(plan.rels[0].error, /section table/);
  validatePlan(plan);
});

test("aot hints: an entry that decodes as junk is walked on trial and dropped (review P2-5)", () => {
  const t = assemble(TEXT, ["entry", asm.blr(), "junk", 0x07000000, asm.blr()]);
  const dol = buildDol({ textAddr: TEXT, text: t.words, entry: t.labels.entry });
  const hints = parseHints({ schema: "salon-aot-hints/1", match: { gameId: "TEST01", dolHash: fnv1a64Hex(dol) }, entryPoints: [t.labels.junk] });
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, hints, options: { gapFill: false } });
  assert.ok(!plan.modules[0].blocks.start.includes(t.labels.junk));
});
