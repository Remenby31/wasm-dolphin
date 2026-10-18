// Print, and with --write record, the observed toolchain identity for this host
// in provenance/wasm-toolchain.lock.json (posix.platforms[<platform>] and the
// host-independent Emscripten tree digest). Run it after bootstrap.sh on a new
// platform, review the diff, and commit it: the lock is the reviewed value that
// verify:toolchain fails closed against.
import { readFileSync, writeFileSync } from "node:fs";

import { hostPlatform, lockPath, observePosixToolchain } from "../wasm-toolchain.mjs";

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const observed = observePosixToolchain(lock);
const { paths, ...report } = observed;
console.log(JSON.stringify(report, null, 2));

if (process.argv.includes("--write")) {
  const previousTree = lock.posix.emscriptenTreeSha256;
  if (previousTree && previousTree !== observed.emscriptenTreeSha256) {
    throw new Error(
      `Emscripten tree on ${hostPlatform} (${observed.emscriptenTreeSha256}) differs from the ` +
      `locked tree (${previousTree}). Hosts must share one Emscripten source tree.`
    );
  }
  lock.posix.emscriptenTreeSha256 = observed.emscriptenTreeSha256;
  lock.posix.platforms[hostPlatform] = observed.hashes;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Recorded ${hostPlatform} in ${lockPath}`);
}
