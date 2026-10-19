#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Single-core speed of this machine as headless Chrome sees it: a small
// register-machine interpreter (dispatch, integer ALU, loads/stores, branches,
// some float), the shape of the emulator's inner loop, run in a dedicated
// worker as WASM and as the same JavaScript. Deterministic: both print the
// same checksum. It compares machines and core sets (P-cores vs E-cores) in
// the browser; nothing converts its Mops/s into a Geekbench score, and the
// speed model of docs/consumer-perf-extrapolation.md uses published scores.
//
// Limits: 16 KiB of state that stays in L1, and an opcode stream that
// repeats every 256 instructions, so the branch predictor learns it. It
// measures the core's execution speed, not memory, caches or misprediction,
// which the emulator also meets.
//
//   node harness/probes/cpu-bench/cpu-bench.mjs [--rounds 3]
//   HARNESS_CHROME_PATH=harness/probes/chrome-ecores.sh node harness/probes/cpu-bench/cpu-bench.mjs
//
// bench.wasm (embedded below) is bench.c built with the toolchain's clang:
//   clang --target=wasm32 -O2 -nostdlib -Wl,--no-entry -Wl,--export=run -o bench.wasm bench.c
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { launchChrome } from "../../lib/browser.mjs";

const wasmB64 = "AGFzbQEAAAABBgFgAX8BfwMCAQAFAwEAAgcQAgZtZW1vcnkCAANydW4AAAwBAQr1BgHyBgIIfwF9QeD/AyICQZiABCkDADcDGCACQZCABCkDADcDECACQYiABCkDADcDCCACQYCABCkDADcDAEGAfiEDQbngACEBA0AgA0GjggRqIAFBkf6Z8H5sQdTH68wCayIGQRB2OgAAIANBooIEaiABQbX59oN4bEGhsO/HBWtBEHY6AAAgA0GhggRqIAFB6bSKlXxsQYLTj+ECa0EQdjoAACADQaCCBGogAUHtnJmOBGxBueAAakEQdjoAACAGIQEgA0EEaiIDDQALQQAhA0GAgH8hAQNAIAFBrIIFaiADQe2l5qoCazYCACABQaiCBWogA0Hi5rvjA2o2AgAgAUGkggVqIANBz4yijgZrNgIAIAFBoIIFaiADNgIAIANBxM33xgdqIQMgAUEQaiIBDQALAn8gAEUEQEEBIQNBAyEBQQQhBkEFIQRBBiEFQQghB0ECIQhBBwwBC0EAIQZDAACAPyEJQQAhAwNAIANB/wFxLQCggAQiAUEHcSEEIAFBA3ZBB3EhBQJAAkACQAJAAkACQAJAAkACQCABQQV2QQFrDgcBAgMEBQYHAAsgAiAEQQJ0aiIBIAIgBUECdGooAgAgASgCAGpBAWo2AgAMBwsgAiAEQQJ0aiIBIAEoAgAgAiAFQQJ0aigCAEEDd3M2AgAMBgsgAiAEQQJ0aiAGIAIgBUECdGooAgBqQf8fcUECdCgCoIIENgIADAULIAIgBEECdGooAgAgBnNB/x9xQQJ0IAIgBUECdGooAgA2AqCCBAwECyACIARBAnRqLQAAQQFxRQ0DIAIgBUECdGooAgBBD3EgA2ohAwwDCyACIARBAnRqIgEgASgCACAJQwEAgD+UIAIgBUECdGotAACzQ28SgzqUkiIJ/AFqNgIADAILIAIgBEECdGoiASACIAVBAnRqKAIAIAEoAgBBsfPd8XlsajYCAAwBCyACIARBAnRqIgEgAiAFQQJ0aigCAEEfdCABKAIAQQF2cjYCAAsgA0EBaiEDIAAgBkEBaiIGRw0ACyACKAIcIQcgAigCFCEFIAIoAhAhBCACKAIMIQYgAigCCCEBIAIoAgQhCCACKAIAIQMgAigCGAshACADQf8fcUECdCgCoIIEIAcgACAFIAQgBiABIAggA0EfbGpBH2xqQR9sakEfbGpBH2xqQR9sakEfbGpzCwslAQBBgIAECx0BAAAAAgAAAAMAAAAEAAAABQAAAAYAAAAHAAAACAB4CXByb2R1Y2VycwEMcHJvY2Vzc2VkLWJ5AQVjbGFuZ1gyMy4wLjBnaXQgKGh0dHBzOi9naXRodWIuY29tL2xsdm0vbGx2bS1wcm9qZWN0IDdiNTg3MTZkOTZjM2FlNGMwYzRlNmY3MmUyOWIxNjEzN2JiNjIyNGIpAJQBD3RhcmdldF9mZWF0dXJlcwgrD211dGFibGUtZ2xvYmFscysTbm9udHJhcHBpbmctZnB0b2ludCsLYnVsay1tZW1vcnkrCHNpZ24tZXh0Kw9yZWZlcmVuY2UtdHlwZXMrCm11bHRpdmFsdWUrD2J1bGstbWVtb3J5LW9wdCsWY2FsbC1pbmRpcmVjdC1vdmVybG9uZw==";
export const CHECKSUM = 2501321547; // run(40e6) in WASM and in JS

const { values } = parseArgs({ options: { rounds: { type: "string", default: "3" } } });

async function once() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gc-cpu-bench-"));
  const context = await launchChrome({ profileDir: dir });
  try {
    await context.assertInvisible?.("after launch");
    const page = context.pages()[0] ?? (await context.newPage());
  const worker = `
      const bytes = Uint8Array.from(atob(${JSON.stringify(wasmB64)}), c => c.charCodeAt(0));
      const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
      function jsRun(iterations) {
        const r = new Uint32Array([1,2,3,4,5,6,7,8]); const mem = new Uint32Array(4096); const prog = new Uint8Array(256);
        let f = Math.fround(1), seed = 12345;
        for (let i = 0; i < 256; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; prog[i] = (seed >>> 16) & 255; }
        for (let i = 0; i < 4096; i++) mem[i] = Math.imul(i, 2654435761) >>> 0;
        let pc = 0;
        for (let n = 0; n < iterations; n++) {
          const op = prog[pc & 255], a = op & 7, b = (op >> 3) & 7;
          switch (op >> 5) {
            case 0: r[a] += r[b] + 1; break;
            case 1: r[a] ^= (r[b] << 3) | (r[b] >>> 29); break;
            case 2: r[a] = mem[(r[b] + n) & 4095]; break;
            case 3: mem[(r[a] ^ n) & 4095] = r[b]; break;
            case 4: if (r[a] & 1) pc += r[b] & 15; break;
            case 5: f = Math.fround(Math.fround(f * Math.fround(1.0000001)) + Math.fround((r[b] & 255) * Math.fround(0.001))); r[a] += f >>> 0; break;
            case 6: r[a] = (Math.imul(r[a], 2654435761) + r[b]) >>> 0; break;
            default: r[a] = (r[a] >>> 1) | (r[b] << 31); break;
          }
          pc++;
        }
        let h = 0; for (let i = 0; i < 8; i++) h = (Math.imul(h, 31) + r[i]) >>> 0;
        return (h ^ mem[r[0] & 4095]) >>> 0;
      }
      onmessage = () => {
        const res = { wasm: [], js: [] }; const N = 40e6;
        for (let k = 0; k < 5; k++) {
          let t = performance.now(); const cw = inst.exports.run(N) >>> 0; res.wasm.push(N / (performance.now() - t) / 1000); res.cw = cw;
          t = performance.now(); const cj = jsRun(N); res.js.push(N / (performance.now() - t) / 1000); res.cj = cj;
        }
        postMessage(res);
      };`;
    await page.goto("about:blank");
    const res = await page.evaluate((src) => new Promise((resolve) => {
      const w = new Worker(URL.createObjectURL(new Blob([src])));
      w.onmessage = (e) => resolve(e.data);
      w.postMessage(0);
    }), worker);
    if (res.cw !== CHECKSUM || res.cj !== CHECKSUM) throw new Error(`checksum mismatch: wasm ${res.cw}, js ${res.cj}`);
    const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
    return { wasmMops: Math.round(med(res.wasm)), jsMops: Math.round(med(res.js)) };
  } finally {
    await context.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

const rounds = [];
for (let i = 0; i < Number(values.rounds); i += 1) rounds.push(await once());
const med = (k) => [...rounds.map((r) => r[k])].sort((a, b) => a - b)[rounds.length >> 1];
console.log(JSON.stringify({ chrome: process.env.HARNESS_CHROME_PATH || "chrome stable", rounds, wasmMops: med("wasmMops"), jsMops: med("jsMops") }));
