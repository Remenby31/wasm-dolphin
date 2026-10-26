// Hostile and maximum-size inputs: every case finishes fast, without a crash,
// or is refused with an error the caller turns into "no plan" (the JIT runs
// the game as today). Sizes are reduced from the review's attack scripts;
// bounds are in CPU time, so a loaded machine does not fail them.
import assert from "node:assert/strict";
import test from "node:test";

import { discover, MAX_BLOCKS } from "../src/aot-discovery.js";
import { imageFromDol, MAX_EXEC_BYTES } from "../src/aot-image.js";
import { ANALYZER_VERSION, fnv1a64Hex, planDol, validatePlan } from "../src/aot-plan.js";
import { parseHints } from "../src/aot-hints.js";
import { planDisc } from "../src/aot-recomp.js";
import { parseRel, planRel, R_PPC_REL24, REL_MODULE_ID_BASE, readLinkedModules, relocateModulePlan } from "../src/aot-rel.js";
import { asm, assemble, buildDol, buildRel } from "./aot-asm.mjs";

const BASE = 0x80000000;
// Timed in this process's CPU time (user + system), not wall time: on a
// loaded machine the process waits for a core and the wall clock runs on
// (full suite under load: 4731 ms against 1500, 2921 against 2000), while
// what these bounds guard is the work a hostile input makes us do.
const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const timed = (fn) => { const t = cpuMs(); const r = fn(); return [r, cpuMs() - t]; };
// Bounds hold on an unloaded M4 Pro. Over a bound, the bound is scaled by how
// much more CPU time a fixed reference workload (20 ms there) takes now: a
// slower machine, not a busier one, is not mistaken for a slow refusal.
const REFERENCE_MS = 20;
const reference = () => timed(() => {
  let h = 0x811c9dc5;
  for (let i = 0; i < 2e7; i++) { h ^= i; h = Math.imul(h, 16777619); }
  return h;
})[1];
function assertFast(ms, bound) {
  if (ms < bound) return;
  // Median of three: the reference's CPU time still moves a little with
  // frequency and cache pressure.
  const runs = [reference(), reference(), reference()].sort((a, b) => a - b);
  // Capped: a refusal 4x slower than the bound is a regression, whatever the machine.
  const scale = Math.min(4, Math.max(1, runs[1] / REFERENCE_MS));
  assert.ok(ms < bound * scale, `${Math.round(ms)} ms of CPU, bound ${bound} ms x ${scale.toFixed(2)} (machine slowdown)`);
}
const lis = (r, x) => asm.lis(r, (x + 0x8000) >>> 16);
const lo = (x) => x & 0xffff;

// A DOL whose header maps several sections, possibly onto the same file bytes.
function rawDol({ sections, entry, size }) {
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  sections.forEach(({ kind, index, offset, address, length }) => {
    const base = kind === "text" ? 0 : 0x1c;
    v.setUint32(base + index * 4, offset);
    v.setUint32(0x48 + base + index * 4, address);
    v.setUint32(0x90 + base + index * 4, length);
  });
  v.setUint32(0xe0, entry);
  for (let o = 0x100; o + 4 <= size; o += 4) v.setUint32(o, asm.nop());
  v.setUint32(size - 4, asm.blr());
  return out;
}

test("aot hostile: a chain of functions each found by the previous one's constant stays linear (P1-1)", () => {
  // fn i loads the address of fn i-1 with lis/addi: one more function per
  // speculative round, then a long run of additions to rescan every round.
  const K = 8, N = 200000;
  const T = [];
  for (let i = 0; i < K; i++) {
    const tgt = BASE + (i - 1) * 16;
    if (i === 0) T.push(asm.blr(), 1, 1, 1);
    else T.push(lis(3, tgt), asm.addi(3, 3, lo(tgt)), asm.blr(), 1);
  }
  const top = BASE + (K - 1) * 16;
  const entry = BASE + T.length * 4;
  T.push(lis(3, top), asm.addi(3, 3, lo(top)));
  for (let i = 0; i < N; i++) T.push(asm.addi(4, 5, 1));
  T.push(asm.blr());
  const { image, entryPoint } = imageFromDol(buildDol({ textAddr: BASE, text: T, entry }));
  const [plan, ms] = timed(() => planDol({ image, entryPoint }));
  assert.equal(plan.modules[0].functions.length, K + 1);
  assertFast(ms, 1000);
});

test("aot hostile: DOL sections sharing file bytes, too much code or too many blocks are refused fast (P1-3)", () => {
  const shared = rawDol({ size: 1 << 20, entry: BASE, sections: [0, 1, 2].map((i) => ({ kind: "text", index: i, offset: 0x100, address: BASE + i * 0x01000000, length: (1 << 20) - 0x100 })) });
  const [, ms] = timed(() => assert.throws(() => imageFromDol(shared), /share file bytes/));
  assertFast(ms, 200);

  const big = rawDol({ size: MAX_EXEC_BYTES + 0x1000, entry: BASE, sections: [{ kind: "text", index: 0, offset: 0x100, address: BASE, length: MAX_EXEC_BYTES + 0xf00 }] });
  assert.throws(() => imageFromDol(big), /bytes of code/);

  // A conditional branch every other word: one block per two words.
  const words = 2 * (MAX_BLOCKS + 1000);
  const T = [];
  for (let i = 0; i < words; i++) T.push(i % 2 ? asm.nop() : (pc) => asm.beq(pc, pc + 8));
  T.push(asm.blr());
  const { image, entryPoint } = imageFromDol(buildDol({ textAddr: BASE, text: assemble(BASE, T).words, entry: BASE }));
  const [, ms2] = timed(() => assert.throws(() => discover(image, { entryPoints: [{ addr: entryPoint, source: "t" }] }), /blocks/));
  assertFast(ms2, 1500);
});

test("aot hostile: the largest accepted image plans in bounded time and memory (P2-10)", () => {
  const dol = rawDol({ size: MAX_EXEC_BYTES, entry: BASE, sections: [{ kind: "text", index: 0, offset: 0x100, address: BASE, length: MAX_EXEC_BYTES - 0x100 }] });
  const before = process.memoryUsage();
  const [plan, ms] = timed(() => { const { image, entryPoint } = imageFromDol(dol); return planDol({ image, entryPoint, dolBytes: dol }); });
  const after = process.memoryUsage();
  validatePlan(plan);
  assertFast(ms, 2000);
  const grownMiB = (after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers) / 2 ** 20;
  assert.ok(grownMiB < 512, `${Math.round(grownMiB)} MiB`);
});

test("aot hostile: REL sections overlapping in the file are refused (P1-2)", () => {
  const S = 1 << 20, NS = 64;
  const u = new Uint8Array(S), v = new DataView(u.buffer);
  v.setUint32(0x0c, NS); v.setUint32(0x10, 0x40);
  const body = 0x40 + NS * 8;
  for (let i = 0; i < NS; i++) { v.setUint32(0x40 + i * 8, (body | 1) >>> 0); v.setUint32(0x44 + i * 8, S - body); }
  const [, ms] = timed(() => assert.throws(() => parseRel(u), /overlap/));
  assertFast(ms, 200);
});

test("aot hostile: a call relocated against another REL is not a function (P2-6)", () => {
  const c = assemble(0, ["prolog", asm.stwu(1, 1, -16), 0x48000001, asm.li(3, 1), 0x48000001, asm.li(3, 2), asm.blr()]);
  const bytes = buildRel({ id: 7, text: c.words, prolog: 0, relocs: [] });
  // Point the import table at module 9 with two REL24 relocations.
  const v = new DataView(bytes.buffer);
  const imp = v.getUint32(0x28), relOff = v.getUint32(0x24);
  const run = [[0, 202, 1, 0], [4, R_PPC_REL24, 1, 0], [8, R_PPC_REL24, 1, 0], [0, 203, 0, 0]];
  const out = new Uint8Array(relOff + run.length * 8);
  out.set(bytes.subarray(0, relOff));
  const o = new DataView(out.buffer);
  run.forEach(([d, t, s, a], i) => { o.setUint16(relOff + i * 8, d); out[relOff + i * 8 + 2] = t; out[relOff + i * 8 + 3] = s; o.setUint32(relOff + i * 8 + 4, a); });
  o.setUint32(imp, 9); o.setUint32(imp + 4, relOff);
  const plan = planRel(out);
  assert.deepEqual(plan.functions.map((f) => f.entry), [0], "only the prolog");
  assert.deepEqual(plan.functions[0].ranges, [[1, 0, 24]]);
});

test("aot hostile: validatePlan stays linear on a region with 100 000 ranges and outside entries (P1-4)", () => {
  const N = 100000;
  const T = [], D = [];
  for (let i = 0; i < N; i++) { T.push(0x48000008, 0); D.push(BASE + i * 8); }
  T.push(asm.blr());
  const { image, entryPoint } = imageFromDol(buildDol({ textAddr: BASE, text: T, dataAddr: 0x81000000, data: D, entry: BASE }));
  const plan = planDol({ image, entryPoint, options: { gapFill: false } });
  assert.ok(plan.modules[0].functions[0].extraEntries.length > N / 2);
  const [, ms] = timed(() => validatePlan(plan));
  assertFast(ms, 500);
});

test("aot plan: hint dynamic code is valid, analyzer is checked, identity covers every input (P2-5, P2-9)", async () => {
  const d = buildDol({ textAddr: 0x80003100, text: [asm.nop(), asm.blr()], entry: 0x80003100 });
  const disc = new Uint8Array(0x10000);
  disc.set(new TextEncoder().encode("GXXE01"), 0);
  new DataView(disc.buffer).setUint32(0x420, 0x8000);
  disc.set(d, 0x8000);
  const read = (o, n) => disc.slice(o, o + n);
  const hints = parseHints({ schema: "salon-aot-hints/1", match: { gameId: "GXXE01", dolHash: fnv1a64Hex(d) }, dynamicCode: [["0x80001800", "0x80001900"]] });
  const plan = validatePlan(await planDisc(read, { hints }));
  assert.deepEqual(plan.dynamic, [{ start: 0x80001800, end: 0x80001900, mode: "virt", source: "hint" }]);
  assert.match(plan.identity.hintsHash, /^[0-9a-f]{16}$/);
  const plain = await planDisc(read);
  assert.equal(plain.identity.hintsHash, null);
  assert.equal(plain.identity.dolHash, plan.identity.dolHash);
  const withProfile = await planDisc(read, { profile: { sessions: 1, blocks: [[0x80003100, 0x80003104, 1, 0]] } });
  assert.notEqual(withProfile.identity.profileHash, null);
  assert.throws(() => validatePlan({ ...plan, analyzer: ANALYZER_VERSION - 1 }), /analyzer/);
});

test("aot rel: a linked module gets its own plan id and keeps its outside entries (P2-7, P2-8)", () => {
  const T = 0x80500100;
  const words = (base) => assemble(base, [
    "prolog", (pc, l) => asm.bl(pc, l.sw), asm.blr(),
    "sw", asm.cmplwi(3, 1), (pc, l) => asm.bgt(pc, l.d),
    asm.slwi2(0, 3), (pc, l) => asm.lis(4, ((l.tab + 0x8000) >>> 16) & 0xffff), (pc, l) => asm.addi(4, 4, l.tab & 0xffff),
    asm.lwzx(0, 4, 0), asm.mtctr(0), asm.bctr(),
    "c0", asm.blr(), "c1", asm.blr(), "d", asm.blr(),
    "tab", 0, 0
  ]);
  // Unlinked: the table words are ADDR32 relocations to c0 and c1.
  const w0 = words(0);
  const relocs = [
    { section: 1, offset: w0.labels.prolog, type: R_PPC_REL24, targetSection: 1, addend: w0.labels.sw },
    // ADDR16_HA / ADDR16_LO point at the immediate halfword of lis / addi.
    { section: 1, offset: w0.labels.sw + 14, type: 6, targetSection: 1, addend: w0.labels.tab },
    { section: 1, offset: w0.labels.sw + 18, type: 4, targetSection: 1, addend: w0.labels.tab },
    { section: 1, offset: w0.labels.tab, type: 1, targetSection: 1, addend: w0.labels.c0 },
    { section: 1, offset: w0.labels.tab + 4, type: 1, targetSection: 1, addend: w0.labels.c1 }
  ];
  const text = [...w0.words];
  text[0] = 0x48000001; text[5] = asm.lis(4, 0); text[6] = asm.addi(4, 4, 0); text[w0.labels.tab / 4] = 0; text[w0.labels.tab / 4 + 1] = 0;
  const plan = planRel(buildRel({ id: 1, text, prolog: 0, relocs }));
  const sw = plan.functions.find((f) => f.entry === w0.labels.sw);
  assert.deepEqual(sw.extraEntries, [[1, w0.labels.c0], [1, w0.labels.c1]]);
  // Linked at T: memory holds the relocated code.
  const w = words(T);
  const mem = new Map();
  w.words.forEach((x, i) => mem.set(T + i * 4, x));
  mem.set(w.labels.tab, w.labels.c0); mem.set(w.labels.tab + 4, w.labels.c1);
  const M = 0x80500000;
  mem.set(0x800030c8, M); mem.set(M, 1); mem.set(M + 0x0c, 2); mem.set(M + 0x10, M + 0x40);
  mem.set(M + 0x48, T | 1); mem.set(M + 0x4c, w.words.length * 4);
  const read32 = (a) => mem.get(a) ?? 0;
  const placed = relocateModulePlan(plan, readLinkedModules(read32)[0], read32);
  assert.equal(placed.id, REL_MODULE_ID_BASE + 1, "never 1, the apploader's id");
  assert.deepEqual(placed.functions.find((f) => f.entry === w.labels.sw).extraEntries, [w.labels.c0, w.labels.c1]);
});
