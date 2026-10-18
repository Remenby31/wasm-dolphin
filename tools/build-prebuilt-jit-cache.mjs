// §28cg build-prebuilt-jit-cache: orchestrates the two-step pipeline that
// produces the shipped IDB pre-warm asset (cores/dolphin/prebuilt-jit-cache.bin).
//
// Step 1: run menu-progress-validate.mjs with PROBE_PERSIST_DIR set, so the
// browser session persists IndexedDB across the run. The validator's normal
// menu+battle script (~120-170s) exercises the JIT through boot + menus +
// warm battle, populating the cache with the ~4k modules touched along the way.
//
// Step 2: run export-prebuilt-jit-cache.mjs against the same persistent dir,
// dumping the IDB modules + buildFingerprint into the binary blob next to
// the WASM core.
//
// Requires the dev server to be running (PORT=8081 npm start).
//
// CI/release usage:
//   PORT=8081 node tools/serve.mjs &
//   npm run build:prebuilt-cache
//
// Env hooks:
//   PROBE_PERSIST_DIR  default ./build/jit-cache-profile (intermediate)
//   DURATION           default 150 (seconds of validator runtime)
//   BASE_URL           default http://127.0.0.1:8081/

import { spawn } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

const persistDir = process.env.PROBE_PERSIST_DIR
  ? path.resolve(process.env.PROBE_PERSIST_DIR)
  : path.resolve("build/jit-cache-profile");
const duration = process.env.DURATION || "150";
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8081/";

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const ps = spawn(cmd, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
      shell: process.platform === "win32"
    });
    ps.on("error", reject);
    ps.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))
    );
  });
}

// The validator plays a disc; there is no default one (the cache is derived
// from the game's code, so it is built locally from the user's own disc).
if (!process.env.ROM) {
  console.error("ROM=<path to your disc image> is required.");
  process.exit(2);
}

console.log(`[build-prebuilt] persistDir=${persistDir}`);
console.log(`[build-prebuilt] duration=${duration}s`);
console.log(`[build-prebuilt] baseUrl=${baseUrl}`);

// Always start from a clean profile dir — leftover IDB from a previous
// build's fingerprint would silently bake stale modules into the blob.
console.log("[build-prebuilt] step 0: clean persist dir");
await rm(persistDir, { recursive: true, force: true });
await mkdir(persistDir, { recursive: true });

console.log("[build-prebuilt] step 1: validator run (populates IDB)");
await run("node", ["tools/_run-audit-shipped.mjs"], {
  PROBE_PERSIST_DIR: persistDir,
  DURATION: duration,
  BASE_URL: baseUrl,
  // Pacing matters less for cache population than for smoothness metrics —
  // the validator will JIT-compile the same set of blocks either way.
  PACING: process.env.PACING || "direct"
});

console.log("[build-prebuilt] step 2: export IDB → prebuilt-jit-cache.bin");
await run("node", ["tools/export-prebuilt-jit-cache.mjs"], {
  PROBE_PERSIST_DIR: persistDir,
  BASE_URL: baseUrl
});

console.log("[build-prebuilt] step 3: check the cache against the committed core");
await run("node", ["tools/check-prebuilt-jit-cache.mjs"], {});

console.log("[build-prebuilt] DONE");
