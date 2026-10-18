// Install tools/hooks/pre-commit for this clone. Git keeps hooks in the common
// directory, so every worktree of the clone gets it. Coordinate before
// running it on a shared clone (docs/repro-build.md).
import { chmodSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hooks = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
  { cwd: root, encoding: "utf8" }).stdout.trim();
const target = join(hooks, "pre-commit");
copyFileSync(join(root, "tools/hooks/pre-commit"), target);
chmodSync(target, 0o755);
console.log(`Installed ${target}`);
