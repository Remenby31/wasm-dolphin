export const PLAYABLE_PRESET = Object.freeze({
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
  jitwarmup: "60",
  oc: "1",
  queue: "4",
  fastsw: "1",
  metrics: "0"
});

const DEFAULT_SETTINGS = Object.freeze({
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

const CHOICE_SETS = Object.freeze({
  core: new Set(["native", "upstream"]),
  video: new Set(["software", "wgpu", "ogl", "null"]),
  cpu: new Set(["auto", "single", "dual"]),
  speed: new Set(["0.5", "0.75", "1", "1.25", "1.5", "unlimited"]),
  present: new Set(["full", "0.75", "half"]),
  presenter: new Set(["webgpu", "webgl", "2d"]),
  pacing: new Set(["tick", "direct", "smooth"]),
  oglproxy: new Set(["proxy", "worker", "main", "readback"]),
  wasmjit: new Set(["0", "1"]),
  jittier: new Set(["guarded", "mixed"]),
  forcejit: new Set(["0", "1"]),
  queue: new Set(["2", "4", "8", "12"]),
  fastsw: new Set(["0", "1", "2", "3"]),
  metrics: new Set(["0", "1"])
});

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

export function readSettingsFromSearch(search) {
  const params = new URLSearchParams(search);

  return {
    core: normalizeChoice("core", params.get("core") || DEFAULT_SETTINGS.core),
    video: normalizeChoice("video", params.get("video") || "software"),
    cpu: normalizeChoice("cpu", params.get("cpu") || DEFAULT_SETTINGS.cpu),
    speed: normalizeChoice("speed", normalizeSpeed(params.get("speed"))),
    present: normalizeChoice("present", normalizePresentationScale(params.get("present"))),
    presenter: normalizeChoice("presenter", normalizePresenter(params.get("presenter"))),
    pacing: normalizeChoice("pacing", params.get("pacing") || DEFAULT_SETTINGS.pacing),
    oglproxy: normalizeChoice("oglproxy", normalizeOglProxy(params.get("oglproxy"))),
    wasmjit: params.get("wasmjit") === "0" ? "0" : DEFAULT_SETTINGS.wasmjit,
    jittier: params.get("wasmjit") === "2" ? "mixed" : normalizeChoice("jittier", params.get("jittier") || DEFAULT_SETTINGS.jittier),
    forcejit: params.get("forcejit") === "1" ? "1" : DEFAULT_SETTINGS.forcejit,
    queue: normalizeChoice("queue", params.get("queue") || DEFAULT_SETTINGS.queue),
    fastsw: normalizeChoice("fastsw", params.get("fastsw") || DEFAULT_SETTINGS.fastsw),
    metrics: params.get("metrics") === "1" ? "1" : DEFAULT_SETTINGS.metrics
  };
}

export function buildSettingsHref(href, settings) {
  const url = new URL(href);
  const nextSettings = normalizeSettings(settings);

  // Renderer probes replace the selected visible executor with diagnostic
  // sinks. Applying settings must return to the visible renderer, including
  // the experimental true-hardware `video=wgpu` option.
  url.searchParams.delete("wgpurenderprobe");

  writeSetting(url.searchParams, "core", nextSettings.core, DEFAULT_SETTINGS.core);
  writeSetting(url.searchParams, "video", nextSettings.video, DEFAULT_SETTINGS.video);
  writeSetting(url.searchParams, "cpu", nextSettings.cpu, DEFAULT_SETTINGS.cpu);
  writeSetting(url.searchParams, "speed", nextSettings.speed, DEFAULT_SETTINGS.speed);
  writeSetting(url.searchParams, "present", nextSettings.present, DEFAULT_SETTINGS.present);
  writeSetting(url.searchParams, "presenter", nextSettings.presenter, DEFAULT_SETTINGS.presenter);
  writeSetting(url.searchParams, "pacing", nextSettings.pacing, DEFAULT_SETTINGS.pacing);
  writeSetting(url.searchParams, "oglproxy", nextSettings.oglproxy, DEFAULT_SETTINGS.oglproxy);
  writeSetting(url.searchParams, "wasmjit", nextSettings.wasmjit, DEFAULT_SETTINGS.wasmjit);
  writeSetting(url.searchParams, "jittier", nextSettings.jittier, DEFAULT_SETTINGS.jittier);
  writeSetting(url.searchParams, "forcejit", nextSettings.forcejit, DEFAULT_SETTINGS.forcejit);
  writeSetting(url.searchParams, "queue", nextSettings.queue, DEFAULT_SETTINGS.queue);
  writeSetting(url.searchParams, "fastsw", nextSettings.fastsw, DEFAULT_SETTINGS.fastsw);
  writeSetting(url.searchParams, "metrics", nextSettings.metrics, DEFAULT_SETTINGS.metrics);
  url.searchParams.delete("unsafejitwarmup");
  if (nextSettings.wasmjit === "0") {
    url.searchParams.delete("jitwarmup");
  } else {
    url.searchParams.set("jitwarmup", PLAYABLE_PRESET.jitwarmup);
  }

  return url.href;
}

export function buildPlayablePresetHref(href) {
  const url = new URL(buildSettingsHref(href, PLAYABLE_PRESET));
  url.searchParams.set("jitwarmup", PLAYABLE_PRESET.jitwarmup);
  url.searchParams.set("oc", PLAYABLE_PRESET.oc);
  return url.href;
}

export function describeSettings(settings) {
  const normalized = normalizeSettings(settings);
  const core = normalized.core === "upstream" ? "Upstream" : "Native";
  const video = normalized.video === "software" ? "Software" : normalized.video.toUpperCase();
  const cpu = normalized.cpu === "auto" ? "Auto CPU" : `${normalized.cpu} CPU`;
  const jit =
    normalized.wasmjit !== "1"
      ? "JIT off"
      : normalized.video === "ogl" && normalized.forcejit !== "1"
        ? "JIT OGL safe-off"
      : normalized.jittier === "mixed"
        ? "JIT mixed"
        : "JIT on";

  return `${core} / ${video} / ${cpu} / ${jit}`;
}

function normalizeSettings(settings) {
  const normalized = {};

  for (const key of SETTING_KEYS) {
    normalized[key] = normalizeChoice(key, settings?.[key] ?? DEFAULT_SETTINGS[key]);
  }

  return normalized;
}

function normalizeChoice(key, value) {
  const text = String(value ?? DEFAULT_SETTINGS[key]);
  return CHOICE_SETS[key].has(text) ? text : DEFAULT_SETTINGS[key];
}

function normalizeSpeed(value) {
  if (value === "unlimited") {
    return value;
  }

  return value || "1";
}

function normalizePresentationScale(value) {
  if (value === "half") {
    return "half";
  }

  if (value === "0.75" || value === ".75" || value === "0.750") {
    return "0.75";
  }

  return "full";
}

function normalizePresenter(value) {
  if (value === "wgpu") {
    return "webgpu";
  }

  if (value === "canvas") {
    return "2d";
  }

  return value || DEFAULT_SETTINGS.presenter;
}

function normalizeOglProxy(value) {
  if (value === "direct" || value === "offscreen") {
    return "worker";
  }

  if (value === "bridge") {
    return "readback";
  }

  return value || DEFAULT_SETTINGS.oglproxy;
}

function writeSetting(params, key, value, defaultValue) {
  if (value === defaultValue) {
    params.delete(key);
    return;
  }

  params.set(key, value);
}
