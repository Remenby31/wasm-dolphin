// cores/dolphin/core.lock.json: the hash of the core the browser accepts by
// default. Pure data, read by src/upstream-worker-protocol.js (JSON module
// import) and written only by update:core-abi, so no tool evaluates or
// pattern-matches JavaScript to find or change it.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const CORE_LOCK_PATH = "cores/dolphin/core.lock.json";

export function parseCoreLock(text) {
  const lock = JSON.parse(text);
  const keys = Object.keys(lock).sort().join(",");
  if (lock.schemaVersion !== 1 || keys !== "schemaVersion,sha256" || !/^[0-9a-f]{64}$/.test(lock.sha256)) {
    throw new Error(`${CORE_LOCK_PATH} must be {"schemaVersion":1,"sha256":"<64 hex>"}`);
  }
  return lock;
}

export const formatCoreLock = (sha256) => `${JSON.stringify({ schemaVersion: 1, sha256 }, null, 2)}\n`;

export function readCoreLock(root) {
  return parseCoreLock(readFileSync(resolve(root, CORE_LOCK_PATH), "utf8")).sha256;
}

export function writeCoreLock(root, sha256) {
  parseCoreLock(formatCoreLock(sha256));
  writeFileSync(resolve(root, CORE_LOCK_PATH), formatCoreLock(sha256));
}
