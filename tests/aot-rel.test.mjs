import assert from "node:assert/strict";
import test from "node:test";

import { CONF_POINTER, CONF_ROOT } from "../src/aot-discovery.js";
import { regionHash } from "../src/aot-plan.js";
import {
  OS_MODULE_LIST_HEAD, R_PPC_ADDR32, R_PPC_REL24, parseRel, planRel, readLinkedModules, relocateModulePlan
} from "../src/aot-rel.js";
import { asm, assemble, buildRel } from "./aot-asm.mjs";

const REL_ID = 7;

// Section 1 (code): prolog calls helper through a REL24 relocation; vfunc is
// only referenced by an ADDR32 relocation in section 2 (a vtable).
function code(base) {
  return assemble(base, [
    "prolog", asm.stwu(1, 1, -16), (pc, l) => asm.bl(pc, l.helper), asm.blr(),
    "helper", asm.li(3, 1), asm.blr(),
    "vfunc", asm.li(3, 5), asm.blr()
  ]);
}

function rel() {
  const c = code(0);
  const text = [...c.words];
  text[1] = 0x48000001; // on disc the call is unrelocated: "bl ."
  return {
    bytes: buildRel({
      id: REL_ID,
      text,
      data: [0],
      prolog: c.labels.prolog,
      relocs: [
        { section: 1, offset: 4, type: R_PPC_REL24, targetSection: 1, addend: c.labels.helper },
        { section: 2, offset: 0, type: R_PPC_ADDR32, targetSection: 1, addend: c.labels.vfunc }
      ]
    }),
    labels: c.labels
  };
}

// Guest memory after OSLink placed the module at M, section 1 at A1, section 2 at A2.
function linkedMemory({ corrupt = false } = {}) {
  const M = 0x80500000, A1 = 0x80500100, A2 = 0x80500200;
  const mem = new Map();
  const c = code(A1);
  c.words.forEach((w, i) => mem.set(A1 + i * 4, w));
  if (corrupt) mem.set(A1 + c.labels.helper - A1, asm.li(3, 2));
  mem.set(A2, c.labels.vfunc);
  mem.set(OS_MODULE_LIST_HEAD, M);
  mem.set(M, REL_ID);
  mem.set(M + 4, 0);
  mem.set(M + 0x0c, 3);
  mem.set(M + 0x10, M + 0x40);
  [[0, 0], [A1 | 1, c.words.length * 4], [A2, 4]].forEach(([o, s], i) => { mem.set(M + 0x40 + i * 8, o); mem.set(M + 0x44 + i * 8, s); });
  return { read32: (a) => mem.get(a) ?? 0, A1, labels: c.labels };
}

test("aot rel: header, sections and relocations are parsed", () => {
  const r = parseRel(rel().bytes);
  assert.equal(r.header.id, REL_ID);
  assert.deepEqual(r.sections.map((s) => [s.exec, s.size]), [[false, 0], [true, 28], [false, 4]]);
  assert.deepEqual(r.imports[0].relocs.map((x) => [x.section, x.offset, x.type]), [[1, 4, R_PPC_REL24], [2, 0, R_PPC_ADDR32]]);
  assert.throws(() => parseRel(new Uint8Array(16)), /incomplete/);
});

test("aot rel: discovery follows relocated calls and vtables, in (section, offset) form", () => {
  const { bytes, labels } = rel();
  const plan = planRel(bytes, { name: "m.rel" });
  const byEntry = new Map(plan.functions.map((f) => [f.entry, f]));
  assert.equal(byEntry.get(labels.prolog).confidence, CONF_ROOT);
  assert.equal(byEntry.get(labels.helper).confidence, CONF_ROOT, "the call resolved through REL24");
  assert.equal(byEntry.get(labels.vfunc).confidence, CONF_POINTER, "reached through the relocated vtable");
  assert.ok(plan.functions.every((f) => f.section === 1));
  assert.deepEqual(plan.sections[1].relocWords, [4]);
});

test("aot rel: a linked module is relocated and fingerprinted from memory; another one is refused", () => {
  const plan = planRel(rel().bytes);
  const { read32, A1, labels } = linkedMemory();
  const [linked] = readLinkedModules(read32);
  assert.equal(linked.id, REL_ID);
  assert.equal(linked.sections[1].address, A1);
  const placed = relocateModulePlan(plan, linked, read32);
  const helper = placed.functions.find((f) => f.entry === labels.helper);
  assert.ok(helper);
  assert.deepEqual(helper.ranges, [[labels.helper, labels.helper + 8]]);
  assert.equal(helper.hash, regionHash(read32, helper.ranges));
  assert.equal(relocateModulePlan(plan, { ...linked, id: 99 }, read32), null);
  const other = linkedMemory({ corrupt: true });
  assert.equal(relocateModulePlan(plan, readLinkedModules(other.read32)[0], other.read32), null, "different code under the same id");
});

test("aot rel: a corrupt module list ends the walk without throwing", () => {
  const loop = new Map([[OS_MODULE_LIST_HEAD, 0x80600000], [0x80600000, 1], [0x80600004, 0x80600000], [0x8060000c, 0], [0x80600010, 0x80600040]]);
  assert.equal(readLinkedModules((a) => loop.get(a) ?? 0).length, 1);
  assert.deepEqual(readLinkedModules(() => 0), []);
});
