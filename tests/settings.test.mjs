import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlayablePresetHref,
  buildSettingsHref,
  describeSettings,
  readSettingsFromSearch
} from "../src/settings.js";

test("uses the playable startup profile when no URL settings are present", () => {
  assert.deepEqual(readSettingsFromSearch(""), {
    core: "upstream",
    video: "software",
    cpu: "dual",
    speed: "1",
    present: "full",
    presenter: "webgpu",
    pacing: "tick",
    oglproxy: "worker",
    wasmjit: "1",
    jittier: "guarded",
    forcejit: "0",
    queue: "4",
    fastsw: "1",
    metrics: "0"
  });
});

test("reads emulator startup settings from URL search params", () => {
  const settings = readSettingsFromSearch(
    "?core=upstream&video=ogl&cpu=dual&speed=unlimited&present=half&presenter=wgpu&pacing=smooth&oglproxy=direct&wasmjit=1&jittier=mixed&forcejit=1&queue=8&fastsw=2"
  );

  assert.deepEqual(settings, {
    core: "upstream",
    video: "ogl",
    cpu: "dual",
    speed: "unlimited",
    present: "half",
    presenter: "webgpu",
    pacing: "smooth",
    oglproxy: "worker",
    wasmjit: "1",
    jittier: "mixed",
    forcejit: "1",
    queue: "8",
    fastsw: "2",
    metrics: "0"
  });
});

test("falls back to supported startup settings for unknown values", () => {
  const settings = readSettingsFromSearch(
    "?core=bad&video=vulkan&cpu=many&speed=9&present=2&presenter=metal&pacing=bad&oglproxy=bad&wasmjit=yes&jittier=turbo&forcejit=yes&queue=99&fastsw=9"
  );

  assert.deepEqual(settings, {
    core: "upstream",
    video: "software",
    cpu: "dual",
    speed: "1",
    present: "full",
    presenter: "webgpu",
    pacing: "tick",
    oglproxy: "worker",
    wasmjit: "1",
    jittier: "guarded",
    forcejit: "0",
    queue: "4",
    fastsw: "1",
    metrics: "0"
  });
});

test("builds a minimal href by omitting playable default settings", () => {
  const href = buildSettingsHref("http://localhost:5173/?core=upstream&wasmjit=1#play", {
    core: "upstream",
    video: "software",
    cpu: "dual",
    speed: "1",
    present: "full",
    presenter: "webgpu",
    pacing: "tick",
    oglproxy: "worker",
    wasmjit: "1",
    jittier: "guarded",
    forcejit: "0",
    queue: "4",
    fastsw: "1",
    metrics: "0"
  });

  assert.equal(href, "http://localhost:5173/?jitwarmup=60#play");
});

test("writes explicit params when settings differ from playable defaults", () => {
  const href = buildSettingsHref("http://localhost:5173/", {
    core: "native",
    video: "software",
    cpu: "auto",
    speed: "1",
    present: "full",
    presenter: "webgl",
    pacing: "direct",
    oglproxy: "readback",
    wasmjit: "0",
    jittier: "mixed",
    forcejit: "0",
    queue: "8",
    fastsw: "0",
    metrics: "0"
  });
  const url = new URL(href);

  assert.equal(url.searchParams.get("core"), "native");
  assert.equal(url.searchParams.get("cpu"), "auto");
  assert.equal(url.searchParams.get("presenter"), "webgl");
  assert.equal(url.searchParams.get("pacing"), "direct");
  assert.equal(url.searchParams.get("oglproxy"), "readback");
  assert.equal(url.searchParams.get("wasmjit"), "0");
  assert.equal(url.searchParams.get("jittier"), "mixed");
  assert.equal(url.searchParams.get("forcejit"), null);
  assert.equal(url.searchParams.get("queue"), "8");
  assert.equal(url.searchParams.get("fastsw"), "0");
});

test("builds the playable Melee preset href", () => {
  const href = buildPlayablePresetHref("http://localhost:5173/");
  const url = new URL(href);

  assert.equal(url.searchParams.get("core"), null);
  assert.equal(url.searchParams.get("video"), null);
  assert.equal(url.searchParams.get("cpu"), null);
  assert.equal(url.searchParams.get("wasmjit"), null);
  assert.equal(url.searchParams.get("jittier"), null);
  assert.equal(url.searchParams.get("forcejit"), null);
  assert.equal(url.searchParams.get("jitwarmup"), "60");
  assert.equal(url.searchParams.get("presenter"), null);
  assert.equal(url.searchParams.get("oglproxy"), null);
  assert.equal(url.searchParams.get("queue"), null);
  assert.equal(url.searchParams.get("fastsw"), null);
});

test("preserves the experimental hardware WebGPU renderer through settings", () => {
  const settings = readSettingsFromSearch(
    "?core=upstream&video=wgpu&presenter=webgpu&metrics=0"
  );
  assert.equal(settings.video, "wgpu");

  const url = new URL(buildSettingsHref("http://localhost:5173/", settings));
  assert.equal(url.searchParams.get("video"), "wgpu");
  assert.equal(
    describeSettings({ ...settings, cpu: "dual", wasmjit: "1" }),
    "Upstream / WGPU / dual CPU / JIT on"
  );
});

test("playable and settings links cannot retain blank WGPU probes", () => {
  const diagnosticHref =
    "http://localhost:5173/?video=wgpu&wgpurenderprobe=null-drain&metrics=1#play";
  const settings = readSettingsFromSearch(diagnosticHref.slice(diagnosticHref.indexOf("?")));

  const settingsUrl = new URL(buildSettingsHref(diagnosticHref, settings));
  const playableUrl = new URL(buildPlayablePresetHref(diagnosticHref));

  assert.equal(settingsUrl.searchParams.get("wgpurenderprobe"), null);
  assert.equal(playableUrl.searchParams.get("wgpurenderprobe"), null);
});

test("describes selected settings for compact display", () => {
  assert.equal(
    describeSettings({ core: "upstream", video: "software", cpu: "dual", wasmjit: "1" }),
    "Upstream / Software / dual CPU / JIT on"
  );
  assert.equal(
    describeSettings({ core: "upstream", video: "ogl", cpu: "dual", wasmjit: "1", forcejit: "0" }),
    "Upstream / OGL / dual CPU / JIT OGL safe-off"
  );
  assert.equal(
    describeSettings({ core: "upstream", video: "ogl", cpu: "dual", wasmjit: "1", jittier: "mixed", forcejit: "1" }),
    "Upstream / OGL / dual CPU / JIT mixed"
  );
});
