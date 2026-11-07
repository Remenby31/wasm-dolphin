// §28cx throughput A/B — all three already-built JIT levers ON together:
// regalloc (§28by GPR dead-store-skip) + blockmerge (§28bx adjacent-block
// merge) + shortprefix (§28ca compile 2-3 op blocks). Warm battle, locked
// product config. Pair with SPEED=unlimited to read raw throughput headroom.
// Out: .omx/menu-progress/<OUT_TAG||allthree-on>
const tag = process.env.OUT_TAG || "allthree-on";
if (!process.env.ROM) throw new Error("set ROM to the disc image to run");
process.env.SAVE_STATE_URL = process.env.SAVE_STATE_URL || "/__battle.sav";
process.env.SAVE_STATE_AT = process.env.SAVE_STATE_AT || "35";
process.env.VIDEO = process.env.VIDEO || "software";
process.env.PRESENTER = process.env.PRESENTER || "webgpu";
process.env.FORCEJIT = process.env.FORCEJIT || "1";
process.env.JITWARMUP = process.env.JITWARMUP || "700";
process.env.DURATION = process.env.DURATION || "60";
process.env.BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8081/";
delete process.env.DISABLE;
process.env.REGALLOC = "1";
process.env.BLOCKMERGE = "1";
process.env.SHORTPREFIX = "1";

process.argv = [
  process.argv[0],
  new URL("./menu-progress-validate.mjs", import.meta.url).pathname,
  "--out-dir",
  `.omx/menu-progress/${tag}`,
];
await import("./menu-progress-validate.mjs");
