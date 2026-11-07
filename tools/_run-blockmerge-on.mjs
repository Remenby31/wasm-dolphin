// §28bx blockmerge A/B — ON. Warm battle, locked product config
// (software hybrid + presenter=webgpu + forcejit). Mirrors
// tools/_run-jitsplit-on.mjs format. Out: .omx/menu-progress/blockmerge-on[-N]
const tag = process.env.OUT_TAG || "blockmerge-on";
if (!process.env.ROM) throw new Error("set ROM to the disc image to run");
process.env.SAVE_STATE_URL = process.env.SAVE_STATE_URL || "/__battle.sav";
process.env.SAVE_STATE_AT = process.env.SAVE_STATE_AT || "35";
process.env.VIDEO = process.env.VIDEO || "software";
process.env.PRESENTER = process.env.PRESENTER || "webgpu";
process.env.FORCEJIT = process.env.FORCEJIT || "1";
process.env.JITWARMUP = process.env.JITWARMUP || "700";
process.env.DURATION = process.env.DURATION || "170";
process.env.BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8081/";
delete process.env.DISABLE;

// menu-progress-validate.mjs already forwards ?redispatch=... — wire a
// ?blockmerge=1 the same way through a tiny extra hook the validator
// understands (already added via REDISPATCH); blockmerge is its own
// URL param, plumbed via an extra env var.
process.env.BLOCKMERGE = "1";

process.argv = [
  process.argv[0],
  new URL("./menu-progress-validate.mjs", import.meta.url).pathname,
  "--out-dir",
  `.omx/menu-progress/${tag}`,
];

await import("./menu-progress-validate.mjs");
