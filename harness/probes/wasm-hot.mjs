#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Top wasm functions by self time + hottest machine instructions, from a V8
// jitdump (--js-flags=--perf-prof) and raw samples. No perf inject needed: the
// jitdump carries every code object's address, size, name AND bytes
// (src/diagnostics/perf-jit.cc WriteJitCodeLoadEntry), so samples are mapped
// and disassembled here, the same way on Linux (perf) and macOS (samply).
//
//   Linux:  perf script -i perf.data -F pid,tid,time,ip --ns > samples.txt
//           node wasm-hot.mjs --jitdump jit-<pid>.dump --perf-script samples.txt
//   macOS:  node wasm-hot.mjs --jitdump jit-<pid>.dump --samply profile.json.gz
//           [--window window.json] [--weight cpu|samples]
//   common: [--tid N | --tid auto] [--top 30] [--insns 12] [--annotate 5]
//           [--out dir]  (full annotated listings of the --annotate hottest)
//
// Names: V8 writes "JS:<name>-<func index>-<tier>" (log.cc CodeEventLogger::
// CodeCreateEvent for wasm::WasmCode); <name> comes from the module's name
// section, else "wasm-function[N]" (wasm-code-manager.cc WasmCode::DebugName).
// Region functions are r<id>_f<entry PC> once region-names.patch is applied.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    jitdump: { type: "string", multiple: true }, "perf-script": { type: "string" }, samply: { type: "string" },
    window: { type: "string" }, tid: { type: "string", default: "auto" }, top: { type: "string", default: "30" },
    insns: { type: "string", default: "12" }, annotate: { type: "string", default: "5" }, out: { type: "string" },
    objdump: { type: "string", default: "objdump" }, weight: { type: "string", default: "cpu" }
  }
});
if (!o.jitdump?.length || (!o["perf-script"] && !o.samply)) {
  console.error("usage: wasm-hot.mjs --jitdump jit-PID.dump (--perf-script samples.txt | --samply profile.json[.gz]) [--tid auto|N]");
  process.exit(2);
}

// ---------- jitdump (perf-jit.cc PerfJitHeader / PerfJitCodeLoad) ----------
export function readJitdump(file) {
  const b = readFileSync(file);
  if (b.readUInt32LE(0) !== 0x4a695444) throw new Error(`${file}: not a jitdump (magic)`);
  const mach = b.readUInt32LE(12), headerSize = b.readUInt32LE(8);
  const recs = [];
  let p = headerSize, rel = 0;
  while (p + 16 <= b.length) {
    const ev = b.readUInt32LE(p), size = b.readUInt32LE(p + 4), t = b.readBigUInt64LE(p + 8);
    if (size < 16 || p + size > b.length) break; // truncated tail (process killed)
    if (ev === 0) { // kLoad
      const tid = b.readUInt32LE(p + 20);
      const start = b.readBigUInt64LE(p + 32), codeSize = Number(b.readBigUInt64LE(p + 40));
      let q = p + 56;
      const z = b.indexOf(0, q);
      const name = b.toString("utf8", q, z);
      const code = b.subarray(z + 1, z + 1 + codeSize);
      // rel: samply's address space for a jitdump "library" = the sum of the
      // code sizes of the earlier load records (samply jitdump_manager.rs).
      recs.push({ start, end: start + BigInt(codeSize), size: codeSize, name, code, t, tid, file: path.basename(file), rel });
      rel += codeSize;
    }
    p += size;
  }
  return { mach, recs };
}

// "JS:r80003100_f80003200-4-turbofan" -> { fn, index, tier }
export function parseName(n) {
  const m = /^(?:[A-Za-z]+:)?(.*)-(\d+|<anonymous>)-(liftoff|turbofan|turboshaft|none|[a-z-]+)$/.exec(n);
  if (!m) return { fn: n.replace(/^[A-Za-z]+:/, ""), index: null, tier: null, wasm: false };
  return { fn: m[1], index: m[2], tier: m[3], wasm: true };
}
export function classify(fn) {
  if (/^r[0-9a-f]{8}_f[0-9a-f]{8}$/.test(fn)) return "region";
  if (/^r[0-9a-f]{8}_(dispatch|inner|exit)$/.test(fn)) return "region-dispatch";
  if (/^wasm-function\[\d+\]$/.test(fn)) return "wasm-unnamed";
  return "other";
}

const dumps = o.jitdump.map(readJitdump);
const mach = dumps[0].mach;
const recs = dumps.flatMap((d) => d.recs).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : Number(a.t - b.t)));
const maxEnd = []; // prefix max of end, to bound the backward scan
for (let i = 0, m = 0n; i < recs.length; i++) { if (recs[i].end > m) m = recs[i].end; maxEnd.push(m); }

// The code object holding ip at time t: among records covering ip, the
// latest loaded at or before t (wasm code GC can reuse an address).
function lookup(ip, t) {
  let lo = 0, hi = recs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (recs[mid].start <= ip) lo = mid + 1; else hi = mid; }
  let best = null;
  for (let i = lo - 1; i >= 0 && maxEnd[i] > ip; i--) {
    const r = recs[i];
    if (ip >= r.end) continue;
    if (t != null && r.t > t) continue;
    if (!best || r.t > best.t) best = r;
  }
  return best;
}

// ---------- samples: [{ tid, t (ns, jitdump clock) | null, ip: BigInt, thread }] ----------
function perfSamples(file) {
  // perf script -F pid,tid,time,ip --ns   (perf record -k mono, same clock as
  // base::TimeTicks on Linux, which stamps the jitdump records)
  // With perf record -g the ip is not on the header line: the call chain
  // follows, one frame per indented line, leaf first; the leaf is the sample.
  const out = [];
  let pending = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(\d+)\/(\d+)\s+(\d+)\.(\d+):\s*([0-9a-f]+)?\s*$/.exec(line);
    if (m) {
      const t = BigInt(m[3]) * 1_000_000_000n + BigInt(m[4].padEnd(9, "0").slice(0, 9));
      const s = { pid: +m[1], tid: +m[2], t, ip: null, thread: null, w: 1 }; // perf samples on-CPU only
      if (m[5]) { s.ip = BigInt("0x" + m[5]); out.push(s); pending = null; } else pending = s;
      continue;
    }
    const f = pending && /^\s+([0-9a-f]+)\b/.exec(line);
    if (f) { pending.ip = BigInt("0x" + f[1]); out.push(pending); pending = null; }
  }
  return out;
}

function samplySamples(file, win) {
  // samply 0.13 saves the Firefox profiler "processed" format: per thread a
  // samples table (stack, time), a stackTable (frame, prefix) and a
  // frameTable (address, func -> resource -> lib). A frame in a jitdump
  // "library" has a relative address in samply's jitdump space (cumulative
  // code sizes, see readJitdump), mapped back here to the record and the
  // offset in its code. Other frames (Chrome / V8 C++) keep their name only.
  let raw = readFileSync(file);
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);
  const prof = JSON.parse(raw.toString("utf8"));
  const start = prof.meta.startTime; // ms since epoch
  const libs = prof.libs ?? [];
  const byFile = new Map();
  for (const r of recs) { const a = byFile.get(r.file) ?? []; a.push(r); byFile.set(r.file, a); }
  const relLookup = (f, rel) => {
    const a = byFile.get(f);
    if (!a) return null;
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid].rel <= rel) lo = mid + 1; else hi = mid; }
    const r = a[lo - 1];
    return r && rel < r.rel + r.size ? r : null;
  };
  for (const a of byFile.values()) a.sort((x, y) => x.rel - y.rel);
  const out = [];
  for (const th of prof.threads) {
    const s = th.samples, st = th.stackTable, ft = th.frameTable, fu = th.funcTable, rt = th.resourceTable;
    const times = s.time ?? (() => { let acc = 0; return s.timeDeltas.map((d) => (acc += d)); })();
    for (let i = 0; i < s.length; i++) {
      const stack = s.stack[i];
      if (stack == null) continue;
      const tMs = start + times[i];
      if (win && (tMs < win.start || tMs > win.end)) continue;
      const frame = st.frame[stack];
      const func = ft.func[frame];
      const res = fu.resource[func];
      const lib = res != null && res >= 0 ? libs[rt.lib[res]] : null;
      const addr = ft.address[frame];
      let rec = null, off = null;
      if (lib && /\.dump$/.test(lib.path ?? "") && addr >= 0) {
        rec = relLookup(path.basename(lib.path), addr);
        if (rec) off = addr - rec.rel;
      }
      // Weight: samply merges identical consecutive samples (samples.weight)
      // and records the thread's CPU time since the previous sample
      // (threadCPUDelta, µs). --weight cpu (default) counts CPU time, so a
      // thread blocked in a wait weighs nothing; --weight samples counts
      // wall-clock samples.
      const w = o.weight === "samples" ? (s.weight?.[i] ?? 1) : (s.threadCPUDelta?.[i] ?? s.weight?.[i] ?? 1);
      if (!w) continue;
      out.push({ w, pid: th.pid, tid: Number(th.tid), t: null, ip: null, rec, off, thread: `${th.processName ?? ""}:${th.name ?? ""}`, native: rec ? null : `${th.stringArray[fu.name[func]] ?? "?"} (${lib?.name ?? "?"})` });
    }
  }
  return out;
}

const win = o.window ? JSON.parse(readFileSync(o.window, "utf8")) : null;
let samples = o["perf-script"] ? perfSamples(o["perf-script"]) : samplySamples(o.samply, win);
if (win && o["perf-script"] && win.monoStartNs) samples = samples.filter((s) => s.t >= BigInt(win.monoStartNs) && s.t <= BigInt(win.monoEndNs));

// ---------- per thread ----------
const threads = new Map();
for (const s of samples) {
  if (s.ip != null) { s.rec = lookup(s.ip, s.t); s.off = s.rec ? Number(s.ip - s.rec.start) : null; }
  const r = s.rec;
  const th = threads.get(s.tid) ?? { tid: s.tid, name: s.thread, n: 0, wasm: 0, region: 0 };
  th.n += s.w;
  if (r) { const { fn, wasm } = parseName(r.name); if (wasm) th.wasm += s.w; const c = classify(fn); if (c === "region" || c === "region-dispatch") th.region += s.w; }
  threads.set(s.tid, th);
}
const thList = [...threads.values()].sort((a, b) => b.region - a.region || b.wasm - a.wasm);
console.log(`jitdump: ${recs.length} code objects (${dumps.length} file(s)), e_machine ${mach}; samples: ${samples.length}`);
console.log("\nthreads (most region samples first):");
console.log(`   tid      name                         ${o["perf-script"] ? "samples" : o.weight === "samples" ? "samples" : "cpu ms "}   in wasm   in regions`);
for (const th of thList.slice(0, 8)) console.log(`  ${String(th.tid).padStart(8)}  ${String(th.name ?? "").slice(0, 28).padEnd(28)} ${String(o.samply && o.weight !== "samples" ? Math.round(th.n / 1000) : th.n).padStart(8)}  ${pct(th.wasm, th.n).padStart(7)}  ${pct(th.region, th.n).padStart(9)}`);
const tid = o.tid === "auto" ? thList[0]?.tid : Number(o.tid);
const mine = samples.filter((s) => s.tid === tid);
const total = mine.reduce((a, s) => a + s.w, 0);
console.log(`\nthread ${tid}: ${mine.length} samples, weight ${total}${o.samply && o.weight !== "samples" ? " µs CPU" : ""} (the emulated CPU thread = most samples in regions, when --tid auto)`);

function pct(a, b) { return b ? `${((100 * a) / b).toFixed(1)} %` : "-"; }

// ---------- functions by self time ----------
const byRec = new Map(); // rec -> { n, offs: Map(offset -> n) }
const byClass = new Map();
let unknown = 0;
const natives = new Map();
for (const s of mine) {
  if (!s.rec) { unknown += s.w; if (s.native) natives.set(s.native, (natives.get(s.native) ?? 0) + s.w); continue; }
  const e = byRec.get(s.rec) ?? { rec: s.rec, n: 0, offs: new Map() };
  e.n += s.w;
  const off = s.off;
  e.offs.set(off, (e.offs.get(off) ?? 0) + s.w);
  byRec.set(s.rec, e);
}
// Same function, several code objects (liftoff + turbofan, several isolates):
// keep them apart (tier matters), but merge identical name+tier.
const byFn = new Map();
for (const e of byRec.values()) {
  const key = e.rec.name;
  const f = byFn.get(key) ?? { name: key, n: 0, parts: [] };
  f.n += e.n; f.parts.push(e);
  byFn.set(key, f);
  const c = classify(parseName(key).fn);
  byClass.set(c, (byClass.get(c) ?? 0) + e.n);
}
byClass.set("not in jitdump (C++ / kernel / other)", unknown);
console.log("\nby kind (self samples):");
for (const [c, n] of [...byClass].sort((a, b) => b[1] - a[1])) console.log(`  ${pct(n, total).padStart(8)}  ${c}`);

if (natives.size) {
  console.log("  outside the jitdump, top 8 leaf frames:");
  for (const [n, c] of [...natives].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`    ${pct(c, total).padStart(7)}  ${n.slice(0, 90)}`);
}

const top = [...byFn.values()].sort((a, b) => b.n - a.n).slice(0, Number(o.top));
console.log(`\ntop ${top.length} functions by self samples (thread ${tid}):`);
console.log("   self    cum    bytes  tier        function");
let cum = 0;
for (const f of top) {
  cum += f.n;
  const { fn, tier } = parseName(f.name);
  const size = Math.max(...f.parts.map((p) => p.rec.size));
  console.log(`  ${pct(f.n, total).padStart(7)} ${pct(cum, total).padStart(7)} ${String(size).padStart(7)}  ${String(tier ?? "-").padEnd(10)}  ${fn}`);
}

// ---------- hottest instructions ----------
function elfFor(code, machine) {
  // Minimal ELF64 LE relocatable: null, .text, .shstrtab. objdump reads the
  // architecture from e_machine (183 arm64, 62 x86-64).
  const shstr = Buffer.from("\0.text\0.shstrtab\0");
  const textOff = 64, strOff = textOff + code.length, shOff = (strOff + shstr.length + 7) & ~7;
  const b = Buffer.alloc(shOff + 3 * 64);
  b.write("\x7fELF", 0, "latin1"); b[4] = 2; b[5] = 1; b[6] = 1;
  b.writeUInt16LE(1, 16); b.writeUInt16LE(machine, 18); b.writeUInt32LE(1, 20);
  b.writeBigUInt64LE(BigInt(shOff), 40); b.writeUInt16LE(64, 52); b.writeUInt16LE(64, 58);
  b.writeUInt16LE(3, 60); b.writeUInt16LE(2, 62);
  Buffer.from(code).copy(b, textOff); shstr.copy(b, strOff);
  const sh = (i, name, type, flags, off, size, align) => {
    const q = shOff + i * 64;
    b.writeUInt32LE(name, q); b.writeUInt32LE(type, q + 4); b.writeBigUInt64LE(BigInt(flags), q + 8);
    b.writeBigUInt64LE(BigInt(off), q + 24); b.writeBigUInt64LE(BigInt(size), q + 32); b.writeBigUInt64LE(BigInt(align), q + 48);
  };
  sh(1, 1, 1, 0x6, textOff, code.length, 4); // .text PROGBITS AX
  sh(2, 7, 3, 0, strOff, shstr.length, 1);   // .shstrtab STRTAB
  return b;
}

function disassemble(code, machine) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wasm-hot-"));
  try {
    const f = path.join(dir, "code.o");
    writeFileSync(f, elfFor(code, machine));
    const txt = execFileSync(o.objdump, ["-d", "--no-show-raw-insn", f], { encoding: "utf8", maxBuffer: 1 << 28 });
    const ins = [];
    for (const line of txt.split("\n")) {
      const m = /^\s*([0-9a-f]+):\s+(.*)$/.exec(line);
      if (m) ins.push({ off: parseInt(m[1], 16), text: m[2].replace(/\s+/g, " ").trim() });
    }
    return ins;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (o.out) mkdirSync(o.out, { recursive: true });
const nAnn = Number(o.annotate), nIns = Number(o.insns);
for (const f of top.slice(0, nAnn)) {
  const part = f.parts.sort((a, b) => b.n - a.n)[0]; // hottest code object of that name
  const ins = disassemble(part.rec.code, mach);
  const hits = new Map(); // instruction index -> n (sample pc mapped to the instruction holding it)
  for (const [off, n] of part.offs) {
    let lo = 0, hi = ins.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ins[mid].off <= off) lo = mid + 1; else hi = mid; }
    const k = Math.max(0, lo - 1);
    hits.set(k, (hits.get(k) ?? 0) + n);
  }
  console.log(`\n== ${parseName(f.name).fn} [${parseName(f.name).tier}]  ${pct(f.n, total)} of thread, ${ins.length} instructions, ${part.rec.size} bytes`);
  const hot = [...hits].sort((a, b) => b[1] - a[1]).slice(0, nIns);
  for (const [k, n] of hot) {
    // The sampled pc is the next instruction to run: the cost often belongs
    // to the one before it (a load, a divide, a mispredicted branch), shown
    // after "prev:". Linux perf with cycles adds a few instructions of skid.
    const prev = k > 0 ? `   [prev ${ins[k - 1].off.toString(16)}: ${ins[k - 1].text}]` : "";
    console.log(`  ${pct(n, part.n).padStart(7)}  ${ins[k].off.toString(16).padStart(5)}: ${ins[k].text.padEnd(38)}${prev}`);
  }
  if (o.out) {
    const safe = parseName(f.name).fn.replace(/[^\w.-]+/g, "_").slice(0, 80);
    const lines = ins.map((x, j) => `${(hits.get(j) ? pct(hits.get(j), part.n) : "").padStart(8)}  ${x.off.toString(16).padStart(5)}: ${x.text}`);
    writeFileSync(path.join(o.out, `${safe}-${parseName(f.name).tier}.asm.txt`), `${f.name}\n${lines.join("\n")}\n`);
  }
}
