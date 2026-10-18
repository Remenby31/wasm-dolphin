import { DolphinCoreAdapter, dolphinBundleAvailable } from "./dolphin-adapter.js";
import { buttonMaskFromPressed, isPadPort } from "./input.js";
import { UpstreamMainThreadAdapter } from "./upstream-main-thread-adapter.js";
import { UpstreamWorkerAdapter, describeUserDataStatus, upstreamBundleAvailable } from "./upstream-worker-adapter.js";
import {
  DEFAULT_UPSTREAM_CORE_URL,
  requestedLegacyOneWayAck,
  requestedSoftwareTevHotCaseMode,
  requestedXfbFastPaths,
  requestedUpstreamCoreBuild
} from "./upstream-worker-protocol.js";
import {
  requestedWgpuAtomicPassReplay,
  requestedWgpuDeepReplayDiagnostics,
  requestedWgpuDetachedPresenter,
  requestedWgpuLoadEpochFence,
  requestedWgpuReplayPump,
  requestedWgpuRendererWorkerProbe,
  requestedWgpuReplayBudgetMs,
  requestedWgpuPowerPreference,
  requestedWgpuReplayDiagnostics,
  requestedWgpuDiagnosticQuiet,
  requestedWgpuProducerProfile,
  requestedWgpuDrawProfile,
  requestedWgpuTailGate,
  requestedWgpuStateCache,
  requestedWgpuGeometryPack,
  requestedWgpuGeometryRange,
  requestedWgpuMappedStageTimingStride,
  requestedWgpuMappedStagingSlotCount,
  requestedWgpuUploadArenaMiB,
  requestedWgpuUploadTransport,
  requestedWgpuMappedStageFast,
  requestedWgpuMappedDrainCoalescing,
  requestedWgpuUboCache,
  requestedWgpuUboMetrics,
  requestedWgpuVpDiag,
  requestedWgpuUniformFast,
  requestedWgpuUboPack
} from "./wgpu-replay-diagnostics.js";
import { instantiateDemoCore } from "./wasm/demo-core.js";
import { createCausalTelemetry, deepMerge } from "./causal-telemetry.js";
import { legacyTickQueueRequested } from "./presentation-pacing.js";
import { requestedGpuCompletionDiagnostics } from "./gpu-completion-telemetry.js";
import { requestedWgpuDirtyRangeProjection } from "./wgpu-dirty-range-projection.js";
import { requestedWgpuPassPackageProjection } from "./wgpu-pass-package-projection.js";
import { requestedWgpuUploadRunProjection } from "./wgpu-upload-run-projection.js";
import { requestedWgpuUboComputeProjection } from "./wgpu-ubo-compute-projection.js";
import { requestedWgpuUboComputeReconstruction } from "./wgpu-ubo-compute-reconstruction.js";
import { requestedWgpuOwnershipTrace } from "./wgpu-ownership-trace.js";
import { requestedWgpuSemanticRuntime } from "./wgpu-semantic-runtime.js";
import {
  requestedInputLatencyDiagnostics,
  requestedInputReadbackDiagnostics
} from "./input-latency-telemetry.js";
import { requestedInputPhotonMarkerConfig } from "./input-visual-marker.js";
import { requestedWgpuVisualCadence } from "./wgpu-visual-cadence.js";
import { requestedWgpuSparseUbo } from "./wgpu-sparse-ubo-copy-forward.js";

const DEMO_WIDTH = 320;
const DEMO_HEIGHT = 240;
const SAVE_KEY = "wasm-dolphin.demo-state.0";
const VISIBLE_SAMPLE_WIDTH = 96;
const VISIBLE_SAMPLE_HEIGHT = 72;
const VISIBLE_SAMPLE_INTERVAL_MS = 250;
const SAFE_JIT_WARMUP_FRAMES = 5000;
const DEFAULT_JIT_WARMUP_FRAMES = 60;

export class EmulatorHost {
  constructor({ canvas, onFrame = () => {}, onStatus = () => {}, onMode = () => {} }) {
    this.canvas = canvas;
    this.onFrame = onFrame;
    this.onStatus = onStatus;
    this.onMode = onMode;

    this.demo = null;
    this.coreKind = requestedCoreKind();
    try {
      this.upstreamCoreBuild = requestedUpstreamCoreBuild(window.location.search);
    } catch (error) {
      onStatus(`Invalid candidate core selector; using pinned baseline: ${error.message}`);
      this.upstreamCoreBuild = requestedUpstreamCoreBuild("");
    }
    this.videoBackend = requestedVideoBackend();
    this.cpuThread = requestedCpuThread(this.videoBackend);
    this.cpuCore = requestedCpuCore();
    this.ppcWasmJit = requestedPpcWasmJit(this.videoBackend);
    this.ppcWasmJitTier = requestedPpcWasmJitTier();
    this.ppcWasmJitForce = requestedPpcWasmJitForce();
    this.ppcWasmJitWarmupFrames = requestedPpcWasmJitWarmupFrames(this.videoBackend);
    this.ppcProfile = requestedPpcProfile();
    this.cpuOverclock = requestedCpuOverclock();
    this.emulationSpeed = requestedEmulationSpeed();
    this.presentationScale = requestedPresentationScale();
    this.presentationQueueSize = requestedPresentationQueueSize();
    this.presenterBackend = requestedPresenterBackend();
    this.presentationPacing = requestedPresentationPacing(this.videoBackend);
    this.legacyTickQueue = legacyTickQueueRequested(window.location.search);
    this.oglProxyMode = requestedOglProxyMode();
    this.oglTestClear = requestedOglTestClear();
    this.fastSoftwareRaster = requestedFastSoftwareRaster();
    this.softwareTevHotCaseMode = requestedSoftwareTevHotCaseMode(window.location.search);
    this.xfbFastPaths = requestedXfbFastPaths(window.location.search);
    this.correctTimeDrift = requestedCorrectTimeDrift();
    this.coreLog = requestedCoreLog();
    this.memcardSlotB = new URLSearchParams(window.location.search).get("memcardb") === "1";
    this.savesMode = new URLSearchParams(window.location.search).get("saves") === "off" ? "off" : "";
    this.efbDiag = requestedEfbDiag();
    this.jitVerbose = new URLSearchParams(window.location.search).get("jitverbose") === "1";
    this.frameCap = Number.parseInt(
      new URLSearchParams(window.location.search).get("framecap") || "0", 10) || 0;
    this.cachedInterpreterDisableMask = requestedCachedInterpreterDisableMask();
    this.wgpuScissoredClearRect = requestedWgpuScissoredClearRect(
      this.cachedInterpreterDisableMask
    );
    this.noJitCache =
      new URLSearchParams(window.location.search).get("nojitcache") === "1";
    this.collectMetrics = requestedCollectMetrics();
    this.legacyOneWayAck = requestedLegacyOneWayAck(window.location.search);
    this.wgpuReplayDiagnostics = requestedWgpuReplayDiagnostics(window.location.search);
    this.wgpuDeepReplayDiagnostics = requestedWgpuDeepReplayDiagnostics(window.location.search);
    this.wgpuDetachedPresenter = requestedWgpuDetachedPresenter(window.location.search);
    this.wgpuLoadEpochFence = requestedWgpuLoadEpochFence(window.location.search);
    // Replaying continuously keeps the producer within a bounded 16K-record
    // window.  Repeated fixed-battle A/B runs showed substantially lower
    // replay age and higher presentation cadence for the real WGPU backend.
    // `wgpupump=0` remains the explicit rollback; other backends stay off.
    this.wgpuReplayPump = requestedWgpuReplayPump(
      window.location.search,
      this.videoBackend === "WebGPU-Real"
    );
    this.wgpuReplayBudgetMs = requestedWgpuReplayBudgetMs(window.location.search);
    this.wgpuPowerPreference = requestedWgpuPowerPreference(window.location.search);
    this.wgpuAtomicPassReplay = requestedWgpuAtomicPassReplay(window.location.search);
    this.wgpuDiagnosticQuiet = requestedWgpuDiagnosticQuiet(window.location.search);
    this.wgpuProducerProfile = this.collectMetrics &&
      requestedWgpuProducerProfile(window.location.search);
    this.wgpuDrawProfile = requestedWgpuDrawProfile(window.location.search);
    // Preserve the raw request so the worker can fail closed when the
    // correctness-sensitive experiment is used without metrics or true WGPU.
    this.wgpuTailGate = requestedWgpuTailGate(window.location.search);
    this.wgpuStateCache = requestedWgpuStateCache(window.location.search);
    this.wgpuUboCache = requestedWgpuUboCache(window.location.search);
    this.wgpuUboMetrics = requestedWgpuUboMetrics(window.location.search);
    this.wgpuVpDiag = requestedWgpuVpDiag(window.location.search);
    this.wgpuUniformFast = requestedWgpuUniformFast(window.location.search);
    this.wgpuUboPack = requestedWgpuUboPack(window.location.search);
    this.wgpuSparseUbo = requestedWgpuSparseUbo(window.location.search);
    this.wgpuGeometryPack = requestedWgpuGeometryPack(window.location.search);
    this.wgpuGeometryRange =
      this.wgpuGeometryPack && requestedWgpuGeometryRange(window.location.search);
    this.wgpuUploadArenaMiB = requestedWgpuUploadArenaMiB(window.location.search);
    this.wgpuUploadTransport = requestedWgpuUploadTransport(window.location.search);
    this.wgpuMappedStagingSlotCount = requestedWgpuMappedStagingSlotCount(
      window.location.search
    );
    this.wgpuMappedStageFast = requestedWgpuMappedStageFast(window.location.search);
    this.wgpuMappedStageTimingStride = requestedWgpuMappedStageTimingStride(
      window.location.search
    );
    this.wgpuMappedDrainCoalescing = requestedWgpuMappedDrainCoalescing(
      window.location.search
    );
    this.wgpuRendererWorkerProbe = requestedWgpuRendererWorkerProbe(window.location.search);
    this.wgpuVisualCadence = requestedWgpuVisualCadence(window.location.search, {
      hardwareVideo: this.videoBackend === "WebGPU-Real"
    });
    this.gpuCompletionDiagnostics = requestedGpuCompletionDiagnostics(window.location.search);
    this.wgpuDirtyRangeProjection = requestedWgpuDirtyRangeProjection(window.location.search);
    this.wgpuPassPackageProjection = requestedWgpuPassPackageProjection(
      window.location.search
    );
    this.wgpuUploadRunProjection = requestedWgpuUploadRunProjection(window.location.search);
    this.wgpuUboComputeProjection = requestedWgpuUboComputeProjection(
      window.location.search
    );
    this.wgpuUboComputeReconstruction = requestedWgpuUboComputeReconstruction(
      window.location.search
    );
    this.wgpuOwnershipTrace = requestedWgpuOwnershipTrace(window.location.search);
    this.wgpuSemanticRuntime = requestedWgpuSemanticRuntime(window.location.search);
    if (this.wgpuSemanticRuntime) this.wgpuOwnershipTrace = true;
    this.inputPhotonMarker = requestedInputPhotonMarkerConfig(window.location.search);
    this.inputLatencyDiagnostics =
      requestedInputLatencyDiagnostics(window.location.search) || this.inputPhotonMarker.enabled;
    this.inputReadbackDiagnostics = requestedInputReadbackDiagnostics(window.location.search);
    this.visibleSamplerEnabled = requestedVisibleSampler();
    // SAB pixel transport: when ?oglsab=1 is set on the URL AND we're on the
    // OGL backend, we allocate two SharedArrayBuffers at boot and hand them
    // to the worker. The worker writes per-readback pixels into the pixel
    // SAB and atomically bumps a generation counter in the meta SAB. Main
    // thread reads the generation in its existing animation loop and
    // putImageDatas onto a 2D-context visible canvas — bypassing the
    // worker's WebGPU presenter + OffscreenCanvas auto-mirror that today's
    // oglproxy=readback path pays for.
    this.oglSabEnabled =
      this.coreKind === "upstream" &&
      this.videoBackend === "OGL" &&
      requestedOglSab() &&
      typeof SharedArrayBuffer === "function";
    this.usesMainThreadOgl =
      this.coreKind === "upstream" && this.videoBackend === "OGL" && this.oglProxyMode === "main";
    this.usesDetachedWgpu =
      this.coreKind === "upstream" && this.videoBackend === "WebGPU-Real" &&
      this.wgpuDetachedPresenter;
    this.usesAdapterCanvas =
      this.coreKind === "upstream" &&
      !this.usesMainThreadOgl &&
      !this.oglSabEnabled &&
      !this.usesDetachedWgpu &&
      Boolean(canvas.transferControlToOffscreen);
    // canvasOwnedByAdapter gates the host's stats-poll cadence (250 ms). In
    // SAB mode the visible canvas stays on main, but the *frame production*
    // still happens in the worker, so we still want the poll active.
    this.canvasOwnedByAdapter = this.usesAdapterCanvas || this.usesMainThreadOgl ||
      this.oglSabEnabled || this.usesDetachedWgpu;
    // SAB mode keeps the visible canvas on the main thread so we can paint
    // it directly via putImageData. The host owns a 2D context here.
    this.context =
      this.canvasOwnedByAdapter && !this.oglSabEnabled
        ? null
        : canvas.getContext("2d", { alpha: false });
    if (this.context) {
      this.context.imageSmoothingEnabled = false;
    }

    // Allocate the SAB pair if SAB mode is enabled. Dimensions match the
    // worker's readback output: DolphinWebPublishAsyncReadback fills
    // s_framebuffer at ScaledPresentationDimension(GL canvas dim) which is
    // presentationScale × 320 × 240. We resize the visible canvas to those
    // exact dimensions so putImageData paints 1:1; CSS scales the canvas
    // up to its display size.
    if (this.oglSabEnabled) {
      const scale = Math.min(1, Math.max(0.25, Number(this.presentationScale) || 0.5));
      this.oglSabWidth = Math.max(160, Math.round(320 * scale));
      this.oglSabHeight = Math.max(120, Math.round(240 * scale));
      canvas.width = this.oglSabWidth;
      canvas.height = this.oglSabHeight;
      const pixelBytes = this.oglSabWidth * this.oglSabHeight * 4;
      this.oglPixelSab = new SharedArrayBuffer(pixelBytes);
      this.oglMetaSab = new SharedArrayBuffer(8); // [generation, reserved]
      this.oglPixelView = new Uint8ClampedArray(this.oglPixelSab);
      this.oglMetaView = new Int32Array(this.oglMetaSab);
      this.oglLastSeenGen = 0;
      // ImageData rejects SharedArrayBuffer-backed views in Chrome. Allocate
      // a regular Uint8ClampedArray and copy SAB → ImageData.data per paint
      // (one TypedArray.set, ~76 KB at present=half — < 0.1 ms).
      this.oglImageData = new ImageData(this.oglSabWidth, this.oglSabHeight);
    } else {
      this.oglPixelSab = null;
      this.oglMetaSab = null;
    }

    this.frameCanvas = this.canvasOwnedByAdapter ? null : document.createElement("canvas");
    if (this.frameCanvas) {
      this.frameCanvas.width = DEMO_WIDTH;
      this.frameCanvas.height = DEMO_HEIGHT;
    }
    this.frameContext = this.frameCanvas?.getContext("2d", { alpha: false }) ?? null;
    this.imageData = this.frameContext?.createImageData(DEMO_WIDTH, DEMO_HEIGHT) ?? null;
    this.pixels = this.imageData ? new Uint32Array(this.imageData.data.buffer) : null;
    this.nativeImageData = null;

    this.adapterLabel = this.coreKind === "upstream" ? "Dolphin upstream core" : "Dolphin native scaffold";
    if (this.coreKind === "upstream" && this.videoBackend === "OGL" && !this.oglSabEnabled) {
      // Standard OGL path: visible canvas is sized for the WebGPU/WebGL
      // presenter that will paint at higher-than-readback density. SAB mode
      // owns its own canvas sizing above (matched to readback size); skip
      // this so the SAB-sized canvas isn't clobbered.
      const oglScale = Math.min(1, Math.max(0.25, Number(this.presentationScale) || 0.5));
      canvas.width = Math.max(160, Math.round(640 * oglScale));
      canvas.height = Math.max(120, Math.round(480 * oglScale));
    }
    // Defer transferControlToOffscreen until the adapter actually posts the
    // canvas to the worker, AND replace the canvas DOM node with a fresh
    // clone right before transfer. The bare-canvas approach failed for at
    // least one user with the Chrome error "Cannot transfer OffscreenCanvas
    // bound to element using captureStream" - some browser extension (or
    // Chrome's own compositor mirror in some configurations) had bound a
    // captureStream to the original canvas, permanently locking it from
    // transfer. Swapping in a fresh canvas element severs any such binding
    // because the new element has none of that history.
    const transferCanvasToOffscreen = () => {
      if (!this.usesAdapterCanvas || typeof canvas.transferControlToOffscreen !== "function") {
        return null;
      }
      try {
        // Try direct transfer first - the simplest case.
        const direct = canvas.transferControlToOffscreen();
        direct.id = "canvas";
        return direct;
      } catch (err) {
        console.warn("[host] direct transferControlToOffscreen failed; trying canvas replacement:", err);
        try {
          // Replace the DOM canvas with a freshly-created one. The new
          // element has no captureStream history, no extension hooks, no
          // compositor binding. Copy across the relevant attributes.
          const replacement = document.createElement("canvas");
          replacement.id = canvas.id;
          replacement.width = canvas.width;
          replacement.height = canvas.height;
          for (const cls of canvas.classList) replacement.classList.add(cls);
          replacement.setAttribute("aria-label", canvas.getAttribute("aria-label") || "");
          if (canvas.parentNode) canvas.parentNode.replaceChild(replacement, canvas);
          // Re-point the host's reference and the elements registry.
          canvas = replacement;
          this.canvas = replacement;
          const off = replacement.transferControlToOffscreen();
          off.id = "canvas";
          return off;
        } catch (err2) {
          console.warn("[host] canvas-replacement transferControlToOffscreen also failed:", err2);
          return null;
        }
      }
    };
    this.adapter =
      this.coreKind === "upstream" && this.usesMainThreadOgl
        ? new UpstreamMainThreadAdapter({
            coreUrl: this.upstreamCoreBuild.coreUrl,
            expectedCoreSha256: this.upstreamCoreBuild.sha256,
            onStatus,
            canvas,
            videoBackend: this.videoBackend,
            cpuThread: this.cpuThread,
            cpuCore: this.cpuCore,
            ppcWasmJit: this.ppcWasmJit,
            ppcWasmJitTier: this.ppcWasmJitTier,
            ppcWasmJitForce: this.ppcWasmJitForce,
            ppcWasmJitWarmupFrames: this.ppcWasmJitWarmupFrames,
            ppcProfile: this.ppcProfile,
            cpuOverclock: this.cpuOverclock,
            emulationSpeed: this.emulationSpeed,
            presentationScale: this.presentationScale,
            oglTestClear: this.oglTestClear,
            fastSoftwareRaster: this.fastSoftwareRaster,
            xfbFastPaths: this.xfbFastPaths
          })
        : this.coreKind === "upstream"
        ? new UpstreamWorkerAdapter({
            coreUrl: this.upstreamCoreBuild.coreUrl,
            expectedCoreSha256: this.upstreamCoreBuild.sha256,
            onStatus,
            // For OGL with oglproxy=worker, skip transferControlToOffscreen
            // entirely. The worker creates a standalone OffscreenCanvas for
            // its GL context and posts ImageBitmaps back per frame; main
            // thread draws them onto the visible canvas via 2D context.
            // This avoids all the captureStream / commit() / pthread-canvas
            // issues that have plagued the bound-canvas paths.
            //
            // Only OGL+worker uses the visibleCanvas/no-transfer path. The
            // software backend always transfers; oglProxyMode is a no-op for
            // it. (Earlier this branch read `oglProxyMode === "worker"`
            // unconditionally, which broke software mode because the default
            // proxy mode is "worker" even when the video backend is software.)
            transferCanvas:
              (this.videoBackend === "OGL" && this.oglProxyMode === "worker") ||
                this.oglSabEnabled || this.usesDetachedWgpu
                ? null
                : transferCanvasToOffscreen,
            visibleCanvas:
              (this.videoBackend === "OGL" && this.oglProxyMode === "worker") ||
                this.oglSabEnabled || this.usesDetachedWgpu
                ? canvas
                : null,
            oglPixelSab: this.oglPixelSab,
            oglMetaSab: this.oglMetaSab,
            oglSabWidth: this.oglSabWidth || 0,
            oglSabHeight: this.oglSabHeight || 0,
            videoBackend: this.videoBackend,
            cpuThread: this.cpuThread,
            cpuCore: this.cpuCore,
            ppcWasmJit: this.ppcWasmJit,
            ppcWasmJitTier: this.ppcWasmJitTier,
            ppcWasmJitForce: this.ppcWasmJitForce,
            ppcWasmJitWarmupFrames: this.ppcWasmJitWarmupFrames,
            ppcProfile: this.ppcProfile,
            cpuOverclock: this.cpuOverclock,
            emulationSpeed: this.emulationSpeed,
            presentationScale: this.presentationScale,
            presentationQueueSize: this.presentationQueueSize,
            presenterBackend: this.presenterBackend,
            presentationPacing: this.presentationPacing,
            legacyTickQueue: this.legacyTickQueue,
            oglProxyMode: this.oglProxyMode,
            oglTestClear: this.oglTestClear,
            fastSoftwareRaster: this.fastSoftwareRaster,
            softwareTevHotCaseMode: this.softwareTevHotCaseMode,
            xfbFastPaths: this.xfbFastPaths,
            correctTimeDrift: this.correctTimeDrift,
            coreLog: this.coreLog,
            memcardSlotB: this.memcardSlotB,
            savesMode: this.savesMode,
            efbDiag: this.efbDiag,
            jitVerbose: this.jitVerbose,
            frameCap: this.frameCap,
            cachedInterpreterDisableMask: this.cachedInterpreterDisableMask,
            wgpuScissoredClearRect: this.wgpuScissoredClearRect,
            noJitCache: this.noJitCache,
            collectMetrics: this.collectMetrics,
            legacyOneWayAck: this.legacyOneWayAck,
            wgpuReplayDiagnostics: this.wgpuReplayDiagnostics,
            wgpuDeepReplayDiagnostics: this.wgpuDeepReplayDiagnostics,
            wgpuDetachedPresenter: this.wgpuDetachedPresenter,
            wgpuLoadEpochFence: this.wgpuLoadEpochFence,
            wgpuReplayPump: this.wgpuReplayPump,
            wgpuReplayBudgetMs: this.wgpuReplayBudgetMs,
            wgpuPowerPreference: this.wgpuPowerPreference,
            wgpuAtomicPassReplay: this.wgpuAtomicPassReplay,
            wgpuDiagnosticQuiet: this.wgpuDiagnosticQuiet,
            wgpuProducerProfile: this.wgpuProducerProfile,
            wgpuDrawProfile: this.wgpuDrawProfile,
            wgpuTailGate: this.wgpuTailGate,
            wgpuStateCache: this.wgpuStateCache,
            wgpuUboCache: this.wgpuUboCache,
            wgpuUboMetrics: this.wgpuUboMetrics,
            wgpuVpDiag: this.wgpuVpDiag,
            wgpuUniformFast: this.wgpuUniformFast,
            wgpuUboPack: this.wgpuUboPack,
            wgpuSparseUbo: this.wgpuSparseUbo,
            wgpuGeometryPack: this.wgpuGeometryPack,
            wgpuGeometryRange: this.wgpuGeometryRange,
            wgpuUploadArenaMiB: this.wgpuUploadArenaMiB,
            wgpuUploadTransport: this.wgpuUploadTransport,
            wgpuMappedStagingSlotCount: this.wgpuMappedStagingSlotCount,
            wgpuMappedStageFast: this.wgpuMappedStageFast,
            wgpuMappedStageTimingStride: this.wgpuMappedStageTimingStride,
            wgpuMappedDrainCoalescing: this.wgpuMappedDrainCoalescing,
            wgpuRendererWorkerProbe: this.wgpuRendererWorkerProbe,
            wgpuVisualCadence: this.wgpuVisualCadence,
            gpuCompletionDiagnostics: this.gpuCompletionDiagnostics,
            wgpuDirtyRangeProjection: this.wgpuDirtyRangeProjection,
            wgpuPassPackageProjection: this.wgpuPassPackageProjection,
            wgpuUploadRunProjection: this.wgpuUploadRunProjection,
            wgpuUboComputeProjection: this.wgpuUboComputeProjection,
            wgpuUboComputeReconstruction: this.wgpuUboComputeReconstruction,
            wgpuOwnershipTrace: this.wgpuOwnershipTrace,
            wgpuSemanticRuntime: this.wgpuSemanticRuntime,
            inputLatencyDiagnostics: this.inputLatencyDiagnostics,
            inputReadbackDiagnostics: this.inputReadbackDiagnostics,
            inputPhotonDiagnostics: this.inputPhotonMarker.enabled,
            inputPhotonMarker: this.inputPhotonMarker
          })
        : new DolphinCoreAdapter({ canvas, onStatus });
    this.mode = "demo";
    this.running = true;
    this.frame = 0;
    this.lastFpsTime = performance.now();
    this.framesSinceFps = 0;
    this.fps = 0;
    this.coreFps = 0;
    this.gameSpeed = 0;
    this.presentationFps = 0;
    this.visibleChangeFps = 0;
    this.visibleFrameHash = 0;
    this.visibleSampleError = "";
    this.visibleChangesSinceFps = 0;
    this.lastVisibleFrameHash = 0;
    this.lastVisibleSampleAt = 0;
    this.visibleSampleCanvas = document.createElement("canvas");
    this.visibleSampleCanvas.width = VISIBLE_SAMPLE_WIDTH;
    this.visibleSampleCanvas.height = VISIBLE_SAMPLE_HEIGHT;
    this.visibleSampleContext = this.visibleSampleCanvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true
    });
    this.lastCoreFrameForFps = 0;
    this.lastCoreTicksForSpeed = 0;
    this.lastPresentedFrameForFps = 0;
    this.buttonMask = 0;
    this.adapterStatsPollMs = this.canvasOwnedByAdapter ? 250 : 0;
    this.lastAdapterStatsPollAt = 0;
    this.causalTelemetry = null;
    this.lastCausalTelemetryAt = 0;
    this.hostCausalStats = {
      rafLoopCount: 0,
      rafLoopTotalMs: 0,
      rafLoopLastMs: 0,
      rafLoopMaxMs: 0,
      renderLastMs: 0,
      publishLastMs: 0,
      rgbaCopyLastMs: 0,
      putImageDataLastMs: 0,
      drawImageLastMs: 0
    };
    this.animationId = 0;
    this.game = {
      name: "Demo scene",
      size: 0,
      mounted: false
    };
  }

  async init() {
    const result = await instantiateDemoCore();
    this.demo = result.instance.exports;
    this.onStatus("Demo WASM ready");

    if (await this.adapterAvailable()) {
      this.onMode(`${this.adapterLabel} detected`);
    } else {
      this.onMode("Demo fallback");
    }

    this.start();
  }

  // Switch the video backend before the core loads. Safe only up to that
  // point: the worker is spawned on first mount and the backend is baked into
  // its load payload, so after that a change means a restart -- and the disc
  // selection is gone.
  //
  // Several settings are DERIVED from the backend (cpu thread, JIT engagement
  // and warmup, pacing), so they are recomputed rather than left at values
  // chosen for the previous one. Each requested* helper reads the URL first,
  // so an explicit user flag still wins; only the defaults follow the backend.
  applyVideoBackend(backend) {
    if (!backend || backend === this.videoBackend) return false;
    if (this.adapter?.loaded) return false;
    this.videoBackend = backend;
    this.cpuThread = requestedCpuThread(backend);
    this.ppcWasmJit = requestedPpcWasmJit(backend);
    this.ppcWasmJitWarmupFrames = requestedPpcWasmJitWarmupFrames(backend);
    this.presentationPacing = requestedPresentationPacing(backend);
    // Unique-frame sampling follows the video path too. Missing this left the
    // hardware renderer reporting 0 visual fps after a profile switch -- the
    // exact metric the switch is meant to improve.
    this.wgpuVisualCadence = requestedWgpuVisualCadence(window.location.search, {
      hardwareVideo: backend === "WebGPU-Real"
    });
    if (this.adapter) {
      this.adapter.videoBackend = backend;
      this.adapter.cpuThread = this.cpuThread;
      this.adapter.ppcWasmJit = this.ppcWasmJit;
      this.adapter.ppcWasmJitWarmupFrames = this.ppcWasmJitWarmupFrames;
      this.adapter.presentationPacing = this.presentationPacing;
      this.adapter.wgpuVisualCadence = this.wgpuVisualCadence;
    }
    return true;
  }

  async mountFile(file) {
    this.game = {
      name: file.name,
      size: file.size,
      mounted: true
    };

    if (await this.adapterAvailable()) {
      try {
        const mounted = await this.adapter.mountGame(file);
        this.mode = "dolphin";
        this.game.name = mounted.title || file.name;
        this.game.gameId = mounted.gameId;
        this.game.platform = mounted.platform;
        this.game.region = mounted.region;
        this.game.core = this.adapterLabel;
        this.game.bootDolOffset = mounted.bootDolOffset;
        this.game.bootDolSize = mounted.bootDolSize;
        this.game.fstOffset = mounted.fstOffset;
        this.game.fstSize = mounted.fstSize;
        this.game.apploaderDate = mounted.apploaderDate;
        this.game.apploaderSize = mounted.apploaderSize;
        this.game.rawSize = mounted.rawSize;
        this.game.dataSize = mounted.dataSize;
        this.game.rootEntryCount = mounted.rootEntryCount;
        this.game.rootEntries = mounted.rootEntries ?? [];
        this.game.bootProbe = mounted.bootProbe ?? null;
        this.game.fullCore = mounted.fullCore;
        this.game.coreBoot = mounted.coreBoot;
        this.game.coreState = mounted.coreState;
        this.game.coreStateName = mounted.coreStateName;
        this.game.coreStatus = mounted.coreStatus;
        this.game.coreTitle = mounted.coreTitle;
        this.lastCoreFrameForFps = this.adapter.coreFrame || 0;
        this.lastPresentedFrameForFps = this.adapter.presentedFrame || 0;
        this.coreFps = 0;
        this.presentationFps = 0;
        this.resetVisibleSampler();
        // A saves warning (read-only tab, saves off) outlives the mount.
        this.onStatus(describeUserDataStatus(this.adapter.userData) || `${this.adapterLabel} mounted`);
        this.onMode(this.adapterLabel);
        return this.game;
      } catch (error) {
        this.mode = "demo";
        this.onStatus(`Dolphin adapter fallback: ${error.message}`);
      }
    } else {
      this.mode = "demo";
      this.onStatus("Disc mounted for adapter; demo core running");
    }

    return this.game;
  }

  async adapterAvailable() {
    if (this.coreKind !== "upstream") return dolphinBundleAvailable();
    if (await upstreamBundleAvailable(this.upstreamCoreBuild.coreUrl)) return true;
    return this.upstreamCoreBuild.candidate
      ? upstreamBundleAvailable(DEFAULT_UPSTREAM_CORE_URL)
      : false;
  }

  start() {
    if (this.running && this.animationId) {
      return;
    }

    this.running = true;
    this.lastAdapterStatsPollAt = 0;
    this.adapter.start();
    this.lastFpsTime = performance.now();
    this.loop();
  }

  pause() {
    this.running = false;
    this.adapter.pause();
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = 0;
    }
  }

  reset() {
    this.frame = 0;
    this.lastCoreFrameForFps = 0;
    this.lastPresentedFrameForFps = 0;
    this.coreFps = 0;
    this.gameSpeed = 0;
    this.presentationFps = 0;
    this.lastCoreTicksForSpeed = 0;
    this.resetVisibleSampler();
    this.adapter.reset();
    this.renderDemo();
    this.publishFrame();
  }

  setPressedButtons(pressedButtons) {
    this.buttonMask = buttonMaskFromPressed(pressedButtons);
    this.adapter.setInputMask(this.buttonMask);
  }

  setInputState(inputState) {
    this.buttonMask = inputState?.mask >>> 0;
    this.adapter.setInputState?.(inputState);
  }

  // Public input API (docs/input.md). port is 0-3 (GameCube ports 1-4); state
  // uses the src/input.js layout (mask of BUTTONS, sticks and triggers as
  // bytes, 0x80 = centre). setPad plugs the port in if needed, and throws a
  // TypeError/RangeError on a field that is not a finite number.
  setPad(port, state) {
    if (!isPadPort(port) || !state) return false;
    if (port === 0) this.buttonMask = state.mask >>> 0;
    if (this.adapter.setPadState) {
      this.adapter.setPadState(port, state);
      return true;
    }
    if (port !== 0) return false;
    this.adapter.setInputState?.(state);
    return true;
  }

  // Plugs (true) or unplugs (false) the controller on a port. An unplugged
  // port answers "no controller" to the game.
  connectPad(port, connected) {
    if (!isPadPort(port) || !this.adapter.connectPad) return false;
    if (port === 0) this.buttonMask = 0;
    this.adapter.connectPad(port, Boolean(connected));
    return true;
  }

  saveState() {
    if (this.mode === "dolphin") {
      // Dolphin numbers its slots from 1 (<game id>.s01).
      this.adapter.saveState(1);
      this.onStatus("Saving slot 1");
      return;
    }

    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({
        frame: this.frame,
        game: this.game,
        savedAt: new Date().toISOString()
      })
    );
    this.onStatus("Demo save slot written");
  }

  loadState() {
    if (this.mode === "dolphin") {
      this.adapter.loadState(1);
      this.onStatus("Loading slot 1");
      return;
    }

    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) {
      this.onStatus("No demo save slot");
      return;
    }

    const state = JSON.parse(raw);
    this.frame = Number(state.frame) || 0;
    this.game = state.game ?? this.game;
    this.renderDemo();
    this.publishFrame();
    this.onStatus("Demo save slot loaded");
  }

  mixAudio(frames = 1024) {
    if (this.mode !== "dolphin") {
      return Promise.resolve({
        available: false,
        frames: 0,
        channels: 2,
        sampleRate: 48000,
        samples: null,
        stats: "audio:demo"
      });
    }

    return this.adapter.mixAudio?.(frames) ?? Promise.resolve({
      available: false,
      frames: 0,
      channels: 2,
      sampleRate: 48000,
      samples: null,
      stats: "audio:unavailable"
    });
  }

  setAudioMuted(muted) {
    if (this.mode === "dolphin") {
      this.adapter.setAudioMuted?.(muted);
    }
  }

  configureAudioWorklet(config) {
    if (this.mode !== "dolphin" || typeof this.adapter.configureAudioWorklet !== "function") {
      return Promise.resolve({ active: false, reason: "core-not-loaded" });
    }
    return this.adapter.configureAudioWorklet(config);
  }

  loop = () => {
    if (!this.running) {
      return;
    }

    const loopStartedAt = performance.now();
    this.frame += 1;
    if (this.mode === "demo") {
      this.renderDemo();
    } else {
      this.renderDolphin();
    }
    const renderEndedAt = performance.now();
    this.publishFrame();
    const loopEndedAt = performance.now();
    // Stall logger: surface main-thread RAF iterations that take > 20 ms
    // (one missed 60 Hz slot). Worst-so-far + every 5th, with per-stage
    // breakdown so we can correlate with the validator's long-anim-frame
    // entries. Also log the very first slow iteration regardless of
    // threshold so we have a sanity check that the logger is firing.
    const loopMs = loopEndedAt - loopStartedAt;
    if (this.collectMetrics) {
      this.hostCausalStats.rafLoopCount += 1;
      this.hostCausalStats.rafLoopTotalMs += loopMs;
      this.hostCausalStats.rafLoopLastMs = loopMs;
      this.hostCausalStats.rafLoopMaxMs = Math.max(this.hostCausalStats.rafLoopMaxMs, loopMs);
      this.hostCausalStats.renderLastMs = renderEndedAt - loopStartedAt;
      this.hostCausalStats.publishLastMs = loopEndedAt - renderEndedAt;
    }
    if (!this._mainStallFirstLogged && loopMs > 0) {
      this._mainStallFirstLogged = true;
      // eslint-disable-next-line no-console
      console.log(`[main-stall:first] loop=${loopMs.toFixed(2)}ms frame=${this.frame} mode=${this.mode}`);
    }
    if (loopMs > 20) {
      this._mainStallCount = (this._mainStallCount || 0) + 1;
      const isNewWorst = loopMs > (this._mainStallWorstMs || 0);
      if (isNewWorst) this._mainStallWorstMs = loopMs;
      if (isNewWorst || this._mainStallCount % 5 === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[main-stall#${this._mainStallCount}${isNewWorst ? "*" : ""}] ` +
          `loop=${loopMs.toFixed(0)}ms ` +
          `render=${(renderEndedAt - loopStartedAt).toFixed(0)} ` +
          `publish=${(loopEndedAt - renderEndedAt).toFixed(0)} ` +
          `frame=${this.frame} mode=${this.mode}`
        );
      }
    }
    this.animationId = requestAnimationFrame(this.loop);
  };

  renderDemo() {
    if (!this.demo?.pixel) {
      return;
    }
    if (!this.frameContext || !this.imageData || !this.pixels || !this.context || !this.frameCanvas) {
      return;
    }

    let offset = 0;
    const frame = this.frame >>> 0;
    const mask = this.buttonMask >>> 0;

    for (let y = 0; y < DEMO_HEIGHT; y += 1) {
      for (let x = 0; x < DEMO_WIDTH; x += 1) {
        this.pixels[offset] = this.demo.pixel(x, y, frame, mask);
        offset += 1;
      }
    }

    this.drawFocusMarker(mask, frame);
    this.frameContext.putImageData(this.imageData, 0, 0);
    this.context.drawImage(this.frameCanvas, 0, 0, this.canvas.width, this.canvas.height);
  }

  renderDolphin() {
    // SAB pixel transport: in this mode the visible canvas stays on the
    // main thread. The worker writes per-readback pixels into a shared
    // array buffer and bumps a generation counter; we putImageData on
    // every animation frame where the counter changed. Skips the worker's
    // setupSoftwarePresenter + OffscreenCanvas auto-mirror entirely.
    if (this.oglSabEnabled) {
      const sabT0 = performance.now();
      if (this.adapterStatsPollMs > 0) {
        const now = performance.now();
        if (now - this.lastAdapterStatsPollAt >= this.adapterStatsPollMs) {
          this.lastAdapterStatsPollAt = now;
          this.adapter.pollFrame?.();
        }
      }
      const sabT1 = performance.now();
      const currentGen = Atomics.load(this.oglMetaView, 0) | 0;
      const sabT2 = performance.now();
      let copiedThisFrame = false;
      if (currentGen !== this.oglLastSeenGen && this.context) {
        this.oglLastSeenGen = currentGen;
        // Copy SAB-backed bytes into the non-shared ImageData buffer
        // (Chrome refuses to construct ImageData over a SAB view directly).
        const copyStartedAt = this.collectMetrics ? performance.now() : 0;
        this.oglImageData.data.set(this.oglPixelView);
        const putStartedAt = this.collectMetrics ? performance.now() : 0;
        this.context.putImageData(this.oglImageData, 0, 0);
        if (this.collectMetrics) {
          this.hostCausalStats.rgbaCopyLastMs = putStartedAt - copyStartedAt;
          this.hostCausalStats.putImageDataLastMs = performance.now() - putStartedAt;
          this.hostCausalStats.drawImageLastMs = 0;
        }
        copiedThisFrame = true;
      }
      const sabT3 = performance.now();
      // Surface slow renderDolphin iterations with per-stage breakdown.
      // poll = pollFrame message dispatch, atomic = gen-counter read,
      // paint = SAB→ImageData memcpy + putImageData.
      const total = sabT3 - sabT0;
      if (total > 20) {
        this._sabStallCount = (this._sabStallCount || 0) + 1;
        const isNewWorst = total > (this._sabStallWorstMs || 0);
        if (isNewWorst) this._sabStallWorstMs = total;
        if (isNewWorst || this._sabStallCount % 10 === 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[sab-paint-stall#${this._sabStallCount}${isNewWorst ? "*" : ""}] ` +
            `total=${total.toFixed(0)}ms ` +
            `poll=${(sabT1 - sabT0).toFixed(0)} ` +
            `atomic=${(sabT2 - sabT1).toFixed(0)} ` +
            `paint=${(sabT3 - sabT2).toFixed(0)} ` +
            `painted=${copiedThisFrame}`
          );
        }
      }
      return;
    }
    if (this.canvasOwnedByAdapter) {
      if (this.adapterStatsPollMs > 0) {
        const now = performance.now();
        if (now - this.lastAdapterStatsPollAt >= this.adapterStatsPollMs) {
          this.lastAdapterStatsPollAt = now;
          this.adapter.pollFrame?.();
        }
      }
      return;
    }
    this.adapter.runFrame();

    const rgba = this.adapter.readFrameRgba();
    if (!rgba || !this.frameContext || !this.context || !this.frameCanvas) {
      return;
    }

    if (
      !this.nativeImageData ||
      this.nativeImageData.width !== this.adapter.width ||
      this.nativeImageData.height !== this.adapter.height
    ) {
      this.frameCanvas.width = this.adapter.width;
      this.frameCanvas.height = this.adapter.height;
      this.nativeImageData = this.frameContext.createImageData(this.adapter.width, this.adapter.height);
    }

    const copyStartedAt = this.collectMetrics ? performance.now() : 0;
    this.nativeImageData.data.set(rgba);
    const putStartedAt = this.collectMetrics ? performance.now() : 0;
    this.frameContext.putImageData(this.nativeImageData, 0, 0);
    const drawStartedAt = this.collectMetrics ? performance.now() : 0;
    this.context.drawImage(this.frameCanvas, 0, 0, this.canvas.width, this.canvas.height);
    if (this.collectMetrics) {
      this.hostCausalStats.rgbaCopyLastMs = putStartedAt - copyStartedAt;
      this.hostCausalStats.putImageDataLastMs = drawStartedAt - putStartedAt;
      this.hostCausalStats.drawImageLastMs = performance.now() - drawStartedAt;
    }
  }

  drawFocusMarker(mask, frame) {
    const size = 16 + (mask & 0x0f);
    const x = (frame * 2 + ((mask & 0xf0) << 1)) % (DEMO_WIDTH - size);
    const y = (DEMO_HEIGHT / 2 + Math.sin(frame / 16) * 52) | 0;

    this.frameContext.save();
    this.frameContext.strokeStyle = "#f2efe6";
    this.frameContext.lineWidth = 2;
    this.frameContext.strokeRect(x, y, size, size);
    this.frameContext.restore();
  }

  publishFrame() {
    this.framesSinceFps += 1;
    const now = performance.now();
    const frame = this.mode === "dolphin" ? this.adapter.coreFrame : this.frame;
    const presentedFrame = this.mode === "dolphin" ? this.adapter.presentedFrame : this.frame;
    this.sampleVisibleFrame(now);
    this.updateCausalTelemetry(now);

    if (now - this.lastFpsTime >= 500) {
      const elapsed = now - this.lastFpsTime;
      this.fps = Math.round((this.framesSinceFps * 1000) / elapsed);
      const measuredCoreFps =
        this.mode === "dolphin" ? Math.max(0, Math.round(((frame - this.lastCoreFrameForFps) * 1000) / elapsed)) : this.fps;
      const coreTicks = this.mode === "dolphin" ? this.adapter.coreTicks : 0;
      const ticksPerSecond = this.mode === "dolphin" ? this.adapter.coreTicksPerSecond || 486000000 : 0;
      const measuredGameSpeed = this.measureGameSpeed(coreTicks, ticksPerSecond, elapsed);
      this.presentationFps = this.mode === "dolphin" ? this.adapter.presentationFps : this.fps;
      this.visibleChangeFps = this.measureVisibleChangeFps(elapsed);
      this.coreFps = measuredCoreFps;
      this.gameSpeed = measuredGameSpeed;
      this.lastCoreFrameForFps = frame;
      this.lastCoreTicksForSpeed = this.mode === "dolphin" ? this.adapter.coreTicks : 0;
      this.lastPresentedFrameForFps = presentedFrame;
      this.framesSinceFps = 0;
      this.lastFpsTime = now;
    }

    this.onFrame({
      frame,
      fps: this.mode === "dolphin" ? this.presentationFps : this.fps,
      uiFps: this.fps,
      coreFps: this.mode === "dolphin" ? this.coreFps : this.fps,
      gameSpeed: this.mode === "dolphin" ? this.gameSpeed : 100,
      presentationFps: this.mode === "dolphin" ? this.presentationFps : this.fps,
      presentationAverageIntervalMs:
        this.mode === "dolphin" ? this.adapter.presentationAverageIntervalMs : 0,
      presentationRawFps: this.mode === "dolphin" ? this.adapter.presentationRawFps : this.fps,
      presentationP95IntervalMs: this.mode === "dolphin" ? this.adapter.presentationP95IntervalMs : 0,
      presentationMaxIntervalMs: this.mode === "dolphin" ? this.adapter.presentationMaxIntervalMs : 0,
      presentationLongFrameCount:
        this.mode === "dolphin" ? this.adapter.presentationLongFrameCount : 0,
      presentationLifetimeMaxIntervalMs:
        this.mode === "dolphin" ? this.adapter.presentationLifetimeMaxIntervalMs : 0,
      presentationLifetimeMaxIntervalAtMs:
        this.mode === "dolphin" ? this.adapter.presentationLifetimeMaxIntervalAtMs : 0,
      presentationLifetimeDropCount:
        this.mode === "dolphin" ? this.adapter.presentationLifetimeDropCount : 0,
      presentationLifetimeFrameCount:
        this.mode === "dolphin" ? this.adapter.presentationLifetimeFrameCount : 0,
      presentationIntervalStddevMs:
        this.mode === "dolphin" ? this.adapter.presentationIntervalStddevMs : 0,
      presentationIntervalHistogram:
        this.mode === "dolphin" ? this.adapter.presentationIntervalHistogram : null,
      presentationIntervalHistogramBuckets:
        this.mode === "dolphin" ? this.adapter.presentationIntervalHistogramBuckets : null,
      presentationFrameLag: this.mode === "dolphin" ? this.adapter.presentationFrameLag : 0,
      presentationQueueAgeMs: this.mode === "dolphin" ? this.adapter.presentationQueueAgeMs : 0,
      visualChangeFps:
        this.mode === "dolphin"
          ? this.visibleSamplerEnabled &&
            this.visibleSampleContext &&
            !this.visibleSampleError &&
            !this.canvasOwnedByAdapter
            ? this.visibleChangeFps
            : this.adapter.visualChangeFps
          : this.fps,
      visualFrameHash: this.mode === "dolphin" ? this.visibleFrameHash || this.adapter.visualFrameHash : 0,
      visualSampleSource:
        this.mode === "dolphin" ? this.adapter.visualSampleSource ?? "none" : "demo",
      visualCadenceTelemetry:
        this.mode === "dolphin" ? this.adapter.visualCadenceTelemetry ?? null : null,
      oglGlError: this.mode === "dolphin" ? this.adapter.oglGlError ?? 0 : 0,
      visibleSampleError: this.mode === "dolphin" ? this.visibleSampleError : "",
      presentedFrame,
      coreTicks: this.mode === "dolphin" ? this.adapter.coreTicks : 0,
      coreTicksPerSecond: this.mode === "dolphin" ? this.adapter.coreTicksPerSecond : 0,
      ppcPc: this.mode === "dolphin" ? this.adapter.ppcPc : 0,
      loadedCheckpointGeneration:
        this.mode === "dolphin" ? this.adapter.loadedCheckpointGeneration : 0,
      loadedCheckpointTicks:
        this.mode === "dolphin" ? this.adapter.loadedCheckpointTicks : null,
      loadedCheckpointPpcPc:
        this.mode === "dolphin" ? this.adapter.loadedCheckpointPpcPc : null,
      cpuCoreName: this.mode === "dolphin" ? this.adapter.cpuCoreName : "",
      ppcWasmBlockCompileCount:
        this.mode === "dolphin" ? this.adapter.ppcWasmBlockCompileCount : 0,
      ppcWasmBlockRunCount: this.mode === "dolphin" ? this.adapter.ppcWasmBlockRunCount : 0,
      ppcWasmHelperStats: this.mode === "dolphin" ? this.adapter.ppcWasmHelperStats : "",
      frameProfileStats: this.mode === "dolphin" ? this.adapter.frameProfileStats : "-",
      causalTelemetry: this.mode === "dolphin" ? this.causalTelemetry : null,
      running: this.running,
      mode: this.mode,
      game: this.game,
      buttonMask: this.buttonMask
    });
  }

  updateCausalTelemetry(now) {
    if (
      !this.collectMetrics ||
      !this.adapter?.causalTelemetry ||
      now - this.lastCausalTelemetryAt < 200
    ) {
      return;
    }
    const count = this.hostCausalStats.rafLoopCount;
    this.causalTelemetry = createCausalTelemetry(deepMerge(this.adapter.causalTelemetry, {
      host: {
        rafLoopCount: count,
        rafLoopLastMs: this.hostCausalStats.rafLoopLastMs,
        rafLoopAverageMs: count > 0 ? this.hostCausalStats.rafLoopTotalMs / count : 0,
        rafLoopMaxMs: this.hostCausalStats.rafLoopMaxMs,
        renderLastMs: this.hostCausalStats.renderLastMs,
        publishLastMs: this.hostCausalStats.publishLastMs,
        rgbaCopyLastMs: this.hostCausalStats.rgbaCopyLastMs,
        putImageDataLastMs: this.hostCausalStats.putImageDataLastMs,
        drawImageLastMs: this.hostCausalStats.drawImageLastMs
      }
    }));
    this.lastCausalTelemetryAt = now;
  }

  measureGameSpeed(coreTicks, ticksPerSecond, elapsedMs) {
    if (this.mode !== "dolphin") {
      return this.fps > 0 ? 100 : 0;
    }

    if (ticksPerSecond <= 0 || this.lastCoreTicksForSpeed <= 0 || coreTicks < this.lastCoreTicksForSpeed) {
      return 0;
    }

    return Math.max(
      0,
      Math.round(((coreTicks - this.lastCoreTicksForSpeed) / ticksPerSecond / (elapsedMs / 1000)) * 100)
    );
  }

  measureVisibleChangeFps(elapsedMs) {
    if (this.mode !== "dolphin") {
      return this.fps;
    }

    if (!this.visibleSampleContext || this.visibleSampleError) {
      return this.adapter.visualChangeFps;
    }

    const fps = Math.round((this.visibleChangesSinceFps * 1000) / elapsedMs);
    this.visibleChangesSinceFps = 0;
    return fps;
  }

  sampleVisibleFrame(now) {
    if (
      this.mode !== "dolphin" ||
      !this.visibleSamplerEnabled ||
      !this.visibleSampleContext ||
      now - this.lastVisibleSampleAt < VISIBLE_SAMPLE_INTERVAL_MS
    ) {
      return;
    }

    this.lastVisibleSampleAt = now;
    try {
      this.visibleSampleContext.drawImage(
        this.canvas,
        0,
        0,
        VISIBLE_SAMPLE_WIDTH,
        VISIBLE_SAMPLE_HEIGHT
      );
      const bytes = this.visibleSampleContext.getImageData(
        0,
        0,
        VISIBLE_SAMPLE_WIDTH,
        VISIBLE_SAMPLE_HEIGHT
      ).data;
      const hash = hashVisibleSample(bytes);
      this.visibleSampleError = "";
      if (!hash) {
        return;
      }
      this.visibleFrameHash = hash;
      if (this.lastVisibleFrameHash && hash !== this.lastVisibleFrameHash) {
        this.visibleChangesSinceFps += 1;
      }
      this.lastVisibleFrameHash = hash;
    } catch (error) {
      this.visibleSampleError = error instanceof Error ? error.message : String(error);
    }
  }

  resetVisibleSampler() {
    this.visibleChangeFps = 0;
    this.visibleFrameHash = 0;
    this.visibleSampleError = "";
    this.visibleChangesSinceFps = 0;
    this.lastVisibleFrameHash = 0;
    this.lastVisibleSampleAt = 0;
  }
}

function hashVisibleSample(bytes) {
  if (!bytes?.length) {
    return 0;
  }

  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 16) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
    hash ^= bytes[index + 1] ?? 0;
    hash = Math.imul(hash, 16777619);
    hash ^= bytes[index + 2] ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function requestedCoreKind() {
  return new URLSearchParams(window.location.search).get("core") === "native" ? "native" : "upstream";
}

function requestedVideoBackend() {
  const requested = new URLSearchParams(window.location.search).get("video");
  if (requested === "ogl") {
    return "OGL";
  }
  if (requested === "null") {
    return "Null";
  }
  // Day-16: `?video=webgpu` keeps the Software→WebGPU-presenter hybrid
  // (real game pixels reach the canvas through a wgpuRenderPass blit,
  // CPU does the rasterisation). Stable, plays Melee.
  //
  // Day-17+: `?video=wgpu` selects the real WebGPU video backend that's
  // under construction — no Software bridge, the C++ side owns the
  // render pipeline. Early phases will only show clear-colour or
  // partial content; this is the path to 60fps GPU rendering.
  if (requested === "webgpu") {
    return "WebGPU";
  }
  if (requested === "wgpu" || requested === "webgpu-real" || requested === "webgpu2") {
    return "WebGPU-Real";
  }
  return "Software Renderer";
}

function requestedCpuThread(videoBackend) {
  const requested = new URLSearchParams(window.location.search).get("cpu");
  if (requested === "single") {
    return false;
  }
  if (requested === "dual") {
    return true;
  }
  if (requested === "auto") {
    return videoBackend === "OGL";
  }
  return true;
}

function requestedCpuCore() {
  const requested = new URLSearchParams(window.location.search).get("ppc");
  return requested === "interpreter" ? "interpreter" : "cached";
}

function requestedPpcWasmJit(videoBackend) {
  const params = new URLSearchParams(window.location.search);
  const wasmjit = params.get("wasmjit");
  if (wasmjit === "0") {
    return false;
  }
  if (videoBackend === "OGL" && wasmjit === null && params.get("forcejit") !== "1") {
    // OGL default is JIT-off. Lane E showed the experimental WASM JIT compiles
    // ~0 useful blocks for this workload, but every engage burst creates a
    // 110-1900ms stall (Lane S H1). Disabling by default trades zero perf for
    // dramatically better stability on the OGL path: 0%-speed samples drop
    // 5% -> 2%, gameSpeed normalises from 150% (overspeed) to 104%, and 89%
    // of seconds reach 30fps+. Power users can opt in with wasmjit=1 or
    // wasmjit=2 explicitly, or with forcejit=1.
    return false;
  }
  return true;
}

function requestedPpcWasmJitTier() {
  const params = new URLSearchParams(window.location.search);
  return params.get("jittier") === "mixed" || params.get("wasmjit") === "2" ? "mixed" : "guarded";
}

function requestedPpcWasmJitForce() {
  // §28bl: REVERTED §28bk's forcejit-default per user request — back
  // to the last known-stable behaviour (forcejit OFF by default, the
  // post-activation stall fuse active) so the software hybrid is a
  // clean known-good baseline to reassess from. forcejit=1 still
  // available explicitly (gives ~46 % heavy battle but bypasses the
  // smoothness fuse — measured tradeoff, §28bi/bj/bk).
  return new URLSearchParams(window.location.search).get("forcejit") === "1";
}

function requestedPpcWasmJitWarmupFrames(videoBackend) {
  const params = new URLSearchParams(window.location.search);
  const forceJit = params.get("forcejit") === "1";
  const unsafeWarmup = params.get("unsafejitwarmup") === "1";
  // OGL safety minimum: on OpenGL backends, we enforce a minimum warmup of 5000 stable video
  // frames before JIT activation to prevent GPU driver instability from blocking the compile
  // burst. This floor applies regardless of jitwarmup URL param to protect OGL presentation
  // stability. Use forcejit=1 to override; use unsafejitwarmup=1 to disable both the floor and
  // the normal staged-warmup threshold (not recommended for stability-sensitive workloads).
  const oglSafetyActive = videoBackend === "OGL" && !forceJit && !unsafeWarmup;
  const minimumWarmup = oglSafetyActive ? SAFE_JIT_WARMUP_FRAMES : 0;
  const requested = Number.parseInt(params.get("jitwarmup") || "", 10);
  let effective;
  if (Number.isFinite(requested) && requested >= 0 && requested <= 60000) {
    effective = Math.max(minimumWarmup, requested);
    if (oglSafetyActive && requested < minimumWarmup) {
      console.log(
        `[wasm-dolphin] OGL safety floor raised jitwarmup from ${requested} to ${minimumWarmup}. ` +
          `Use forcejit=1 or unsafejitwarmup=1 to bypass.`
      );
    }
  } else {
    // Short and counted in emulated XFB frames, so the JIT engages at the
    // same point on every run. The core spreads the first compile burst
    // over CPU slices (compile smearing), which is what the old minute-long
    // wait was covering for.
    effective = Math.max(minimumWarmup, DEFAULT_JIT_WARMUP_FRAMES);
  }
  return effective;
}

function requestedPpcProfile() {
  return new URLSearchParams(window.location.search).get("ppcprof") === "1";
}

function requestedCpuOverclock() {
  const requested = Number.parseFloat(new URLSearchParams(window.location.search).get("oc") || "");
  if (Number.isFinite(requested) && requested >= 0.01 && requested <= 5) {
    return requested;
  }
  return 1;
}

function requestedEmulationSpeed() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("speed");
  if (raw === "unlimited") {
    return 0;
  }

  const requested = Number.parseFloat(raw || "");
  if (Number.isFinite(requested) && requested >= 0 && requested <= 5) {
    return requested;
  }
  return 1;
}

function requestedPresentationScale() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("present");
  if (raw === "full") {
    return 1;
  }
  if (raw === "half") {
    return 0.5;
  }

  const requested = Number.parseFloat(raw || "");
  if (Number.isFinite(requested) && requested >= 0.25 && requested <= 1) {
    return requested;
  }
  return 1;
}

function requestedPresentationQueueSize() {
  const requested = Number.parseInt(new URLSearchParams(window.location.search).get("queue") || "", 10);
  if (Number.isFinite(requested) && requested >= 2 && requested <= 12) {
    return requested;
  }
  return 4;
}

function requestedPresenterBackend() {
  const requested = new URLSearchParams(window.location.search).get("presenter");
  if (requested === "webgpu" || requested === "wgpu") {
    return "webgpu";
  }
  if (requested === "2d" || requested === "canvas") {
    return "2d";
  }
  if (requested === "webgl") {
    return "webgl";
  }
  return "webgpu";
}

function requestedPresentationPacing(videoBackend = "Software Renderer") {
  const requested = new URLSearchParams(window.location.search).get("pacing");
  // §28cl pacing modes:
  //   direct — paint immediately when a new frame arrives (lowest latency,
  //            but canvas only updates as often as Melee produces unique
  //            frames, which is often only 10-15 Hz despite 60fps core)
  //   smooth — buffer N frames + paint on a steady 60Hz cadence (smoother
  //            visual but adds latency from the buffer depth)
  //   tick   — §28cl best-of-both: present immediately on new frames (zero
  //            buffer, zero added latency, like direct) AND also re-paint
  //            the LAST KNOWN frame on a steady 16.7ms tick so the canvas
  //            keeps refreshing even when Melee renders duplicates. Visual
  //            cadence stays at 60Hz like a real GameCube on a CRT.
  if (requested === "tick") return "tick";
  if (videoBackend === "OGL") {
    return requested === "smooth" ? "smooth" : "direct";
  }
  // §28cx: tick is the DEFAULT for the software-raster paths (Software Renderer
  // and the video=webgpu software hybrid) — user-verified snappier than Direct
  // (canvas refreshes ~60Hz instead of only on unique frames ~20Hz), with the
  // tick re-paint flicker fixed because presentFrameBytes feeds the re-paint
  // cache the latest GOOD frame. The WebGPU-Real GPU backend (?video=wgpu)
  // presents via its own GPU path that does NOT feed that cache, so tick would
  // re-blit a stale frame → flicker; keep it on smooth (its prior default).
  // Opt out anywhere with ?pacing=direct / ?pacing=smooth.
  if (requested === "direct") return "direct";
  if (requested === "smooth") return "smooth";
  if (videoBackend === "WebGPU-Real") return "smooth";
  return "tick";
}

function requestedOglProxyMode() {
  const requested = new URLSearchParams(window.location.search).get("oglproxy");
  if (requested === "main" || requested === "direct") {
    return "main";
  }
  if (requested === "readback" || requested === "bridge") {
    return "readback";
  }
  if (requested === "proxy" || requested === "compat") {
    return "proxy";
  }
  return "worker";
}

function requestedOglTestClear() {
  return new URLSearchParams(window.location.search).get("ogltestclear") === "1";
}

function requestedOglSab() {
  return new URLSearchParams(window.location.search).get("oglsab") === "1";
}

function requestedFastSoftwareRaster() {
  const requested = Number.parseInt(new URLSearchParams(window.location.search).get("fastsw") || "1", 10);
  return Number.isFinite(requested) ? Math.min(3, Math.max(0, requested)) : 1;
}

// §28cz play-speed sync: opt-in ?timedrift=1 flips Dolphin's MAIN_CORRECT_TIME_DRIFT
// so the throttle recovers time lost to heavy-scene CPU stalls (game clock tracks a
// real stopwatch) instead of conceding it. Default off = stock throttle behavior.
// ?corelog=1 forwards Dolphin's own ERROR/WARN output to the browser console.
// Off by default: the volume is large enough to distort timing, and the
// shipping page load should stay unchanged.
function requestedCoreLog() {
  return new URLSearchParams(window.location.search).get("corelog") === "1";
}

// ?efbdiag=1 blits the EFB colour texture straight to the canvas, bypassing
// the XFB and the presenter. It answers one question: does the EFB actually
// contain the scene? Diagnostic only -- the picture it shows is not the
// game's real output.
function requestedEfbDiag() {
  if (typeof window === "undefined") return false;
  // "1" blits the EFB to the canvas; "2" blits the XFB entry last presented.
  const raw = new URLSearchParams(window.location.search).get("efbdiag");
  return raw === "2" ? 2 : (raw === "1" ? 1 : false);
}

function requestedCorrectTimeDrift() {
  return new URLSearchParams(window.location.search).get("timedrift") === "1";
}

// Day-1 bisection knob: ?disable=cat1,cat2 → bitmask handed to the C++ JIT.
// Bit layout matches DOLPHIN_WEB_DISABLE_* in CachedInterpreter.cpp.
// Accepts comma-separated category names, a raw 0xHEX value, or a decimal int.
// Unknown category names are logged and ignored (so a typo doesn't pretend to
// disable things it isn't actually disabling).
const CACHED_INTERPRETER_DISABLE_BITS = {
  meleeloop:   1 << 0,
  meleecall:   1 << 1,
  osinterrupt: 1 << 2,
  dcbxloop:    1 << 3,
  fastbranch:  1 << 4,
  fastfp:      1 << 5,
  fastinteger: 1 << 6,
  fastsystem:  1 << 7,
  wasmblock:   1 << 8,
  wasmcarry:   1 << 9,   // umbrella: all 5 carry-emitting OPCD-31 ops
  wasmaddc:    1 << 10,  // SUBOP10=10  addcx  only
  wasmsubfc:   1 << 11,  // SUBOP10=8   subfcx only
  wasmadde:    1 << 12,  // SUBOP10=138 addex  only
  wasmsubfe:   1 << 13,  // SUBOP10=136 subfex only
  wasmaddze:   1 << 14,  // SUBOP10=202 addzex only
  blockredispatch: 1 << 15, // §28bt in-place block re-dispatch (off => baseline path)
  blockmerge:      1 << 17, // §28bx adjacent-block merge (default-off; ?blockmerge=1 to enable)
  regalloc:        1 << 20, // §28by GPR regalloc / dead-store-skip (default-off; ?regalloc=1 to enable)
  shortprefix:     1 << 21, // §28ca lower JIT min-prefix 4→2 (default-off; ?shortprefix=1 to enable)
  smearcompile:    1 << 22, // §28ce cap JIT compiles/slice (default-off; ?smearcompile=1 to enable)
  fastmemhoist:    1 << 23, // §28cz per-block fastmem bounds-check hoist (ENABLE polarity; default-off; ?fastmemhoist=1)
  inlinefma:       1 << 24, // inline exact FMA; set: the FMA family calls the interpreter's NI_madd_msub
  // Aliases the plan / TL;DR uses interchangeably:
  fastinputpoll: 1 << 1, // legacy synonym for meleecall (input-poll lives there)
  fastmem:       1 << 7, // legacy synonym for fastsystem (load/store-ish helpers)
  all:           0x17fffff
};

// The WebGPU backend emits partial and independent-channel EFB clears as a
// scissored quad draw. It is ON by default in the backend itself; this only
// exists to turn it off for bisection, because doing so restores the
// over-clearing legacy path and reproduces the pre-fix broken frame.
//
// `?wgpuclearrect=0` is the supported spelling. `?disable=0x2000000` is the
// spelling this knob shipped with while it rode on the cached-interpreter
// disable mask, kept working so older notes and scripts still bisect.
const LEGACY_DISABLE_BIT_CLEARRECT_OFF = 1 << 25;

function requestedWgpuScissoredClearRect(disableMask) {
  if (typeof window === "undefined") return true;
  const raw = new URLSearchParams(window.location.search).get("wgpuclearrect");
  if (raw === "0") return false;
  if (raw === "1") return true;
  return ((disableMask >>> 0) & LEGACY_DISABLE_BIT_CLEARRECT_OFF) === 0;
}

function requestedCachedInterpreterDisableMask() {
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get("disable") || "").trim();
  let mask = 0;
  if (raw) {
    if (/^0x[0-9a-f]+$/i.test(raw)) {
      const parsed = Number.parseInt(raw.slice(2), 16);
      mask = Number.isFinite(parsed) ? parsed >>> 0 : 0;
    } else if (/^\d+$/.test(raw)) {
      const parsed = Number.parseInt(raw, 10);
      mask = Number.isFinite(parsed) ? parsed >>> 0 : 0;
    } else {
      for (const token of raw.split(/[,+\s]+/).filter(Boolean)) {
        const key = token.toLowerCase();
        if (key in CACHED_INTERPRETER_DISABLE_BITS) {
          mask |= CACHED_INTERPRETER_DISABLE_BITS[key];
        } else {
          console.warn(`[wasm-dolphin] unknown ?disable category "${token}" (ignored)`);
        }
      }
    }
  }
  // §28bt block re-dispatch: DEFAULT-ON. Rigorously verified +11% warm
  // (4-run non-overlapping same-binary A/B, correctness-clean on battle);
  // it is the evidence-backed JIT-core speed win for the >50% of hot Melee
  // code that runs short interpreted blocks. The earlier "cutscene stall"
  // was the unrelated NKit/reload OOM artifact, not §28bt (which is a CPU
  // dispatch-loop change, gated, with all per-block state writeback intact).
  // INSTANT escape hatch with no rebuild: ?disable=blockredispatch (or
  // ?redispatch=0) reverts to the exact baseline dispatch path.
  if (params.get("redispatch") === "0") {
    mask |= CACHED_INTERPRETER_DISABLE_BITS.blockredispatch;
  }
  // §28bx adjacent-block merge: DEFAULT-OFF (unverified first cut of a
  // correctness-critical JIT change). Opt-in for A/B testing with
  // ?blockmerge=1; any other state leaves it disabled. ?disable=blockmerge
  // or a raw mask also composes.
  if (params.get("blockmerge") !== "1") {
    mask |= CACHED_INTERPRETER_DISABLE_BITS.blockmerge;
  }
  // §28by/C1 GPR regcache: DEFAULT-ON as of Jun-02. The active flag drives
  // the C1 GPR-in-WASM-locals register cache (eager-load used GPRs at block
  // prologue, route reads/writes through locals, flush dirty at block end),
  // NOT just the old dead-store-skip. Clean uncapped A/B (SPEED=unlimited,
  // 3 trials): base ~191% gameSpeed vs regalloc ~265% = +38%, fully
  // non-overlapping; blockmerge added nothing on top. Visually verified
  // rendering correct (Great Bay battle). INSTANT escape hatch, no rebuild:
  // ?regalloc=0 reverts to the no-regcache baseline.
  if (params.get("regalloc") === "0") {
    mask |= CACHED_INTERPRETER_DISABLE_BITS.regalloc;
  }
  // §28ca short-prefix: DEFAULT-OFF. Drops MIN_WASM_PREFIX_INSTRUCTIONS 4→2
  // so blocks of 2-3 PPC ops compile to WASM instead of falling to
  // Interpret<false>. Audit (§28bz) showed 54% of JIT attempts reject as
  // "too short" — biggest single bottleneck surface. ?shortprefix=1 to opt in.
  if (params.get("shortprefix") !== "1") {
    mask |= CACHED_INTERPRETER_DISABLE_BITS.shortprefix;
  }
  // §28ce compile-burst smearing: DEFAULT-OFF. Caps JIT compiles per Run()
  // slice (max 8 OR 5000us wall, whichever first). Smears the cold-start
  // 1.6s synchronous compile burst (measured in §28cd: 12,757 cache misses
  // produce a 1134ms presentation-interval spike) across thousands of
  // slices, eliminating the visible freeze. DEFAULT-ON as of Jun-02 (the
  // user-felt mid-match stutter fix; throughput-neutral — only changes
  // interpret-vs-compile timing, never correctness). Escape hatch, no
  // rebuild: ?smearcompile=0 reverts to compile-eagerly.
  if (params.get("smearcompile") === "0") {
    mask |= CACHED_INTERPRETER_DISABLE_BITS.smearcompile;
  }
  // §28cz fastmem bounds-check hoist: DEFAULT-OFF, ENABLE polarity (the bit is
  // an enable bit in the core: feature is ON only when the bit is SET). Opt in
  // with ?fastmemhoist=1; any other state leaves the bit clear so codegen is
  // byte-identical to today. Correctness-critical (a wrong hoisted check = an
  // unchecked OOB WASM load) — kept off until A/B + correctness verified.
  if (params.get("fastmemhoist") === "1") {
    mask |= CACHED_INTERPRETER_DISABLE_BITS.fastmemhoist;
  }
  return mask >>> 0;
}

function requestedVisibleSampler() {
  return new URLSearchParams(window.location.search).get("mainsample") === "1";
}

function requestedCollectMetrics() {
  return new URLSearchParams(window.location.search).get("metrics") === "1";
}
