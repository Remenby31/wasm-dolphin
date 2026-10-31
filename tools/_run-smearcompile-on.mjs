// §28ce compile-burst smearing A/B — ON. Caps JIT compiles per Run() slice
// (8 max OR 5000us wall). Smears the cold-start 1.6s compile burst.
const tag = process.env.OUT_TAG || "smearcompile-on";
if (!process.env.ROM) throw new Error("set ROM to the disc image to run");
process.env.SAVE_STATE_URL = process.env.SAVE_STATE_URL || "/__battle.sav";
process.env.SAVE_STATE_AT = process.env.SAVE_STATE_AT || "35";
process.env.VIDEO = process.env.VIDEO || "software";
process.env.PRESENTER = process.env.PRESENTER || "webgpu";
process.env.FORCEJIT = process.env.FORCEJIT || "1";
process.env.JITWARMUP = process.env.JITWARMUP || "700";
process.env.DURATION = process.env.DURATION || "120";
process.env.BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8081/";
process.env.SMEARCOMPILE = "1";
delete process.env.DISABLE;

process.argv = [
  process.argv[0],
  new URL("./menu-progress-validate.mjs", import.meta.url).pathname,
  "--out-dir",
  `.omx/menu-progress/${tag}`,
];
await import("./menu-progress-validate.mjs");
