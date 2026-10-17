// Build the GPL "complete corresponding source" archive for the committed core.
//
// cores/dolphin/dolphin-core-upstream.wasm is a derivative work of Dolphin
// (GPLv2-or-later), so distributing it obliges us to distribute the source it
// was built from. This produces that archive: the patched Dolphin tree the
// core is compiled from, our shim and build tooling, and the provenance record
// that ties the two together.
//
// The archive is verified before it is written -- provenance has to agree that
// the working tree is the locked upstream commit plus the locked patch series,
// so a drifted checkout produces an error rather than a mislabelled tarball.
//
// It keeps the repository layout, so extracting it and running
// `npm run build:core:repro -- --no-sync` rebuilds the core with nothing else
// fetched but the toolchain. CI does exactly that from the published artifact.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSourceLock, verifyDolphinProvenance } from "./dolphin-provenance.mjs";
import { verifyWasmToolchain } from "./wasm-toolchain.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Everything the recipient needs to rebuild the core: every tracked file of
// this repository (the JS around the core included -- the build tooling reads
// src/ and the combined work is GPL), the patched Dolphin tree, and the Rust
// crates statically linked through Naga, std's own dependencies included
// (std is rebuilt from rust-src for the shared-memory target).
export const VENDORED_CRATES = "tools/naga-spirv-wgsl/vendor";
const GENERATED_PAYLOAD = ["vendor/dolphin", VENDORED_CRATES];

// vendor/dolphin/.git and the submodule .git files are history, not source.
const EXCLUDES = [".git", "__pycache__"];

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", ...options });
}

function readableSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function manifest(lock, provenance, commit) {
  return `# Corresponding source for wasm-dolphin

This archive is the complete corresponding source, in the sense of the GNU
General Public License, for the compiled core distributed as
\`cores/dolphin/dolphin-core-upstream.wasm\`.

That core is a derivative work of Dolphin (https://github.com/dolphin-emu/dolphin),
which is licensed GPLv2-or-later. The combined work is therefore GPL, and the
license text is included as LICENSE.

## What is here

| Path | What it is |
|------|------------|
| \`vendor/dolphin/\` | The Dolphin source tree the core is compiled from, already patched |
| \`patches/dolphin-wasm/\` | The patch series applied to upstream, as individual patches |
| \`core/upstream/\` | The C-ABI shim compiled together with Dolphin |
| \`tools/naga-spirv-wgsl/\` | The Rust SPIR-V to WGSL bridge linked into the core |
| \`${VENDORED_CRATES}/\` | Every crate linked into the bridge, Naga and std's dependencies included |
| \`src/\`, \`index.html\` | The browser front end that loads the core |
| \`tools/\`, \`provenance/\` | Build driver, pinned toolchain, provenance tooling and locks |

It is every tracked file of the repository at \`${commit}\`, plus the two generated trees above.

## Exactly which source this is

- Upstream repository: ${lock.upstream.repository}
- Upstream commit: ${lock.upstream.commit}
- Patches applied: ${provenance.patches.count}
- Changed paths against upstream: ${provenance.vendorSnapshot.rootPaths}

\`vendor/dolphin/\` is that commit with those patches already applied, so it can be
built directly. To reconstruct it yourself instead, clone the upstream
repository at the commit above and apply \`patches/dolphin-wasm/snapshot/\` in
filename order.

## Rebuilding

On macOS or Linux, from the extracted directory (Node.js 22+, git, python3,
rustup; Docker for the second form):

    npm run build:core:repro -- --no-sync
    npm run build:core:repro -- --docker --bind-mounts --no-sync

The first run installs the pinned toolchain described in
\`provenance/wasm-toolchain.lock.json\`. The Rust crates are built offline
from \`${VENDORED_CRATES}/\`. The result is written to
\`build/repro/<platform>/core/\`; see \`docs/repro-build.md\`.
`;
}

// Vendor the bridge's crates and std's dependencies with the pinned cargo,
// in the registry layout (name-version) so the path remapping in
// configure-upstream-wasm.mjs gives the same bytes as a registry build.
function vendorCrates() {
  const toolchain = verifyWasmToolchain();
  const { cargo, rustc } = toolchain.paths;
  const sysroot = run(rustc, ["--print", "sysroot"]).trim();
  const result = spawnSync(cargo, [
    "vendor", "--locked", "--versioned-dirs",
    "--sync", join(sysroot, "lib/rustlib/src/rust/library/Cargo.toml"),
    join(root, VENDORED_CRATES)
  ], {
    cwd: join(root, "tools/naga-spirv-wgsl"),
    env: { ...process.env, RUSTC: rustc },
    stdio: ["ignore", "ignore", "inherit"]
  });
  if (result.error || result.status !== 0) {
    throw new Error(`cargo vendor failed (${result.error?.message ?? `exit ${result.status}`})`);
  }
}

export function buildCorrespondingSource({ outputDir = join(root, "dist") } = {}) {
  const vendor = join(root, "vendor/dolphin");
  if (!existsSync(vendor)) {
    throw new Error(
      "vendor/dolphin is missing. Run `npm run fetch:dolphin` and `npm run patch:upstream` first."
    );
  }

  // Fail before writing anything if the tree is not what the lock describes.
  const provenance = verifyDolphinProvenance(root);
  const lock = loadSourceLock(root);

  const version = JSON.parse(run("node", ["-p", "JSON.stringify(require('./package.json'))"])).version;
  const commit = run("git", ["rev-parse", "HEAD"]).trim();
  const stem = `wasm-dolphin-corresponding-source-v${version}`;
  mkdirSync(outputDir, { recursive: true });

  vendorCrates();

  const staging = mkdtempSync(join(tmpdir(), "wasm-dolphin-cs-"));
  writeFileSync(join(staging, "CORRESPONDING-SOURCE.md"), manifest(lock, provenance, commit));
  const tracked = run("git", ["ls-files", "-z"]).split("\0").filter(Boolean);
  const listPath = join(staging, "files.txt");
  writeFileSync(listPath, `${[...tracked, ...GENERATED_PAYLOAD].join("\n")}\n`);

  const archive = join(outputDir, `${stem}.tar.gz`);
  rmSync(archive, { force: true });

  const posix = (value) => value.split("\\").join("/");
  // Everything goes under one top-level directory. GNU tar and bsdtar spell
  // the rename differently.
  const gnu = /GNU tar/.test(run("tar", ["--version"]));
  const prefix = gnu
    ? ["--transform", `s,^,${stem}/,`, "--force-local", "--show-transformed-names"]
    : ["-s", `,^,${stem}/,`];
  // Two passes, because GNU tar and bsdtar order -C and -T differently:
  // the tree from the repository root, then the manifest from the staging
  // directory, then gzip.
  const tarPath = archive.replace(/\.gz$/, "");
  rmSync(tarPath, { force: true });
  try {
    run("tar", ["-c", ...prefix, "-f", posix(tarPath), ...EXCLUDES.map((entry) => `--exclude=${entry}`),
      "-T", posix(listPath)], { stdio: ["ignore", "inherit", "pipe"] });
    run("tar", ["-r", ...prefix, "-f", posix(tarPath), "-C", posix(staging), "CORRESPONDING-SOURCE.md"],
      { stdio: ["ignore", "inherit", "pipe"] });
    run("gzip", ["-n", "-f", posix(tarPath)], { stdio: ["ignore", "inherit", "pipe"] });
  } catch (error) {
    const detail = error.stderr ? `: ${String(error.stderr).trim()}` : "";
    throw new Error(`tar failed while writing ${archive}${detail}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return {
    archive,
    bytes: statSync(archive).size,
    commit: lock.upstream.commit,
    patches: provenance.patches.count
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = buildCorrespondingSource();
  console.log(`Corresponding source: ${result.archive}`);
  console.log(`  upstream ${result.commit} + ${result.patches} patches`);
  console.log(`  ${readableSize(result.bytes)}`);
  console.log("Attach it to the release alongside the core.");
}
