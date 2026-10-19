// Guest memory image for ahead-of-time discovery: the executable and data
// sections of a DOL (or of a REL module, see aot-rel.js) placed at their
// load addresses. Read-only views over the caller's bytes, nothing copied.
import { parseDolHeader } from "./dol.js";

// Bounds that keep discovery around a second on hostile input: analysis costs
// up to ~1 µs per executable word on an M4 Pro. Measured games have ~3 MiB of
// code; a disc above the bound gets no plan and runs on the JIT as today.
export const MAX_EXEC_BYTES = 4 << 20;
export const MAX_IMAGE_BYTES = 24 << 20;

export class GuestImage {
  constructor(segments) {
    this.segments = segments
      .filter((s) => s.bytes.byteLength > 0)
      .map((s) => ({
        start: s.start >>> 0,
        end: s.start + s.bytes.byteLength,
        exec: Boolean(s.exec),
        name: s.name || "",
        bytes: s.bytes,
        view: new DataView(s.bytes.buffer, s.bytes.byteOffset, s.bytes.byteLength)
      }))
      .sort((a, b) => a.start - b.start);
    let execBytes = 0, total = 0;
    for (const [i, s] of this.segments.entries()) {
      if (s.end > 0x100000000) throw new Error(`image: section ${s.name} wraps past 4 GiB`);
      if (i && s.start < this.segments[i - 1].end) throw new Error(`image: sections ${this.segments[i - 1].name} and ${s.name} overlap`);
      total += s.end - s.start;
      if (s.exec) execBytes += s.end - s.start;
    }
    if (execBytes > MAX_EXEC_BYTES) throw new Error(`image: ${execBytes} bytes of code, more than ${MAX_EXEC_BYTES}`);
    if (total > MAX_IMAGE_BYTES) throw new Error(`image: ${total} bytes, more than ${MAX_IMAGE_BYTES}`);
    this.execSegments = this.segments.filter((s) => s.exec);
  }

  // Segments are sorted and disjoint: binary search.
  static find(list, addr) {
    let lo = 0, hi = list.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (addr < list[m].start) hi = m - 1;
      else if (addr >= list[m].end) lo = m + 1;
      else return list[m];
    }
    return null;
  }

  segmentAt(addr) {
    return GuestImage.find(this.segments, addr);
  }

  isExec(addr) {
    if (addr & 3) return false;
    const s = GuestImage.find(this.execSegments, addr);
    return s !== null && addr + 4 <= s.end;
  }

  read32(addr) {
    const s = this.segmentAt(addr);
    if (!s || addr + 4 > s.end) return undefined;
    return s.view.getUint32(addr - s.start, false);
  }
}

// Build the image of a DOL from its bytes (header at offset 0). Sections past
// the end of the buffer are clipped; bss is not part of the image.
export function imageFromDol(dolBytes) {
  const bytes = dolBytes instanceof Uint8Array ? dolBytes : new Uint8Array(dolBytes);
  const dol = parseDolHeader(bytes);
  const segments = [];
  // Sections are distinct byte ranges of the file: several sections mapping
  // the same bytes would multiply the code to analyse.
  const byOffset = [...dol.loadSections].sort((x, y) => x.fileOffset - y.fileOffset);
  for (let i = 1; i < byOffset.length; i++) {
    const prev = byOffset[i - 1];
    if (byOffset[i].fileOffset < prev.fileOffset + prev.size) throw new Error(`DOL sections ${prev.kind}${prev.index} and ${byOffset[i].kind}${byOffset[i].index} share file bytes`);
  }
  for (const section of dol.loadSections) {
    const end = Math.min(section.fileOffset + section.size, bytes.byteLength);
    if (section.fileOffset >= end) continue;
    segments.push({
      start: section.address,
      bytes: bytes.subarray(section.fileOffset, end),
      exec: section.kind === "text",
      name: `${section.kind}${section.index}`
    });
  }
  return { image: new GuestImage(segments), entryPoint: dol.entryPoint, dol };
}
