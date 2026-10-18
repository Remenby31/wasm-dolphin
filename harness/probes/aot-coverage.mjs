#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Coverage of ahead-of-time discovery (docs/aot-plan.md): which share of the
// guest code a scene runs was already in the plan.
//
//   record: boot a disc headless, optionally load a savestate and hold a key,
//           then sample the emulated PC for --secs seconds.
//     node harness/probes/aot-coverage.mjs record --iso disc.iso --port N --out samples.json
//       [--state scene.sav] [--warmup 25] [--secs 20] [--hold KeyX] [--query "..."]
//   report: coverage of recorded samples by the static plan, then by the plan
//           built with a profile made of other recordings (other scenes).
//     node harness/probes/aot-coverage.mjs report --iso disc.iso --samples a.json [--profile b.json ...]
//
// The sampler is a worker spinning on the shared wasm heap, reading
// PowerPCState.pc where GetPPCPC reads it (location taken from the core's own
// code, see pcLocationFromWasm). It sees the PC where the core stores it, at
// block dispatch: the unit that counts is the distinct PC (an entry into
// compiled code). Time shares are reported too but are dominated by hot and
// idle loops.
import { openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { blocksFromPcSamples } from "../../src/aot-profile.js";
import { planDisc } from "../../src/aot-recomp.js";

const isMain = import.meta.url === `file://${process.argv[1]}`;
const [mode, ...rest] = isMain ? process.argv.slice(2) : [];
const values = isMain ? parseArgs({
  args: rest,
  options: {
    iso: { type: "string" },
    port: { type: "string", default: process.env.HARNESS_PORT },
    out: { type: "string" },
    state: { type: "string" },
    warmup: { type: "string", default: "25" },
    secs: { type: "string", default: "20" },
    hold: { type: "string", default: "" },
    query: { type: "string" },
    samples: { type: "string" },
    profile: { type: "string", multiple: true, default: [] }
  }
}).values : {};

// Little-endian LEB128.
function leb(bytes, p) {
  let result = 0, shift = 0, b;
  do {
    b = bytes[p++];
    result += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return [result, p];
}

// Body of the wasm function exported as `exportName`.
export function wasmFunctionBody(wasm, exportName) {
  let pos = 8, importedFuncs = 0, funcIndex = null;
  while (pos < wasm.length) {
    const id = wasm[pos];
    const [size, start] = leb(wasm, pos + 1);
    const end = start + size;
    let p = start;
    if (id === 2) {
      let count; [count, p] = leb(wasm, p);
      for (let i = 0; i < count; i++) {
        let len; [len, p] = leb(wasm, p); p += len;
        [len, p] = leb(wasm, p); p += len;
        const kind = wasm[p++];
        if (kind === 0) { [, p] = leb(wasm, p); importedFuncs++; }
        else if (kind === 1) { p++; let fl; [fl, p] = leb(wasm, p); [, p] = leb(wasm, p); if (fl & 1) [, p] = leb(wasm, p); }
        else if (kind === 2) { let fl; [fl, p] = leb(wasm, p); [, p] = leb(wasm, p); if (fl & 1) [, p] = leb(wasm, p); }
        else if (kind === 3) p += 2;
        else if (kind === 4) { p++; [, p] = leb(wasm, p); }
      }
    } else if (id === 7) {
      let count; [count, p] = leb(wasm, p);
      for (let i = 0; i < count; i++) {
        let len; [len, p] = leb(wasm, p);
        const name = new TextDecoder().decode(wasm.subarray(p, p + len)); p += len;
        const kind = wasm[p++];
        let index; [index, p] = leb(wasm, p);
        if (kind === 0 && name === exportName) funcIndex = index;
      }
    } else if (id === 10 && funcIndex !== null) {
      let count; [count, p] = leb(wasm, p);
      for (let i = 0; i < count; i++) {
        let bodySize; [bodySize, p] = leb(wasm, p);
        if (i === funcIndex - importedFuncs) return wasm.subarray(p, p + bodySize);
        p += bodySize;
      }
    }
    pos = end;
  }
  return null;
}

// GetPPCPC reads `*(u32*)ptr + offset`: i32.const ptr; i32.load; i32.load offset=off.
export function pcLocationFromBody(body) {
  for (let i = 0; i < body.length - 8; i++) {
    if (body[i] !== 0x41) continue;
    const [ptr, p] = leb(body, i + 1);
    if (body[p] === 0x28 && body[p + 1] === 0x02 && body[p + 2] === 0x00 && body[p + 3] === 0x28 && body[p + 4] === 0x02) {
      const [offset] = leb(body, p + 5);
      return { ptr, offset };
    }
  }
  return null;
}

export function pcLocationFromCore(coreDir) {
  const glue = readFileSync(path.join(coreDir, "dolphin-core-upstream.js"), "utf8");
  const name = /"_GetPPCPC"\]\s*=\s*wasmExports\["([^"]+)"\]/.exec(glue)?.[1] ?? "GetPPCPC";
  const body = wasmFunctionBody(new Uint8Array(readFileSync(path.join(coreDir, "dolphin-core-upstream.wasm"))), name);
  const loc = body && pcLocationFromBody(body);
  if (!loc) throw new Error("GetPPCPC does not have the expected shape: update pcLocationFromBody for this core");
  return loc;
}

// Runs inside a dedicated worker. Two histograms over main RAM: PC changes
// (entries) and all samples (time); low memory for real-mode vectors.
const SAMPLER_SRC = `onmessage = (e) => {
  const { buffer, ctl, ptr, offset } = e.data;
  const u32 = new Uint32Array(buffer), flag = new Int32Array(ctl);
  const ent = new Uint32Array(0x1800000 >>> 2), tim = new Uint32Array(0x1800000 >>> 2);
  const lowEnt = new Uint32Array(0x1000), lowTim = new Uint32Array(0x1000);
  let n = 0, other = 0, last = -1, k = 0;
  const t0 = performance.now();
  while ((++k & 0xfff) !== 0 || Atomics.load(flag, 0) === 0) {
    const pc = u32[((u32[ptr >>> 2] + offset) >>> 0) >>> 2];
    n++;
    if (pc >= 0x80000000 && pc < 0x81800000) { const i = (pc - 0x80000000) >>> 2; tim[i]++; if (pc !== last) ent[i]++; }
    else if (pc > 0 && pc < 0x4000) { lowTim[pc >>> 2]++; if (pc !== last) lowEnt[pc >>> 2]++; }
    else other++;
    last = pc;
  }
  const pcs = [];
  for (let i = 0; i < 0x1000; i++) if (lowTim[i]) pcs.push([i * 4, lowEnt[i], lowTim[i]]);
  for (let i = 0; i < tim.length; i++) if (tim[i]) pcs.push([0x80000000 + i * 4, ent[i], tim[i]]);
  postMessage({ samples: n, other, ms: performance.now() - t0, pcs });
};`;

async function record() {
  const { ensureServer, pageCall, readCoreProgress, REPO_ROOT } = await import("../lib/browser.mjs");
  const { PRESETS } = await import("../lib/matrix.mjs");
  const { openSession } = await import("../lib/session.mjs");
  if (!values.iso || !values.port || !values.out) throw new Error("record: --iso, --port and --out are required");
  const iso = path.resolve(values.iso), out = path.resolve(values.out);
  const homebrew = iso.startsWith(path.join(REPO_ROOT, "harness", "homebrew"));
  if (!homebrew && (out + path.sep).startsWith(REPO_ROOT + path.sep)) throw new Error("samples of a non-homebrew disc stay outside the repository");
  if (!homebrew && process.env.CI) throw new Error("this disc is local-only and must never run in CI");
  const loc = pcLocationFromCore(path.join(REPO_ROOT, "cores", "dolphin"));
  const query = values.query ?? PRESETS.wgpu;
  const server = await ensureServer({ port: Number(values.port) });
  const routes = values.state ? { "**/__harness_state.sav": path.resolve(values.state) } : {};
  const session = await openSession({ base: server.base, query, iso, routes });
  try {
    const { page } = session;
    for (let end = Date.now() + 60000; ((await readCoreProgress(page))?.frame ?? 0) === 0;) {
      if (Date.now() > end) throw new Error("core never reached Running");
      await page.waitForTimeout(100);
    }
    if (values.state) {
      let loaded;
      for (let tries = 0; tries < 60; tries++) {
        loaded = await pageCall(page, "__loadStateFile", new URL("__harness_state.sav", session.url).href, 120000);
        if (loaded?.loaded || loaded?.beforeState !== "Starting") break;
        await page.waitForTimeout(1000);
      }
      if (!loaded?.loaded) throw new Error(`savestate load failed: ${JSON.stringify(loaded)}`);
    }
    if (values.hold) await page.keyboard.down(values.hold);
    await page.waitForTimeout(Number(values.warmup) * 1000);
    const worker = page.workers().find((w) => w.url().includes("upstream-discio-worker"));
    if (!worker) throw new Error("discio worker not found");
    await worker.evaluate(({ SAMPLER_SRC, loc }) => {
      if (!self.__aotPcSampleHeap) throw new Error("this core build does not expose __aotPcSampleHeap");
      const ctl = new SharedArrayBuffer(4);
      const w = new Worker(URL.createObjectURL(new Blob([SAMPLER_SRC], { type: "text/javascript" })));
      self.__aotPcSampler = { ctl, done: new Promise((r) => { w.onmessage = (e) => { r(e.data); w.terminate(); }; }) };
      w.postMessage({ buffer: self.__aotPcSampleHeap, ctl, ptr: loc.ptr, offset: loc.offset });
    }, { SAMPLER_SRC, loc });
    await page.waitForTimeout(Number(values.secs) * 1000);
    const result = await worker.evaluate(() => { Atomics.store(new Int32Array(self.__aotPcSampler.ctl), 0, 1); return self.__aotPcSampler.done; });
    if (values.hold) await page.keyboard.up(values.hold).catch(() => {});
    const record = { url: session.url, state: values.state ? path.basename(values.state) : null, warmupSec: Number(values.warmup), secs: Number(values.secs), pcLocation: loc, ...result };
    writeFileSync(out, JSON.stringify(record) + "\n");
    console.log(`[aot-coverage] ${result.samples} samples, ${result.pcs.length} distinct PCs -> ${out}`);
  } finally {
    await session.close();
    await server.stop();
  }
}

// Share of recorded PCs that fall in a block of the plan or one of its dynamic ranges.
export function coverage(plan, pcs) {
  const ranges = [];
  for (const m of plan.modules) m.blocks.start.forEach((s, i) => ranges.push([s, m.blocks.end[i]]));
  for (const d of plan.dynamic) ranges.push([d.start, d.end]);
  ranges.sort((a, b) => a[0] - b[0]);
  const hit = (pc) => {
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (pc < ranges[m][0]) hi = m - 1; else if (pc >= ranges[m][1]) lo = m + 1; else return true;
    }
    return false;
  };
  let d = 0, dc = 0, e = 0, ec = 0, t = 0, tc = 0;
  const missed = [];
  for (const [pc, ent, tim] of pcs) {
    d++; e += ent; t += tim;
    if (hit(pc)) { dc++; ec += ent; tc += tim; } else missed.push(pc);
  }
  const pct = (a, b) => (b ? Math.round((100000 * a) / b) / 1000 : null);
  return { distinct: d, distinctPct: pct(dc, d), entriesPct: pct(ec, e), timePct: pct(tc, t), missed: missed.length, missedLowMem: missed.filter((pc) => pc < 0x80000000).length };
}

async function report() {
  if (!values.iso || !values.samples) throw new Error("report: --iso and --samples are required");
  const fd = openSync(path.resolve(values.iso), "r");
  const read = (o, n) => { const b = new Uint8Array(n); return b.subarray(0, readSync(fd, b, 0, n, o)); };
  const samples = JSON.parse(readFileSync(values.samples, "utf8"));
  const result = { samples: path.basename(values.samples), static: coverage(await planDisc(read), samples.pcs) };
  if (values.profile.length) {
    const pcs = values.profile.flatMap((f) => JSON.parse(readFileSync(f, "utf8")).pcs.map(([pc]) => pc));
    const plan = await planDisc(read, { profile: { sessions: values.profile.length, blocks: blocksFromPcSamples(pcs) } });
    result.profileFrom = values.profile.map((f) => path.basename(f));
    result.withProfile = coverage(plan, samples.pcs);
  }
  console.log(JSON.stringify(result));
}

if (isMain) {
  if (mode === "record") await record();
  else if (mode === "report") await report();
  else throw new Error("usage: aot-coverage.mjs record|report ...");
}
