// Ahead-of-time discovery for one disc, from the browser: read the DOL and
// RELs from the user's disc, merge the profile of earlier sessions and an
// optional hint sheet, and return the compilation plan (docs/aot-plan.md).
import { readDiscExecutables } from "./aot-disc.js";
import { GuestImage, imageFromDol } from "./aot-image.js";
import { discover } from "./aot-discovery.js";
import { hintsMatch } from "./aot-hints.js";
import { fnv1a64Hex, planDol, planModule } from "./aot-plan.js";
import { encodeProfile } from "./aot-profile.js";
import { planRel } from "./aot-rel.js";

// `read(offset, length)` reads the disc image (Uint8Array or a promise of one).
export async function planDisc(read, { profile = null, hints = null, options = {}, onProgress = () => {} } = {}) {
  onProgress({ step: "read" });
  const disc = await readDiscExecutables(read);
  const dolHash = fnv1a64Hex(disc.dol);
  const sheet = hints && hintsMatch(hints, { gameId: disc.gameId, dolHash }) ? hints : null;
  onProgress({ step: "dol" });
  const { image, entryPoint } = imageFromDol(disc.dol);
  const plan = planDol({ image, entryPoint, gameId: disc.gameId, dolBytes: disc.dol, profile, hints: sheet, options });
  if (sheet) {
    for (const [start, end] of sheet.dynamicCode) plan.dynamic.push({ start, end, mode: "virt", source: "hint" });
  }
  if (disc.apploader) {
    onProgress({ step: "apploader" });
    plan.modules.push(planApploader(disc.apploader, options));
  }
  for (const [i, rel] of disc.rels.entries()) {
    onProgress({ step: "rel", index: i, count: disc.rels.length });
    try {
      plan.rels.push(planRel(rel.bytes, { name: rel.path, options }));
    } catch (error) {
      // A REL we cannot parse is simply left to the JIT.
      plan.rels.push({ kind: "rel", name: rel.path, error: String(error?.message || error) });
    }
  }
  // Everything the plan was built from: a cached plan is reused only for the
  // same inputs (DOL, apploader, RELs, profile, hint sheet).
  plan.identity = {
    dolHash,
    apploaderHash: disc.apploader ? fnv1a64Hex(disc.apploader.bytes) : null,
    rels: disc.rels.map((r) => ({ path: r.path, hash: fnv1a64Hex(r.bytes) })),
    profileHash: profile ? fnv1a64Hex(encodeProfile(profile)) : null,
    hintsHash: sheet ? fnv1a64Hex(new TextEncoder().encode(JSON.stringify(sheet))) : null
  };
  onProgress({ step: "done" });
  return plan;
}

// A booted .dol (no disc: no apploader, RELs or hint sheet): the plan of
// its own code, with the same identity fields as a disc's.
export async function planDolFile(read, size, { profile = null, options = {} } = {}) {
  const dol = await read(0, size);
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, gameId: null, dolBytes: dol, profile, options });
  plan.identity = {
    dolHash: fnv1a64Hex(dol),
    apploaderHash: null,
    rels: [],
    profileHash: profile ? fnv1a64Hex(encodeProfile(profile)) : null,
    hintsHash: null
  };
  return plan;
}

// The apploader is plain code at a fixed address: a second absolute module.
export function planApploader({ address, entry, bytes }, options = {}) {
  const image = new GuestImage([{ start: address, bytes, exec: true, name: "apploader" }]);
  const result = discover(image, { ...options, entryPoints: [{ addr: entry, source: "apploader-entry" }] });
  return planModule(result, { id: 1, kind: "apploader", read32: (a) => image.read32(a) });
}

// Disc read from a File/Blob in the browser.
export function fileReader(file) {
  return async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
}
