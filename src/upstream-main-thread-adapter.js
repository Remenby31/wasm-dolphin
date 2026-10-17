import { widenU32Counter } from "./u32-counter.js";
import { parseDolHeader } from "./dol.js";
import {
  DEFAULT_UPSTREAM_CORE_SHA256,
  DEFAULT_UPSTREAM_CORE_URL,
  WORKERFS_MOUNT_DIR,
  sanitizeDiscFileName,
  verifyUpstreamCoreWasm
} from "./upstream-worker-protocol.js";

const MIN_FULL_BOOT_BYTES = 16 * 1024 * 1024;

export class UpstreamMainThreadAdapter {
  constructor({
    coreUrl = DEFAULT_UPSTREAM_CORE_URL,
    expectedCoreSha256 = DEFAULT_UPSTREAM_CORE_SHA256,
    canvas,
    onStatus = () => {},
    videoBackend = "OGL",
    cpuThread = false,
    cpuCore = "cached",
    ppcWasmJit = false,
    ppcWasmJitTier = "guarded",
    ppcWasmJitForce = false,
    ppcWasmJitWarmupFrames = 3600,
    ppcProfile = false,
    cpuOverclock = 1,
    emulationSpeed = 1,
    presentationScale = 1,
    oglTestClear = false,
    fastSoftwareRaster = 0,
    xfbFastPaths = 0
  } = {}) {
    this.coreUrl = coreUrl;
    this.expectedCoreSha256 = expectedCoreSha256;
    this.canvas = canvas;
    this.onStatus = onStatus;
    this.videoBackend = videoBackend;
    this.cpuThread = cpuThread;
    this.cpuCore = cpuCore;
    this.ppcWasmJit = ppcWasmJit;
    this.ppcWasmJitTier = ppcWasmJitTier === "mixed" ? "mixed" : "guarded";
    this.ppcWasmJitForce = Boolean(ppcWasmJitForce);
    this.ppcWasmJitWarmupFrames = ppcWasmJitWarmupFrames;
    this.ppcProfile = Boolean(ppcProfile);
    this.cpuOverclock = cpuOverclock;
    this.emulationSpeed = emulationSpeed;
    this.presentationScale = presentationScale;
    this.oglTestClear = Boolean(oglTestClear);
    this.fastSoftwareRaster = Math.min(3, Math.max(0, Number(fastSoftwareRaster) || 0));
    this.xfbFastPaths = (Number(xfbFastPaths) || 0) & 3;
    this.module = null;
    this.api = null;
    this.loaded = false;
    this.mounted = false;
    this.width = 640;
    this.height = 480;
    this.coreFrame = 0;
    this.presentedFrame = 0;
    this.presentationFps = 0;
    this.presentationRawFps = 0;
    this.presentationAverageIntervalMs = 0;
    this.presentationP95IntervalMs = 0;
    this.presentationMaxIntervalMs = 0;
    this.presentationLongFrameCount = 0;
    this.presentationFrameLag = 0;
    this.presentationQueueAgeMs = 0;
    this.visualChangeFps = 0;
    this.visualFrameHash = 0;
    this.visualSampleSource = "none";
    this.oglGlError = 0;
    this.lastOglSwapCount = 0;
    this.coreTicks = 0;
    this.coreTicksPerSecond = 486000000;
    this.ppcPc = 0;
    this.cpuCoreName = "";
    this.ppcWasmBlockCompileCount = 0;
    this.ppcWasmBlockRunCount = 0;
    this.widenBlockRunCount = widenU32Counter();
    this.ppcWasmHelperStats = "";
    this.frameProfileStats = "-";
    this.coreBoot = { attempted: false, accepted: false, path: "", skippedReason: "" };
  }

  async load() {
    if (this.loaded) {
      return this.module;
    }

    let verified;
    try {
      verified = await verifyUpstreamCoreWasm(this.coreUrl, this.expectedCoreSha256, window.location.href);
    } catch (error) {
      if (this.coreUrl === DEFAULT_UPSTREAM_CORE_URL) throw error;
      this.onStatus(`Candidate core rejected; rolling back to pinned baseline: ${error.message}`);
      this.coreUrl = DEFAULT_UPSTREAM_CORE_URL;
      this.expectedCoreSha256 = DEFAULT_UPSTREAM_CORE_SHA256;
      verified = await verifyUpstreamCoreWasm(this.coreUrl, this.expectedCoreSha256, window.location.href);
    }
    const coreUrl = verified.coreUrl;
    const imported = await import(coreUrl);
    const factory = imported.default ?? imported.createDolphinCore ?? window.createDolphinCore;
    if (typeof factory !== "function") {
      throw new Error("Upstream Dolphin bundle did not expose createDolphinCore");
    }

    this.canvas.id = this.canvas.id || "canvas";
    this.module = await factory({
      noInitialRun: true,
      wasmBinary: verified.wasmBinary,
      canvas: this.canvas,
      dolphinOglWorkerWebGl: this.videoBackend === "OGL",
      dolphinOglTestClear: this.oglTestClear,
      dolphinFastSoftwareRaster: this.fastSoftwareRaster,
      dolphinXfbFastPaths: this.xfbFastPaths,
      locateFile: (path) => new URL(path, coreUrl).href,
      print: (message) => this.onStatus(String(message)),
      printErr: (message) => this.onStatus(String(message)),
      onAbort: (reason) => this.onStatus(`Emscripten abort: ${reason}`)
    });

    this.api = this.bindApi(this.module);
    this.api.setVideoBackend?.(this.videoBackend);
    this.api.setCpuThread?.(Boolean(this.cpuThread));
    this.api.setCpuCore?.(this.cpuCore);
    this.api.setPpcWasmJitEnabled?.(0);
    this.api.setPpcProfileEnabled?.(this.ppcProfile ? 1 : 0);
    this.api.setCpuOverclock?.(Number(this.cpuOverclock));
    this.api.setEmulationSpeed?.(Number(this.emulationSpeed));
    this.api.setPresentationScale?.(Number(this.presentationScale));
    this.api.setFastSoftwareRaster?.(this.fastSoftwareRaster);
    this.api.setXfbFastPaths?.(this.xfbFastPaths);
    this.api.coreInit?.();
    this.loaded = true;
    this.refreshStats();
    return this.module;
  }

  bindApi(module) {
    const cwrap = module.cwrap.bind(module);
    const ccall = module.ccall.bind(module);
    const optionalCwrap = (name, returnType, argTypes = []) =>
      typeof module[`_${name}`] === "function" ? cwrap(name, returnType, argTypes) : null;

    return {
      mountDisc: (path) => ccall("MountDisc", "number", ["string"], [path]),
      coreInit: optionalCwrap("CoreInit", "number", []),
      setVideoBackend: optionalCwrap("SetVideoBackend", null, ["string"]),
      setCpuThread: optionalCwrap("SetCpuThread", null, ["number"]),
      setCpuCore: optionalCwrap("SetCpuCore", null, ["string"]),
      setCpuOverclock: optionalCwrap("SetCpuOverclock", null, ["number"]),
      setEmulationSpeed: optionalCwrap("SetEmulationSpeed", null, ["number"]),
      setPresentationScale: optionalCwrap("SetPresentationScale", null, ["number"]),
      setFastSoftwareRaster: optionalCwrap("SetFastSoftwareRaster", "number", ["number"]),
      setXfbFastPaths: optionalCwrap("SetXfbFastPaths", "number", ["number"]),
      bootDisc: optionalCwrap("BootDisc", "number", ["string"]),
      setCorePaused: optionalCwrap("SetCorePaused", "number", ["number"]),
      resetCore: optionalCwrap("ResetCore", "number", []),
      saveCoreState: optionalCwrap("SaveCoreState", "number", ["number"]),
      loadCoreState: optionalCwrap("LoadCoreState", "number", ["number"]),
      pumpHostJobs: optionalCwrap("PumpHostJobs", null, []),
      getCoreState: optionalCwrap("GetCoreState", "number", []),
      getCoreStateName: optionalCwrap("GetCoreStateName", "string", []),
      getCoreStatus: optionalCwrap("GetCoreStatus", "string", []),
      getCoreTitle: optionalCwrap("GetCoreTitle", "string", []),
      getCoreTicksLow: optionalCwrap("GetCoreTicksLow", "number", []),
      getCoreTicksHigh: optionalCwrap("GetCoreTicksHigh", "number", []),
      getCoreTicksPerSecond: optionalCwrap("GetCoreTicksPerSecond", "number", []),
      getPpcPc: optionalCwrap("GetPPCPC", "number", []),
      getCpuCoreName: optionalCwrap("GetCPUCoreName", "string", []),
      audioSampleRate: optionalCwrap("AudioSampleRate", "number", []),
      audioChannels: optionalCwrap("AudioChannels", "number", []),
      audioBufferFrames: optionalCwrap("AudioBufferFrames", "number", []),
      audioBuffer: optionalCwrap("AudioBuffer", "number", []),
      mixAudio: optionalCwrap("MixAudio", "number", ["number"]),
      setAudioMuted: optionalCwrap("SetAudioMuted", "number", ["number"]),
      getAudioStats: optionalCwrap("GetAudioStats", "string", []),
      getPpcWasmBlockCompileCount: optionalCwrap("GetPpcWasmBlockCompileCount", "number", []),
      getPpcWasmBlockRunCount: optionalCwrap("GetPpcWasmBlockRunCount", "number", []),
      getPpcWasmHelperStats: optionalCwrap("GetPpcWasmHelperStats", "string", []),
      getPpcProfileStats: optionalCwrap("GetPpcProfileStats", "string", []),
      getVideoStats: optionalCwrap("GetVideoStats", "string", []),
      reset: cwrap("Reset", null, []),
      setInputMask: cwrap("SetInputMask", null, ["number"]),
      setInputState:
        typeof module._SetInputState === "function"
          ? (state) =>
              ccall(
                "SetInputState",
                null,
                ["number", "number", "number", "number", "number", "number", "number", "number", "number", "number"],
                [
                  state.mask >>> 0,
                  state.stickX | 0,
                  state.stickY | 0,
                  state.cStickX | 0,
                  state.cStickY | 0,
                  state.triggerLeft | 0,
                  state.triggerRight | 0,
                  state.analogA | 0,
                  state.analogB | 0,
                  state.inputGeneration >>> 0
                ]
              )
          : null,
      runFrame: cwrap("RunFrame", null, []),
      frameWidth: cwrap("FrameWidth", "number", []),
      frameHeight: cwrap("FrameHeight", "number", []),
      frameBuffer: cwrap("FrameBuffer", "number", []),
      saveState: cwrap("SaveState", "number", ["number"]),
      loadState: cwrap("LoadState", "number", ["number"]),
      getFrame: cwrap("GetFrame", "number", []),
      getGameId: cwrap("GetGameId", "string", []),
      getGameTitle: cwrap("GetGameTitle", "string", []),
      getMakerId: cwrap("GetMakerId", "string", []),
      getPlatform: cwrap("GetPlatform", "string", []),
      getRegion: cwrap("GetRegion", "string", []),
      getDiscNumber: cwrap("GetDiscNumber", "number", []),
      getApploaderDate: cwrap("GetApploaderDate", "string", []),
      getApploaderSize: cwrap("GetApploaderSize", "number", []),
      getBootDolOffset: cwrap("GetBootDolOffset", "number", []),
      getBootDolSize: cwrap("GetBootDolSize", "number", []),
      getFstOffset: cwrap("GetFstOffset", "number", []),
      getFstSize: cwrap("GetFstSize", "number", []),
      getRawSize: cwrap("GetRawSize", "number", []),
      getDataSize: cwrap("GetDataSize", "number", []),
      getRootEntryCount: cwrap("GetRootEntryCount", "number", []),
      getRootEntryName: cwrap("GetRootEntryName", "string", ["number"]),
      getRootEntryPath: cwrap("GetRootEntryPath", "string", ["number"]),
      getRootEntryIsDirectory: cwrap("GetRootEntryIsDirectory", "number", ["number"]),
      getRootEntryOffset: cwrap("GetRootEntryOffset", "number", ["number"]),
      getRootEntrySize: cwrap("GetRootEntrySize", "number", ["number"]),
      readDisc: cwrap("ReadDisc", "number", ["number", "number", "number"]),
      setPpcWasmJitEnabled: optionalCwrap("SetPpcWasmJitEnabled", null, ["number"]),
      setPpcProfileEnabled: optionalCwrap("SetPpcProfileEnabled", null, ["number"])
    };
  }

  async mountGame(file) {
    await this.load();
    if (!file) {
      throw new Error("No disc file was provided");
    }

    const fs = this.module.FS;
    const safeName = sanitizeDiscFileName(file.name);
    const path = `${WORKERFS_MOUNT_DIR}/${safeName}`;

    try {
      fs.mkdir(WORKERFS_MOUNT_DIR);
    } catch {
      // Mount point may already exist.
    }

    if (this.mounted) {
      fs.unmount(WORKERFS_MOUNT_DIR);
      this.mounted = false;
    }

    fs.mount(fs.filesystems.WORKERFS, { blobs: [{ name: safeName, data: file }] }, WORKERFS_MOUNT_DIR);
    this.mounted = true;

    if (!this.api.mountDisc(path)) {
      throw new Error("Upstream Dolphin DiscIO rejected the selected disc");
    }

    this.coreBoot = { attempted: false, accepted: false, path, skippedReason: "" };
    if (this.api.bootDisc && file.size >= MIN_FULL_BOOT_BYTES) {
      this.coreBoot.attempted = true;
      this.coreBoot.accepted = Boolean(this.api.bootDisc(path));
      this.api.pumpHostJobs?.();
    } else if (this.api.bootDisc) {
      this.coreBoot.skippedReason = `Disc image is too small for full CPU boot (${file.size} bytes)`;
    }

    this.refreshStats();
    const metadata = this.metadata();
    return {
      ...metadata,
      bootProbe: this.bootProbe(metadata),
      path
    };
  }

  metadata() {
    const rootEntryCount = this.api?.getRootEntryCount() ?? -1;
    return {
      width: this.width,
      height: this.height,
      frame: this.coreFrame,
      gameId: this.api?.getGameId() ?? "",
      title: this.api?.getGameTitle() ?? "",
      makerId: this.api?.getMakerId() ?? "",
      platform: this.api?.getPlatform() ?? "",
      region: this.api?.getRegion() ?? "",
      discNumber: this.api?.getDiscNumber() ?? -1,
      apploaderDate: this.api?.getApploaderDate() ?? "",
      apploaderSize: this.api?.getApploaderSize() ?? -1,
      bootDolOffset: this.api?.getBootDolOffset() ?? -1,
      bootDolSize: this.api?.getBootDolSize() ?? -1,
      fstOffset: this.api?.getFstOffset() ?? -1,
      fstSize: this.api?.getFstSize() ?? -1,
      rawSize: this.api?.getRawSize() ?? -1,
      dataSize: this.api?.getDataSize() ?? -1,
      rootEntryCount,
      rootEntries: this.readRootEntries(rootEntryCount),
      fullCore: Boolean(this.api?.bootDisc),
      coreBoot: this.coreBoot,
      coreState: this.api?.getCoreState?.() ?? -1,
      coreStateName: this.api?.getCoreStateName?.() ?? "",
      coreStatus: this.api?.getCoreStatus?.() ?? "",
      coreTitle: this.api?.getCoreTitle?.() ?? "",
      coreTicks: this.coreTicks,
      coreTicksPerSecond: this.coreTicksPerSecond,
      ppcPc: this.ppcPc,
      cpuCoreName: this.cpuCoreName,
      ppcWasmBlockCompileCount: this.ppcWasmBlockCompileCount,
      ppcWasmBlockRunCount: this.ppcWasmBlockRunCount
    };
  }

  bootProbe(metadata) {
    if (!this.api || !this.module || !metadata.gameId) {
      return { attempted: false, status: "blocked", blocker: "No mounted disc", milestones: [] };
    }

    const milestones = [`Disc mounted: ${metadata.gameId}`];
    try {
      const headerBytes = this.readDiscBytes(metadata.bootDolOffset, Math.min(0x100, metadata.bootDolSize));
      const dol = parseDolHeader(headerBytes);
      milestones.push(`Boot DOL entry parsed: ${formatHex(dol.entryPoint)}`);
      return {
        attempted: true,
        status: this.coreBoot.accepted ? "boot-submitted" : "blocked",
        blocker: this.coreBoot.accepted
          ? "Dolphin core boot was submitted; waiting for rendered frames and controller input"
          : metadata.coreStatus || this.coreBoot.skippedReason || "Dolphin core rejected the boot request",
        milestones,
        dol,
        coreState: metadata.coreState,
        coreStateName: metadata.coreStateName,
        coreStatus: metadata.coreStatus,
        coreTitle: metadata.coreTitle
      };
    } catch (error) {
      return {
        attempted: true,
        status: "failed",
        blocker: error instanceof Error ? error.message : String(error),
        milestones
      };
    }
  }

  readDiscBytes(offset, length) {
    const pointer = this.module._malloc(length);
    if (!pointer) {
      throw new Error("Unable to allocate DOL read buffer");
    }
    try {
      const read = this.api.readDisc(offset, length, pointer);
      if (read <= 0) {
        throw new Error("Unable to read boot DOL bytes");
      }
      return this.module.HEAPU8.slice(pointer, pointer + read);
    } finally {
      this.module._free(pointer);
    }
  }

  readRootEntries(rootEntryCount) {
    if (!this.api || rootEntryCount <= 0) {
      return [];
    }
    const entries = [];
    for (let index = 0; index < Math.min(rootEntryCount, 256); index += 1) {
      entries.push({
        name: this.api.getRootEntryName(index),
        path: this.api.getRootEntryPath(index),
        directory: Boolean(this.api.getRootEntryIsDirectory(index)),
        offset: this.api.getRootEntryOffset(index),
        size: this.api.getRootEntrySize(index)
      });
    }
    return entries;
  }

  runFrame() {
    this.api?.pumpHostJobs?.();
    this.refreshStats();
  }

  refreshStats() {
    if (!this.api) {
      return;
    }
    this.width = this.api.frameWidth();
    this.height = this.api.frameHeight();
    this.coreFrame = this.api.getFrame();
    this.presentedFrame = this.coreFrame;
    this.coreTicks = this.readCoreTicks();
    this.coreTicksPerSecond = this.api.getCoreTicksPerSecond?.() || 486000000;
    this.ppcPc = this.api.getPpcPc?.() ?? 0;
    this.cpuCoreName = this.api.getCpuCoreName?.() ?? "";
    this.ppcWasmBlockCompileCount = this.api.getPpcWasmBlockCompileCount?.() ?? 0;
    this.ppcWasmBlockRunCount = this.widenBlockRunCount(this.api.getPpcWasmBlockRunCount?.() ?? 0);
    this.ppcWasmHelperStats = joinedStats(
      this.api.getPpcWasmHelperStats?.(),
      this.api.getPpcProfileStats?.(),
      this.api.getVideoStats?.(),
      "present main-ogl"
    );
    // For OGL the videoStats `hash:` field is frozen on a stale XFB snapshot
    // because OnXfb is bypassed when the OGL backend renders straight to the
    // canvas; only OnOglSwap fires, and it does not refresh that hash. The
    // ogl_swap counter in OglSwapStats() does increment per swap, so use it
    // as the authoritative OGL frame-change signal here too.
    const oglStats = parseOglSwapStats(this.ppcWasmHelperStats);
    if (oglStats.swap > 0) {
      if (this.lastOglSwapCount > 0 && oglStats.swap > this.lastOglSwapCount) {
        this.visualChangeFps = oglStats.swap - this.lastOglSwapCount;
      }
      this.visualFrameHash = oglStats.swap;
      this.visualSampleSource = "ogl-swap";
      this.lastOglSwapCount = oglStats.swap;
    } else {
      this.visualFrameHash = parseVideoFrameHash(this.ppcWasmHelperStats);
      this.visualSampleSource = "xfb-hash";
    }
    this.oglGlError = oglStats.glError;
  }

  readCoreTicks() {
    const low = this.api?.getCoreTicksLow?.() ?? 0;
    const high = this.api?.getCoreTicksHigh?.() ?? 0;
    return high * 4294967296 + (low >>> 0);
  }

  setInputMask(mask) {
    this.api?.setInputMask(mask >>> 0);
  }

  setInputState(state) {
    this.api?.setInputState?.(state);
  }

  readFrameRgba() {
    return null;
  }

  async mixAudio(frames = 1024) {
    if (!this.loaded || !this.api?.mixAudio || !this.api?.audioBuffer || !this.module?.HEAPU8) {
      return {
        available: false,
        frames: 0,
        channels: 2,
        sampleRate: 48000,
        samples: null,
        stats: this.api?.getAudioStats?.() || "audio:unavailable"
      };
    }

    const channels = Math.max(1, Math.min(2, this.api.audioChannels?.() || 2));
    const sampleRate = Math.max(8000, this.api.audioSampleRate?.() || 48000);
    const maxFrames = Math.max(1, this.api.audioBufferFrames?.() || 4096);
    const requested = Math.max(1, Math.min(maxFrames, Number(frames) || 1024));
    const mixed = Math.max(0, Math.min(maxFrames, this.api.mixAudio(requested) | 0));
    const byteLength = mixed * channels * Int16Array.BYTES_PER_ELEMENT;
    const pointer = this.api.audioBuffer();
    const samples = pointer && byteLength > 0 ? this.module.HEAPU8.slice(pointer, pointer + byteLength).buffer : null;

    return {
      available: Boolean(pointer && mixed > 0),
      frames: mixed,
      channels,
      sampleRate,
      samples,
      stats: this.api.getAudioStats?.() || ""
    };
  }

  setAudioMuted(muted) {
    this.api?.setAudioMuted?.(muted ? 1 : 0);
  }

  start() {
    this.api?.setCorePaused?.(0);
  }

  pause() {
    this.api?.setCorePaused?.(1);
  }

  reset() {
    if (!this.api?.resetCore?.()) {
      this.api?.reset();
    }
  }

  saveState(slot) {
    return this.api?.saveCoreState?.(slot | 0) || this.api?.saveState(slot | 0);
  }

  loadState(slot) {
    return this.api?.loadCoreState?.(slot | 0) || this.api?.loadState(slot | 0);
  }
}

function joinedStats(...parts) {
  return parts.filter((part) => typeof part === "string" && part.length > 0).join(" | ");
}

function parseVideoFrameHash(stats) {
  const match = String(stats || "").match(/\bhash:([0-9a-f]+)/i);
  return match ? Number.parseInt(match[1], 16) >>> 0 : 0;
}

function parseOglSwapStats(stats) {
  const text = String(stats || "");
  const swap = Number.parseInt(/\bogl_swap:(\d+)/i.exec(text)?.[1] || "", 10);
  const glError = Number.parseInt(/\bglerr:0x([0-9a-f]+)/i.exec(text)?.[1] || "", 16);
  return {
    swap: Number.isFinite(swap) ? swap >>> 0 : 0,
    glError: Number.isFinite(glError) ? glError >>> 0 : 0
  };
}

function formatHex(value) {
  return Number.isFinite(value) && value >= 0 ? `0x${Math.trunc(value).toString(16)}` : "";
}
