// Guest memory image for ahead-of-time discovery: the executable and data
// sections of a DOL (or of a REL module, see aot-rel.js) placed at their
// load addresses. Read-only views over the caller's bytes, nothing copied.
import { parseDolHeader } from "./dol.js";

export class GuestImage {
  constructor(segments) {
    this.segments = segments
      .filter((s) => s.bytes.byteLength > 0)
      .map((s) => ({
        start: s.start >>> 0,
        end: (s.start + s.bytes.byteLength) >>> 0,
        exec: Boolean(s.exec),
        name: s.name || "",
        bytes: s.bytes,
        view: new DataView(s.bytes.buffer, s.bytes.byteOffset, s.bytes.byteLength)
      }))
      .sort((a, b) => a.start - b.start);
    this.execSegments = this.segments.filter((s) => s.exec);
  }

  segmentAt(addr) {
    for (const s of this.segments) if (addr >= s.start && addr < s.end) return s;
    return null;
  }

  isExec(addr) {
    if (addr & 3) return false;
    for (const s of this.execSegments) if (addr >= s.start && addr + 4 <= s.end) return true;
    return false;
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
