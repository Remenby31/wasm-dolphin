// Per-game renderer defaults, derived from measured sweeps of the test library.
//
// Both video paths are correct for most titles but differ enormously in unique
// visual frames, and a handful of games are actively broken on one of them. The
// right default is therefore per-game, not global -- but only where there is
// evidence. Anything absent from this table keeps the shipping default.
//
// Measurement basis: full 45-disc sweeps of both paths on the same machine and
// harness, comparing steady-state unique visual FPS, plus screenshot checks.
// See docs/webgpu-hardware-renderer-bugs.md and docs/perf-results/.
//
// Rules used to build the table, applied conservatively:
//
//   hardware — the frame was CHECKED BY EYE against the software render and is
//              correct, AND the hardware path is materially faster. A large FPS
//              win alone is not enough: a wrong frame can be fast.
//   software — the hardware path is broken for this title, or measurably worse.
//
// Titles with a big FPS win but no verified screenshot are deliberately left
// out. Being absent costs a little speed; being wrong ships a broken picture.
//
// A "hardware" verdict is only as wide as the GPUs it was checked on. Every one
// below comes from the same rig, an AMD Radeon (RDNA 4) under Windows, so it is
// keyed to that adapter family. The same build on an Apple GPU drew GM4E01's
// menus correctly and then raced with no 3D world at all (gc-web-emu REPORT §7):
// Metal is a different driver stack, not a slower copy. Outside a validated
// (game, family) pair a hardware profile resolves to software. Extending one
// to a new family takes the same screenshot check on that family.

/** Adapter families the hardware sweeps were run on. */
const RDNA4_SWEEP = Object.freeze(["amd"]);

/**
 * @type {Record<string, {renderer: "hardware", validatedOn: readonly string[], why: string}
 *                     | {renderer: "software", why: string}>}
 */
export const GAME_PROFILES = {
  // --- hardware: verified correct by screenshot, and much faster -----------
  GWWE01: { renderer: "hardware", validatedOn: RDNA4_SWEEP, why: "60 vs 7 fps; throne room verified" },
  GFZE01: { renderer: "hardware", validatedOn: RDNA4_SWEEP, why: "60 vs 8 fps; was the software path's worst case" },
  // Not on Apple: correct menus, but no 3D geometry in a race (REPORT §7).
  GM4E01: { renderer: "hardware", validatedOn: RDNA4_SWEEP, why: "60 vs 18 fps; mode select verified" },
  GPVE01: { renderer: "hardware", validatedOn: RDNA4_SWEEP, why: "60 vs 10 fps; memory-card screen verified" },
  GKYE01: { renderer: "hardware", validatedOn: RDNA4_SWEEP, why: "60 vs 10 fps; race scene verified against software" },
  GLME01: { renderer: "hardware", validatedOn: RDNA4_SWEEP, why: "20.5 vs 6 fps; full colour verified (was sepia pre-fix)" },
  GALE01: { renderer: "hardware", validatedOn: RDNA4_SWEEP, why: "60 vs 22 fps; character select verified" },

  // --- software: hardware path broken or worse -----------------------------
  GMSE01: { renderer: "software", why: "background missing on hardware (issue #8)" },
  GCDE08: { renderer: "software", why: "renders black on hardware" },
  GRSEAF: { renderer: "software", why: "does not progress on hardware" },
  GHAE08: { renderer: "software", why: "2 vs 17 fps; hardware is much worse" },
  D43E01: { renderer: "software", why: "0 vs 4 fps; hardware is much worse" },
  G4SE01: { renderer: "software", why: "12 vs 17 fps; hardware is worse" },
  GSAE01: { renderer: "software", why: "79% vs 30% game speed; hardware is 2.6x slower" },
  GAFE01: { renderer: "software", why: "renders black on both paths (issue #11); stay on the shipping path" },

  // Wii. These were briefly defaulted to hardware on a 50-vs-9 fps win with the
  // menus checked by eye. That was wrong twice over. The rendering half of it
  // is now fixed: the scissored ClearRect (0055) and its independent alpha mask
  // (0060) put the world back, and on the deterministic race state the hardware
  // path renders course, kart, signage and HUD pixel-for-pixel against the
  // software reference at a matched emulated frame. What is left is speed --
  // hardware averages ~44% against software's ~100% on that same state -- so
  // software stays the default on performance, not on correctness.
  RMCE01: { renderer: "software", why: "44% vs ~100% game speed; hardware renders correctly but is slower" },
  SOUE01: { renderer: "software", why: "hardware unverified in gameplay; no Wii Remote input yet" }
};

// Where the GameCube disc header (and so the 6-character game id) sits in each
// container this project accepts. Verified by inspecting real files rather than
// assumed from format docs:
//
//   .iso / .nkit.iso  raw disc image, header at 0
//   .rvz             RVZ container, magic "RVZ\x01", copy of the disc header at 0x58
//   .ciso            CISO container, magic "CISO", 0x8000 header then payload
//
// GCZ and WIA are accepted by the core but are not probed here; they simply get
// no profile, which is the safe outcome.
const ID_PROBES = [
  { offset: 0x0, magic: null },
  { offset: 0x58, magic: { at: 0, bytes: "RVZ" } },
  { offset: 0x8000, magic: { at: 0, bytes: "CISO" } }
];

const ID_PATTERN = /^[A-Z0-9]{6}$/;

function readAscii(buffer, offset, length) {
  const view = new Uint8Array(buffer, offset, length);
  let out = "";
  for (const byte of view) out += String.fromCharCode(byte);
  return out;
}

/**
 * Read the 6-character game id from a disc file without mounting it.
 *
 * This has to happen before the core loads, because the video backend is fixed
 * when the worker starts -- after that, switching means restarting, and the
 * file selection is gone. Reads at most ~32KB from the front of the file.
 *
 * Returns null for anything it cannot identify, which is not an error: the
 * caller falls back to the configured default.
 */
export async function readGameId(file) {
  if (!file || typeof file.slice !== "function") return null;
  try {
    // One read covering every probe offset, rather than several range reads.
    const head = await file.slice(0, 0x8010).arrayBuffer();
    for (const probe of ID_PROBES) {
      if (probe.offset + 6 > head.byteLength) continue;
      if (probe.magic) {
        const seen = readAscii(head, probe.magic.at, probe.magic.bytes.length);
        if (seen !== probe.magic.bytes) continue;
      }
      const id = readAscii(head, probe.offset, 6);
      if (ID_PATTERN.test(id)) return id;
    }
  } catch {
    // Unreadable slice (permissions, zero-length, exotic container): no id.
  }
  return null;
}

/** Profile for a game id, or null when we have no measurement for it. */
export function lookupGameProfile(gameId) {
  if (!gameId) return null;
  return GAME_PROFILES[gameId.toUpperCase()] ?? null;
}

// GPUAdapterInfo.vendor is a short lowercase id in Chrome ("apple", "amd",
// "nvidia", "intel", ...), but older builds and some drivers leave it empty or
// put the marketing name in description, so match on both.
const ADAPTER_FAMILIES = [
  ["apple", /\bapple\b/],
  ["amd", /\b(amd|ati|radeon)\b/],
  ["nvidia", /\bnvidia\b/],
  ["intel", /\bintel\b/],
  ["qualcomm", /\b(qualcomm|adreno)\b/],
  ["arm", /\b(arm|mali)\b/]
];

/** Normalize a GPUAdapterInfo-like object to a family id, or null. */
export function adapterFamilyFromInfo(info) {
  if (!info) return null;
  const text = `${info.vendor ?? ""} ${info.description ?? ""}`.toLowerCase();
  for (const [family, pattern] of ADAPTER_FAMILIES) {
    if (pattern.test(text)) return family;
  }
  return null;
}

/**
 * Family of the WebGPU adapter the core will get, or null when there is none
 * or it cannot be identified. Ask with the same power preference the core uses,
 * or a dual-GPU machine could answer for the wrong one.
 */
export async function detectAdapterFamily(gpu = globalThis.navigator?.gpu, powerPreference = "high-performance") {
  try {
    const adapter = await gpu?.requestAdapter?.({ powerPreference });
    if (!adapter) return null;
    const info = adapter.info ?? (await adapter.requestAdapterInfo?.());
    return adapterFamilyFromInfo(info);
  } catch {
    return null;
  }
}

/**
 * Renderer to use for a game on an adapter family, or null to keep the
 * shipping default. `validated` says whether a hardware verdict covers this
 * family; a hardware profile outside its validated families falls back to
 * software rather than shipping a picture nobody has checked.
 */
export function resolveRendererProfile(gameId, adapterFamily) {
  const profile = lookupGameProfile(gameId);
  if (!profile) return null;
  if (profile.renderer === "software") return { renderer: "software", validated: true };
  const validated = Boolean(adapterFamily) && profile.validatedOn.includes(adapterFamily);
  return { renderer: validated ? "hardware" : "software", validated };
}
