#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// A homebrew boot with aot=1 in Playwright's WebKit (JavaScriptCore, the
// Safari engine) or in Chromium (to calibrate), headless. Reads what the
// engine decided and what the region optimiser did:
//   - relaxed SIMD probe (src/relaxed-madd-probe.js): "fused", "unfused",
//     "unsupported" or "inconsistent", and the core's own mode;
//   - aotStatus / validationReadAotProgress: regions planned, compiled,
//     refused, installed; the wasm feature probes when the engine has them;
//   - the region counters (region calls, time in regions): the regions ran;
//   - worker console lines that look like compile or link errors.
// Speed is only an indication here (video=software, a headless engine).
//
//   node harness/probes/webkit-boot.mjs --dol harness/homebrew/out/x.dol --port N
//     [--browser webkit|chromium] [--secs 40] [--query "..."] [--out file.json]
//     [--expect-installs]   fail unless regions were installed (> 0) with 0
//                           compile errors
//     [--expect-relaxed MODE]  fail unless the relaxed SIMD probe answered MODE
//                           (WebKit: unsupported) and the core is fused only
//                           when MODE is "fused"
//     [--module-sizes]      record each compiled module's function sizes in
//                           the workers Playwright reports (Chromium sees the
//                           CPU thread's region compiles; WebKit does not).
//                           It wraps WebAssembly and disturbs the timing:
//                           a separate run, never with a speed reading.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { bootIso, ensureServer, FATAL_PATTERN, importPlaywright, launchChrome, readFrameInfo, workerRequest } from "../lib/browser.mjs";
import { decodeRegionStats } from "../lib/jit-region-stats.mjs";

export const DEFAULT_QUERY = "core=upstream&video=software&presenter=2d&cpu=single&speed=1&wasmjit=1&aot=1&metrics=1";
// Worker or page console lines that mean a module did not compile or link.
export const COMPILE_ERROR = /CompileError|LinkError|failed to compile|compile error|regionsRefused[^0-9]*[1-9]/i;

// JavaScriptCore never tiers a wasm function over 100,000 bytes of body up
// to OMG (option maximumOMGCandidateCost): it stays in BBQ, 1.6x slower on a
// hot loop in Safari 26's jsc. Region fragments must stay under it.
export const JSC_OMG_MAX_FUNCTION_BYTES = 100000;

// Function body sizes of a wasm module (code section), or null; pure.
export function functionBodySizes(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let p = 8;
  const leb = () => { let r = 0, shift = 0, b; do { b = u[p++]; r += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return r; };
  while (p < u.length) {
    const id = u[p++], size = leb(), end = p + size;
    if (id === 10) {
      const n = leb(), out = [];
      for (let i = 0; i < n; i += 1) { const len = leb(); out.push(len); p += len; }
      return out;
    }
    p = end;
  }
  return null;
}

// Installed in every worker: records the function body sizes of each module
// it compiles (not the bytes), read back by the probe. Pure source.
export const RECORD_MODULE_SIZES = `(${(sizesOf) => {
  if (self.__wasmSizes) return;
  self.__wasmSizes = [];
  const note = (src) => {
    try {
      const u = src instanceof Uint8Array ? src : ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength) : src instanceof ArrayBuffer ? new Uint8Array(src) : null;
      if (u && self.__wasmSizes.length < 5000) self.__wasmSizes.push({ bytes: u.length, functions: sizesOf(u) });
    } catch {}
  };
  const W = WebAssembly, M = W.Module, compile = W.compile, inst = W.instantiate;
  W.Module = function (b, ...rest) { note(b); return new M(b, ...rest); };
  W.Module.prototype = M.prototype;
  Object.setPrototypeOf(W.Module, M);
  W.compile = (b, ...rest) => { note(b); return compile.call(W, b, ...rest); };
  W.instantiate = (b, ...rest) => { if (!(b instanceof M)) note(b); return inst.call(W, b, ...rest); };
}})(${functionBodySizes.toString()})`;

// Region-sized modules (not the core) and their largest functions; pure.
export function moduleSizeSummary(records, coreMinBytes = 4 << 20) {
  const mods = records.filter((m) => m.functions && m.bytes < coreMinBytes);
  const fns = mods.flatMap((m) => m.functions);
  return {
    modules: mods.length, functions: fns.length,
    maxFunctionBytes: fns.length ? Math.max(...fns) : null,
    overOmgCap: fns.filter((n) => n > JSC_OMG_MAX_FUNCTION_BYTES).length,
  };
}

// The verdict from what was read; pure.
export function webkitBootVerdict(r) {
  const installs = r.installs ?? 0;
  const compileErrors = r.compileErrors.length + (r.refused ?? 0);
  // Installed is not run: the region counters must have moved too.
  const regionCalls = r.regionStats?.regionCalls ?? 0;
  return { installs, compileErrors, regionCalls, ok: r.booted && installs > 0 && compileErrors === 0 && regionCalls > 0 };
}

// Regions installed, compiled and refused, from the progress events and the
// status (whichever this engine reports).
export function regionCounts(progress, status) {
  const ev = progress?.events ?? [];
  const installs = ev.filter((e) => e.type === "install").reduce((n, e) => n + (e.loaded ?? 0), 0);
  const done = ev.find((e) => e.type === "done");
  return {
    installs: Math.max(installs, status?.installed ?? 0, status?.regionsInstalled ?? 0) || (done?.compiled ?? 0),
    compiled: done?.compiled ?? status?.compiled ?? null,
    refused: status?.regionsRefused ?? done?.refused ?? null,
    state: progress?.state ?? status?.state ?? null,
  };
}

async function launch(browser) {
  if (browser === "chromium") return { context: await launchChrome({ profileDir: mkdtempSync(path.join(os.tmpdir(), "gc-webkit-cal-")) }), close: (c) => c.close() };
  const { webkit } = await importPlaywright();
  const b = await webkit.launch({ headless: true });
  const context = await b.newContext();
  return { context, close: () => b.close() };
}

async function main() {
  const { values } = parseArgs({
    options: {
      dol: { type: "string" }, port: { type: "string", default: process.env.HARNESS_PORT }, browser: { type: "string", default: "webkit" },
      secs: { type: "string", default: "40" }, query: { type: "string", default: DEFAULT_QUERY }, out: { type: "string" },
      "expect-installs": { type: "boolean", default: false }, "module-sizes": { type: "boolean", default: false },
      "expect-relaxed": { type: "string" },
    },
  });
  if (!values.dol || !values.port) throw new Error("usage: webkit-boot.mjs --dol x.dol --port N [--browser webkit|chromium]");
  const server = await ensureServer({ port: values.port });
  const { context, close } = await launch(values.browser);
  const lines = [];
  const r = { browser: values.browser, query: values.query, dol: path.basename(values.dol), booted: false };
  try {
    const page = await context.newPage();
    const keep = (m) => lines.push(m.text());
    page.on("console", keep);
    const workers = [];
    page.on("worker", (w) => {
      w.on("console", keep);
      workers.push(w);
      if (values["module-sizes"]) w.evaluate(RECORD_MODULE_SIZES).catch(() => {});
    });
    page.on("pageerror", (e) => lines.push(`pageerror: ${e.message}`));
    r.userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);
    try {
      await bootIso(page, { url: `${server.base}?${values.query}`, iso: path.resolve(values.dol), timeoutMs: 120000 });
      r.booted = true;
    } catch (e) {
      r.bootError = String(e?.message || e).split("\n")[0];
    }
    if (r.booted) {
      const ask = (type, payload) => workerRequest(page, type, payload, 15000).catch((e) => ({ error: String(e?.message || e) }));
      // Counters on (and reset) for the window, counts only.
      await ask("validationReadJitRegionStats", { sampleEvery: 0 });
      await page.waitForTimeout(Number(values.secs) * 1000);
      const stats = await ask("validationReadJitRegionStats", {});
      const s = stats?.bytes ? decodeRegionStats(stats.bytes) : { error: stats?.error ?? "no stats" };
      r.regionStats = s.error ? { error: s.error } : { regionCalls: s.regionCalls, regionCycles: s.regionCycles, totalCycles: s.totalCycles, regionShare: s.totalCycles > 0 ? s.regionCycles / s.totalCycles : null };
      r.relaxedMadd = await ask("validationReadRelaxedMadd");
      r.aotStatus = await ask("aotStatus");
      r.aotProgress = await ask("validationReadAotProgress");
      r.frame = await readFrameInfo(page).catch(() => null);
      if (values["module-sizes"]) {
        const records = (await Promise.all(workers.map((w) => w.evaluate(() => self.__wasmSizes ?? []).catch(() => [])))).flat();
        r.moduleSizes = moduleSizeSummary(records);
      }
      Object.assign(r, regionCounts(r.aotProgress, r.aotStatus));
    }
  } finally {
    await close(context);
  }
  r.compileErrors = lines.filter((t) => COMPILE_ERROR.test(t)).slice(0, 20);
  r.fatal = lines.filter((t) => FATAL_PATTERN.test(t)).slice(0, 20);
  r.statusLines = lines.filter((t) => /relaxed_madd|aot[: ]|regions? |wasm feature|tail call/i.test(t)).slice(0, 40);
  r.verdict = webkitBootVerdict(r);
  console.log(`[webkit-boot] ${JSON.stringify({ browser: r.browser, booted: r.booted, bootError: r.bootError, relaxedMadd: r.relaxedMadd, state: r.state, installs: r.installs, compiled: r.compiled, refused: r.refused, compileErrors: r.compileErrors.length, regionStats: r.regionStats, moduleSizes: r.moduleSizes, speed: r.frame?.speed ?? null })}`);
  if (values.out) writeFileSync(values.out, JSON.stringify(r, null, 1));
  const relaxed = values["expect-relaxed"];
  if (relaxed && !(r.relaxedMadd?.mode === relaxed && r.relaxedMadd?.coreFused === (relaxed === "fused"))) {
    console.error(`[webkit-boot] expected relaxed SIMD ${relaxed} (core fused ${relaxed === "fused"}): ${JSON.stringify(r.relaxedMadd)}`);
    process.exit(1);
  }
  if (values["expect-installs"] && !r.verdict.ok) {
    console.error(`[webkit-boot] expected installs > 0 and 0 compile errors: ${JSON.stringify(r.verdict)}`);
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
