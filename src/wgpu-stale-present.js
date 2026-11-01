// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Stale presents: a present that announces a new frame (its patch 0208 frame
// tag moved) but shows a texture that received no new content since it was
// last shown. On a late replay in dual core, a VI swap can present the XFB
// buffer whose copy of the current frame has not run yet: the picture from
// two frames back comes again and the scene jumps back (Spark, 2026-11-01,
// glitch-meter G4: A and C from the same texture, C after a bare present).
// framesOutOfOrder misses it, the tag still moves forward.
//
// Each write into a texture (a render pass targeting it, a blit or an upload
// into it, its creation) gives it a new content generation; each present
// remembers the generation it showed of its texture. A duplicate VI swap (the
// same tag again) is not stale, it repeats the picture on purpose. A tag
// epoch change (a state load, a boot) forgets what was shown.
//
// Per write: one Map set. Per present: two Map reads and a set. Cheap on any
// device, the iPhone included; always on.

export function createStalePresentDetector() {
  let seq = 0;
  const written = new Map(); // texture id -> content generation of its last write
  const shown = new Map(); // texture id -> content generation at its last present
  let lastTag = 0, lastEpoch = 0;
  // Lifetime (the integrity gate takes deltas): null until a tagged present.
  let stale = null;
  return {
    get stale() { return stale; },
    // A write into texture `id`.
    wrote(id) {
      if (id) written.set(id, ++seq);
    },
    // Texture `id` created (ids are reused after a destroy): fresh content.
    created(id) {
      if (!id) return;
      shown.delete(id);
      written.set(id, ++seq);
    },
    // A present of texture `id` with frame tag `tag` (0: untagged) in tag
    // epoch `epoch`. True when it is stale.
    present(id, tag, epoch = 0) {
      if (!tag || !id) return false;
      stale ??= 0;
      if (epoch !== lastEpoch) shown.clear();
      const newFrame = tag !== lastTag || epoch !== lastEpoch;
      lastTag = tag;
      lastEpoch = epoch;
      const content = written.get(id) ?? 0;
      const before = shown.get(id);
      shown.set(id, content);
      if (newFrame && before !== undefined && before === content) {
        stale += 1;
        return true;
      }
      return false;
    }
  };
}
