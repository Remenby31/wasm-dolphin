// §28cx C1 baseline runner (regalloc/regcache OFF) that respects OUT_TAG so it
// doesn't collide with the audit-shipped fixed dir. Mirrors the locked product
// config; honors SPEED/DURATION/BASE_URL via env. Out: .omx/menu-progress/<tag>
const tag = process.env.OUT_TAG || "c1-base";
if (!process.env.ROM) throw new Error("set ROM to the disc image to run");
process.env.SAVE_STATE_URL = process.env.SAVE_STATE_URL || "/__battle.sav";
process.env.SAVE_STATE_AT = process.env.SAVE_STATE_AT || "35";
process.env.VIDEO = process.env.VIDEO || "software";
process.env.PRESENTER = process.env.PRESENTER || "webgpu";
process.env.FORCEJIT = process.env.FORCEJIT || "1";
process.env.JITWARMUP = process.env.JITWARMUP || "700";
process.env.DURATION = process.env.DURATION || "55";
process.env.BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8081/";
delete process.env.DISABLE;
delete process.env.REGALLOC;
delete process.env.BLOCKMERGE;
delete process.env.SHORTPREFIX;

process.argv = [
  process.argv[0],
  new URL("./menu-progress-validate.mjs", import.meta.url).pathname,
  "--out-dir",
  `.omx/menu-progress/${tag}`,
];
await import("./menu-progress-validate.mjs");
