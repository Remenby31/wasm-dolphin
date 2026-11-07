import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { browserVersionsOf, fullBrowserVersion, mixedBrowserReason } from "../harness/lib/browser-version.mjs";
import { noVerdictReasons } from "../harness/probes/drop-meter.mjs";
import { humanSummary } from "../harness/probes/parcours.mjs";

test("full browser version: CDP Browser.getVersion's product, the session detached; null off Chromium or on any failure, never a throw", async () => {
  let detached = 0;
  const cdp = (send) => ({ send, detach: async () => { detached += 1; } });
  const ctx = (session) => ({ newCDPSession: async () => session });
  assert.equal(await fullBrowserVersion(ctx(cdp(async (m) => (m === "Browser.getVersion" ? { product: "HeadlessChrome/157.0.8103.39" } : null))), {}), "HeadlessChrome/157.0.8103.39");
  assert.equal(detached, 1);
  // a failing call: null, still detached
  assert.equal(await fullBrowserVersion(ctx(cdp(async () => { throw new Error("Target closed"); })), {}), null);
  assert.equal(detached, 2);
  // no product, no CDP (Firefox, Safari), a session that cannot open
  assert.equal(await fullBrowserVersion(ctx(cdp(async () => ({}))), {}), null);
  assert.equal(await fullBrowserVersion({}, {}), null);
  assert.equal(await fullBrowserVersion(null, null), null);
  assert.equal(await fullBrowserVersion({ newCDPSession: async () => { throw new Error("not Chromium"); } }, {}), null);
  // a detach that throws is not the caller's problem
  assert.equal(await fullBrowserVersion(ctx({ send: async () => ({ product: "X/1" }), detach: () => { throw new Error("gone"); } }), {}), "X/1");
});

test("browser versions of a series: distinct, in order, unknown left out; a reason only when several", () => {
  assert.deepEqual(browserVersionsOf(["A/1", null, "A/1", undefined, "", "B/2", "A/1"]), ["A/1", "B/2"]);
  assert.equal(mixedBrowserReason([]), null);
  assert.equal(mixedBrowserReason(["A/1"]), null);
  assert.match(mixedBrowserReason(["HeadlessChrome/156.0.8078.80", "HeadlessChrome/157.0.8103.39"]), /several browser versions \(HeadlessChrome\/156\.0\.8078\.80, HeadlessChrome\/157\.0\.8103\.39\)/);
});

test("drop-meter: an A/B whose runs mixed browser versions has no verdict; one version (or none known) changes nothing", () => {
  const a = (side, browserVersion) => ({ side, visit: 1, analysis: { overloaded: false, sampled: true, browserVersion } });
  const verdicts = { 1: { inconclusive: false } };
  const six = (v1, v2) => [a("baseline", v1), a("baseline", v1), a("baseline", v1), a("candidate", v1), a("candidate", v2), a("candidate", v2)];
  assert.equal(noVerdictReasons({ analyses: six("C/156.0.8078.80", "C/156.0.8078.80"), visits: 1, verdicts }), null);
  assert.equal(noVerdictReasons({ analyses: six(undefined, undefined), visits: 1, verdicts }), null);
  assert.match(noVerdictReasons({ analyses: six("C/156.0.8078.80", "C/157.0.8103.39"), visits: 1, verdicts }).join(), /several browser versions/);
});

test("parcours: the summary warns when a series mixed browser versions", () => {
  assert.ok(!humanSummary({ runs: [] }).some((l) => /WARNING/.test(l)));
  assert.ok(humanSummary({ runs: [], browserMixed: "runs on several browser versions (A, B): not comparable across them" }).some((l) => /^WARNING: runs on several browser versions/.test(l)));
});

test("both probes record the full version per run and read the mixed reason from it (source contract)", () => {
  const src = (p) => readFileSync(new URL(`../harness/probes/${p}`, import.meta.url), "utf8");
  const parcours = src("parcours.mjs"), drop = src("drop-meter.mjs");
  assert.match(parcours, /raw\.browserVersion = safari \? raw\.browser : await fullBrowserVersion\(context, page\);/);
  assert.match(parcours, /analysis\.browserVersion = raw\.browserVersion \?\? null;/);
  assert.match(parcours, /summary\.browserMixed = mixedBrowserReason\(summary\.browserVersions\);/);
  assert.match(parcours, /if \(summary\.browserMixed\) reasons\.push\(summary\.browserMixed\);/);
  assert.match(drop, /raw\.browserVersion = await fullBrowserVersion\(context, page\);/);
  assert.match(drop, /browserVersion: raw\.browserVersion \?\? null,/);
  assert.match(drop, /summary\.browserMixed = mixedBrowserReason\(summary\.browserVersions\);/);
});
