#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Region cache cycle (plan piste 3, P6, lane 10). Headless only.
//
// Four launches of the engine on ONE profile, each booting the disc and then
// asking the discio worker (validationAotCacheProbe) to store what is missing
// from a set of region-shaped modules and load them all back:
//   1. cold: nothing present, everything compiled and stored, run hot so V8
//      tiers up and writes its code cache;
//   2. same core: everything present, nothing compiled from scratch, first
//      call already fast;
//   3. another core hash: nothing present (everything recompiled); the first
//      core's cache is kept (two identities per disc);
//   4. a third core hash: everything recompiled, the oldest cache pruned.
// The modules are synthetic (no imports): until the region compiler (P4)
// exists, this checks the storage, keys, Service Worker and code cache path.
//
// node harness/probes/aot-cache-cycle.mjs --iso disc.iso [--tree .] [--port 8090] [--out dir]
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { bootIso, grabFrame, launchChrome, workerRequest } from "../lib/browser.mjs";
import { ensureServer } from "../lib/server.mjs";
import { savePng } from "../lib/session.mjs";
import { machineSnapshot } from "../lib/system.mjs";

const { values } = parseArgs({
  options: {
    tree: { type: "string", default: "." },
    iso: { type: "string" },
    port: { type: "string", default: process.env.HARNESS_PORT || "8090" },
    query: { type: "string", default: "core=upstream&video=software&cpu=dual&wasmjit=1&aotsw=1" },
    regions: { type: "string", default: "60" },
    functions: { type: "string", default: "80" },
    hot: { type: "string", default: "2500" },
    out: { type: "string" }
  }
});
const log = (m) => console.log(`[aot-cycle ${new Date().toISOString().slice(11, 19)}] ${m}`);

// Region-shaped synthetic modules: `functions` exported functions each, every
// one a loop of mixed integer work, big enough for TurboFan to matter.
function uleb(o, v) { do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v); }
function sleb(o, v) { v |= 0; for (;;) { const b = v & 0x7f; v >>= 7; if ((v === 0 && !(b & 0x40)) || (v === -1 && b & 0x40)) { o.push(b); return; } o.push(b | 0x80); } }
function section(o, id, c) { o.push(id); uleb(o, c.length); o.push(...c); }
function regionModule(seed, count) {
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  const o = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  section(o, 1, [1, 0x60, 1, 0x7f, 1, 0x7f]);
  const f = []; uleb(f, count); for (let i = 0; i < count; i++) f.push(0); section(o, 3, f);
  const e = []; uleb(e, count);
  for (let i = 0; i < count; i++) { const n = `f${i}`; uleb(e, n.length); for (const c of n) e.push(c.charCodeAt(0)); e.push(0); uleb(e, i); }
  section(o, 7, e);
  const code = []; uleb(code, count);
  const OPS = [0x6a, 0x6b, 0x6c, 0x71, 0x72, 0x73, 0x74, 0x76, 0x77];
  for (let i = 0; i < count; i++) {
    // locals: 1 = i, 2 = acc, 3 = t
    const b = [1, 3, 0x7f];
    b.push(0x41); sleb(b, rnd()); b.push(0x21, 2);
    b.push(0x03, 0x40); // loop
    for (let k = 0; k < 24; k++) {
      b.push(0x20, 2, 0x41); sleb(b, (rnd() & 0xffff) | 1); b.push(OPS[rnd() % OPS.length], 0x20, 1, OPS[rnd() % 3], 0x21, 2);
    }
    b.push(0x20, 1, 0x41, 1, 0x6a, 0x22, 1, 0x20, 0, 0x48, 0x0d, 0); // i++ ; br_if i<n
    b.push(0x0b, 0x20, 2, 0x0b);
    uleb(code, b.length); code.push(...b);
  }
  section(o, 10, code);
  return Buffer.from(o);
}

// Keys end with a SHA-256, as region keys must (the hash of the guest code;
// here, of the synthetic module).
const modules = Array.from({ length: Number(values.regions) }, (_, i) => {
  const bytes = regionModule(0x9e3779b9 ^ (i + 1), Number(values.functions));
  return { key: `probe-region:${createHash("sha256").update(bytes).digest("hex")}`, b64: bytes.toString("base64") };
});
const OTHER_CORE = "c".repeat(64);
const THIRD_CORE = "d".repeat(64);
const out = values.out;
mkdirSync(out, { recursive: true });
const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-aot-cycle-"));
const server = await ensureServer({ port: Number(values.port), root: path.resolve(values.tree) });
const results = [];
try {
  const launches = [
    { name: "launch1", hot: Number(values.hot), settleMs: 6000 },
    { name: "launch2", hot: 0, settleMs: 0 },
    { name: "launch3-other-core", hot: 0, settleMs: 0, coreHash: OTHER_CORE },
    // Two identities per disc live side by side; a third drops the oldest.
    { name: "launch4-third-core", hot: 0, settleMs: 0, coreHash: THIRD_CORE }
  ];
  for (const launch of launches) {
    const context = await launchChrome({ profileDir });
    try {
      await context.assertInvisible("after launch");
      const page = context.pages()[0] ?? (await context.newPage());
      const machineBefore = machineSnapshot();
      await bootIso(page, { url: `${server.base}?${values.query}`, iso: values.iso, timeoutMs: 120000 });
      await context.assertInvisible("after boot");
      // The core keeps running in its own threads; the probe runs in the
      // discio worker, which it blocks while timing calls.
      const probe = await page.evaluate(async ({ modules, launch }) => {
        const decoded = modules.map((m) => ({ key: m.key, bytes: Uint8Array.from(atob(m.b64), (c) => c.charCodeAt(0)).buffer }));
        return window.__host.adapter.request("validationAotCacheProbe", {
          modules: decoded,
          compilerVersion: "probe-1",
          coreHash: launch.coreHash ?? null,
          hotRounds: launch.hot,
          settleMs: launch.settleMs
        });
      }, { modules, launch });
      const swControlsPage = await page.evaluate(() => Boolean(navigator.serviceWorker?.controller));
      const progress = await workerRequest(page, "validationReadJitCacheReadiness", {}, 15000);
      const r = { launch: launch.name, machineBefore, swControlsPage, aotDiscKey: progress?.aotDiscKey, ...probe };
      results.push(r);
      savePng(await grabFrame(page), path.join(out, `${launch.name}.png`));
      log(`${launch.name}: present=${r.present} stored=${r.stored} streamed=${r.stats?.streamed} sw=${r.viaServiceWorker} load=${r.loadMs?.toFixed(0)}ms first=${r.firstRoundMs?.toFixed(1)}ms second=${r.secondRoundMs?.toFixed(1)}ms pruned=${r.pruned?.length} ${r.error ?? ""}`);
    } finally {
      await context.close().catch(() => {});
    }
  }
} finally {
  await server.stop();
  rmSync(profileDir, { recursive: true, force: true });
}
writeFileSync(path.join(out, "cycle.json"), JSON.stringify(results, null, 1));
const [l1, l2, l3, l4] = results;
const pass = l1?.present === 0 && l1?.stored === modules.length &&
  l2?.present === modules.length && l2?.stored === 0 &&
  l3?.present === 0 && l3?.stored === modules.length && l3?.pruned?.length === 0 &&
  l4?.present === 0 && l4?.stored === modules.length && l4?.pruned?.length === 1;
log(`verdict: ${pass ? "PASS" : "FAIL"} (launch 2 compiled ${l2?.stored} of ${modules.length} from scratch, launch 3 recompiled ${l3?.stored}, launch 4 pruned ${l4?.pruned?.length})`);
process.exit(pass ? 0 : 1);
