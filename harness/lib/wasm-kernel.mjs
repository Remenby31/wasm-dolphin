// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// A generated single-thread Wasm kernel for the PC kit's calibration bench
// (harness/probes/pc-bench.mjs): many small functions reached by
// call_indirect from a dispatch loop, each a seeded random mix of the
// operations the emulator's regions are made of (integer ALU, rotates, the
// and/shift/or byteswap of a big-endian guest, loads and stores into guest
// RAM, an f64 round trip with a saturating truncation). Two shapes:
//   core   8 functions, 16 KiB of memory: stays in L1, the predictor learns
//          the dispatch (cpu-bench's shape: execution speed);
//   front  2048 functions (~830 KiB of wasm), 4 MiB of memory: overflows the
//          32-48 KiB L1i and the L2, mispredicts the indirect call (the
//          front-end-bound side of the emulator, research/deep-x86-windows.md
//          §2.5).
// The module is built here, byte by byte, with no toolchain; `reference`
// runs the same operations in JS and gives the same checksum (tests).
// Deterministic for a given seed.

const OPS = ["add", "xor", "mul", "rotl", "shru", "load", "store", "bswap", "f64"];

export const SHAPES = Object.freeze({
  core: Object.freeze({ funcs: 8, memWords: 4096, opsPerFunc: 24, seed: 0x5a17 }),
  front: Object.freeze({ funcs: 2048, memWords: 1 << 20, opsPerFunc: 24, seed: 0x5a17 }),
  // The JIT's tell, not in the score: one loop over 16 live i32 locals, no
  // call, no memory. Liftoff keeps them on the stack (x64: more than 5
  // locals are spilled, research/deep-x86-windows.md §1.3), TurboFan in
  // registers; the core kernel, bound by call_indirect and memory, showed
  // no gap between the two on CI windows-2025.
  alu: Object.freeze({ kind: "alu", locals: 16, seed: 0x5a17 })
});
// The kernels the score is made of.
export const SCORE_KERNELS = Object.freeze(["core", "front"]);

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x;
  };
}

// The operation list of every function: [kind, immediate].
export function kernelPlan({ funcs, memWords, opsPerFunc, seed }) {
  if (!Number.isInteger(Math.log2(funcs)) || !Number.isInteger(Math.log2(memWords))) throw new Error("funcs and memWords must be powers of two");
  const r = rng(seed);
  return Array.from({ length: funcs }, () => Array.from({ length: opsPerFunc }, () => {
    const kind = OPS[r() % OPS.length];
    const imm = kind === "rotl" || kind === "shru" || kind === "load" || kind === "store" ? 1 + (r() % 13) : (r() | 1) >>> 0;
    return [kind, imm];
  }));
}

// ---- wasm encoding
const uleb = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const sleb = (v) => {
  const out = [];
  v |= 0;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && b & 0x40)) { out.push(b); return out; }
    out.push(b | 0x80);
  }
};
const i32c = (v) => [0x41, ...sleb(v | 0)];
const f64c = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return [0x44, ...b]; };
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const str = (s) => vec([...new TextEncoder().encode(s)].map((c) => [c]));

const X = 0, Y = 1; // locals of a kernel function: x (the param), y
const get = (l) => [0x20, l], set = (l) => [0x21, l];
const ADD = 0x6a, MUL = 0x6c, AND = 0x71, OR = 0x72, XOR = 0x73, SHL = 0x74, SHRU = 0x76, ROTL = 0x77;

function addrOf(shift, memWords) {
  // ((x >>> shift) & (memWords - 1)) << 2
  return [...get(X), ...i32c(shift), SHRU, ...i32c(memWords - 1), AND, ...i32c(2), SHL];
}

function emitOp([kind, imm], memWords) {
  switch (kind) {
    case "add": return [...get(X), ...i32c(imm), ADD, ...set(X)];
    case "xor": return [...get(X), ...i32c(imm), XOR, ...set(X)];
    case "mul": return [...get(X), ...i32c(imm), MUL, ...get(Y), ADD, ...set(X)];
    case "rotl": return [...get(X), ...i32c(imm), ROTL, ...set(X)];
    case "shru": return [...get(X), ...get(X), ...i32c(imm), SHRU, XOR, ...set(Y)];
    case "load": return [...addrOf(imm, memWords), 0x28, 2, 0, ...get(X), XOR, ...set(X)];
    case "store": return [...addrOf(imm, memWords), ...get(X), ...get(Y), ADD, 0x36, 2, 0];
    case "bswap": return [
      ...get(X), ...i32c(24), SHL,
      ...get(X), ...i32c(0xff00), AND, ...i32c(8), SHL, OR,
      ...get(X), ...i32c(8), SHRU, ...i32c(0xff00), AND, OR,
      ...get(X), ...i32c(24), SHRU, OR, ...set(X)];
    case "f64": return [...get(X), 0xb8, ...f64c(0.75), 0xa2, 0xfc, 0x03, ...get(Y), XOR, ...set(Y)];
    default: throw new Error(`unknown op ${kind}`);
  }
}

function aluPlan({ locals, seed }) {
  const r = rng(seed);
  return {
    init: Array.from({ length: locals }, () => r() >>> 0),
    steps: Array.from({ length: locals }, (_, i) => ({ j: (i + 1) % locals, k: (i + 5) % locals, rot: 1 + (r() % 31), mul: (r() | 1) >>> 0 }))
  };
}
// run(n): n rounds of v[i] = rotl(v[i] ^ v[j], rot) + v[k] * mul over every
// local; returns their xor.
function buildAlu(shape) {
  const { init, steps } = aluPlan(shape);
  const L = shape.locals, N = 0, CNT = L + 1, V = (i) => 1 + i;
  const code = [
    ...init.flatMap((v, i) => [...i32c(v), ...set(V(i))]),
    0x02, 0x40, ...get(N), 0x45, 0x0d, 0,
    0x03, 0x40,
    ...steps.flatMap((st, i) => [...get(V(i)), ...get(V(st.j)), XOR, ...i32c(st.rot), ROTL, ...get(V(st.k)), ...i32c(st.mul), MUL, ADD, ...set(V(i))]),
    ...get(CNT), ...i32c(1), ADD, 0x22, CNT, ...get(N), 0x49, 0x0d, 0,
    0x0b, 0x0b,
    ...get(V(0)), ...init.slice(1).flatMap((_, i) => [...get(V(i + 1)), XOR])
  ];
  const b = [...vec([[L + 1, 0x7f]]), ...code, 0x0b];
  const T = [0x60, 1, 0x7f, 1, 0x7f];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec([T])), ...section(3, vec([[0]])),
    ...section(7, vec([[...str("run"), 0x00, 0]])),
    ...section(10, vec([[...uleb(b.length), ...b]]))
  ]);
}

// The module: functions 0..funcs-1 (i32) -> i32 in a table, `run(n)` the
// dispatch loop, `memory` exported (the alu shape: its own loop).
export function buildKernel(shape) {
  if (shape.kind === "alu") return buildAlu(shape);
  const plan = kernelPlan(shape);
  const { funcs, memWords } = shape;
  const T = [0x60, 1, 0x7f, 1, 0x7f];
  const body = (locals, code) => { const b = [...vec(locals), ...code, 0x0b]; return [...uleb(b.length), ...b]; };
  const kernelBodies = plan.map((ops) => body([[1, 0x7f]], [...ops.flatMap((op) => emitOp(op, memWords)), ...get(X), ...get(Y), XOR]));
  // run(n): s = seed; for (i = 0; i < n; i++) s = table[(s >>> 7) & (funcs-1)](s) + i; return s
  const S = 1, I = 2;
  const runBody = body([[2, 0x7f]], [
    ...i32c(0x1234567), ...set(S),
    0x02, 0x40, // block (n == 0: skip)
    ...get(0), 0x45, 0x0d, 0, // i32.eqz n; br_if 0
    0x03, 0x40,
    ...get(S), ...get(S), ...i32c(7), SHRU, ...i32c(funcs - 1), AND, 0x11, 0, 0,
    ...get(I), ADD, ...set(S),
    ...get(I), ...i32c(1), ADD, 0x22, I, ...get(0), 0x49, 0x0d, 0,
    0x0b, 0x0b,
    ...get(S)
  ]);
  const pages = Math.max(1, (memWords * 4) / 65536);
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec([T])),
    ...section(3, vec(Array.from({ length: funcs + 1 }, () => [0]))),
    ...section(4, vec([[0x70, 0x00, ...uleb(funcs)]])),
    ...section(5, vec([[0x00, ...uleb(pages)]])),
    ...section(7, vec([[...str("run"), 0x00, ...uleb(funcs)], [...str("memory"), 0x02, 0]])),
    ...section(9, vec([[0x00, ...i32c(0), 0x0b, ...vec(Array.from({ length: funcs }, (_, i) => uleb(i)))]])),
    ...section(10, vec([...kernelBodies, runBody]))
  ];
  return new Uint8Array(bytes);
}

// The same computation in JS (a checksum for tests; never timed).
export function reference(shape, n) {
  if (shape.kind === "alu") {
    const { init, steps } = aluPlan(shape);
    const v = Uint32Array.from(init);
    for (let c = 0; c < n; c += 1) {
      for (let i = 0; i < v.length; i += 1) {
        const st = steps[i], x = (v[i] ^ v[st.j]) >>> 0;
        v[i] = (((x << st.rot) | (x >>> (32 - st.rot))) + Math.imul(v[st.k], st.mul)) >>> 0;
      }
    }
    return v.reduce((h, x) => (h ^ x) >>> 0, 0);
  }
  const plan = kernelPlan(shape);
  const mem = new Uint32Array(shape.memWords);
  const mask = shape.memWords - 1;
  const call = (ops, x) => {
    let y = 0;
    for (const [kind, imm] of ops) {
      switch (kind) {
        case "add": x = (x + imm) >>> 0; break;
        case "xor": x = (x ^ imm) >>> 0; break;
        case "mul": x = (Math.imul(x, imm) + y) >>> 0; break;
        case "rotl": x = ((x << imm) | (x >>> (32 - imm))) >>> 0; break;
        case "shru": y = (x ^ (x >>> imm)) >>> 0; break;
        case "load": x = (mem[(x >>> imm) & mask] ^ x) >>> 0; break;
        case "store": mem[(x >>> imm) & mask] = (x + y) >>> 0; break;
        case "bswap": x = ((x << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24)) >>> 0; break;
        case "f64": y = (Math.floor(x * 0.75) ^ y) >>> 0; break;
      }
    }
    return (x ^ y) >>> 0;
  };
  let s = 0x1234567;
  for (let i = 0; i < n; i += 1) s = (call(plan[(s >>> 7) & (shape.funcs - 1)], s) + i) >>> 0;
  return s;
}
