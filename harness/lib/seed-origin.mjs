// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// A seeded profile (aot-warm-launch seed) holds caches (Cache API, OPFS,
// IndexedDB) that belong to the origin it was seeded on, 127.0.0.1:<port>.
// Measured on another port, every launch would be a first one with no
// warning (seen on 2026-10-21). The seed writes SEED_FILE inside the profile,
// so a clone carries it; measure checks it.
import { readFileSync } from "node:fs";
import path from "node:path";

export const SEED_FILE = ".harness-seed.json";

// { seed } when the ports match, { error } when they do not, { warning } when
// the profile does not say (seeded before this check).
export function seedOriginCheck(profileDir, measurePort) {
  let seed;
  try { seed = JSON.parse(readFileSync(path.join(profileDir, SEED_FILE), "utf8")); } catch { return { warning: `${profileDir} has no ${SEED_FILE}: its origin cannot be checked (seeded before this check?)` }; }
  if (Number(seed.port) !== Number(measurePort)) return { error: `the profile was seeded on port ${seed.port} (${seed.origin}) and is measured on port ${measurePort}: its caches belong to the other origin, every launch would be a first launch. Measure with --port ${seed.port}.` };
  return { seed };
}
