import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { imageFromDol } from "../src/aot-image.js";
import { planDol } from "../src/aot-plan.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";
import { checkSlice, regionSlices } from "./helpers/aot-region-equivalence.mjs";
import { LAYOUT, STATE_BYTES, decode, interpretStep, translateFunction } from "./helpers/aot-ppc-subset.mjs";

const TEXT = 0x80003100;

const add = (d, a, b) => (31 << 26) | (d << 21) | (a << 16) | (b << 11) | (266 << 1);
const mtlr = (s) => (31 << 26) | (s << 21) | (8 << 16) | (467 << 1);

// A call graph of straight-line functions in the subset: nested calls, LR
// saved in a register around them, a tail branch (which the plan merges into
// its caller as a second range), arithmetic on several registers.
function program() {
  const t = assemble(TEXT, [
    "main", asm.mflr(31), asm.li(3, 7), (pc, l) => asm.bl(pc, l.double), (pc, l) => asm.bl(pc, l.sum), asm.addi(5, 3, -1), mtlr(31), (pc, l) => asm.b(pc, l.tailend),
    "double", add(3, 3, 3), asm.blr(),
    "sum", asm.mflr(30), asm.li(4, 100), (pc, l) => asm.bl(pc, l.leaf), add(3, 3, 4), mtlr(30), asm.blr(),
    "leaf", asm.ori(4, 4, 0x0f), asm.lis(6, 0x1234), asm.blr(),
    "tailend", asm.ori(7, 5, 1), asm.blr()
  ]);
  return buildDol({ textAddr: TEXT, text: t.words, entry: t.labels.main });
}

function setup(dol) {
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  const read32 = (a) => image.read32(a);
  return { plan, read32 };
}

const run = (setupResult, opts) => checkSlice({
  ...setupResult, interpretStep, layout: LAYOUT, stateBytes: STATE_BYTES,
  translate: (f) => translateFunction(f, setupResult.read32, opts), ...opts
});

test("subset decoder and the reference interpreter agree on a hand-checked program", () => {
  const s = setup(program());
  assert.equal(decode(0x4e800020, 0).kind, "blr");
  assert.equal(decode(0x7c000000, 0), null, "outside the subset");
  const st = { pc: TEXT, lr: 0x100, g: new Int32Array(32), gpr(r) { return this.g[r]; }, setGpr(r, v) { this.g[r] = v; } };
  for (let n = 0; st.pc !== 0x100; n++) {
    assert.ok(n < 100, "the program returns");
    interpretStep(st, s.read32);
  }
  // main: r3 = 7; double -> 14; sum: r4 = 100 | 0xf = 111, r3 = 14 + 111 = 125; r5 = 124; tailend: r7 = 125
  assert.equal(st.g[3], 125);
  assert.equal(st.g[4], 111);
  assert.equal(st.g[5], 124);
  assert.equal(st.g[7], 125);
  assert.equal(st.g[6], 0x12340000);
  assert.equal(st.g[31], 0x100);
  assert.equal(st.g[30], (TEXT + 0x10) | 0, "return point after bl sum");
});

test("every function, over 3 slices: regions and interpreter end in the same state", () => {
  const s = setup(program());
  const slices = 3;
  assert.equal(regionSlices(s.plan, { slices, maxFunctions: 2 }).flat().length, regionSlices(s.plan, { slices: 1, maxFunctions: 2 })[0].length);
  let checked = 0;
  for (let k = 0; k < slices; k++) {
    const report = run(s, { slice: k, slices, maxFunctions: 2 });
    assert.deepEqual(report.mismatches, [], `slice ${k}`);
    assert.equal(report.equal, report.checked);
    assert.ok(report.checked === 0 || report.regionRuns >= report.checked, "the checked functions ran in regions");
    checked += report.checked;
  }
  assert.equal(checked, s.plan.modules[0].functions.length, "every function checked once across the slices");
});

test("a planted translator bug is caught, in the slice that holds it", () => {
  const s = setup(program());
  // the translator gets ori wrong in one function
  const mutate = (ins) => { if (ins.kind === "ori" && ins.imm === 0x0f) ins.imm = 0x0e; };
  const reports = [0, 1].map((k) => run(s, { slice: k, slices: 2, maxFunctions: 1, mutate }));
  const mismatches = reports.flatMap((r) => r.mismatches);
  assert.ok(mismatches.length >= 1);
  // the reference still says r4 = 111 where the bug gives 110
  const m = mismatches.find((x) => x.expected);
  assert.notDeepEqual(m.expected.gpr, m.got.gpr);
});

test("functions the translator refuses run in the interpreter, regions around them still match", () => {
  const s = setup(program());
  const plan = s.plan;
  const leaf = plan.modules[0].functions.find((f) => f.ranges[0][0] !== TEXT && f.ranges[0][1] - f.ranges[0][0] === 12);
  assert.ok(leaf);
  const translate = (f) => (f === leaf ? null : translateFunction(f, s.read32));
  const report = checkSlice({ ...s, slice: 0, slices: 1, interpretStep, layout: LAYOUT, stateBytes: STATE_BYTES, translate, maxFunctions: 100 });
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.translated, plan.modules[0].functions.length - 1);
});

// The cpufuzz homebrew (ours, MIT), when it was built: most of its code is
// outside the subset, so this mostly checks that the driver copes with a real
// plan; every function the subset covers must match.
const CPUFUZZ = new URL("../harness/homebrew/out/cpufuzz.dol", import.meta.url);
test("cpufuzz over 4 slices: no mismatch on what the subset translates", { skip: !existsSync(CPUFUZZ) && "harness/homebrew/out/cpufuzz.dol not built" }, () => {
  const s = setup(readFileSync(CPUFUZZ));
  let functions = 0, mismatches = 0;
  for (let k = 0; k < 4; k++) {
    const report = run(s, { slice: k, slices: 4, maxFunctions: 40 });
    assert.ok(report.functions > 0, `slice ${k} is not empty`);
    functions += report.functions;
    mismatches += report.mismatches.length;
  }
  assert.equal(functions, s.plan.modules.reduce((n, m) => n + m.functions.length, 0));
  assert.equal(mismatches, 0);
});
