// The browser's full version, per run. Chrome reduces navigator.userAgent to
// "HeadlessChrome/156.0.0.0", so a silent update between two runs left no
// trace in the records: on 2026-11-07 the Mac's MDM reinstalled Chrome
// mid-series (156.0.8078.80 -> 157.0.8103.39 at 02:38, killing the run in
// progress), and the next runs were pooled with the earlier ones.

// Chromium: CDP Browser.getVersion ("Chrome/157.0.8103.39" headless too); any
// other browser, or a session that fails: null (never throws).
export async function fullBrowserVersion(context, page) {
  if (typeof context?.newCDPSession !== "function") return null;
  let cdp = null;
  try {
    cdp = await context.newCDPSession(page);
    const v = await cdp.send("Browser.getVersion");
    return typeof v?.product === "string" && v.product ? v.product : null;
  } catch {
    return null;
  } finally {
    if (cdp) await Promise.resolve().then(() => cdp.detach()).catch(() => {});
  }
}

// The distinct versions among a series' runs, in order of first appearance
// (unknown ones left out).
export function browserVersionsOf(versions) {
  const out = [];
  for (const v of versions) if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  return out;
}

// Why a series cannot be read as one: its runs ran on several browser
// versions. null when one (or none known).
export function mixedBrowserReason(versions) {
  return versions.length > 1 ? `runs on several browser versions (${versions.join(", ")}): not comparable across them` : null;
}
