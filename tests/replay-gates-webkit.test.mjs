// --webkit-frames (replay-gates --exact, WebKit only): a bad call is refused
// before the perf lock and the browser.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const probe = new URL("../harness/probes/replay-gates.mjs", import.meta.url).pathname;
const dir = mkdtempSync(path.join(tmpdir(), "webkit-frames-"));
writeFileSync(path.join(dir, "s.vi240.png"), "");
const run = (...extra) => spawnSync(process.execPath, [probe, "--iso", "x.iso", "--state", "x.sav", "--port", "1", "--out", path.join(dir, "out"),
  "--query", "video=wgpu&cpu=single", "--vi", "240", ...extra], { encoding: "utf8", timeout: 20_000, env: { ...process.env, HARNESS_PERF_LOCK: path.join(dir, "never") } });

test("--webkit-frames is refused before the lock when the call is wrong", () => {
  for (const [args, message] of [
    [["--extra", "&x=1", "--webkit-frames", path.join(dir, "s.vi{vi}.png")], /go with --exact/],
    [["--exact", "--webkit-frames", path.join(dir, "s.png")], /no \{vi\}/],
    [["--exact", "--webkit-frames", path.join(dir, "t.vi{vi}.png")], /t\.vi240\.png is missing/],
    [["--exact", "--webkit-frames", path.join(dir, "s.vi{vi}.png"), "--extra", "&x=1"], /no --extra/],
    [["--exact", "--webkit-tolerance", "max=20"], /needs --webkit-frames/],
    [["--exact", "--webkit-frames", path.join(dir, "s.vi{vi}.png"), "--webkit-tolerance", "over=2"], /percentage/],
  ]) {
    const r = run(...args);
    assert.notEqual(r.status, 0, args.join(" "));
    assert.match(r.stderr, message, args.join(" "));
    assert.doesNotMatch(r.stdout, /lock/i, "never queued for the lock");
  }
});
