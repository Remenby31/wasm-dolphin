// Strict reader of a region module's metadata.code.branch_hint section
// (0131), with the rules under which V8 drops the whole section, silently
// (module-decoder-impl.h, research/deep-wasm-code-metadata.md §4 lever 6):
// before the code section; function indices strictly increasing and naming
// a defined function; offsets strictly increasing within a function; each
// hint one byte long, 0 or 1; nothing left over. And ours: every offset, in
// the function's body (locals included), on an `if` or a `br_if`.
// Returns { hints, errors }: hints counted, every rule broken (none when the
// section is valid or absent).

const SECTION = "metadata.code.branch_hint";

function reader(bytes, at = 0) {
  const r = {
    at,
    byte() {
      if (r.at >= bytes.length) throw new Error("out of bytes");
      return bytes[r.at++];
    },
    uleb() {
      let v = 0, shift = 0, b;
      do { b = r.byte(); v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
      return v;
    },
    name() {
      const n = r.uleb();
      const s = new TextDecoder().decode(bytes.subarray(r.at, r.at + n));
      r.at += n;
      return s;
    },
    limits() {
      const flags = r.byte();
      r.uleb();
      if (flags & 1) r.uleb();
    }
  };
  return r;
}

export function checkBranchHintSection(bytes) {
  const errors = [];
  const r = reader(bytes, 8);
  let importedFunctions = 0, definedFunctions = 0, hintSection = null, codeSeen = false;
  const bodies = [];
  while (r.at < bytes.length) {
    const id = r.byte();
    const size = r.uleb();
    const start = r.at, end = start + size;
    if (id === 0) {
      const name = r.name();
      if (name === SECTION) {
        if (hintSection) errors.push("two branch_hint sections");
        if (codeSeen) errors.push("branch_hint section after the code section");
        hintSection = { start: r.at, end };
      }
    } else if (id === 2) {
      const count = r.uleb();
      for (let i = 0; i < count; i++) {
        r.name(); r.name();
        const kind = r.byte();
        if (kind === 0) { r.uleb(); importedFunctions++; }
        else if (kind === 1) { r.byte(); r.limits(); }
        else if (kind === 2) r.limits();
        else if (kind === 3) { r.byte(); r.byte(); }
        else if (kind === 4) { r.byte(); r.uleb(); }
        else throw new Error(`import kind ${kind}`);
      }
    } else if (id === 3) {
      definedFunctions = r.uleb();
    } else if (id === 10) {
      codeSeen = true;
      const count = r.uleb();
      for (let i = 0; i < count; i++) {
        const n = r.uleb();
        bodies.push(bytes.subarray(r.at, r.at + n));
        r.at += n;
      }
    }
    r.at = end;
  }
  if (!hintSection) return { hints: 0, errors };
  const h = reader(bytes, hintSection.start);
  let hints = 0, lastFn = -1;
  try {
    const functions = h.uleb();
    for (let f = 0; f < functions; f++) {
      const fn = h.uleb();
      if (fn <= lastFn) errors.push(`function ${fn} after ${lastFn}`);
      lastFn = fn;
      const body = bodies[fn - importedFunctions];
      if (fn < importedFunctions || !body) errors.push(`function ${fn} is not defined (${importedFunctions} imported, ${definedFunctions} defined)`);
      const count = h.uleb();
      let lastOffset = -1;
      for (let i = 0; i < count; i++) {
        const offset = h.uleb();
        const size = h.uleb();
        const value = h.byte();
        hints++;
        if (offset <= lastOffset) errors.push(`function ${fn}: offset ${offset} after ${lastOffset}`);
        lastOffset = offset;
        if (size !== 1) errors.push(`function ${fn}: hint size ${size}`);
        if (value > 1) errors.push(`function ${fn}: hint value ${value}`);
        if (body && !(offset < body.length && (body[offset] === 0x04 || body[offset] === 0x0d))) errors.push(`function ${fn}: offset ${offset} is not on an if or a br_if`);
      }
    }
  } catch (e) {
    errors.push(`truncated: ${e.message}`);
  }
  if (h.at !== hintSection.end) errors.push(`${hintSection.end - h.at} bytes left over`);
  return { hints, errors };
}
