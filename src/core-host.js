import { aotCompilerRequested, jitOffThreadRequested } from "./aot-compiler-worker.js";
import { aotSamplePeriodRequested } from "./aot-hot-sampler.js";
import { wasmEngine } from "./wasm-engine.js";
import { anisotropyToCore, clampInternalResolution, internalResolutionCeiling, requestedEnhancements } from "./wgpu-enhancements.js";
import { displayFilterFits, normalizeDisplayFilter, requestedDisplayFilter } from "./wgpu-display-filter.js";
import { parseCustomRtc } from "./custom-rtc.js";
import { DolphinCoreAdapter, dolphinBundleAvailable } from "./dolphin-adapter.js";
import { buttonMaskFromPressed, isPadPort } from "./input.js";
import { UpstreamMainThreadAdapter } from "./upstream-main-thread-adapter.js";
import { UpstreamWorkerAdapter, describeUserDataStatus, upstreamBundleAvailable } from "./upstream-worker-adapter.js";
import {
  DEFAULT_UPSTREAM_CORE_URL,
  requestedLegacyOneWayAck,
  requestedSoftwareTevHotCaseMode,
  requestedXfbFastPaths
} from "./upstream-worker-protocol.js";
import { requestedUpstreamCoreBuild } from "./default-core.js";
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
import { requestedWgpuPipelinePrewarm } from "./wgpu-pipeline-prewarm.js";
import { requestedWgpuSparseUbo } from "./wgpu-sparse-ubo-copy-forward.js";
import { captureSessionAfterDeviceLoss, requestedWgpuSessionRecover } from "./wgpu-session-recovery.js";

const DEMO_WIDTH = 320;
const DEMO_HEIGHT = 240;
const SAVE_KEY = "wasm-dolphin.demo-state.0";
const VISIBLE_SAMPLE_WIDTH = 96;
const VISIBLE_SAMPLE_HEIGHT = 72;
const VISIBLE_SAMPLE_INTERVAL_MS = 250;
const SAFE_JIT_WARMUP_FRAMES = 5000;
const DEFAULT_JIT_WARMUP_FRAMES = 60;

export class EmulatorHost {
  constructor({ canvas, onFrame = () => {}, onStatus = () => {}, onMode = () => {}, onGpuDeviceLost = () => {}, onGpuRecovering = () => {} }) {
    this.canvas = canvas;
    this.onFrame = onFrame;
    this.onStatus = onStatus;
    this.onMode = onMode;
    // { internalResolution, fallback, reason, detail, cause }: the WebGPU
    // renderer stopped (the picture would freeze): cause "device-lost"
    // (fallback 1 when it was above 1x: the next boot of this host and every
    // setEnhancements stay at 1x) or "renderer-error" (fallback null, restart
    // at the same scale). With ?wgpurecover=1 it comes once the core is
    // paused and saved, with { paused, pauseChanged, state, stateGameId,
    // stateError }, after onGpuRecovering({ internalResolution, fallback,
    // reason }) at the start of the save (docs/wgpu-session-fallback.md).
    this.onGpuDeviceLost = onGpuDeviceLost;
    this.onGpuRecovering = onGpuRecovering;
    this.wgpuSessionRecover = requestedWgpuSessionRecover(window.location.search);

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
    this.customRtc = requestedCustomRtc();
    this.ppcWasmJit = requestedPpcWasmJit(this.videoBackend);
    this.ppcWasmJitTier = requestedPpcWasmJitTier();
    this.ppcWasmJitForce = requestedPpcWasmJitForce();
    this.ppcWasmJitWarmupFrames = requestedPpcWasmJitWarmupFrames(this.videoBackend);
    this.ppcProfile = requestedPpcProfile();
    this.gpuSpinMicros = requestedGpuSpinMicros();
    this.cpuOverclock = requestedCpuOverclock();
    this.emulationSpeed = requestedEmulationSpeed();
    this.audioBufferMs = requestedAudioBufferMs();
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
    this.pacing = requestedPacing();
    this.coreLog = requestedCoreLog();
    this.memcardSlotB = new URLSearchParams(window.location.search).get("memcardb") === "1";
    // ?ir=1-4 and ?aniso=1|2|4|8|16 (patch 0168, WebGPU path); setEnhancements
    // changes them while a game runs.
    this.enhancements = requestedEnhancements(window.location.search);
    // ?fsr=off|light|strong, ?displayfit=1 (WebGPU path with presentvsync):
    // the canvas at the display's pixels, scaled and sharpened at the
    // present; setDisplayFilter changes it while a game runs.
    this.displayFilter = requestedDisplayFilter(window.location.search);
    this.displayBoxObserver = null;
    this.displayBoxObserved = null;
    if (displayFilterFits(this.displayFilter)) this.watchDisplayBox();
    // 1 once a device was lost above 1x (internalResolutionCeiling()).
    this.scaleLostCeiling = 4;
    this.scaleCeilingPromise = null;
    // The worker's own adapter's ceiling, once its presenter took it.
    this.workerScaleCeiling = null;
    // CPU reads of the EFB (peeks), off by default as in Dolphin (EFBAccessEnable).
    this.efbAccess = new URLSearchParams(window.location.search).get("efbaccess") === "1";
    // Bench: ?xfbdecode=0 skips the XFB's YUV->RGBA decode on the CPU thread,
    // honoured by the core under video=null only (WebGPU never decodes).
    this.xfbNoDecode = new URLSearchParams(window.location.search).get("xfbdecode") === "0";
    // Harness: FIFO logs (.dff) may boot. Off for the app (FifoPlayer trusts the log).
    this.fifoLog = new URLSearchParams(window.location.search).get("fifolog") === "1";
    // EFB copies written to guest RAM too (Dolphin's EFBToTextureEnable=False).
    this.efbCopyRam = new URLSearchParams(window.location.search).get("efbcopyram") === "1";
    // EFB copies to RAM not deferred (Dolphin's DeferEFBCopies=False).
    this.efbNoDefer = new URLSearchParams(window.location.search).get("efbdefer") === "0";
    // Harness: optional WebGPU features withheld from the device, comma-separated
    // (e.g. Safari 26 has no dual-source-blending). Empty for the app.
    this.wgpuMask = new URLSearchParams(window.location.search).get("wgpumask") ?? "";
    // Harness: accept a CPU fallback WebGPU adapter (SwiftShader), refused for
    // the app as no usable GPU (the Windows CI lane has nothing else).
    this.wgpuFallback = new URLSearchParams(window.location.search).get("wgpufallback") === "1";
    // ?dstalpha2pass=0 (patch 0149): the dst-alpha second pass (0136) off.
    this.dstAlphaTwoPass = new URLSearchParams(window.location.search).get("dstalpha2pass") !== "0";
    // ?discreadahead=0: the disc read exactly as asked (no read-ahead).
    this.discReadahead = new URLSearchParams(window.location.search).get("discreadahead") !== "0";
    // ?discprefetch=1: the background prefetch of the next segment (0155),
    // off by default (within noise on Chromium; to be measured on WebKit).
    this.discPrefetch = new URLSearchParams(window.location.search).get("discprefetch") === "1";
    // Harness: keep a software WebGL presenter (SwiftShader), which the app
    // refuses for the 2D canvas (cheaper on a CPU).
    this.webglSoftware = new URLSearchParams(window.location.search).get("webglsw") === "1";
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
    // On by default, ?jitoffthread=0 turns it off: the CPU thread never compiles
    // a JIT module first; it posts the bytes to the compiler worker and
    // interprets until it arrives.
    this.jitOffThread = jitOffThreadRequested(window.location.search);
    // On by default, ?aotcompiler=0 turns it off: compile cached/requested JIT
    // modules in the compiler worker.
    this.aotCompiler = aotCompilerRequested(window.location.search);
    // ?aot=1: first-launch optimisation of the disc (P7), off by default.
    this.aotFirstLaunch = new URLSearchParams(window.location.search).get("aot") === "1";
    // With aot=1, the local profile's guest-PC sampler: ?aotsample=N ms, 0 off.
    this.aotSampleMs = aotSamplePeriodRequested(window.location.search);
    // The wasm engine (src/wasm-engine.js), resolved here once: a worker's
    // location is its own script's, so ?wasmengine= reaches it only this way.
    this.wasmEngine = wasmEngine({ search: window.location.search });
    this.codeSpaceMiB = requestedCodeSpaceMiB(window.location.search, this.wasmEngine);
    // ?regioncap=N|0: the region function cap forced (tests, benches); by
    // default the worker takes it from the engine (JSC only).
    const regionCap = new URLSearchParams(window.location.search).get("regioncap");
    this.regionCap = regionCap !== null && /^\d+$/.test(regionCap) ? Number(regionCap) : null;
    // With aot=1, regions tail-call the next region (patch 0102); ?regionchain=0 turns it off.
    this.regionChain = new URLSearchParams(window.location.search).get("regionchain") !== "0";
    // Where relaxed_madd is fused the JIT's FMA uses it (patch 0129); ?fusedmadd=0
    // keeps the exact plain-f64 path (A/B on one core).
    this.fusedMadd = new URLSearchParams(window.location.search).get("fusedmadd") !== "0";
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
    this.wgpuPipelinePrewarm = requestedWgpuPipelinePrewarm(window.location.search);
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
    // A fresh canvas element in place of the current one (its attributes
    // copied), transferred to the worker. Also used once the worker's WebGL
    // presenter lost its context for good: a canvas that had a WebGL context
    // can never get a 2D one.
    const replaceCanvasForWorker = () => {
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
      // The display filter's box is the new element's.
      this.observeDisplayCanvas();
      const off = replacement.transferControlToOffscreen();
      off.id = "canvas";
      return off;
    };
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
          // compositor binding.
          return replaceCanvasForWorker();
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
            customRtc: this.customRtc,
            ppcWasmJit: this.ppcWasmJit,
            ppcWasmJitTier: this.ppcWasmJitTier,
            ppcWasmJitForce: this.ppcWasmJitForce,
            ppcWasmJitWarmupFrames: this.ppcWasmJitWarmupFrames,
            ppcProfile: this.ppcProfile,
            gpuSpinMicros: this.gpuSpinMicros,
            codeSpaceMiB: this.codeSpaceMiB,
            cpuOverclock: this.cpuOverclock,
            emulationSpeed: this.emulationSpeed,
            audioBufferMs: this.audioBufferMs,
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
            // After a lost WebGL context: a new element, so whoever captures
            // the canvas (captureStream) must re-capture: "presentercanvas".
            replacePresenterCanvas: () => {
              const off = replaceCanvasForWorker();
              window.dispatchEvent(new CustomEvent("presentercanvas", { detail: { canvas: this.canvas } }));
              return off;
            },
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
            customRtc: this.customRtc,
            ppcWasmJit: this.ppcWasmJit,
            ppcWasmJitTier: this.ppcWasmJitTier,
            ppcWasmJitForce: this.ppcWasmJitForce,
            ppcWasmJitWarmupFrames: this.ppcWasmJitWarmupFrames,
            ppcProfile: this.ppcProfile,
            gpuSpinMicros: this.gpuSpinMicros,
            codeSpaceMiB: this.codeSpaceMiB,
            cpuOverclock: this.cpuOverclock,
            emulationSpeed: this.emulationSpeed,
            audioBufferMs: this.audioBufferMs,
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
            rushPresentation: this.pacing.rushPresentation,
            syncOnSkipIdle: this.pacing.syncOnSkipIdle,
            dupXfbRearmsThrottle: this.pacing.dupXfbRearmsThrottle,
            smoothEarly: this.pacing.smoothEarly,
            sleepMarginUs: this.pacing.sleepMarginUs,
            sleepStepUs: this.pacing.sleepStepUs,
            sleepK: this.pacing.sleepK,
            sleepSpinUs: this.pacing.sleepSpinUs,
            presentVsync: this.pacing.presentVsync,
            presentGamePace: this.pacing.presentGamePace,
            presentPaceStats: this.pacing.presentPaceStats,
            coreLog: this.coreLog,
            memcardSlotB: this.memcardSlotB,
            internalResolution: this.enhancements.internalResolution,
            maxAnisotropy: this.enhancements.maxAnisotropy,
            widescreen: this.enhancements.widescreen,
            displayFilter: this.displayFilter,
            efbAccess: this.efbAccess,
            xfbNoDecode: this.xfbNoDecode,
            fifoLog: this.fifoLog,
            efbCopyRam: this.efbCopyRam,
            efbNoDefer: this.efbNoDefer,
            wgpuMask: this.wgpuMask,
            wgpuFallback: this.wgpuFallback,
            dstAlphaTwoPass: this.dstAlphaTwoPass,
            discReadahead: this.discReadahead,
            discPrefetch: this.discPrefetch,
            webglSoftware: this.webglSoftware,
            savesMode: this.savesMode,
            efbDiag: this.efbDiag,
            jitVerbose: this.jitVerbose,
            frameCap: this.frameCap,
            cachedInterpreterDisableMask: this.cachedInterpreterDisableMask,
            wgpuScissoredClearRect: this.wgpuScissoredClearRect,
            noJitCache: this.noJitCache,
            jitOffThread: this.jitOffThread,
            aotCompiler: this.aotCompiler,
            aotFirstLaunch: this.aotFirstLaunch,
            aotSampleMs: this.aotSampleMs,
            wasmEngine: this.wasmEngine,
            regionCap: this.regionCap,
            regionChain: this.regionChain,
            fusedMadd: this.fusedMadd,
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
            wgpuSessionRecover: this.wgpuSessionRecover,
            wgpuPipelinePrewarm: this.wgpuPipelinePrewarm,
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
            inputPhotonMarker: this.inputPhotonMarker,
            onGpuDeviceLost: (event) => this.handleGpuDeviceLost(event),
            onScaleCeiling: (ceiling) => { this.workerScaleCeiling = ceiling; }
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
        // Before the boot: what the disc's settings ask of the renderer.
        this.game.needs = mounted.needs ?? { boundingBox: false };
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

  // A streamed guest's state on a port (docs/input.md, "Streaming"): as
  // setPad, plus the guest's sequence number and reception time
  // (performance.timeOrigin + now()), echoed by padFeedback once a poll read it.
  // Refused (false) unless the port was given to a guest (enableRemotePad)
  // and is plugged in: it never plugs a port in.
  setRemotePad(port, state, meta = {}) {
    if (!isPadPort(port) || !state) return false;
    return Boolean(this.adapter.setRemotePadState?.(port, state, meta));
  }

  // The host gives `port` to a streamed guest (true) or takes it back
  // (false, e.g. kick). Only such ports accept setRemotePad and tapPad; the
  // host's own ports never go through the direct block.
  enableRemotePad(port, enabled) {
    if (!isPadPort(port)) return false;
    return Boolean(this.adapter.enableRemotePad?.(port, Boolean(enabled)));
  }

  // Presses maybe already released (press counters of a streamed guest): a
  // button mask, or 12 per-button counts when several presses of a button
  // arrive at once. The SI poll reports each of them. False when the core
  // cannot: the caller must hold them itself.
  tapPad(port, presses) {
    if (!isPadPort(port)) return false;
    return Boolean(this.adapter.tapPad?.(port, presses));
  }

  // { pollCount, appliedSeq, appliedRxTime, pollTime, rumble, rumbleGeneration,
  // reportedMask, presses[12] } for a port, or null on a core without the
  // direct pad block.
  padFeedback(port) {
    if (!isPadPort(port)) return null;
    return this.adapter.padFeedback?.(port) ?? null;
  }

  // Streaming (docs/input.md, "Streaming"): a video MediaStreamTrack fed by
  // the emulation worker itself, one VideoFrame per presented frame, without
  // the page's main thread in between. Null where the browser has no
  // MediaStreamTrackGenerator (then use canvas.captureStream()).
  captureVideoTrack() {
    if (typeof MediaStreamTrackGenerator !== "function" || !this.adapter.request) return null;
    if (this.streamTrack && this.streamTrack.readyState === "live") return this.streamTrack;
    // The worker presents the frames only when it owns the canvas, and not
    // with OGL (its CPU framebuffer is a stale readback there).
    const why = this.streamCaptureUnsupported();
    if (why) {
      this.onStatus(`Worker capture unavailable: ${why}`);
      return null;
    }
    const generator = new MediaStreamTrackGenerator({ kind: "video" });
    const writable = generator.writable;
    this.adapter.request("streamCapture", { writable }, [writable]).catch((error) => {
      this.onStatus(`Worker capture unavailable: ${error?.message ?? error}`);
      generator.stop();
    });
    this.streamTrack = generator;
    return generator;
  }

  // Null when the worker can capture, else why not.
  streamCaptureUnsupported() {
    if (this.videoBackend === "OGL") return "OGL backend";
    if (!this.usesAdapterCanvas) return "the worker does not own the canvas";
    return null;
  }

  // Ends the worker capture (room closed, last guest gone).
  stopVideoCapture() {
    const track = this.streamTrack;
    this.streamTrack = null;
    track?.stop();
    return this.adapter.request?.("streamCaptureStop").catch(() => {});
  }

  // { attached, frames, dropped, errors, source, width, height,
  // captureMsTotal, captureMsMax, lastCaptureAt, lastCoreFrame }
  async streamCaptureStats() {
    const r = await this.adapter.request?.("streamCaptureStats");
    return r?.stats ?? null;
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

  // Internal resolution (1-4) and maximum anisotropy (1, 2, 4, 8, 16; 0 =
  // the game's), the units of ?ir= and ?aniso=, applied at the core's next
  // frame. Resolves { applied, internalResolution } (applied false before the
  // core runs, or with a core without patch 0168); the values are kept for
  // the next boot.
  // widescreen: true for 16:9 (patch 0178, Dolphin's generic widescreen
  // hack: the 3D view widened; 2D elements stretched, some objects cut at the
  // edges), false for 4:3. The canvas follows the core's backbuffer.
  async setEnhancements({ internalResolution, anisotropy, widescreen } = {}) {
    if (internalResolution !== undefined) {
      const { ceiling } = await this.internalResolutionCeiling();
      this.enhancements.internalResolution = clampInternalResolution(internalResolution, ceiling);
    }
    if (anisotropy !== undefined) this.enhancements.maxAnisotropy = anisotropyToCore(anisotropy);
    if (widescreen !== undefined) {
      this.enhancements.widescreen = widescreen === true;
      this.announceAspect();
    }
    if (this.mode !== "dolphin" || typeof this.adapter?.setEnhancements !== "function") {
      return { applied: false, reason: "core-not-loaded" };
    }
    return this.adapter.setEnhancements(this.enhancements);
  }

  // The picture's aspect, for the page's layout (app.js follows it): 16:9
  // with widescreen (patch 0178), else 4:3. A "wgpuaspect" event on window.
  announceAspect() {
    const [w, h] = this.enhancements.widescreen ? [16, 9] : [4, 3];
    globalThis.dispatchEvent?.(new CustomEvent("wgpuaspect", { detail: { w, h } }));
  }

  // Display filter: sharpness "off" | "light" | "strong" (FSR1 RCAS after an
  // EASU upscale to the display), fit true to size the canvas to the display
  // without sharpening (an internal resolution above the display is then
  // area-filtered down: supersampling). Kept for the next boot. Resolves the
  // worker's answer ({ applied, active, sharpness, fit, box }).
  async setDisplayFilter({ sharpness, fit } = {}) {
    this.displayFilter = normalizeDisplayFilter({
      ...this.displayFilter,
      ...(sharpness !== undefined ? { sharpness } : {}),
      ...(fit !== undefined ? { fit } : {})
    });
    if (displayFilterFits(this.displayFilter)) this.watchDisplayBox();
    if (typeof this.adapter?.setDisplayFilter !== "function") return { applied: false, reason: "core-not-loaded" };
    return this.adapter.setDisplayFilter(this.displayFilter);
  }

  // The canvas element's size in device pixels, for the display filter's
  // canvas (devicePixelContentBoxSize: exact, follows zoom and moves between
  // screens).
  // contain: the element is laid out with object-fit: contain (the picture
  // keeps its aspect inside the box), else the canvas is stretched to it.
  watchDisplayBox() {
    if (this.displayBoxObserver || typeof ResizeObserver !== "function" || !this.canvas) return;
    this.displayBoxObserver = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      const device = entry?.devicePixelContentBoxSize?.[0];
      const ratio = globalThis.devicePixelRatio || 1;
      const contain = globalThis.getComputedStyle?.(entry.target)?.objectFit === "contain";
      const box = device
        ? { width: device.inlineSize, height: device.blockSize, contain }
        : { width: Math.round(entry.contentRect.width * ratio), height: Math.round(entry.contentRect.height * ratio), contain };
      this.displayFilter = normalizeDisplayFilter({ ...this.displayFilter, box });
      if (displayFilterFits(this.displayFilter)) this.adapter?.setDisplayFilter?.({ box: this.displayFilter.box })?.catch?.(() => {});
    });
    this.observeDisplayCanvas();
  }

  // (Re)observe this.canvas: after replaceCanvasForWorker the old element is
  // gone from the page.
  observeDisplayCanvas() {
    const observer = this.displayBoxObserver;
    if (!observer || !this.canvas || this.displayBoxObserved === this.canvas) return;
    if (this.displayBoxObserved) observer.unobserve(this.displayBoxObserved);
    this.displayBoxObserved = this.canvas;
    try {
      observer.observe(this.canvas, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(this.canvas);
    }
  }

  // The highest internal resolution this machine is trusted with:
  // { ceiling, reason } (src/wgpu-enhancements.js): the worker's adapter's
  // once its presenter took it (wgpu-scale-ceiling), before that the same
  // rule on an adapter the page asks with the worker's power preference;
  // 1 after a device loss above 1x. setEnhancements holds every scale to
  // it, the worker too. Ask it before offering a scale, again after the boot.
  async internalResolutionCeiling() {
    this.scaleCeilingPromise ??= (async () => {
      const gpu = globalThis.navigator?.gpu;
      const adapter = await gpu?.requestAdapter?.({ powerPreference: this.wgpuPowerPreference ?? "high-performance" }).catch(() => null);
      let info = adapter?.info ?? null;
      if (adapter && !info && typeof adapter.requestAdapterInfo === "function") {
        info = await adapter.requestAdapterInfo().catch(() => null);
      }
      return internalResolutionCeiling(adapter ? { info, limits: adapter.limits, isFallbackAdapter: adapter.isFallbackAdapter } : null,
        { deviceMemory: globalThis.navigator?.deviceMemory });
    })();
    const adapter = this.workerScaleCeiling ?? await this.scaleCeilingPromise;
    return this.scaleLostCeiling < adapter.ceiling
      ? { ceiling: this.scaleLostCeiling, reason: "device-lost" }
      : adapter;
  }

  // cause "device-lost": the GPU went (memory may be why), the scale falls
  // to 1x. "renderer-error": a fatal replay error on a live device (the
  // scale is not why): the page restarts at the same scale, fallback null.
  handleGpuDeviceLost({ internalResolution = 1, reason = "unknown", detail = "", cause = "device-lost", pause = null } = {}) {
    const deviceLost = cause !== "renderer-error";
    const fallback = deviceLost && internalResolution > 1 ? 1 : null;
    if (fallback) {
      this.scaleLostCeiling = fallback;
      this.enhancements.internalResolution = fallback;
    }
    this.onStatus(deviceLost
      ? `WebGPU device lost at ${internalResolution}x (${reason})${fallback ? "; internal resolution back to 1x" : ""}`
      : `WebGPU renderer failed at ${internalResolution}x (${reason}); restart at the same scale`);
    const event = { internalResolution, fallback, reason, detail, cause: deviceLost ? "device-lost" : "renderer-error" };
    if (!this.wgpuSessionRecover || this.mode !== "dolphin") {
      this.onGpuDeviceLost(event);
      return null;
    }
    return this.recoverSessionAfterDeviceLoss(event, pause);
  }

  // ?wgpurecover=1: tell the page a recovery runs, keep the paused session,
  // then always hand the loss to the page, whatever failed on the way.
  async recoverSessionAfterDeviceLoss(event, workerPause) {
    const describe = (error) => (error instanceof Error ? error.message : String(error));
    this.onStatus("WebGPU device lost: keeping the session (pause, save state)");
    try {
      this.onGpuRecovering({ internalResolution: event.internalResolution, fallback: event.fallback, reason: event.reason });
    } catch (error) {
      this.onStatus(`Device loss recovery handler failed: ${describe(error)}`);
    }
    let session = { paused: false, pauseChanged: false, state: null, stateGameId: "", stateError: "" };
    try {
      session = await captureSessionAfterDeviceLoss(this.adapter, { workerPause });
      this.onStatus(session.state
        ? `Session kept after the device loss (${session.state.byteLength} bytes)`
        : `Session not kept after the device loss: ${session.stateError}`);
    } catch (error) {
      session = { ...session, stateError: describe(error) };
      this.onStatus(`Session not kept after the device loss: ${session.stateError}`);
    } finally {
      try {
        this.onGpuDeviceLost({ ...event, ...session });
      } catch (error) {
        this.onStatus(`Device loss handler failed: ${describe(error)}`);
      }
    }
    return session;
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

// ?rtc=<seconds since 1970>: the emulated real-time clock starts there and
// follows emulated time, so two boots of one disc are identical (harness
// comparisons). Without it, the console clock is the host's.
function requestedCustomRtc() {
  return parseCustomRtc(new URLSearchParams(window.location.search).get("rtc"));
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

// ?gpuspin=<us> (patch 0098): the GPU thread sleeps once its FIFO has been
// drained this long instead of busy-looping until the next 1 kHz tick.
// Default 200 us (race, 2026-10-22: GPU thread 37 -> 25 % of a core, CPU
// thread +1.6 % on the Spark bench, +5.7 % median on the Mac with wgpu);
// 0 sleeps at once and costs the CPU thread a wakeup per burst (-3 %).
// ?gpuspin=-1 restores the 1 kHz busy loop.
export const DEFAULT_GPU_SPIN_MICROS = 200;
export const MAX_GPU_SPIN_MICROS = 1000000;
// Strict: "-1" or a decimal integer in [0, MAX_GPU_SPIN_MICROS]. Anything else
// (blank, " 50", "1e3", "2.5", out of range) is refused with a warning and
// the default applies.
export function parseGpuSpinMicros(raw) {
  if (raw == null) return DEFAULT_GPU_SPIN_MICROS;
  if (raw === "-1") return -1;
  if (/^\d{1,7}$/.test(raw) && Number(raw) <= MAX_GPU_SPIN_MICROS) return Number(raw);
  console.warn(`?gpuspin=${JSON.stringify(raw)} ignored: expected -1 or an integer from 0 to ${MAX_GPU_SPIN_MICROS} (microseconds); using ${DEFAULT_GPU_SPIN_MICROS}`);
  return DEFAULT_GPU_SPIN_MICROS;
}
// The CachedInterpreter code space (patch 0138), in MiB. Its whole size is
// dirtied at boot (Emscripten's mmap zeroes it). Under JSC (iOS) that memory
// counts for jetsam and 32 MiB hold the working set (peak 4 to 9 MiB measured):
// 32. Elsewhere (V8) a smaller space moved the later heap allocations and
// cost up to 1 % (measured): 128, as before. ?codespace=<4..128> overrides.
export const CODE_SPACE_MIB_JSC = 32;
export const CODE_SPACE_MIB_DEFAULT = 128;
export function requestedCodeSpaceMiB(search, engine) {
  const raw = new URLSearchParams(search).get("codespace");
  if (raw != null && /^\d{1,3}$/.test(raw) && Number(raw) >= 4 && Number(raw) <= 128) return Number(raw);
  return engine === "jsc" ? CODE_SPACE_MIB_JSC : CODE_SPACE_MIB_DEFAULT;
}
function requestedGpuSpinMicros() {
  return parseGpuSpinMicros(new URLSearchParams(window.location.search).get("gpuspin"));
}

function requestedCpuOverclock() {
  const requested = Number.parseFloat(new URLSearchParams(window.location.search).get("oc") || "");
  if (Number.isFinite(requested) && requested >= 0.01 && requested <= 5) {
    return requested;
  }
  return 1;
}

// ?audiobuffer=N (ms, 16-200): the core mixer's queue (Dolphin's
// AudioBufferSize), part of the audio latency. 40 ms by default with
// the AudioWorklet (pairs on mains 2026-10-28, mixer queue counted: total
// latency 118-124 -> 80-85 ms from the title on, 0 underruns, no drop
// regression); with ?audiotransport=legacy, 0 (the core's 80 ms), never
// measured lower. A value in range overrides either.
export const DEFAULT_WORKLET_AUDIO_BUFFER_MS = 40;
export function requestedAudioBufferMs(search = window.location.search) {
  const params = new URLSearchParams(search);
  const n = Number.parseInt(params.get("audiobuffer") || "", 10);
  if (Number.isInteger(n) && n >= 16 && n <= 200) return n;
  return params.get("audiotransport") === "legacy" ? 0 : DEFAULT_WORKLET_AUDIO_BUFFER_MS;
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

// Pacing switches (patch 0150): Rush Frame Presentation is off by default
// (upstream's default), ?rush=1 turns it on. For measurement: ?synconidle=1
// turns SyncOnSkipIdle on, ?dupvsync=1 makes a duplicated XFB rearm the
// throttle; ?smoothearly=0 (patch 0153) makes the video thread present on
// arrival: SmoothEarlyPresentation off and no sleep to the present's time
// (off alone, with Rush off, it would still sleep to the intended time);
// ?sleepmargin=<us> (patch 0165, 0..8000) sleeps the throttle to its target
// minus the margin, then spins to it; ?sleepstep=<us> (0..4000) sleeps in
// short steps inside the margin before the spin. The throttle's sleep is the
// cascade by default (research/deep-precise-sleep.md §6 D, measured
// 2026-10-25/26): each wait k x the time left, ?sleepk=<permille> (0..950,
// default 750, 0: the plain sleep), until ?sleepspin=<us> (50..2000, default
// 150) is left, then a spin.
// Absent: the shipped pacing.
export function requestedPacing(search = window.location.search) {
  const params = new URLSearchParams(search);
  return {
    rushPresentation: params.get("rush") === "1",
    syncOnSkipIdle: params.get("synconidle") === "1",
    dupXfbRearmsThrottle: params.get("dupvsync") === "1",
    smoothEarly: params.get("smoothearly") !== "0",
    sleepMarginUs: /^\d{1,4}$/.test(params.get("sleepmargin") ?? "") && Number(params.get("sleepmargin")) <= 8000 ? Number(params.get("sleepmargin")) : 0,
    sleepStepUs: /^\d{1,4}$/.test(params.get("sleepstep") ?? "") && Number(params.get("sleepstep")) <= 4000 ? Number(params.get("sleepstep")) : 0,
    // 0 turns the cascade off; otherwise 500-950 (a lower k leaves most of
    // each wait to the spin, review of #292)
    sleepK: /^\d{1,3}$/.test(params.get("sleepk") ?? "") && Number(params.get("sleepk")) <= 950 ? (Number(params.get("sleepk")) === 0 ? 0 : Math.max(500, Number(params.get("sleepk")))) : 750,
    sleepSpinUs: /^\d{2,4}$/.test(params.get("sleepspin") ?? "") && Number(params.get("sleepspin")) >= 50 && Number(params.get("sleepspin")) <= 2000 ? Number(params.get("sleepspin")) : 150,
    // At most one wgpu present per BeginFrame (the worker's rAF), on by
    // default since 2026-10-26: ~58 distinct pictures shown a second instead
    // of ~56 and half the on-screen repeats on the race (12 pairs, --display).
    // ?presentvsync=0 (or false, off, no) presents as the ring drains.
    presentVsync: !["0", "false", "off", "no"].includes((params.get("presentvsync") ?? "").toLowerCase()),
    // ?presentpace=game: the vsync presenter shows frames at the game's own
    // pace on a screen faster than the game (src/wgpu-game-pacer.js). Off by default.
    presentGamePace: (params.get("presentpace") ?? "").toLowerCase() === "game",
    // ?presentpace=game or =observe: the refresh histogram (HUD) and the
    // game's period are kept; observe keeps them without pacing. Off: none
    // of it runs, the presenter does no extra work.
    presentPaceStats: ["game", "observe"].includes((params.get("presentpace") ?? "").toLowerCase())
  };
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
  inlinefma:       1 << 26, // inline exact FMA; set: the FMA family calls the interpreter's NI_madd_msub
  regionmtmsr:     1 << 27, // 0183 regions go on past a mtmsr that changes only EE (ENABLE polarity; default-on; ?regionmtmsr=0 turns it off)
  regshape:        1 << 28, // 0184 x64 register shape: at most 4 GPRs per block in locals (ENABLE polarity; default-off; ?regshape=x64)
  // Aliases the plan / TL;DR uses interchangeably:
  fastinputpoll: 1 << 1, // legacy synonym for meleecall (input-poll lives there)
  fastmem:       1 << 7, // legacy synonym for fastsystem (load/store-ish helpers)
  all:           0x47fffff
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
    // 0183's and 0184's bits are ENABLE bits: a raw ?disable= mask (or the
    // name) must not turn them on by accident; only ?regionmtmsr=1 and
    // ?regshape=x64 do.
    mask &= ~(CACHED_INTERPRETER_DISABLE_BITS.regionmtmsr | CACHED_INTERPRETER_DISABLE_BITS.regshape);
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
  // 0183: ENABLE polarity too, default-on since its measures (Mac race
  // +1.55 % warm / +1.85 % cold over 8 pairs; drop-meter guard clean): a
  // region goes on past a mtmsr that only turns interrupts off or on.
  // ?regionmtmsr=0 turns it off (its regions have their own cache keys).
  if (params.get("regionmtmsr") !== "0") {
    mask |= CACHED_INTERPRETER_DISABLE_BITS.regionmtmsr;
  }
  // 0184: the x64 register shape, default-off until the CI bench and a real
  // PC decide (?regshape=x64; automatic detection comes after).
  if (params.get("regshape") === "x64") {
    mask |= CACHED_INTERPRETER_DISABLE_BITS.regshape;
  }
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
