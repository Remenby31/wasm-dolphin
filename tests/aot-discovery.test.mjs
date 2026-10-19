import assert from "node:assert/strict";
import test from "node:test";

import { CONF_GAP, CONF_POINTER, CONF_ROOT, EDGE, discover } from "../src/aot-discovery.js";
import { imageFromDol } from "../src/aot-image.js";
import { decodeFlow, FLOW_BRANCH, FLOW_INDIRECT, isValidInstruction, mayWriteGpr } from "../src/aot-ppc.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";

const TEXT = 0x80003100;
const DATA = 0x80100000;
const ha = (x) => ((x + 0x8000) >>> 16) & 0xffff;
const lo = (x) => x & 0xffff;
const at = (label, f) => (pc, l) => f(pc, l[label]);

// Synthetic program: calls, a constant indirect call, a bounded switch, a
// function only reachable through a vtable in data, an unreferenced
// function after padding, and junk that must stay unknown.
function program() {
  const tableAddr = DATA, vtableAddr = DATA + 12;
  const text = assemble(TEXT, [
    "entry",
    asm.stwu(1, 1, -16),
    asm.mflr(0),
    at("func_a", (pc, t) => asm.bl(pc, t)),
    (pc, l) => asm.lis(12, ha(l.func_cb)),
    (pc, l) => asm.addi(12, 12, lo(l.func_cb)),
    asm.mtctr(12),
    asm.bctrl(),
    at("switcher", (pc, t) => asm.bl(pc, t)),
    asm.blr(),
    "func_a", asm.li(3, 1), asm.blr(),
    "func_cb", asm.li(3, 2), asm.blr(),
    "switcher",
    asm.cmplwi(3, 2),
    at("sw_default", (pc, t) => asm.bgt(pc, t)),
    asm.lis(4, ha(tableAddr)),
    asm.slwi2(0, 3),
    asm.addi(4, 4, lo(tableAddr)),
    asm.lwzx(0, 4, 0),
    asm.mtctr(0),
    "site", asm.bctr(),
    "case0", asm.li(3, 0), asm.blr(),
    "case1", asm.li(3, 1), asm.blr(),
    "case2", asm.li(3, 2), asm.blr(),
    "sw_default", asm.li(3, -1), asm.blr(),
    0,
    "vfunc", asm.li(3, 7), asm.blr(),
    0,
    "gapfunc", asm.stwu(1, 1, -16), asm.addi(1, 1, 16), asm.blr(),
    "junk", 0x07000000, asm.blr()
  ]);
  const l = text.labels;
  const data = [l.case0, l.case1, l.case2, l.vfunc];
  return { dol: buildDol({ textAddr: TEXT, text: text.words, dataAddr: DATA, data, entry: l.entry }), labels: l, tableAddr, vtableAddr };
}

function run(options = {}) {
  const p = program();
  const { image, entryPoint } = imageFromDol(p.dol);
  const r = discover(image, { entryPoints: [{ addr: entryPoint, source: "dol-entry" }], ...options });
  return { ...p, r, image };
}

test("aot decoder: validity, flow and register effects", () => {
  assert.equal(isValidInstruction(0), false);
  assert.equal(isValidInstruction(0x07000000), false);
  assert.equal(isValidInstruction(asm.stwu(1, 1, -16)), true);
  assert.equal(isValidInstruction(asm.blr()), true);
  assert.equal(isValidInstruction(0x10000000 | (21 << 1)), true, "ps_add");
  const b = decodeFlow(asm.bl(0x80001000, 0x80000f00), 0x80001000);
  assert.deepEqual([b.kind, b.target, b.link], [FLOW_BRANCH, 0x80000f00, true]);
  assert.equal(decodeFlow(asm.bctr(), 0).kind, FLOW_INDIRECT);
  assert.equal(decodeFlow(asm.bgt(0x100, 0x120), 0x100).conditional, true);
  // lis rD, imm encodes rA = 0 as "no register": it does not write r0.
  assert.equal(mayWriteGpr(asm.lis(3, 0x8034), 0), false);
  assert.equal(mayWriteGpr(asm.lis(3, 0x8034), 3), true);
  assert.equal(mayWriteGpr(asm.stwu(1, 1, -16), 1), true);
  assert.equal(mayWriteGpr(asm.ori(5, 4, 1), 4), false);
});

test("aot discovery: calls, constant indirect call, switch, data pointers and gaps", () => {
  const { r, labels: l } = run();
  const byEntry = new Map(r.functions.map((f) => [f.entry, f]));
  assert.equal(byEntry.get(l.entry).confidence, CONF_ROOT);
  assert.equal(byEntry.get(l.func_a).confidence, CONF_ROOT);
  assert.equal(byEntry.get(l.func_cb).confidence, CONF_ROOT, "bctrl through lis/addi resolves to a call");
  assert.equal(byEntry.get(l.switcher).confidence, CONF_ROOT);
  assert.equal(byEntry.get(l.vfunc).confidence, CONF_POINTER, "reached through the vtable in data");
  assert.equal(byEntry.get(l.gapfunc).confidence, CONF_GAP);
  assert.ok(!byEntry.has(l.case0), "jump table targets are blocks of the switch, not functions");

  assert.equal(r.jumpTables.length, 1);
  const t = r.jumpTables[0];
  assert.deepEqual([t.site, t.count, t.bound], [l.site, 3, "cmplwi"]);
  assert.deepEqual(t.targets, [l.case0, l.case1, l.case2]);

  const blockOf = (a) => r.blocks.start.findIndex((s, i) => a >= s && a < r.blocks.end[i]);
  assert.equal(blockOf(l.junk), -1, "an invalid word stays unknown");
  assert.equal(blockOf(l.junk + 4), -1, "and so does code only reachable through it");
  const sw = r.functions.findIndex((f) => f.entry === l.switcher);
  for (const c of [l.case0, l.case1, l.case2, l.sw_default]) assert.equal(r.blocks.func[blockOf(c)], sw);

  const callEdges = r.edges.kind.map((k, i) => [k, r.blocks.start[r.edges.to[i]]]).filter(([k]) => k === EDGE.call).map(([, to]) => to);
  assert.ok(callEdges.includes(l.func_a) && callEdges.includes(l.func_cb) && callEdges.includes(l.switcher));
  assert.ok(r.blocks.start.includes(l.entry + 12), "the return site of a call starts a block");
  assert.equal(r.badStops.length, 0);
});

test("aot discovery: speculative passes can be turned off", () => {
  const { r, labels: l } = run({ pointerScan: false, constScan: false, gapFill: false });
  const entries = new Set(r.functions.map((f) => f.entry));
  assert.ok(entries.has(l.switcher));
  assert.ok(!entries.has(l.vfunc) && !entries.has(l.gapfunc));
});

test("aot discovery: bge bound excludes N; unbounded tables are scanned", () => {
  const tableAddr = DATA;
  const text = assemble(TEXT, [
    "entry",
    asm.cmplwi(5, 2, 1),
    at("dflt", (pc, t) => asm.bge(pc, t, 1)),
    asm.lis(6, ha(tableAddr)),
    asm.addi(6, 6, lo(tableAddr)),
    asm.slwi2(5, 5),
    asm.lwzx(7, 6, 5),
    asm.mtctr(7),
    asm.bctr(),
    "c0", asm.blr(),
    "c1", asm.blr(),
    "dflt", asm.blr(),
    "entry2",
    asm.lis(6, ha(tableAddr + 8)),
    asm.addi(6, 6, lo(tableAddr + 8)),
    asm.lwzx(7, 6, 5),
    asm.mtctr(7),
    asm.bctr(),
    "d0", asm.blr(),
    "d1", asm.blr()
  ]);
  const l = text.labels;
  const dol = buildDol({ textAddr: TEXT, text: text.words, dataAddr: DATA, data: [l.c0, l.c1, l.d0, l.d1, 0x12345678], entry: l.entry });
  const { image } = imageFromDol(dol);
  const r = discover(image, { entryPoints: [{ addr: l.entry, source: "t" }, { addr: l.entry2, source: "t" }], gapFill: false });
  const [a, b] = r.jumpTables;
  assert.deepEqual([a.count, a.bound], [2, "cmplwi"]);
  assert.deepEqual([b.bound, b.targets], ["scan", [l.d0, l.d1]], "a scan stops at the first word that is not code");
});

test("aot discovery: relative tables (entries are offsets from the table)", () => {
  const tableAddr = DATA;
  const add = (d, a, b) => (31 << 26) | (d << 21) | (a << 16) | (b << 11) | (266 << 1);
  const text = assemble(TEXT, [
    "entry",
    asm.lis(26, ha(tableAddr)),
    asm.addi(26, 26, lo(tableAddr)),
    asm.cmplwi(3, 1),
    at("dflt", (pc, t) => asm.bgt(pc, t)),
    asm.slwi2(10, 3),
    asm.lwzx(10, 26, 10),
    add(10, 10, 26),
    asm.mtctr(10),
    asm.bctr(),
    "c0", asm.blr(),
    "c1", asm.blr(),
    "dflt", asm.blr()
  ]);
  const l = text.labels;
  const dol = buildDol({ textAddr: TEXT, text: text.words, dataAddr: DATA, data: [l.c0 - tableAddr, l.c1 - tableAddr], entry: l.entry });
  const { image } = imageFromDol(dol);
  const [t] = discover(image, { entryPoints: [{ addr: l.entry, source: "t" }], gapFill: false }).jumpTables;
  assert.deepEqual([t.kind, t.bound, t.targets], ["rel", "cmplwi", [l.c0, l.c1]]);
});

test("aot discovery: outside entries of a region (table targets, code pointers)", async () => {
  const { planModule } = await import("../src/aot-plan.js");
  const { r, labels: l, image } = run();
  const m = planModule(r, { read32: (a) => image.read32(a) });
  const sw = m.functions.find((f) => f.entry === l.switcher);
  assert.deepEqual(sw.extraEntries, [l.case0, l.case1, l.case2]);
  assert.deepEqual(m.functions.find((f) => f.entry === l.func_a).extraEntries, []);
});

// Performance guards (review P2-3, P2-4): hostile shapes must stay linear.
test("aot discovery: many code pointers into a run that ends on junk stay linear", () => {
  const N = 50000;
  const text = [asm.blr()];
  for (let i = 0; i < N; i++) text.push(asm.nop());
  text.push(0);
  const data = Array.from({ length: N }, (_, i) => TEXT + 4 + i * 4);
  const { image, entryPoint } = imageFromDol(buildDol({ textAddr: TEXT, text, dataAddr: DATA, data, entry: TEXT }));
  const t0 = performance.now();
  const r = discover(image, { entryPoints: [{ addr: entryPoint, source: "t" }] });
  const ms = performance.now() - t0;
  assert.equal(r.functions.length, 1);
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
});

test("aot discovery: a branchy region ending on junk is bounded by the trial budget", () => {
  // Each pointer targets a nop chain with a conditional branch (not straight
  // line), all ending on junk: only the shared budget bounds the work.
  const N = 20000;
  const text = [asm.blr()];
  for (let i = 0; i < N; i++) text.push((pc) => asm.beq(pc, pc + 8));
  text.push(0, 0);
  const t = assemble(TEXT, text);
  const data = Array.from({ length: N }, (_, i) => TEXT + 4 + i * 4);
  const { image, entryPoint } = imageFromDol(buildDol({ textAddr: TEXT, text: t.words, dataAddr: DATA, data, entry: TEXT }));
  const t0 = performance.now();
  const r = discover(image, { entryPoints: [{ addr: entryPoint, source: "t" }], gapFill: false });
  assert.equal(r.functions.length, 1);
  assert.ok(performance.now() - t0 < 5000);
});

test("aot discovery: 65,536 notCode ranges are searched, not scanned", () => {
  const text = [];
  for (let i = 0; i < 20000; i++) text.push(asm.nop());
  text.push(asm.blr());
  const { image, entryPoint } = imageFromDol(buildDol({ textAddr: TEXT, text, entry: TEXT }));
  const exclude = Array.from({ length: 65536 }, (_, i) => [0x90000000 + i * 8, 0x90000004 + i * 8]);
  const t0 = performance.now();
  const r = discover(image, { entryPoints: [{ addr: entryPoint, source: "t" }], exclude });
  assert.equal(r.stats.codeBytes, 20001 * 4);
  assert.ok(performance.now() - t0 < 1000);
});
