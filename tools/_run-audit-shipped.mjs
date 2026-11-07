// §28bz bottleneck audit: 90s warm-battle capture at shipped default.
// Wide-band counter pass — surfaces state_ptr load/store traffic + §28bt
// re-dispatch chain depth alongside existing JIT counters. Same config as
// long-duration runs so numbers are comparable.
if (!process.env.ROM) throw new Error("set ROM to the disc image to run");
process.env.SAVE_STATE_URL = process.env.SAVE_STATE_URL || "/__battle.sav";
process.env.SAVE_STATE_AT = process.env.SAVE_STATE_AT || "35";
process.env.VIDEO = process.env.VIDEO || "software";
process.env.PRESENTER = process.env.PRESENTER || "webgpu";
process.env.FORCEJIT = process.env.FORCEJIT || "1";
process.env.JITWARMUP = process.env.JITWARMUP || "700";
process.env.DURATION = process.env.DURATION || "90";
process.env.BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8081/";
delete process.env.DISABLE;
delete process.env.BLOCKMERGE;
delete process.env.REGALLOC;

process.argv = [
  process.argv[0],
  new URL("./menu-progress-validate.mjs", import.meta.url).pathname,
  "--out-dir",
  ".omx/menu-progress/audit-shipped",
];
await import("./menu-progress-validate.mjs");
