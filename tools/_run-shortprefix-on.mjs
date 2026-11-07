// §28ca short-prefix A/B — ON. Lowers MIN_WASM_PREFIX_INSTRUCTIONS 4→2.
// Targets the 54% short-block reject finding from §28bz audit.
const tag = process.env.OUT_TAG || "shortprefix-on";
if (!process.env.ROM) throw new Error("set ROM to the disc image to run");
process.env.SAVE_STATE_URL = process.env.SAVE_STATE_URL || "/__battle.sav";
process.env.SAVE_STATE_AT = process.env.SAVE_STATE_AT || "35";
process.env.VIDEO = process.env.VIDEO || "software";
process.env.PRESENTER = process.env.PRESENTER || "webgpu";
process.env.FORCEJIT = process.env.FORCEJIT || "1";
process.env.JITWARMUP = process.env.JITWARMUP || "700";
process.env.DURATION = process.env.DURATION || "170";
process.env.BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8081/";
process.env.SHORTPREFIX = "1";
delete process.env.DISABLE;

process.argv = [
  process.argv[0],
  new URL("./menu-progress-validate.mjs", import.meta.url).pathname,
  "--out-dir",
  `.omx/menu-progress/${tag}`,
];
await import("./menu-progress-validate.mjs");
