import assert from "node:assert/strict";
import test from "node:test";

import { CONF_PROFILE, CONF_ROOT } from "../src/aot-discovery.js";
import { walkFst } from "../src/aot-disc.js";
import { AotProfileStore, blocksFromCoreDump, decodeProfile, encodeProfile, mergeProfiles } from "../src/aot-profile.js";
import { hintsMatch, loadHints, parseHints } from "../src/aot-hints.js";
import { imageFromDol } from "../src/aot-image.js";
import {
  PLAN_BINARY_MAGIC, PLAN_SCHEMA, encodePlanRegions, fnv1a64Hex, planDol, regionHash, validatePlan
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

test("aot profile: blocks from a previous session become entries", () => {
  const { dol, l } = program();
  const { image, entryPoint } = imageFromDol(dol);
  const profile = { sessions: 1, blocks: blocksFromCoreDump(new Uint32Array([l.hidden, 12, 0x80000500, 0x100])) };
  const plan = planDol({ image, entryPoint, profile, options: { gapFill: false } });
  const f = plan.modules[0].functions.find((x) => x.entry === l.hidden);
  assert.equal(f.confidence, CONF_PROFILE);
  assert.deepEqual(f.sources, ["profile"]);
  assert.deepEqual(plan.dynamic, [{ start: 0x80000500, end: 0x80000600, source: "profile" }], "code outside the DOL is kept as dynamic");
});

test("aot profile: binary round trip, merge and OPFS store", async () => {
  const p = { sessions: 2, blocks: [[0x80003100, 0x80003110], [0x80003110, 0x80003120], [0x80004000, 0x80004008]] };
  assert.deepEqual(decodeProfile(encodeProfile(p)), p, "adjacent blocks keep their own start");
  assert.equal(decodeProfile(new Uint8Array(30)), null);
  const merged = mergeProfiles(p, { sessions: 1, blocks: [[0x80003104, 0x80003114], [0x80005000, 0x80005004]] });
  assert.equal(merged.sessions, 3);
  assert.deepEqual(merged.blocks[0], [0x80003100, 0x80003120], "overlapping blocks merge");

  const store = new AotProfileStore(fakeOpfs());
  assert.equal(await store.load("abc"), null);
  await store.record("abc", [[0x80003100, 0x80003110]]);
  const second = await store.record("abc", [[0x80004000, 0x80004004]]);
  assert.equal(second.sessions, 2);
  assert.deepEqual((await store.load("abc")).blocks, [[0x80003100, 0x80003110], [0x80004000, 0x80004004]]);
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
  assert.equal(entries.get(l.hidden).confidence, CONF_ROOT);
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
