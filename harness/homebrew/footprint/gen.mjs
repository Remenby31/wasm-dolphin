#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// footprint: the PowerPC code of the CI bench's front-end workload
// (research/deep-x64-ci-bench.md §4.4). Writes GNU assembly for powerpc-eabi:
//
//   node harness/homebrew/footprint/gen.mjs [--functions 1024] [--seed 0x5eed]
//
// Static code in the DOL (the region planner of aot=1 sees it, unlike code
// written at run time), deterministic from the seed. N functions, swept in
// order by fp_run (main.c calls it in a loop, never waiting for a VI):
//   - blocks of integer ALU, loads/stores to the data area (r30), scalar FP
//     (lfd/fmadd/stfd) and paired singles (psq_l/ps_madd/psq_st, emitted as
//     .long: no assembler support needed);
//   - branches on a shared xorshift state (r29) at several biases, a 4-way
//     jump table (bctr), short counted loops (bdnz);
//   - one cold block inline per function, taken about once in 4096 calls
//     (an error check's slow path);
//   - 0-2 calls each, gated on the state, to later functions only (no
//     recursion): direct (bl) or through a per-function table (bctrl).
// Registers: r29 the state, r28 the running hash, r30 the data area, r31
// the function table, r26-r27 the driver's counters; generated code uses
// only r0, r3-r12 and f0-f13 besides r28/r29, and keeps r30/r31.
// Our code only: no game content, no SDK.
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { functions: { type: "string", default: "1024" }, seed: { type: "string", default: "0x5eed4f50" } } });
const N = Number(values.functions);
let rng = Number(values.seed) >>> 0 || 1;
const rnd = () => { rng ^= rng << 13; rng >>>= 0; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return rng; };
const R = (n) => rnd() % n;
const pick = (a) => a[R(a.length)];

// Paired-single encodings (Gekko): psq_l/psq_st (opcodes 56/60, W=0,
// I=0: GQR0, float), ps_add (4/21), ps_mul (4/25), ps_madd (4/29).
const word = (w) => `\t.long 0x${(w >>> 0).toString(16).padStart(8, "0")}`;
const psq = (op, frD, d, rA) => word((op << 26) | (frD << 21) | (rA << 16) | (d & 0xfff));
const psA = (xo, D, A, B, C) => word((4 << 26) | (D << 21) | (A << 16) | (B << 11) | (C << 6) | (xo << 1));

const out = [];
const emit = (...s) => out.push(...s);
let label = 0;
const L = () => `.L${label++}`;

const GPR = [3, 4, 5, 6, 7, 8, 9, 10];
const g = () => pick(GPR);
function alu(n) {
  for (let k = 0; k < n; k++) {
    const [d, a, b] = [g(), g(), g()];
    switch (R(10)) {
      case 0: emit(`\tadd ${d},${a},${b}`); break;
      case 1: emit(`\tsubf ${d},${a},${b}`); break;
      case 2: emit(`\txor ${d},${a},29`); break;
      case 3: emit(`\tand ${d},${a},${b}`); break;
      case 4: emit(`\tor ${d},${a},${b}`); break;
      case 5: emit(`\trlwinm ${d},${a},${R(32)},${R(16)},${16 + R(16)}`); break;
      case 6: emit(`\tmullw ${d},${a},${b}`); break;
      case 7: emit(`\taddi ${d},${a},${R(2000) - 1000}`); break;
      case 8: emit(`\tsrawi ${d},${a},${R(31) + 1}`); break;
      default: emit(`\tadde ${d},${a},${b}`); break;
    }
  }
}
// The state: one xorshift step.
function step() { emit("\tslwi 11,29,13", "\txor 29,29,11", "\tsrwi 11,29,17", "\txor 29,29,11", "\tslwi 11,29,5", "\txor 29,29,11"); }
// The data area (main.c): 0-2047 float pairs (read only), 2048-4095 their
// results (written only), 4096-16383 words (read and written), 16384-28671
// doubles (read only), 28672-32767 their results (written only). FP and PS
// inputs never change, so no value drifts to Inf or NaN.
function mem() {
  emit("\trlwinm 11,29,2,19,29", "\taddi 11,11,4096"); // 4096..12284, word aligned
  emit(`\tlwzx ${g()},30,11`);
  alu(2);
  emit(`\tstwx ${g()},30,11`);
  emit(`\tlwz ${g()},${4096 + R(3072) * 4}(30)`);
  emit(`\tsth ${g()},${12288 + R(2000) * 2}(30)`);
}
function fp() {
  const off = () => 16384 + R(1536) * 8; // 16384..28664
  emit(`\tlfd 1,${off()}(30)`, `\tlfd 2,${off()}(30)`, `\tlfd 3,${off()}(30)`);
  emit(pick(["\tfmadd 4,1,2,3", "\tfmsub 4,1,2,3", "\tfnmadd 4,1,2,3"]), "\tfmul 5,4,1", "\tfadd 6,5,2", "\tfrsp 6,6");
  emit(`\tstfd 6,${28672 + R(512) * 8}(30)`);
}
function ps() {
  const off = () => R(256) * 8; // 0..2040 (psq displacement: 12 bits signed)
  emit(psq(56, 7, off(), 30), psq(56, 8, off(), 30), psq(56, 9, off(), 30));
  emit(psA(29, 10, 7, 9, 8), psA(21, 11, 10, 7, 0), psA(25, 12, 11, 0, 8)); // ps_madd, ps_add, ps_mul
  emit("\taddi 12,30,2048", psq(60, 12, off(), 12)); // results: 2048..4088
}
// A branch on the state: taken with probability 1 - 2^-bits.
function branchy() {
  const bits = pick([1, 1, 2, 3, 5]);
  const skip = L();
  const at = R(33 - bits); // bits at..at+bits-1 of the state
  emit(`\trlwinm. 0,29,0,${at},${at + bits - 1}`);
  emit(`\t${pick(["beq", "bne"])} ${skip}`);
  alu(2 + R(5));
  emit(`${skip}:`);
}
function loop() {
  const top = L();
  emit(`\tli 0,${4 + R(12)}`, "\tmtctr 0", `${top}:`);
  alu(3 + R(3));
  emit(`\tbdnz ${top}`);
}
const rodata = [];
function jumpTable() {
  const cases = [L(), L(), L(), L()], end = L(), table = L();
  emit("\trlwinm 11,29,2,28,29", `\tlis 12,${table}@ha`, `\taddi 12,12,${table}@l`, "\tlwzx 12,12,11", "\tmtctr 12", "\tbctr");
  for (const c of cases) { emit(`${c}:`); alu(3 + R(6)); emit(`\tb ${end}`); }
  emit(`${end}:`);
  rodata.push(`${table}:`, ...cases.map((c) => `\t.long ${c}`));
}
// The cold path: inline, taken when 12 bits of the state are zero.
function cold() {
  const hot = L();
  emit("\trlwinm. 0,29,0,20,31", `\tbne ${hot}`);
  alu(10 + R(10)); fp(); mem(); alu(10 + R(15));
  emit(`${hot}:`);
}
function calls(i) {
  const later = N - i - 1;
  if (later <= 0) return;
  const n = R(3);
  for (let k = 0; k < n; k++) {
    const skip = L();
    emit("\trlwinm. 0,29,0,30,31", `\tbne ${skip}`); // 1 in 4
    if (R(2)) {
      emit(`\tbl fp_f${i + 1 + R(later)}`);
    } else {
      const t = L();
      emit("\trlwinm 11,29,2,28,29", `\tlis 12,${t}@ha`, `\taddi 12,12,${t}@l`, "\tlwzx 12,12,11", "\tmtctr 12", "\tbctrl");
      rodata.push(`${t}:`, ...[0, 1, 2, 3].map(() => `\t.long fp_f${i + 1 + R(later)}`));
    }
    emit(`${skip}:`);
  }
}

emit("# Generated by harness/homebrew/footprint/gen.mjs: do not edit.", `# functions ${N}, seed ${values.seed}`, "\t.text");
for (let i = 0; i < N; i++) {
  emit("\t.align 2", `fp_f${i}:`, "\tstwu 1,-32(1)", "\tmflr 0", "\tstw 0,36(1)");
  const blocks = 6 + R(6);
  const coldAt = R(blocks);
  for (let b = 0; b < blocks; b++) {
    step();
    const kind = R(16);
    if (kind < 4) alu(6 + R(9));
    else if (kind < 7) mem();
    else if (kind < 9) fp();
    else if (kind < 10) ps();
    else if (kind < 13) branchy();
    else if (kind < 14) loop();
    else jumpTable();
    if (b === coldAt) cold();
  }
  calls(i);
  emit(`\txor 28,28,${g()}`, "\trotlwi 28,28,7", `\tadd 28,28,${g()}`);
  emit("\tlwz 0,36(1)", "\tmtlr 0", "\taddi 1,1,32", "\tblr");
}
// fp_run(data, sweeps, table) -> hash: every function once per sweep, in order.
emit("\t.align 2", "\t.globl fp_run", "fp_run:",
  "\tstwu 1,-64(1)", "\tmflr 0", "\tstw 0,68(1)", "\tstmw 26,40(1)",
  "\tmr 30,3", "\tmr 27,4", "\tmr 31,5", `\tlis 29,0x${((Number(values.seed) >>> 16) || 1).toString(16)}`, `\tori 29,29,0x${(Number(values.seed) & 0xffff).toString(16)}`, "\tli 28,0",
  ".Lsweep:", "\tli 26,0",
  ".Lnext:", "\tslwi 11,26,2", "\tlwzx 12,31,11", "\tmtctr 12", "\tbctrl",
  "\taddi 26,26,1", `\tcmplwi 26,${N}`, "\tblt .Lnext",
  "\tsubic. 27,27,1", "\tbne .Lsweep",
  "\tmr 3,28", "\tlmw 26,40(1)", "\tlwz 0,68(1)", "\tmtlr 0", "\taddi 1,1,64", "\tblr");
emit("\t.section .rodata", "\t.align 2", "\t.globl fp_functions", "fp_functions:");
for (let i = 0; i < N; i++) emit(`\t.long fp_f${i}`);
emit(...rodata);
emit("\t.globl fp_function_count", "fp_function_count:", `\t.long ${N}`);
process.stdout.write(out.join("\n") + "\n");
