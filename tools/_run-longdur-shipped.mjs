// Comp-play match-length realism check at shipped default.
// 10-min sustained warm battle: §28bt re-dispatch ON (default), blockmerge OFF.
// Watch for smoothness drift, drop-rate creep, JIT-poison events.
if (!process.env.ROM) throw new Error("set ROM to the disc image to run");
process.env.SAVE_STATE_URL = process.env.SAVE_STATE_URL || "/__battle.sav";
process.env.SAVE_STATE_AT = process.env.SAVE_STATE_AT || "35";
process.env.VIDEO = process.env.VIDEO || "software";
process.env.PRESENTER = process.env.PRESENTER || "webgpu";
process.env.FORCEJIT = process.env.FORCEJIT || "1";
process.env.JITWARMUP = process.env.JITWARMUP || "700";
process.env.DURATION = process.env.DURATION || "660"; // 11 min (60s warmup + 600s battle)
process.env.BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8081/";
delete process.env.DISABLE;
delete process.env.BLOCKMERGE; // shipped default

process.argv = [
  process.argv[0],
  new URL("./menu-progress-validate.mjs", import.meta.url).pathname,
  "--out-dir",
  ".omx/menu-progress/longdur-shipped",
];
await import("./menu-progress-validate.mjs");
