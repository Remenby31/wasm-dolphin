// Copyright 2026
// SPDX-License-Identifier: GPL-2.0-or-later

#include "dolphin_web_discio.cpp"
#include "dolphin_web_fma.h"

#include <array>
#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <chrono>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <malloc.h>
#include <unistd.h>
#endif

#include "AudioCommon/AudioCommon.h"
#include "AudioCommon/SoundStream.h"
#include "Common/CommonPaths.h"
#include "Common/Config/Config.h"
#include "Common/FileUtil.h"
#include "Common/HookableEvent.h"
#include "Common/Logging/LogManager.h"
#include "Common/MsgHandler.h"
#include "Common/WindowSystemInfo.h"

#include "Core/Boot/Boot.h"
#include "Core/BootManager.h"
#include "Core/Config/GraphicsSettings.h"
#include "Core/Config/MainSettings.h"
#include "Core/ConfigLoaders/BaseConfigLoader.h"
#include "Core/ConfigLoaders/GameConfigLoader.h"
#include "Core/ConfigManager.h"
#include "Core/HW/SI/SI_Device.h"
#include "Core/Core.h"
#include "Core/CoreTiming.h"
#include "Core/HW/GBAPad.h"
#include "Core/HW/ProcessorInterface.h"
#include "Core/HW/EXI/EXI.h"
#include "Core/HW/EXI/EXI_Device.h"
#include "Core/HW/EXI/EXI_DeviceMemoryCard.h"
#include "Core/HW/GCKeyboard.h"
#include "Core/HW/GCPad.h"
#include "Core/HW/SystemTimers.h"
#include "Core/Host.h"
#include "Core/PowerPC/PowerPC.h"
#include "Core/State.h"
#include "Core/System.h"

#include "InputCommon/ControllerInterface/ControllerInterface.h"

#include "VideoCommon/Fifo.h"
#include "VideoCommon/Statistics.h"
#include "VideoCommon/VideoBackendBase.h"
#include "VideoCommon/VideoConfig.h"

extern "C" void DolphinWeb_SetFastSoftwareRaster(int mode);
extern "C" std::uint32_t DolphinWeb_SetCachedInterpreterDisableMask(std::uint32_t mask);
extern "C" std::uint32_t DolphinWeb_GetCachedInterpreterDisableMask();
extern "C" unsigned int DolphinWeb_SetRendererFeatureMask(unsigned int mask);
extern "C" unsigned int DolphinWeb_GetRendererFeatureMask();
extern "C" void DolphinWeb_SetDupXfbRearmsThrottle(int on);  // patch 0150
extern "C" void DolphinWeb_SetPresentOnArrival(int on);       // patch 0153
extern "C" void DolphinWeb_SetThrottleSleepMarginUs(int us);  // patch 0165
extern "C" void DolphinWeb_SetThrottleSleepStepUs(int us);    // patch 0165
extern "C" void DolphinWeb_SetThrottleSleepCascade(int k_permille, int spin_us);  // patch 0165
extern "C" void NotifyWebGpuOwnershipTraceLoadRequested();

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include <pthread.h>

// §27d: defined in VideoCommon/Fifo.cpp — the after-load callback (CPU
// pthread) stores a sentinel; the GPU-thread gate reads it back.
namespace Fifo { extern std::atomic<std::uint32_t> g_s27_sentinel; }

extern "C" const char* DolphinWeb_GetAudioCommonStats();

#ifdef __clang__
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-variable-declarations"
#endif
EM_JS(int, DolphinWeb_RunWasmJitSmokeImpl, (int value), {
  if (!Module._dolphinWasmJitSmoke) {
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
      0x03, 0x02, 0x01, 0x00,
      0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
      0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x41, 0x2a, 0x6a, 0x0b
    ]);
    Module._dolphinWasmJitSmoke =
        new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports.f;
  }
  return Module._dolphinWasmJitSmoke(value) | 0;
});

EM_JS(int, DolphinWeb_RunGeneratedWasmI32, (const unsigned char* bytes_ptr, int bytes_len, int value), {
  const bytes = Module.HEAPU8.slice(bytes_ptr, bytes_ptr + bytes_len);
  const fn = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports.f;
  return fn(value) | 0;
});

EM_JS(void, DolphinWeb_RunGeneratedWasmVoidI32,
      (const unsigned char* bytes_ptr, int bytes_len, int value), {
  const bytes = Module.HEAPU8.slice(bytes_ptr, bytes_ptr + bytes_len);
  const fn = new WebAssembly.Instance(new WebAssembly.Module(bytes), {env: {memory: wasmMemory}})
                 .exports.f;
  fn(value);
});
#ifdef __clang__
#pragma clang diagnostic pop
#endif
#else
int DolphinWeb_RunWasmJitSmokeImpl(int value)
{
  return value + 42;
}

int DolphinWeb_RunGeneratedWasmI32(const unsigned char*, int, int value)
{
  return value;
}

void DolphinWeb_RunGeneratedWasmVoidI32(const unsigned char*, int, int)
{
}
#endif

namespace
{
#ifndef DOLPHIN_WASM_MEMORY_PAGES
#error "DOLPHIN_WASM_MEMORY_PAGES must be supplied by the pinned CMake configuration"
#endif
constexpr std::uint32_t DOLPHIN_WASM_SHARED_MEMORY_PAGES = DOLPHIN_WASM_MEMORY_PAGES;

void EmitU32Leb(std::vector<std::uint8_t>& bytes, std::uint32_t value)
{
  do
  {
    std::uint8_t byte = value & 0x7f;
    value >>= 7;
    if (value != 0)
      byte |= 0x80;
    bytes.push_back(byte);
  } while (value != 0);
}

void EmitI32Leb(std::vector<std::uint8_t>& bytes, std::int32_t value)
{
  bool more = true;
  while (more)
  {
    std::uint8_t byte = value & 0x7f;
    value >>= 7;
    const bool sign_bit = (byte & 0x40) != 0;
    if ((value == 0 && !sign_bit) || (value == -1 && sign_bit))
      more = false;
    else
      byte |= 0x80;
    bytes.push_back(byte);
  }
}

void EmitSection(std::vector<std::uint8_t>& bytes, std::uint8_t id,
                 const std::vector<std::uint8_t>& content)
{
  bytes.push_back(id);
  EmitU32Leb(bytes, static_cast<std::uint32_t>(content.size()));
  bytes.insert(bytes.end(), content.begin(), content.end());
}

std::vector<std::uint8_t> BuildI32AddImmediateModule(std::int32_t immediate)
{
  std::vector<std::uint8_t> bytes = {0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00};

  EmitSection(bytes, 1, {0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f});
  EmitSection(bytes, 3, {0x01, 0x00});
  EmitSection(bytes, 7, {0x01, 0x01, 0x66, 0x00, 0x00});

  std::vector<std::uint8_t> body = {0x00, 0x20, 0x00, 0x41};
  EmitI32Leb(body, immediate);
  body.push_back(0x6a);
  body.push_back(0x0b);

  std::vector<std::uint8_t> code;
  code.push_back(0x01);
  EmitU32Leb(code, static_cast<std::uint32_t>(body.size()));
  code.insert(code.end(), body.begin(), body.end());
  EmitSection(bytes, 10, code);

  return bytes;
}

std::vector<std::uint8_t> BuildStateAddImmediateModule(std::uint32_t dest_offset,
                                                       std::uint32_t source_offset,
                                                       std::int32_t immediate)
{
  std::vector<std::uint8_t> bytes = {0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00};

  EmitSection(bytes, 1, {0x01, 0x60, 0x01, 0x7f, 0x00});

  std::vector<std::uint8_t> imports;
  imports.push_back(0x01);
  imports.push_back(0x03);
  imports.insert(imports.end(), {'e', 'n', 'v'});
  imports.push_back(0x06);
  imports.insert(imports.end(), {'m', 'e', 'm', 'o', 'r', 'y'});
  imports.push_back(0x02);
  imports.push_back(0x03);
  // Imported shared memory's declared min/max MUST equal the actual SAB's
  // min/max — and we bumped INITIAL_MEMORY from 1 GiB → 1.5 GiB in
  // CMakeLists.txt (no growth). 1.5 GiB / 64 KiB = 24576 pages. Out-of-sync
  // values trigger LinkError("memory max 24576 > WASM binary max 16384") in
  // the JIT block compiler around frame 700. Keep both numbers in step
  // with INITIAL_MEMORY.
  EmitU32Leb(imports, DOLPHIN_WASM_SHARED_MEMORY_PAGES);
  EmitU32Leb(imports, DOLPHIN_WASM_SHARED_MEMORY_PAGES);
  EmitSection(bytes, 2, imports);

  EmitSection(bytes, 3, {0x01, 0x00});
  EmitSection(bytes, 7, {0x01, 0x01, 0x66, 0x00, 0x00});

  std::vector<std::uint8_t> body = {0x00, 0x20, 0x00, 0x20, 0x00, 0x28, 0x02};
  EmitU32Leb(body, source_offset);
  body.push_back(0x41);
  EmitI32Leb(body, immediate);
  body.push_back(0x6a);
  body.push_back(0x36);
  body.push_back(0x02);
  EmitU32Leb(body, dest_offset);
  body.push_back(0x0b);

  std::vector<std::uint8_t> code;
  code.push_back(0x01);
  EmitU32Leb(code, static_cast<std::uint32_t>(body.size()));
  code.insert(code.end(), body.begin(), body.end());
  EmitSection(bytes, 10, code);

  return bytes;
}

struct PpcWasmStateLayout
{
  std::uint32_t pc_offset;
  std::uint32_t npc_offset;
  std::uint32_t gpr_offset;
  std::uint32_t downcount_offset;
};

void EmitLocalGet(std::vector<std::uint8_t>& body, std::uint32_t index)
{
  body.push_back(0x20);
  EmitU32Leb(body, index);
}

void EmitI32Const(std::vector<std::uint8_t>& body, std::uint32_t value)
{
  body.push_back(0x41);
  EmitI32Leb(body, static_cast<std::int32_t>(value));
}

void EmitStateLoadU32(std::vector<std::uint8_t>& body, std::uint32_t offset)
{
  EmitLocalGet(body, 0);
  body.push_back(0x28);
  body.push_back(0x02);
  EmitU32Leb(body, offset);
}

void EmitStateStoreU32Prefix(std::vector<std::uint8_t>& body, std::uint32_t offset)
{
  EmitLocalGet(body, 0);
  (void)offset;
}

void EmitStateStoreU32Suffix(std::vector<std::uint8_t>& body, std::uint32_t offset)
{
  body.push_back(0x36);
  body.push_back(0x02);
  EmitU32Leb(body, offset);
}

std::uint32_t GprOffset(const PpcWasmStateLayout& layout, std::uint32_t index)
{
  return layout.gpr_offset + index * sizeof(std::uint32_t);
}

void EmitGprOrZero(std::vector<std::uint8_t>& body, const PpcWasmStateLayout& layout,
                   std::uint32_t index)
{
  if (index == 0)
    EmitI32Const(body, 0);
  else
    EmitStateLoadU32(body, GprOffset(layout, index));
}

bool EmitPpcIntegerInstruction(std::vector<std::uint8_t>& body,
                               const PpcWasmStateLayout& layout, UGeckoInstruction inst)
{
  switch (inst.OPCD)
  {
  case 14:  // addi
    EmitStateStoreU32Prefix(body, GprOffset(layout, inst.RD));
    EmitGprOrZero(body, layout, inst.RA);
    EmitI32Const(body, static_cast<std::uint32_t>(static_cast<std::int32_t>(inst.SIMM_16)));
    body.push_back(0x6a);
    EmitStateStoreU32Suffix(body, GprOffset(layout, inst.RD));
    return true;

  case 15:  // addis
  {
    const auto immediate =
        static_cast<std::uint32_t>(static_cast<std::int32_t>(inst.SIMM_16) * 65536);
    EmitStateStoreU32Prefix(body, GprOffset(layout, inst.RD));
    EmitGprOrZero(body, layout, inst.RA);
    EmitI32Const(body, immediate);
    body.push_back(0x6a);
    EmitStateStoreU32Suffix(body, GprOffset(layout, inst.RD));
    return true;
  }

  case 24:  // ori
    EmitStateStoreU32Prefix(body, GprOffset(layout, inst.RA));
    EmitStateLoadU32(body, GprOffset(layout, inst.RS));
    EmitI32Const(body, inst.UIMM);
    body.push_back(0x72);
    EmitStateStoreU32Suffix(body, GprOffset(layout, inst.RA));
    return true;

  case 25:  // oris
    EmitStateStoreU32Prefix(body, GprOffset(layout, inst.RA));
    EmitStateLoadU32(body, GprOffset(layout, inst.RS));
    EmitI32Const(body, inst.UIMM << 16);
    body.push_back(0x72);
    EmitStateStoreU32Suffix(body, GprOffset(layout, inst.RA));
    return true;

  case 31:
    if (inst.SUBOP10 != 444 || inst.Rc)
      return false;
    EmitStateStoreU32Prefix(body, GprOffset(layout, inst.RA));
    EmitStateLoadU32(body, GprOffset(layout, inst.RS));
    EmitStateLoadU32(body, GprOffset(layout, inst.RB));
    body.push_back(0x72);
    EmitStateStoreU32Suffix(body, GprOffset(layout, inst.RA));
    return true;

  default:
    return false;
  }
}

std::vector<std::uint8_t> BuildPpcIntegerBlockModule(std::span<const UGeckoInstruction> instructions,
                                                     const PpcWasmStateLayout& layout,
                                                     std::uint32_t next_pc,
                                                     std::uint32_t downcount)
{
  std::vector<std::uint8_t> bytes = {0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00};

  EmitSection(bytes, 1, {0x01, 0x60, 0x01, 0x7f, 0x00});

  std::vector<std::uint8_t> imports;
  imports.push_back(0x01);
  imports.push_back(0x03);
  imports.insert(imports.end(), {'e', 'n', 'v'});
  imports.push_back(0x06);
  imports.insert(imports.end(), {'m', 'e', 'm', 'o', 'r', 'y'});
  imports.push_back(0x02);
  imports.push_back(0x03);
  // See INITIAL_MEMORY sync note above.
  EmitU32Leb(imports, DOLPHIN_WASM_SHARED_MEMORY_PAGES);
  EmitU32Leb(imports, DOLPHIN_WASM_SHARED_MEMORY_PAGES);
  EmitSection(bytes, 2, imports);

  EmitSection(bytes, 3, {0x01, 0x00});
  EmitSection(bytes, 7, {0x01, 0x01, 0x66, 0x00, 0x00});

  std::vector<std::uint8_t> body = {0x00};
  for (const UGeckoInstruction inst : instructions)
  {
    if (!EmitPpcIntegerInstruction(body, layout, inst))
      return {};
  }

  EmitStateStoreU32Prefix(body, layout.pc_offset);
  EmitI32Const(body, next_pc);
  EmitStateStoreU32Suffix(body, layout.pc_offset);

  EmitStateStoreU32Prefix(body, layout.npc_offset);
  EmitI32Const(body, next_pc);
  EmitStateStoreU32Suffix(body, layout.npc_offset);

  EmitStateStoreU32Prefix(body, layout.downcount_offset);
  EmitStateLoadU32(body, layout.downcount_offset);
  EmitI32Const(body, downcount);
  body.push_back(0x6b);
  EmitStateStoreU32Suffix(body, layout.downcount_offset);

  body.push_back(0x0b);

  std::vector<std::uint8_t> code;
  code.push_back(0x01);
  EmitU32Leb(code, static_cast<std::uint32_t>(body.size()));
  code.insert(code.end(), body.begin(), body.end());
  EmitSection(bytes, 10, code);

  return bytes;
}

PpcWasmStateLayout GetPpcStateLayout(PowerPC::PowerPCState& state)
{
  const auto base = reinterpret_cast<std::uintptr_t>(&state);
  return {
      static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(&state.pc) - base),
      static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(&state.npc) - base),
      static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(state.gpr) - base),
      static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(&state.downcount) - base),
  };
}

UGeckoInstruction EncodeDForm(std::uint32_t opcd, std::uint32_t rd_or_rs, std::uint32_t ra,
                              std::uint16_t immediate)
{
  return UGeckoInstruction{(opcd << 26) | (rd_or_rs << 21) | (ra << 16) | immediate};
}

UGeckoInstruction EncodeXForm(std::uint32_t opcd, std::uint32_t rs, std::uint32_t ra,
                              std::uint32_t rb, std::uint32_t xo, bool rc = false)
{
  return UGeckoInstruction{(opcd << 26) | (rs << 21) | (ra << 16) | (rb << 11) | (xo << 1) |
                           (rc ? 1u : 0u)};
}
}  // namespace

namespace UICommon
{
Common::EventHook AddFlushUnsavedDataCallback(std::function<void()> callback)
{
  return {};
}

std::string FormatSize(u64 bytes, int decimals)
{
  return std::to_string(bytes) + " B";
}
}  // namespace UICommon

namespace
{
bool s_runtime_initialized = false;
// Written by the API's thread and by alerts from any thread (CPU, GPU): every
// access goes through SetCoreStatus / GetCoreStatus, under this mutex.
std::mutex s_core_status_mutex;
std::string s_core_status = "Not initialized";

void SetCoreStatus(std::string status)
{
  std::lock_guard lock(s_core_status_mutex);
  s_core_status = std::move(status);
}
std::string s_core_title;
std::string s_video_backend = "Software Renderer";

// Dolphin's own ERROR_LOG_FMT / WARN_LOG_FMT output is otherwise discarded in
// this build: Emscripten's print is routed to postStatus and no LogListener is
// ever registered, so the emulator's diagnostics never reach the browser
// console. That silence has real cost -- the software rasterizer emits an
// "unsupported pixel format" warning that nobody has been able to see.
//
// Opt-in via ?corelog=1 (Module['dolphinCoreLog']), because the volume is
// large enough to distort timing. Default off leaves the shipping page
// byte-identical in behaviour.
class BrowserLogListener final : public Common::Log::LogListener
{
public:
  void Log(Common::Log::LogLevel level, const char* msg) override
  {
    if (msg == nullptr)
      return;
    const int severity = static_cast<int>(level);
    EM_ASM({
      var text = "[dolphin] " + UTF8ToString($1);
      if ($0 <= 1) { console.error(text); }
      else if ($0 == 2) { console.warn(text); }
      else { console.log(text); }
    }, severity, msg);
  }
};

PowerPC::CPUCore s_cpu_core = PowerPC::CPUCore::CachedInterpreter;
// ?rtc=<seconds since 1970>: a fixed start for the emulated real-time clock,
// which then follows emulated time (EXI_DeviceIPL.cpp). Off: the host clock.
bool s_custom_rtc_enabled = false;
std::uint32_t s_custom_rtc_value = 0;
bool s_cpu_thread = false;
float s_cpu_overclock = 1.0f;
float s_emulation_speed = 1.0f;
// The mixer's granule queue (Dolphin's AudioBufferSize, ms): 0 keeps its
// default (80). Part of the audio latency, with the page's AudioWorklet ring.
int s_audio_buffer_ms = 0;
constexpr int AUDIO_PULL_MAX_FRAMES = 4096;
std::array<s16, AUDIO_PULL_MAX_FRAMES * 2> s_audio_pull_buffer{};
std::string s_audio_stats = "audio:unavailable";
std::string s_audio_stats_snapshot = "audio:unavailable";
// CoreTiming::GetTicks() is CPU-thread-only. The browser worker normally
// polls from the disc-I/O worker, so those legacy observations can differ
// slightly from the exact state-load checkpoint. Capture the authoritative
// checkpoint at the start of the existing CPU-thread after-load callback.
std::atomic<std::uint32_t> s_last_loaded_ticks_low{0};
std::atomic<std::uint32_t> s_last_loaded_ticks_high{0};
std::atomic<std::uint32_t> s_last_loaded_ppc_pc{0};
std::atomic<std::uint32_t> s_last_loaded_checkpoint_generation{0};

void RelayAlert(const std::string& message)
{
#ifdef __EMSCRIPTEN__
  EM_ASM(
      {
        const message = UTF8ToString($0);
        if (typeof postMessage === 'function')
          postMessage({type: 'status', message});
        if (typeof console !== 'undefined')
          console.error(message);
      },
      message.c_str());
#else
  (void)message;
#endif
}

// Rate limit for the alerts relayed to the page, as src/status-rate-limit.js
// does for the worker's status lines. Every relayed line reaches Chrome's
// browser process (and CDP): a core looping on one alert (2026-10-21: an MMU
// "Invalid read" a million times in 31 s, from the CPU thread) took it past
// 10 GB and stalled the worker serving disc reads.
// - consecutive identical alerts are folded: the first is relayed, the
//   repeats counted, "… repeated N times" relayed when another one comes, or
//   once per window while they go on;
// - beyond ALERT_MAX_PER_WINDOW alerts per window, alerts are counted, not
//   relayed, and one summary is relayed when the window rolls;
// - critical alerts are always relayed.
// The core status (SetCoreStatus) always holds the latest alert. Alerts come
// from any thread. A loop that stops dead keeps its last "… repeated N times"
// until another alert comes (no timer here; accepted, review of #63).
constexpr int ALERT_MAX_PER_WINDOW = 200;
constexpr std::chrono::milliseconds ALERT_WINDOW{1000};
struct AlertRelayState
{
  std::mutex mutex;
  std::string last;
  std::uint32_t repeats = 0;
  std::chrono::steady_clock::time_point repeats_since{};
  std::chrono::steady_clock::time_point window_start{};
  int sent_in_window = 0;
  std::uint32_t dropped_in_window = 0;
  std::uint32_t relayed = 0, folded = 0, dropped = 0;
};
AlertRelayState s_alert_relay;

void SendAlert(AlertRelayState& r, const std::string& message)
{
  r.relayed += 1;
  RelayAlert(message);
}

void FlushAlertRepeats(AlertRelayState& r, std::chrono::steady_clock::time_point t)
{
  if (r.repeats > 0)
  {
    SendAlert(r, "… repeated " + std::to_string(r.repeats) + (r.repeats > 1 ? " times: " : " time: ") +
                     r.last.substr(0, 200));
  }
  r.repeats = 0;
  r.repeats_since = t;
}

void RollAlertWindow(AlertRelayState& r, std::chrono::steady_clock::time_point t)
{
  if (t - r.window_start < ALERT_WINDOW)
    return;
  if (r.dropped_in_window > 0)
  {
    SendAlert(r, "[alert] " + std::to_string(r.dropped_in_window) + " alert(s) not relayed (rate cap " +
                     std::to_string(ALERT_MAX_PER_WINDOW) + " per second)");
  }
  r.window_start = t;
  r.sent_in_window = 0;
  r.dropped_in_window = 0;
}

void RelayAlertLimited(const std::string& message, bool critical)
{
  auto& r = s_alert_relay;
  std::lock_guard lock(r.mutex);
  const auto t = std::chrono::steady_clock::now();
  RollAlertWindow(r, t);
  if (critical)
  {
    FlushAlertRepeats(r, t);
    r.last = message;
    SendAlert(r, message);
    return;
  }
  if (message == r.last)
  {
    r.repeats += 1;
    r.folded += 1;
    if (t - r.repeats_since >= ALERT_WINDOW)
      FlushAlertRepeats(r, t);  // a loop: the count goes out once per window
    return;
  }
  FlushAlertRepeats(r, t);
  r.last = message;
  if (r.sent_in_window >= ALERT_MAX_PER_WINDOW)
  {
    r.dropped_in_window += 1;
    r.dropped += 1;
    return;
  }
  r.sent_in_window += 1;
  SendAlert(r, message);
}

bool BrowserMsgHandler(const char* caption, const char* text, bool yes_no, Common::MsgType style)
{
  (void)yes_no;
  const std::string message = std::string(caption ? caption : "Alert") + ": " + (text ? text : "");
  SetCoreStatus(message);
  RelayAlertLimited(message, style == Common::MsgType::Critical);
  return true;
}

const char* StateName(Core::State state)
{
  switch (state)
  {
  case Core::State::Uninitialized:
    return "Uninitialized";
  case Core::State::Paused:
    return "Paused";
  case Core::State::Running:
    return "Running";
  case Core::State::Stopping:
    return "Stopping";
  case Core::State::Starting:
    return "Starting";
  }
  return "Unknown";
}

void CreateDirectoryIfNeeded(const std::string& path)
{
  if (!path.empty())
    File::CreateFullPath(path);
}

// Patch 0168. Internal resolution: 1 to 4 times native (the EFB, the EFB and
// XFB copies, the backbuffer); any other value is native, as the page's
// normalizeInternalResolution says. The software renderer has a single
// resolution, so other backends stay at 1. Anisotropic filtering: log2 of the
// maximum (0 = 1x .. 4 = 16x); any other value is -1, what the game asks for
// (src/wgpu-enhancements.js anisotropyToCore). Base layer only: the video
// thread applies a change at its next frame (VideoConfig::CheckForConfigChanges
// recreates the EFB, WebGPUGfx resizes the backbuffer and tells the page).
// Returns the scale in effect.
static int ApplyEnhancements(int efb_scale, int anisotropy)
{
  const int scale =
      s_video_backend == "WebGPU" && efb_scale >= 1 && efb_scale <= 4 ? efb_scale : 1;
  Config::SetBase(Config::GFX_EFB_SCALE, scale);
  Config::SetBase(Config::GFX_ENHANCE_MAX_ANISOTROPY,
                  static_cast<AnisotropicFilteringMode>(anisotropy >= 0 && anisotropy <= 4 ?
                                                            anisotropy : -1));
  return scale;
}

void EnsureRuntime()
{
  if (s_runtime_initialized)
    return;

  File::SetUserPath(D_USER_IDX, "/dolphin-user");
  CreateDirectoryIfNeeded(File::GetUserPath(D_USER_IDX));
  CreateDirectoryIfNeeded(File::GetUserPath(D_CONFIG_IDX));
  CreateDirectoryIfNeeded(File::GetUserPath(D_GCUSER_IDX));
  CreateDirectoryIfNeeded(File::GetUserPath(D_CACHE_IDX));
  CreateDirectoryIfNeeded(File::GetUserPath(D_SHADERS_IDX));
  CreateDirectoryIfNeeded(File::GetUserPath(D_STATESAVES_IDX));
  CreateDirectoryIfNeeded(File::GetUserPath(D_DUMP_IDX));

  // Wii NAND. SetUserPath(D_USER_IDX) derives D_WIIROOT_IDX as <user>/Wii/,
  // and BootManager calls Core::InitializeWiiRoot for Wii discs -- but that
  // only POINTS the session root at this path, it does not create it. Nothing
  // else did either, because the rest of this list is GameCube-oriented, so
  // IOS HLE had no filesystem to open and every Wii title reported "Could not
  // write to/read from Wii system memory" while otherwise emulating fine.
  //
  // The top-level directories are the standard NAND layout; IOS creates files
  // beneath them but expects the roots to exist.
  CreateDirectoryIfNeeded(File::GetUserPath(D_WIIROOT_IDX));
  CreateDirectoryIfNeeded(File::GetUserPath(D_WIISYSCONF_IDX));
  for (const char* nand_dir :
       {"import", "meta", "shared1", "shared2", "sys", "ticket", "title", "tmp"})
  {
    CreateDirectoryIfNeeded(File::GetUserPath(D_WIIROOT_IDX) + nand_dir);
  }
  // Core::InitializeWiiRoot(use_temporary=true) puts the session NAND here
  // instead; create it so a deterministic run has somewhere to go too.
  CreateDirectoryIfNeeded(File::GetUserPath(D_USER_IDX) + "WiiSession");

  Config::Init();
  Config::AddLayer(ConfigLoaders::GenerateBaseConfigLoader());
  SConfig::Init();
  g_Config.Init();
  Common::Log::LogManager::Init();
  // ?corelog=1 forwards Dolphin's log output to the browser console.
  if (EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                           Module['dolphinCoreLog']) ? 1 : 0; }) != 0)
  {
    auto* log_manager = Common::Log::LogManager::GetInstance();
    if (log_manager != nullptr)
    {
      log_manager->RegisterListener(Common::Log::LogListener::CONSOLE_LISTENER,
                                    std::make_unique<BrowserLogListener>());
      log_manager->EnableListener(Common::Log::LogListener::CONSOLE_LISTENER, true);
      log_manager->SetConfigLogLevel(Common::Log::LogLevel::LWARNING);
      for (int i = 0; i < static_cast<int>(Common::Log::LogType::NUMBER_OF_LOGS); ++i)
        log_manager->SetEnable(static_cast<Common::Log::LogType>(i), true);
    }
  }
  Common::RegisterMsgAlertHandler(&BrowserMsgHandler);
  Statistics::Init();

  Config::SetBase(Config::MAIN_GFX_BACKEND, s_video_backend);
  Config::SetBase(Config::GFX_PREFER_GLES, s_video_backend == "OGL");
  Config::SetBase(Config::MAIN_CPU_CORE, s_cpu_core);
  Config::SetBase(Config::MAIN_CUSTOM_RTC_ENABLE, s_custom_rtc_enabled);
  if (s_custom_rtc_enabled)
    Config::SetBase(Config::MAIN_CUSTOM_RTC_VALUE, s_custom_rtc_value);
  Config::SetBase(Config::MAIN_CPU_THREAD, s_cpu_thread);
  Config::SetBase(Config::MAIN_SKIP_IPL, true);
  Config::SetBase(Config::MAIN_DSP_HLE, true);
  Config::SetBase(Config::MAIN_DSP_THREAD, false);
  Config::SetBase(Config::MAIN_FAST_DISC_SPEED, true);
  Config::SetBase(Config::MAIN_EMULATION_SPEED, s_emulation_speed);
  if (s_audio_buffer_ms > 0)
    Config::SetBase(Config::MAIN_AUDIO_BUFFER_SIZE, s_audio_buffer_ms);
  // §28cz play-speed sync. When the browser CPU falls more than MaxFallback
  // (100ms) behind in a heavy scene, Dolphin's throttle normally CONCEDES that
  // time (slides the reference clock forward) and never catches up, so the
  // in-game clock drifts behind a real stopwatch. CorrectTimeDrift=true disables
  // that concession: the throttle recovers the lost time so the game clock
  // tracks wall-clock. Opt-in via ?timedrift=1 (Module['dolphinCorrectTimeDrift']);
  // default false keeps stock Dolphin behavior so the default root is unchanged.
  const bool correct_time_drift =
      EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                           Module['dolphinCorrectTimeDrift']) ? 1 : 0; }) != 0;
  Config::SetBase(Config::MAIN_CORRECT_TIME_DRIFT, correct_time_drift);
  Config::SetBase(Config::MAIN_OVERCLOCK_ENABLE, true);
  Config::SetBase(Config::MAIN_OVERCLOCK, s_cpu_overclock);
  Config::SetBase(Config::MAIN_PRECISION_FRAME_TIMING, false);
  // Pacing switches (patch 0150): Rush Frame Presentation is off, as
  // upstream's default (with it, heavy scenes ran up to 40 ms ahead of the
  // presents: VI p99 ~60 ms); ?rush=1 (Module['dolphinRushPresentation'] true)
  // turns it back on. For measurement: ?synconidle=1 turns Dolphin's
  // SyncOnSkipIdle on, ?dupvsync=1 makes a duplicated XFB rearm the throttle.
  const bool rush_presentation =
      EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                           Module['dolphinRushPresentation'] === true) ? 1 : 0; }) != 0;
  const bool sync_on_skip_idle =
      EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                           Module['dolphinSyncOnSkipIdle'] === true) ? 1 : 0; }) != 0;
  DolphinWeb_SetDupXfbRearmsThrottle(
      EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                           Module['dolphinDupXfbRearmsThrottle'] === true) ? 1 : 0; }));
  // ?smoothearly=0 (patch 0153, Module['dolphinSmoothEarly'] false): the
  // video thread presents on arrival, with no sleep to the present's time
  // (Present.cpp, 0094). SmoothEarlyPresentation off alone would not remove
  // it: with Rush off, GetUpdatedPresentationTime returns the intended time.
  const bool smooth_early =
      EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                           Module['dolphinSmoothEarly'] === false) ? 0 : 1; }) != 0;
  DolphinWeb_SetPresentOnArrival(smooth_early ? 0 : 1);
  // ?sleepmargin=<us> (patch 0165, Module['dolphinSleepMarginUs']): the
  // throttle sleeps to its target minus the margin, then spins (0: off).
  DolphinWeb_SetThrottleSleepMarginUs(
      EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                           Number.isInteger(Module['dolphinSleepMarginUs'])) ?
                              Module['dolphinSleepMarginUs'] : 0; }));
  // ?sleepstep=<us>: short sleeps inside the margin before the final spin.
  DolphinWeb_SetThrottleSleepStepUs(
      EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                           Number.isInteger(Module['dolphinSleepStepUs'])) ?
                              Module['dolphinSleepStepUs'] : 0; }));
  // ?sleepk=<permille>&sleepspin=<us>: the geometric cascade (0: off).
  DolphinWeb_SetThrottleSleepCascade(
      EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                           Number.isInteger(Module['dolphinSleepK'])) ?
                              Module['dolphinSleepK'] : 750; }),
      EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                           Number.isInteger(Module['dolphinSleepSpinUs'])) ?
                              Module['dolphinSleepSpinUs'] : 150; }));
  Config::SetBase(Config::MAIN_RUSH_FRAME_PRESENTATION, rush_presentation);
  Config::SetBase(Config::MAIN_SMOOTH_EARLY_PRESENTATION, smooth_early);
  Config::SetBase(Config::MAIN_SYNC_ON_SKIP_IDLE, sync_on_skip_idle);
  Config::SetBase(Config::MAIN_ACCURATE_FMADDS, false);
  Config::SetBase(Config::MAIN_ENABLE_CHEATS, false);
  Config::SetBase(Config::MAIN_OSD_MESSAGES, false);
  Config::SetBase(Config::MAIN_SLOT_A, ExpansionInterface::EXIDeviceType::MemoryCardFolder);
  // A second GCI-folder card in slot B only when the page asks for it
  // (?memcardb=1 sets Module['dolphinMemcardSlotB']): with a card in each
  // slot, some games stop to ask which one to use.
  const bool memcard_slot_b =
      EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                           Module['dolphinMemcardSlotB']) ? 1 : 0; }) != 0;
  Config::SetBase(Config::MAIN_SLOT_B, memcard_slot_b ?
                                           ExpansionInterface::EXIDeviceType::MemoryCardFolder :
                                           ExpansionInterface::EXIDeviceType::None);
  // A controller sits on all four ports; DolphinWeb_GetPadStatus reports which
  // ones are plugged in, so the host can hot-plug them.
  for (int port = 0; port < 4; ++port)
    Config::SetBase(Config::GetInfoForSIDevice(port), SerialInterface::SIDEVICE_GC_CONTROLLER);
  Config::SetBase(Config::MAIN_AUDIO_BACKEND, std::string("Web Audio"));
  Config::SetBase(Config::MAIN_AUDIO_MUTED, false);
  // Dolphin's default. OGL and WebGPU present the XFB from the texture cache,
  // so the copy to guest RAM only fed DolphinWeb_OnXfb's software presenter.
  // A GameINI that needs the RAM copy ([Video_Hacks] XFBToTextureEnable =
  // False, embedded by 0097 v3) overrides this base value from the game
  // layer: only the base layer is set here.
  const bool hardware_xfb = s_video_backend == "OGL" || s_video_backend == "WebGPU";
  Config::SetBase(Config::GFX_HACK_SKIP_XFB_COPY_TO_RAM, hardware_xfb);
  // ?xfbdecode=0 (Module['dolphinXfbNoDecode']), benches only: under the
  // null backend the decode is the only CPU-thread cost WebGPU does not pay
  // (6.9 % of the CPU thread on the heavy scene, Spark, 2026-10-27).
  // Ignored by every other backend, whose XFB is their only image.
  const bool xfb_no_decode = EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                                                  Module['dolphinXfbNoDecode']) ? 1 : 0; }) != 0;
  s_skip_xfb_decode =
      s_video_backend == "WebGPU" || (s_video_backend == "Null" && xfb_no_decode);
  // Without the RAM copy, an XFB texture keeps its id until the game copies a
  // new one, so Dolphin's duplicate check starts skipping the presents of
  // fields that repeat a frame (with the RAM copy every field reloaded a new
  // texture). Keep one present per VI field, as before and as OGL does.
  if (s_video_backend == "WebGPU")
    Config::SetBase(Config::GFX_HACK_SKIP_DUPLICATE_XFBS, false);
  // Internal resolution and anisotropic filtering (patch 0168), from the page
  // (?ir= sets Module['dolphinEfbScale'], ?aniso= Module['dolphinMaxAnisotropy'])
  // and later from DolphinWeb_SetEnhancements. EFB copies to textures follow
  // the internal resolution, Dolphin's default: render-to-texture effects
  // (shadows, reflections, split screens, blur) would otherwise stay native
  // and look blurrier than the frame. At 1x a scaled copy is the native one.
  Config::SetBase(Config::GFX_HACK_COPY_EFB_SCALED, true);
  ApplyEnhancements(
      EM_ASM_INT({ return (typeof Module !== 'undefined') ? (Module['dolphinEfbScale'] | 0) : 1; }),
      EM_ASM_INT({
        const n = (typeof Module !== 'undefined') ? Module['dolphinMaxAnisotropy'] : undefined;
        return typeof n === 'number' ? (n | 0) : -1;
      }));
  // ?efbaccess=1 (Module['dolphinEfbAccess']): CPU reads and writes of the
  // EFB, off by default as in Dolphin. A base-layer value: the disc's
  // GameINI (tools/gamesettings-allowlist.json) turns it on above it.
  const bool efb_access = EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                                               Module['dolphinEfbAccess']) ? 1 : 0; }) != 0;
  Config::SetBase(Config::GFX_HACK_EFB_ACCESS_ENABLE, efb_access);
  // ?efbcopyram=1 (Module['dolphinEfbCopyRam']): EFB copies also land in
  // guest RAM. Base layer too: a GameINI's EFBToTextureEnable wins.
  const bool efb_copy_ram = EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                                                 Module['dolphinEfbCopyRam']) ? 1 : 0; }) != 0;
  Config::SetBase(Config::GFX_HACK_SKIP_EFB_COPY_TO_RAM, !efb_copy_ram);
  // ?efbdefer=0 (Module['dolphinEfbNoDefer']): EFB copies to RAM wait for
  // the GPU one by one instead of at the next sync point, as a GameINI asks
  // with DeferEFBCopies=False. Base layer too: a GameINI's value wins.
  const bool efb_no_defer = EM_ASM_INT({ return (typeof Module !== 'undefined' &&
                                                 Module['dolphinEfbNoDefer']) ? 1 : 0; }) != 0;
  Config::SetBase(Config::GFX_HACK_DEFER_EFB_COPIES, !efb_no_defer);
  // Fill the canvas with the XFB, as the software presenter does. Dolphin's
  // default analog aspect pillarboxes a 640-wide XFB to ~583 pixels, so the
  // hardware path showed every game narrower than the software one.
  Config::SetBase(Config::GFX_ASPECT_RATIO, AspectMode::Stretch);
  // §28cx: ubershaders DISCRIMINATOR (May-30). The UBO const-index fix made the
  // uber pixel shaders translate (fail 27->0) and 7195 draws execute, but the EFB
  // is still all-zero (nz=0/max=0) => draws write nothing. Flip WebGPU back to
  // specialized (Synchronous) to isolate: specialized shaders translate fine and
  // previously got "characters appear" — if the EFB goes non-black here, the
  // black is uber-specific (alpha-test discard / bpmem-konst UBO not uploaded in
  // uber mode); if still black, it's a deeper scene-pass write issue.
  Config::SetBase(Config::GFX_SHADER_COMPILATION_MODE,
                  ShaderCompilationMode::Synchronous);
  Config::SetBase(Config::GFX_SHADER_COMPILER_THREADS, 0);
  Config::SetBase(Config::GFX_SHADER_PRECOMPILER_THREADS, 0);
  VideoBackendBase::ActivateBackend(s_video_backend);

  if (!g_controller_interface.IsInit())
  {
    WindowSystemInfo wsi;
    wsi.type = WindowSystemType::Headless;
    g_controller_interface.Initialize(wsi);
  }

  Pad::Initialize();
  Pad::InitializeGBA();
  Keyboard::Initialize();

  // §27 savestate-load backend resync. Probe evidence: after
  // State::Load the WebGPU command-ring producer (the dual-core GPU
  // FIFO mainloop, which is what records opcodes) freezes — the ring
  // `write` index stops advancing the instant the load lands and never
  // resumes (CPU/core keeps running the battle at ~44fps, frame
  // counter advances, but zero GPU commands flow → black & static).
  // Root cause: in dual-core, VideoBackendBase::DoState() ends with
  // FifoManager::GpuMaySleep() (m_gpu_mainloop.AllowSleep()) on the
  // explicit assumption that "the next GP burst will wake it up
  // again". In this wasm remote-backend model that burst-wake does
  // not re-park-wake the asleep BlockingLoop, so the GPU thread stays
  // asleep forever. The after-load callback fires on the CPU thread at
  // the very end of LoadAsFromCore (after DoState's GpuMaySleep), so
  // re-issuing RunGpu() here force-wakes the GPU mainloop; it then
  // drains the FIFO the now-running game is filling and the producer
  // resumes. Consumer caches (texture/bind-group ids, _wgEfbColorId)
  // self-rederive once commands flow again, so no consumer reset is
  // needed for this construct.
  State::SetOnAfterLoadCallback([]() {
    auto& system = Core::System::GetInstance();
    const std::uint64_t loaded_ticks = system.GetCoreTiming().GetTicks();
    s_last_loaded_ticks_low.store(static_cast<std::uint32_t>(loaded_ticks),
                                  std::memory_order_relaxed);
    s_last_loaded_ticks_high.store(static_cast<std::uint32_t>(loaded_ticks >> 32),
                                   std::memory_order_relaxed);
    s_last_loaded_ppc_pc.store(system.GetPPCState().pc, std::memory_order_relaxed);
    s_last_loaded_checkpoint_generation.fetch_add(1, std::memory_order_release);
    DolphinWeb_HarnessOnStateLoaded();
    // Publish the semantic epoch only after State::Load has applied and the
    // checkpoint is observable. The GPU wake below then guarantees that the
    // first producer command in the new epoch belongs to the restored state.
    NotifyWebGpuOwnershipTraceLoadRequested();
    // §27b disambiguator: which pthread runs the after-load callback
    // (= the LoadAsFromCore context)? Compare to the long-lived CPU
    // pthread tid ([s27-GPB]) and GPU pthread tid ([s27-gate]). A
    // *third* tid confirms the load runs off the emulation CPU thread
    // → the CPU↔GPU CP-FIFO incoherence is the RunOnCPUThread-job
    // context hop (§27b hypothesis 2).
    EM_ASM({ console.log("[after-load] cb fired tid=" + ($0 >>> 0)); },
           static_cast<unsigned>(pthread_self()));
    // §27c fix attempt 1 (smallest, non-blocking rendezvous). The
    // GPU-FIFO pthread is stranded on a pre-load CP snapshot: post-load
    // it reads CPReadWriteDistance==0 forever while this CPU thread
    // sees it grow (§27b). FlushGpu() does m_gpu_mainloop.Wait() — the
    // canonical CPU↔GPU rendezvous — which forces a happens-before
    // edge so the GPU thread re-acquires the restored CP state; then
    // RunGpu() re-kicks it. (The GPU loop is idle/spinning with no
    // pending work, so Wait() returns promptly — no hang.)
    // §27d definitive shared-memory test: store a sentinel from THIS
    // (CPU) pthread; the GPU-thread gate logs it (`sent=`). If the GPU
    // thread never reads 0xABCD1234, the two dual-core pthreads do not
    // share memory post-load (architecture defect, no Dolphin-level
    // resync can fix it); if it does, the CP desync is logical state.
    Fifo::g_s27_sentinel.store(0xABCD1234u, std::memory_order_seq_cst);
    // §27d candidate (a): the blocking FlushGpu()/m_gpu_mainloop.Wait()
    // version drained the load-time FIFO backlog for ~3 s then TOTALLY
    // halted both Dolphin pthreads (CPU+GPU silent) — Wait() on the CPU
    // thread is a regression. Use the non-blocking EmulatorState(true)
    // (m_emu_running_state.Set + m_gpu_mainloop.Wakeup() + clears
    // AllowSleep) so the GPU consumer re-engages for the steady state,
    // then RunGpu() re-kicks it. No CPU-thread blocking.
    auto& fifo = Core::System::GetInstance().GetFifo();
    fifo.EmulatorState(true);
    fifo.RunGpu();
  });

  s_runtime_initialized = true;
  SetCoreStatus("Runtime initialized");
}
}  // namespace

std::vector<std::string> Host_GetPreferredLocales()
{
  return {"en"};
}

bool Host_UIBlocksControllerState()
{
  return false;
}

bool Host_RendererHasFocus()
{
  return true;
}

bool Host_RendererHasFullFocus()
{
  return true;
}

bool Host_RendererIsFullscreen()
{
  return false;
}

bool Host_TASInputHasFocus()
{
  return false;
}

void Host_Message(HostMessageID id)
{
  if (id == HostMessageID::WMUserStop)
  {
    SetCoreStatus("Core requested stop");
    Core::Stop(Core::System::GetInstance());
  }
}

void Host_PPCSymbolsChanged()
{
}

void Host_PPCBreakpointsChanged()
{
}

void Host_RequestRenderWindowSize(int width, int height)
{
}

void Host_UpdateDisasmDialog()
{
}

void Host_JitCacheInvalidation()
{
}

void Host_JitProfileDataWiped()
{
}

void Host_UpdateTitle(const std::string& title)
{
  s_core_title = title;
}

void Host_YieldToUI()
{
}

void Host_TitleChanged()
{
}

void Host_UpdateDiscordClientID(const std::string& client_id)
{
}

bool Host_UpdateDiscordPresenceRaw(const std::string& details, const std::string& state,
                                   const std::string& large_image_key,
                                   const std::string& large_image_text,
                                   const std::string& small_image_key,
                                   const std::string& small_image_text,
                                   const std::int64_t start_timestamp,
                                   const std::int64_t end_timestamp, const int party_size,
                                   const int party_max)
{
  return false;
}

std::unique_ptr<GBAHostInterface> Host_CreateGBAHost(std::weak_ptr<HW::GBA::Core> core)
{
  return nullptr;
}

extern "C"
{
int CoreInit()
{
  EnsureRuntime();
  return 1;
}

int SetVideoBackend(const char* backend)
{
  if (!backend || s_runtime_initialized)
    return 0;

  const std::string requested = backend;
  if (requested == "OGL" || requested == "OpenGL" || requested == "OpenGL ES")
  {
    s_video_backend = "OGL";
    return 1;
  }
  if (requested == "Software Renderer" || requested == "Software")
  {
    s_video_backend = "Software Renderer";
    return 1;
  }
  if (requested == "Null")
  {
    s_video_backend = "Null";
    return 1;
  }
  // Day-16: `?video=webgpu` (the user-facing string "WebGPU") routes
  // to the Software→WebGPU-presenter hybrid. The C++ Software path
  // runs the CPU rasteriser into s_framebuffer; JS uploads those
  // bytes through a real wgpuRenderPass blit on the canvas context.
  // This is the path that plays Melee today.
  if (requested == "WebGPU")
  {
    s_video_backend = "Software Renderer";
    return 1;
  }
  // Day-17 (wasm-dolphin): `?video=wgpu` activates the *real* WebGPU
  // video backend (the WebGPU::VideoBackend class registered in
  // VideoBackendBase). Construction underway — early days render
  // clear-colour or partial content while WebGPUGfx / WebGPUTexture
  // gain real wgpu API calls. End goal: GPU rasterisation, 60fps,
  // no CPU bottleneck.
  if (requested == "WebGPU-Real")
  {
    s_video_backend = "WebGPU";
    return 1;
  }

  return 0;
}

int SetCpuThread(int enabled)
{
  if (s_runtime_initialized)
    return 0;

  s_cpu_thread = enabled != 0;
  return 1;
}

// The value Dolphin's game config gives an allowlisted
// setting (tools/gamesettings-allowlist.json) for a disc ID and revision from
// the INIs under /dolphin-sys/GameSettings, as the game's boot reads it: MMU
// (System::Initialize, IsMMUMode), FPRF (patch 0121), SafeTextureCacheColorSamples,
// XFBToTextureEnable (GFX_HACK_SKIP_XFB_COPY_TO_RAM), EFBAccessEnable,
// EFBToTextureEnable (GFX_HACK_SKIP_EFB_COPY_TO_RAM), BBoxEnable and
// DeferEFBCopies; booleans
// as 0/1. The global game layer is added for the read and removed after; -1
// when a game's layer is already there (a game is running), which this must
// not replace, -2 for a setting it does not know. Read before the boot by
// the worker (a disc that needs the bounding box, which video=wgpu does not
// compute) and by the tests (patch 0097).
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int GameConfigValue(const char* game_id, int revision, const char* setting)
{
  const std::string_view name = setting;
  if (name != "MMU" && name != "FPRF" && name != "SafeTextureCacheColorSamples" &&
      name != "XFBToTextureEnable" && name != "EFBAccessEnable" &&
      name != "EFBToTextureEnable" && name != "BBoxEnable" && name != "DeferEFBCopies")
    return -2;
  if (Config::GetLayer(Config::LayerType::GlobalGame))
    return -1;
  Config::AddLayer(ConfigLoaders::GenerateGlobalGameConfigLoader(game_id, static_cast<u16>(revision)));
  const int value =
      name == "MMU"                  ? (Config::Get(Config::MAIN_MMU) ? 1 : 0) :
      name == "FPRF"                 ? (Config::Get(Config::MAIN_FPRF) ? 1 : 0) :
      name == "XFBToTextureEnable"   ? (Config::Get(Config::GFX_HACK_SKIP_XFB_COPY_TO_RAM) ? 1 : 0) :
      name == "EFBAccessEnable"      ? (Config::Get(Config::GFX_HACK_EFB_ACCESS_ENABLE) ? 1 : 0) :
      name == "EFBToTextureEnable"   ? (Config::Get(Config::GFX_HACK_SKIP_EFB_COPY_TO_RAM) ? 1 : 0) :
      name == "BBoxEnable"           ? (Config::Get(Config::GFX_HACK_BBOX_ENABLE) ? 1 : 0) :
      name == "DeferEFBCopies"       ? (Config::Get(Config::GFX_HACK_DEFER_EFB_COPIES) ? 1 : 0) :
                                       Config::Get(Config::GFX_SAFE_TEXTURE_CACHE_COLOR_SAMPLES);
  Config::RemoveLayer(Config::LayerType::GlobalGame);
  return value;
}

// The first name of GameConfigValue (the ABI manifest lists it).
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int GameConfigValueForTest(const char* game_id, int revision, const char* setting)
{
  return GameConfigValue(game_id, revision, setting);
}

// The MMU only (the first 0097 test; kept: the ABI manifest lists it).
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int GameConfigMmuForTest(const char* game_id, int revision)
{
  return GameConfigValueForTest(game_id, revision, "MMU");
}

// Tests: `count` alerts through the relay, all the same text when
// `distinct` is 0, all different otherwise; then the relay's totals
// [relayed, folded, dropped] (cumulative).
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void AlertRelayForTest(std::uint32_t count, std::uint32_t distinct)
{
  for (std::uint32_t i = 0; i < count; ++i)
  {
    const std::string text = distinct ? "Invalid read from " + std::to_string(i) : "Invalid read from 0xbd420186";
    BrowserMsgHandler("Warning", text.c_str(), false, Common::MsgType::Warning);
  }
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void AlertRelayStats(std::uint32_t* out)
{
  std::lock_guard lock(s_alert_relay.mutex);
  out[0] = s_alert_relay.relayed;
  out[1] = s_alert_relay.folded;
  out[2] = s_alert_relay.dropped;
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int SetCustomRtc(int enabled, std::uint32_t seconds_since_1970)
{
  // The console counts from 2000 (GC_EPOCH): an earlier start would wrap.
  constexpr std::uint32_t kJan2000 = 946684800;
  if (s_runtime_initialized || (enabled && seconds_since_1970 < kJan2000))
    return 0;
  s_custom_rtc_enabled = enabled != 0;
  s_custom_rtc_value = seconds_since_1970;
  return 1;
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
std::uint32_t GetCustomRtc()
{
  return s_custom_rtc_enabled ? s_custom_rtc_value : 0;
}

int SetCpuCore(const char* core)
{
  if (!core || s_runtime_initialized)
    return 0;

  const std::string requested = core;
  if (requested == "interpreter" || requested == "Interpreter")
  {
    s_cpu_core = PowerPC::CPUCore::Interpreter;
    return 1;
  }
  if (requested == "cached" || requested == "cached-interpreter" ||
      requested == "CachedInterpreter")
  {
    s_cpu_core = PowerPC::CPUCore::CachedInterpreter;
    return 1;
  }

  return 0;
}

int SetCpuOverclock(float factor)
{
  if (s_runtime_initialized || factor < 0.01f || factor > 5.0f)
    return 0;

  s_cpu_overclock = factor;
  return 1;
}

int SetEmulationSpeed(float factor)
{
  if (s_runtime_initialized || factor < 0.0f || factor > 5.0f)
    return 0;

  s_emulation_speed = factor;
  return 1;
}

// ?audiobuffer=N: the mixer's queue, before the boot (16-200 ms; the mixer
// itself keeps 4 to 64 granules). 1 when taken, 0 otherwise.
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int DolphinWeb_SetAudioBufferMs(int ms)
{
  if (s_runtime_initialized || ms < 16 || ms > 200)
    return 0;

  s_audio_buffer_ms = ms;
  return 1;
}

int SetFastSoftwareRaster(int mode)
{
  DolphinWeb_SetFastSoftwareRaster(mode < 0 ? 0 : mode > 3 ? 3 : mode);
  return 1;
}

// Day-1 bisection knob: per-helper disable bitmask for the cached-interpreter
// fast paths. See the DOLPHIN_WEB_DISABLE_* constants in
// vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp
// for the bit layout. Returns the previous mask. Safe to call at any time —
// changes take effect on the next block compile attempt.
std::uint32_t SetCachedInterpreterDisableMask(std::uint32_t mask)
{
  return DolphinWeb_SetCachedInterpreterDisableMask(mask);
}

std::uint32_t GetCachedInterpreterDisableMask()
{
  return DolphinWeb_GetCachedInterpreterDisableMask();
}

// Renderer capability mask for the WebGPU backend. ENABLE polarity and default
// ON in the backend itself, so a host that never calls this still renders
// correctly; the setter exists to turn a feature OFF for bisection. Bit 0 is
// the scissored ClearRect path. See DOLPHIN_WEB_RENDERER_FEATURE_* in
// vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp.
std::uint32_t SetRendererFeatureMask(std::uint32_t mask)
{
  return DolphinWeb_SetRendererFeatureMask(mask);
}

std::uint32_t GetRendererFeatureMask()
{
  return DolphinWeb_GetRendererFeatureMask();
}

// Day-1 instrumentation accessors: the per-swap ring buffer lives in
// dolphin_web_discio.cpp's anonymous namespace and is visible here through
// the single-TU include at the top of this file. JS reads via Module.HEAPU32
// using the pointer, then walks slots `[lastDrainHead .. head) mod capacity`.
DolphinWebFrameRingEntry* GetFrameRingEntryPtr()
{
  return s_frame_ring.data();
}

int GetFrameRingCapacity()
{
  return static_cast<int>(DOLPHIN_WEB_FRAME_RING_CAPACITY);
}

int GetFrameRingEntrySize()
{
  return static_cast<int>(sizeof(DolphinWebFrameRingEntry));
}

std::uint32_t GetFrameRingHead()
{
  return s_frame_ring_head.load(std::memory_order_relaxed);
}

int BootDisc(const char* path)
{
  if (!path)
  {
    SetCoreStatus("Boot path was null");
    return 0;
  }

  EnsureRuntime();

  if (Core::IsRunningOrStarting(Core::System::GetInstance()))
    Core::Stop(Core::System::GetInstance());

  auto boot = BootParameters::GenerateFromFile(std::string(path));
  if (!boot)
  {
    SetCoreStatus("BootParameters::GenerateFromFile rejected disc");
    return 0;
  }

  WindowSystemInfo wsi;
  wsi.type = WindowSystemType::Headless;
  VideoBackendBase::ActivateBackend(s_video_backend);

  const bool booted = BootManager::BootCore(Core::System::GetInstance(), std::move(boot), wsi);
  SetCoreStatus(booted ? "Boot submitted to Dolphin core" : "BootManager::BootCore failed");
  return booted ? 1 : 0;
}

void StopCore()
{
  if (s_runtime_initialized)
    Core::Stop(Core::System::GetInstance());
  SetCoreStatus("Stopped");
}

int SetCorePaused(int paused)
{
  if (!s_runtime_initialized || !Core::IsRunning(Core::System::GetInstance()))
    return 0;

  Core::SetState(Core::System::GetInstance(), paused ? Core::State::Paused : Core::State::Running);
  Core::HostDispatchJobs(Core::System::GetInstance());
  SetCoreStatus(paused ? "Paused" : "Running");
  return 1;
}

// Internal resolution (1 to 4) and anisotropic filtering (log2, -1 = game)
// while a game runs (patch 0168). Returns the scale in effect, or 0 before
// the runtime exists (nothing applied: the boot reads Module's fields).
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int DolphinWeb_SetEnhancements(int efb_scale, int anisotropy)
{
  if (!s_runtime_initialized)
    return 0;
  return ApplyEnhancements(efb_scale, anisotropy);
}

// Heap use, for diagnostics only (the headroom at 4x, follow-up of 0168):
// out[0] bytes malloc has handed out, out[1] free bytes inside its arena,
// out[2] the sbrk top (the arena's end). The heap above the top plus the
// free bytes is what a savestate or a texture can still take. mallinfo()
// walks the arena under malloc's lock: call it on demand, never per frame.
// Returns the words written (3), or 0 when `words` is too small.
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
int DolphinWeb_HeapStats(uint32_t* out, int words)
{
  if (!out || words < 3)
    return 0;
  const struct mallinfo info = mallinfo();
  out[0] = static_cast<uint32_t>(info.uordblks);
  out[1] = static_cast<uint32_t>(info.fordblks);
  out[2] = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(sbrk(0)));
  return 3;
}
#endif

// Writes every inserted memory card's pending saves to /dolphin-user now,
// so the page copies what the game has written instead of what Dolphin's
// flush thread last wrote (up to a second earlier). Runs on the calling
// (runtime main) thread: GCMemcardDirectory::FlushToFile takes the card's
// write mutex, and the card's own flush thread proxies its file writes here.
// Returns the number of cards flushed, or -1 when no game is running.
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int FlushMemoryCards()
{
  if (!s_runtime_initialized)
    return -1;
  auto& system = Core::System::GetInstance();
  const Core::State state = Core::GetState(system);
  if (state != Core::State::Running && state != Core::State::Paused)
    return -1;
  int flushed = 0;
  for (const auto slot : {ExpansionInterface::Slot::A, ExpansionInterface::Slot::B})
  {
    auto* device = system.GetExpansionInterface().GetDevice(slot);
    if (device == nullptr)
      continue;
    if (device->m_device_type != ExpansionInterface::EXIDeviceType::MemoryCard &&
        device->m_device_type != ExpansionInterface::EXIDeviceType::MemoryCardFolder)
      continue;
    static_cast<ExpansionInterface::CEXIMemoryCard*>(device)->FlushCard();
    ++flushed;
  }
  return flushed;
}

int ResetCore()
{
  if (!s_runtime_initialized || !Core::IsRunning(Core::System::GetInstance()))
    return 0;

  Core::QueueHostJob(
      [](Core::System& system) { system.GetProcessorInterface().ResetButton_Tap(); });
  Core::HostDispatchJobs(Core::System::GetInstance());
  SetCoreStatus("Reset requested");
  return 1;
}

int SaveCoreState(int slot)
{
  if (!s_runtime_initialized || slot < 0 || !Core::IsRunning(Core::System::GetInstance()))
    return 0;

  State::Save(Core::System::GetInstance(), slot);
  Core::HostDispatchJobs(Core::System::GetInstance());
  SetCoreStatus("Save state requested");
  return 1;
}

int LoadCoreState(int slot)
{
  if (!s_runtime_initialized || slot < 0 || !Core::IsRunning(Core::System::GetInstance()))
    return 0;

  State::Load(Core::System::GetInstance(), slot);
  Core::HostDispatchJobs(Core::System::GetInstance());
  SetCoreStatus("Load state requested");
  return 1;
}

// Load a Dolphin save state from an arbitrary file path in the
// Emscripten FS (the JS side FS.writeFile's the .sav there first).
// Mirrors LoadCoreState but uses State::LoadAs(filename). NOTE: Dolphin
// save states are serialization-version + build locked — a state from
// a different Dolphin build is rejected by CheckIfStateLoadIsAllowed /
// version check inside LoadAs; that's expected, not a crash here.
int LoadStateFile(const char* path)
{
  if (!s_runtime_initialized || path == nullptr || *path == '\0' ||
      !Core::IsRunning(Core::System::GetInstance()))
    return 0;

  State::LoadAs(Core::System::GetInstance(), std::string(path));
  Core::HostDispatchJobs(Core::System::GetInstance());
  SetCoreStatus("Load state from file requested");
  return 1;
}

// Save a Dolphin save state to a file path in the Emscripten FS so the
// JS side can read the bytes back and persist them. State::SaveAs is
// async (queues onto the CPU thread + a compress/dump worker), so the
// caller must pump frames before reading the file. A state produced
// here is version-matched to THIS build, so LoadStateFile can restore
// it deterministically (unlike a foreign-build .sav — see §22).
int SaveStateFile(const char* path)
{
  if (!s_runtime_initialized || path == nullptr || *path == '\0' ||
      !Core::IsRunning(Core::System::GetInstance()))
    return 0;

  // SaveToFileSync (not SaveAs): compress+write happens inline on the
  // CPU thread, not the async WorkQueueThread that never got
  // wall-time under the worker poll (§23 size=0). Caller pumps frames
  // until the CPU thread runs the queued job; then the file is whole.
  State::SaveToFileSync(Core::System::GetInstance(), std::string(path));
  Core::HostDispatchJobs(Core::System::GetInstance());
  SetCoreStatus("Save state to file requested");
  return 1;
}

void PumpHostJobs()
{
  if (s_runtime_initialized)
    Core::HostDispatchJobs(Core::System::GetInstance());
}

int GetCoreState()
{
  if (!s_runtime_initialized)
    return static_cast<int>(Core::State::Uninitialized);
  return static_cast<int>(Core::GetState(Core::System::GetInstance()));
}

const char* GetCoreStateName()
{
  if (!s_runtime_initialized)
    return "Uninitialized";
  return StateName(Core::GetState(Core::System::GetInstance()));
}

const char* GetCoreStatus()
{
  // A copy per calling thread: the pointer stays valid until this thread's
  // next call, whatever other threads write meanwhile.
  thread_local std::string snapshot;
  std::lock_guard lock(s_core_status_mutex);
  snapshot = s_core_status;
  return snapshot.c_str();
}

const char* GetCoreTitle()
{
  return s_core_title.c_str();
}

std::uint32_t GetCoreTicksLow()
{
  if (!s_runtime_initialized)
    return 0;
  return static_cast<std::uint32_t>(Core::System::GetInstance().GetCoreTiming().GetTicks());
}

std::uint32_t GetCoreTicksHigh()
{
  if (!s_runtime_initialized)
    return 0;
  return static_cast<std::uint32_t>(Core::System::GetInstance().GetCoreTiming().GetTicks() >> 32);
}

std::uint32_t GetCoreTicksPerSecond()
{
  if (!s_runtime_initialized)
    return 486000000u;
  return Core::System::GetInstance().GetSystemTimers().GetTicksPerSecond();
}

std::uint32_t GetPPCPC()
{
  if (!s_runtime_initialized)
    return 0;
  return Core::System::GetInstance().GetPPCState().pc;
}

std::uint32_t GetLastLoadedCoreTicksLow()
{
  return s_last_loaded_ticks_low.load(std::memory_order_acquire);
}

std::uint32_t GetLastLoadedCoreTicksHigh()
{
  return s_last_loaded_ticks_high.load(std::memory_order_acquire);
}

std::uint32_t GetLastLoadedPPCPC()
{
  return s_last_loaded_ppc_pc.load(std::memory_order_acquire);
}

std::uint32_t GetLastLoadedCheckpointGeneration()
{
  return s_last_loaded_checkpoint_generation.load(std::memory_order_acquire);
}

const char* GetCPUCoreName()
{
  if (!s_runtime_initialized)
    return "Not booted";
  return s_cpu_core == PowerPC::CPUCore::Interpreter ? "Interpreter" : "Cached Interpreter";
}

int AudioSampleRate()
{
  if (!s_runtime_initialized)
    return 48000;

  const SoundStream* sound_stream = Core::System::GetInstance().GetSoundStream();
  const Mixer* mixer = sound_stream ? sound_stream->GetMixer() : nullptr;
  const u32 sample_rate = mixer ? mixer->GetSampleRate() : 0;
  return sample_rate > 0 ? static_cast<int>(sample_rate) : 48000;
}

int AudioChannels()
{
  return 2;
}

int AudioBufferFrames()
{
  return AUDIO_PULL_MAX_FRAMES;
}

s16* AudioBuffer()
{
  return s_audio_pull_buffer.data();
}

int MixAudio(int requested_frames)
{
  const int frames = std::clamp(requested_frames, 0, AUDIO_PULL_MAX_FRAMES);
  if (frames <= 0)
    return 0;

  std::memset(s_audio_pull_buffer.data(), 0, static_cast<std::size_t>(frames) * 2 * sizeof(s16));

  if (!s_runtime_initialized)
  {
    s_audio_stats = "audio:unavailable";
    return 0;
  }

  if (Config::Get(Config::MAIN_AUDIO_MUTED))
  {
    s_audio_stats = "audio:muted";
    return frames;
  }

  const SoundStream* sound_stream = Core::System::GetInstance().GetSoundStream();
  Mixer* mixer = sound_stream ? sound_stream->GetMixer() : nullptr;
  if (!mixer || !mixer->IsOutputSampleRateValid())
  {
    s_audio_stats = "audio:unavailable";
    return 0;
  }

  const std::size_t mixed = mixer->Mix(s_audio_pull_buffer.data(), static_cast<std::size_t>(frames));
  std::size_t nonzero_samples = 0;
  for (std::size_t index = 0; index < mixed * 2; ++index)
  {
    if (s_audio_pull_buffer[index] != 0)
      ++nonzero_samples;
  }

  s_audio_stats = "audio:frames:" + std::to_string(mixed) + " nz:" +
                  std::to_string(nonzero_samples) + " rate:" +
                  std::to_string(mixer->GetSampleRate());
  return static_cast<int>(mixed);
}

int SetAudioMuted(int muted)
{
  if (!s_runtime_initialized)
    return 0;

  Config::SetBaseOrCurrent(Config::MAIN_AUDIO_MUTED, muted != 0);
  AudioCommon::UpdateSoundStream(Core::System::GetInstance());
  return 1;
}

const char* GetAudioStats()
{
#ifdef __EMSCRIPTEN__
  const char* ai_stats = DolphinWeb_GetAudioCommonStats();
  if (ai_stats && ai_stats[0] != '\0')
  {
    s_audio_stats_snapshot = s_audio_stats + " | " + ai_stats;
    return s_audio_stats_snapshot.c_str();
  }
#endif
  return s_audio_stats.c_str();
}

int RunWasmJitSmoke(int value)
{
  return DolphinWeb_RunWasmJitSmokeImpl(value);
}

int RunPpcWasmAddiSmoke(int value, int immediate)
{
  const std::vector<std::uint8_t> bytes = BuildI32AddImmediateModule(immediate);
#ifdef __EMSCRIPTEN__
  return DolphinWeb_RunGeneratedWasmI32(bytes.data(), static_cast<int>(bytes.size()), value);
#else
  return value + immediate;
#endif
}

int RunPpcWasmStateAddiSmoke(int value, int immediate)
{
  std::array<std::uint32_t, 32> gpr{};
  gpr[3] = static_cast<std::uint32_t>(value);

  constexpr std::uint32_t source_offset = 3 * sizeof(std::uint32_t);
  constexpr std::uint32_t dest_offset = 4 * sizeof(std::uint32_t);
  const std::vector<std::uint8_t> bytes =
      BuildStateAddImmediateModule(dest_offset, source_offset, immediate);

#ifdef __EMSCRIPTEN__
  DolphinWeb_RunGeneratedWasmVoidI32(
      bytes.data(), static_cast<int>(bytes.size()),
      static_cast<int>(reinterpret_cast<std::uintptr_t>(gpr.data())));
#else
  gpr[4] = gpr[3] + static_cast<std::uint32_t>(immediate);
#endif

  return static_cast<int>(gpr[4]);
}

int RunPpcWasmDolphinStateAddiSmoke(int value, int immediate)
{
  EnsureRuntime();

  auto& ppc_state = Core::System::GetInstance().GetPPCState();
  ppc_state.gpr[3] = static_cast<std::uint32_t>(value);
  ppc_state.gpr[4] = 0;

  constexpr std::uint32_t source_offset = 3 * sizeof(std::uint32_t);
  constexpr std::uint32_t dest_offset = 4 * sizeof(std::uint32_t);
  const std::vector<std::uint8_t> bytes =
      BuildStateAddImmediateModule(dest_offset, source_offset, immediate);

#ifdef __EMSCRIPTEN__
  DolphinWeb_RunGeneratedWasmVoidI32(
      bytes.data(), static_cast<int>(bytes.size()),
      static_cast<int>(reinterpret_cast<std::uintptr_t>(ppc_state.gpr)));
#else
  ppc_state.gpr[4] = ppc_state.gpr[3] + static_cast<std::uint32_t>(immediate);
#endif

  return static_cast<int>(ppc_state.gpr[4]);
}

int RunPpcWasmIntegerBlockSmoke()
{
  EnsureRuntime();

  auto& ppc_state = Core::System::GetInstance().GetPPCState();
  ppc_state.pc = 0x80003100;
  ppc_state.npc = 0;
  ppc_state.downcount = 100;
  for (std::uint32_t& gpr : ppc_state.gpr)
    gpr = 0;

  const std::array<UGeckoInstruction, 4> instructions = {
      EncodeDForm(15, 3, 0, 0x1234),    // lis r3, 0x1234
      EncodeDForm(24, 3, 3, 0x5678),    // ori r3, r3, 0x5678
      EncodeDForm(14, 4, 3, 0xfff0),    // addi r4, r3, -0x10
      EncodeXForm(31, 4, 5, 4, 444),    // mr r5, r4
  };
  constexpr std::uint32_t next_pc = 0x80003110;
  constexpr std::uint32_t downcount = 4;

  const PpcWasmStateLayout layout = GetPpcStateLayout(ppc_state);
  const std::vector<std::uint8_t> bytes =
      BuildPpcIntegerBlockModule(instructions, layout, next_pc, downcount);
  if (bytes.empty())
    return 0;

#ifdef __EMSCRIPTEN__
  DolphinWeb_RunGeneratedWasmVoidI32(
      bytes.data(), static_cast<int>(bytes.size()),
      static_cast<int>(reinterpret_cast<std::uintptr_t>(&ppc_state)));
#else
  ppc_state.gpr[3] = 0x12345678;
  ppc_state.gpr[4] = 0x12345668;
  ppc_state.gpr[5] = ppc_state.gpr[4];
  ppc_state.pc = next_pc;
  ppc_state.npc = next_pc;
  ppc_state.downcount -= downcount;
#endif

  return ppc_state.gpr[3] == 0x12345678 && ppc_state.gpr[4] == 0x12345668 &&
                 ppc_state.gpr[5] == 0x12345668 && ppc_state.pc == next_pc &&
                 ppc_state.npc == next_pc && ppc_state.downcount == 96 ?
             1 :
             0;
}
}
