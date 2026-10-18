// Copyright 2026
// SPDX-License-Identifier: GPL-2.0-or-later

#include <array>
#include <algorithm>
#include <climits>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "DiscIO/DiscExtractor.h"
#include "DiscIO/DiscUtils.h"
#include "DiscIO/Enums.h"
#include "DiscIO/Filesystem.h"
#include "DiscIO/Volume.h"
#include "DiscIO/VolumeDisc.h"
#include "Core/CoreTiming.h"
#include "Core/HW/ProcessorInterface.h"
#include "Core/HW/VideoInterface.h"
#include "Core/System.h"
#include "InputCommon/GCPadStatus.h"
#include "VideoCommon/CommandProcessor.h"
#include "VideoCommon/Fifo.h"
#include "VideoCommon/PixelEngine.h"
#include "VideoCommon/WasmGpuSyncDiag.h"
#include "VideoCommon/TextureDecoder.h"
#include "VideoCommon/Statistics.h"

#include "dolphin_web_xfb_fastpaths.h"
#include "dolphin_web_pad_latch.h"
#include "dolphin_web_raster_profile.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/atomic.h>
#include <emscripten/em_asm.h>
#include <emscripten/emscripten.h>
#endif

#ifdef __EMSCRIPTEN__
extern "C" int DolphinWeb_FastSoftwareRaster();
#else
static int DolphinWeb_FastSoftwareRaster()
{
  return 0;
}
#endif

namespace
{
using WebProfileClock = std::chrono::steady_clock;

constexpr int METADATA_FRAME_WIDTH = 320;
constexpr int METADATA_FRAME_HEIGHT = 240;
constexpr int MAX_XFB_WIDTH = 720;
constexpr int MAX_XFB_HEIGHT = 576;

constexpr std::uint32_t INPUT_A = 1u << 0;
constexpr std::uint32_t INPUT_B = 1u << 1;
constexpr std::uint32_t INPUT_X = 1u << 2;
constexpr std::uint32_t INPUT_Y = 1u << 3;
constexpr std::uint32_t INPUT_START = 1u << 4;
constexpr std::uint32_t INPUT_L = 1u << 5;
constexpr std::uint32_t INPUT_R = 1u << 6;
constexpr std::uint32_t INPUT_Z = 1u << 7;
constexpr std::uint32_t INPUT_D_UP = 1u << 8;
constexpr std::uint32_t INPUT_D_DOWN = 1u << 9;
constexpr std::uint32_t INPUT_D_LEFT = 1u << 10;
constexpr std::uint32_t INPUT_D_RIGHT = 1u << 11;
constexpr std::uint32_t INPUT_STICK_UP = 1u << 12;
constexpr std::uint32_t INPUT_STICK_DOWN = 1u << 13;
constexpr std::uint32_t INPUT_STICK_LEFT = 1u << 14;
constexpr std::uint32_t INPUT_STICK_RIGHT = 1u << 15;
constexpr std::uint32_t INPUT_C_STICK_UP = 1u << 16;
constexpr std::uint32_t INPUT_C_STICK_DOWN = 1u << 17;
constexpr std::uint32_t INPUT_C_STICK_LEFT = 1u << 18;
constexpr std::uint32_t INPUT_C_STICK_RIGHT = 1u << 19;

struct RootEntry
{
  std::string name;
  std::string path;
  double offset;
  double size;
  int is_directory;
};

std::unique_ptr<DiscIO::VolumeDisc> s_disc;
std::string s_game_id;
std::string s_game_title;
std::string s_maker_id;
std::string s_platform;
std::string s_region;
std::string s_apploader_date;
double s_apploader_size = -1.0;
double s_boot_dol_offset = -1.0;
double s_boot_dol_size = -1.0;
double s_fst_offset = -1.0;
double s_fst_size = -1.0;
double s_raw_size = -1.0;
double s_data_size = -1.0;
int s_root_entry_count = -1;
std::vector<RootEntry> s_root_entries;
std::array<std::uint32_t, MAX_XFB_WIDTH * MAX_XFB_HEIGHT> s_framebuffer{};
int s_frame_width = METADATA_FRAME_WIDTH;
int s_frame_height = METADATA_FRAME_HEIGHT;
std::uint32_t s_frame = 0;

struct InputStateSnapshot
{
  std::uint32_t mask = 0;
  std::uint32_t generation = 0;
  std::uint8_t stick_x = GCPadStatus::MAIN_STICK_CENTER_X;
  std::uint8_t stick_y = GCPadStatus::MAIN_STICK_CENTER_Y;
  std::uint8_t c_stick_x = GCPadStatus::C_STICK_CENTER_X;
  std::uint8_t c_stick_y = GCPadStatus::C_STICK_CENTER_Y;
  std::uint8_t trigger_left = 0;
  std::uint8_t trigger_right = 0;
  std::uint8_t analog_a = 0;
  std::uint8_t analog_b = 0;
};

struct PadPollSnapshot
{
  std::uint32_t poll_count = 0;
  std::uint32_t input_mask = 0;
  std::uint32_t input_generation = 0;
  std::uint16_t button_mask = 0;
  std::uint8_t stick_x = GCPadStatus::MAIN_STICK_CENTER_X;
  std::uint8_t stick_y = GCPadStatus::MAIN_STICK_CENTER_Y;
};

// One snapshot and one connection flag per GameCube port. Port 1 (index 0)
// starts connected: the keyboard drives it by default. A disconnected port
// answers "no controller" to the SI poll, so a game never sees a phantom pad.
constexpr int PAD_PORT_COUNT = 4;
std::mutex s_input_state_mutex;
std::array<InputStateSnapshot, PAD_PORT_COUNT> s_input_states{};
std::array<bool, PAD_PORT_COUNT> s_pad_connected{true, false, false, false};
struct PadPoll
{
  InputStateSnapshot input;
  bool connected = false;
};
// Guarded by s_input_state_mutex. See dolphin_web_pad_latch.h.
std::array<DolphinWeb::PadLatch<PadPoll>, PAD_PORT_COUNT> s_pad_latches{};
std::mutex s_pad_poll_mutex;
PadPollSnapshot s_pad_poll;
bool s_using_xfb_frame = false;
std::string s_video_stats = "xfb:0";
float s_presentation_scale = 0.5f;
std::uint32_t s_frame_signal = 0;
std::atomic<std::uint32_t> s_input_update_count{0};
WebProfileClock::time_point s_last_xfb_profile_time{};
std::uint64_t s_last_xfb_interval_us = 0;
std::uint64_t s_total_xfb_interval_us = 0;
std::uint64_t s_max_xfb_interval_us = 0;
std::uint64_t s_xfb_interval_count = 0;
std::uint64_t s_last_xfb_decode_us = 0;
std::uint64_t s_total_xfb_decode_us = 0;
std::uint64_t s_max_xfb_decode_us = 0;
std::uint64_t s_xfb_decode_count = 0;
std::atomic<std::uint32_t> s_last_video_sync_us{0};
std::atomic<std::uint32_t> s_last_video_publish_us{0};
std::atomic<std::uint32_t> s_last_video_total_us{0};
// §28cs lifetime max — the avg in the HUD masks the 41-47ms spikes the
// §28cn-cr investigation chain identified. Need max to see which
// sub-component (sync vs publish) is the actual culprit.
std::atomic<std::uint32_t> s_max_video_sync_us{0};
std::atomic<std::uint32_t> s_max_video_publish_us{0};
std::atomic<std::uint32_t> s_max_video_total_us{0};
std::atomic<std::uint32_t> s_last_sw_xfb_convert_us{0};
std::atomic<std::uint32_t> s_last_sw_xfb_copy_us{0};
std::atomic<std::uint32_t> s_last_sw_xfb_total_us{0};
std::atomic<std::uint32_t> s_last_sw_xfb_width{0};
std::atomic<std::uint32_t> s_last_sw_xfb_height{0};
std::atomic<std::uint32_t> s_last_sw_xfb_dst_height{0};
std::atomic<std::uint32_t> s_xfb_fast_paths{0};
std::atomic<std::uint64_t> s_xfb_encoded_rows_reused{0};
std::atomic<std::uint64_t> s_xfb_identity_frames_decoded{0};
std::atomic<std::uint32_t> s_software_tev_hot_case_mode{0};
std::atomic<std::uint32_t> s_software_tev_hot_case_generation{1};
std::atomic<std::uint32_t> s_ogl_swap_count{0};
std::atomic<int> s_last_ogl_worker_owned{0};
std::atomic<int> s_last_ogl_commit_result{0};
std::atomic<std::uint32_t> s_last_ogl_width{0};
std::atomic<std::uint32_t> s_last_ogl_height{0};
std::atomic<std::uint32_t> s_last_ogl_debug_bits{0};
std::atomic<std::uint32_t> s_last_ogl_readback_rgba{0};
std::atomic<int> s_last_ogl_gl_error{0};

// Day-1 per-frame ring buffer. The OGL swap callback pushes one entry per
// swap; the JS worker drains it on a 1Hz timer and logs to console. Lets us
// see exactly which frame stops drawing without needing to set a breakpoint
// in C++. Capacity is one ring slot per (Melee 60fps × ~4 seconds) — enough
// to capture a JIT-engagement transition with margin around it.
struct DolphinWebFrameRingEntry
{
  std::uint32_t frame;
  std::uint32_t prim;
  std::uint32_t draw;
  std::uint32_t verts;
  std::uint32_t xfb_hash;
  std::uint32_t glerr;
  std::int32_t  commit_result;
  std::uint32_t debug_bits;
};
static_assert(sizeof(DolphinWebFrameRingEntry) == 32,
              "frame ring entry must stay 32 bytes for JS HEAPU32 stride math");

constexpr std::uint32_t DOLPHIN_WEB_FRAME_RING_CAPACITY = 256;
std::atomic<std::uint32_t> s_frame_ring_head{0};  // monotonic write counter (mod CAPACITY = slot)
std::array<DolphinWebFrameRingEntry, DOLPHIN_WEB_FRAME_RING_CAPACITY> s_frame_ring{};

void PushFrameRingEntry(std::uint32_t frame, std::uint32_t prim, std::uint32_t draw,
                        std::uint32_t verts, std::uint32_t xfb_hash, std::uint32_t glerr,
                        std::int32_t commit_result, std::uint32_t debug_bits)
{
  const std::uint32_t head = s_frame_ring_head.fetch_add(1, std::memory_order_relaxed);
  const std::uint32_t slot = head % DOLPHIN_WEB_FRAME_RING_CAPACITY;
  DolphinWebFrameRingEntry& entry = s_frame_ring[slot];
  entry.frame = frame;
  entry.prim = prim;
  entry.draw = draw;
  entry.verts = verts;
  entry.xfb_hash = xfb_hash;
  entry.glerr = glerr;
  entry.commit_result = commit_result;
  entry.debug_bits = debug_bits;
}

int ScaledPresentationDimension(std::uint32_t source)
{
  const int scaled = static_cast<int>(static_cast<float>(source) * s_presentation_scale);
  return std::clamp(scaled, 1, static_cast<int>(source));
}

void DownsampleFramebuffer(std::uint32_t source_width, std::uint32_t source_height, int target_width,
                           int target_height)
{
  if (target_width == static_cast<int>(source_width) &&
      target_height == static_cast<int>(source_height))
  {
    return;
  }

  for (int y = 0; y < target_height; ++y)
  {
    const auto source_y =
        static_cast<std::size_t>((static_cast<std::uint64_t>(y) * source_height) / target_height);
    for (int x = 0; x < target_width; ++x)
    {
      const auto source_x =
          static_cast<std::size_t>((static_cast<std::uint64_t>(x) * source_width) / target_width);
      s_framebuffer[static_cast<std::size_t>(y) * target_width + x] =
          s_framebuffer[source_y * source_width + source_x];
    }
  }
}

std::uint32_t YuvToRgba(std::uint8_t y, std::uint8_t u, std::uint8_t v)
{
  return DolphinWeb::XfbFastPaths::YuvToRgba(y, u, v);
}

void DecodeXfbToPresentationBuffer(const std::uint8_t* xfb, std::uint32_t source_width,
                                   std::uint32_t stride, std::uint32_t source_height,
                                   int target_width, int target_height)
{
  if (target_width == static_cast<int>(source_width) &&
      target_height == static_cast<int>(source_height) &&
      DolphinWeb::XfbFastPaths::DecodeIdentityYuyvToRgba(
          s_xfb_fast_paths.load(std::memory_order_relaxed), s_framebuffer.data(), xfb,
          source_width, stride, source_height))
  {
    s_xfb_identity_frames_decoded.fetch_add(1, std::memory_order_relaxed);
    return;
  }

  if (source_width < 2)
  {
    TexDecoder_DecodeXFB(reinterpret_cast<std::uint8_t*>(s_framebuffer.data()), xfb, source_width,
                         source_height, stride);
    DownsampleFramebuffer(source_width, source_height, target_width, target_height);
    return;
  }

  for (int y = 0; y < target_height; ++y)
  {
    const std::uint32_t source_y =
        static_cast<std::uint32_t>((static_cast<std::uint64_t>(y) * source_height) /
                                   static_cast<std::uint32_t>(target_height));
    const std::uint8_t* row = xfb + static_cast<std::size_t>(source_y) * stride;
    for (int x = 0; x < target_width; ++x)
    {
      const std::uint32_t source_x =
          static_cast<std::uint32_t>((static_cast<std::uint64_t>(x) * source_width) /
                                     static_cast<std::uint32_t>(target_width));
      const std::uint32_t pair_x = std::min(source_x & ~1u, source_width - 2);
      const std::uint8_t* pair = row + static_cast<std::size_t>(pair_x) * 2;
      const std::uint8_t luma = (source_x & 1u) ? pair[2] : pair[0];
      s_framebuffer[static_cast<std::size_t>(y) * target_width + x] =
          YuvToRgba(luma, pair[1], pair[3]);
    }
  }
}

void CopyRgbaToPresentationBuffer(const std::uint8_t* rgba, std::uint32_t source_width,
                                  std::uint32_t source_height, int target_width,
                                  int target_height)
{
  for (int y = 0; y < target_height; ++y)
  {
    const std::uint32_t sampled_y =
        static_cast<std::uint32_t>((static_cast<std::uint64_t>(y) * source_height) /
                                   static_cast<std::uint32_t>(target_height));
    const std::uint32_t source_y = source_height - 1 - sampled_y;
    for (int x = 0; x < target_width; ++x)
    {
      const std::uint32_t source_x =
          static_cast<std::uint32_t>((static_cast<std::uint64_t>(x) * source_width) /
                                     static_cast<std::uint32_t>(target_width));
      const std::uint8_t* pixel =
          rgba + (static_cast<std::size_t>(source_y) * source_width + source_x) * 4;
      s_framebuffer[static_cast<std::size_t>(y) * target_width + x] =
          0xff000000u | (static_cast<std::uint32_t>(pixel[2]) << 16) |
          (static_cast<std::uint32_t>(pixel[1]) << 8) | static_cast<std::uint32_t>(pixel[0]);
    }
  }
}

void PublishFrameSignal()
{
#ifdef __EMSCRIPTEN__
  emscripten_atomic_store_u32(&s_frame_signal, s_frame);
  emscripten_atomic_notify(&s_frame_signal, INT_MAX);
#endif
}

std::string PadDebugStats()
{
  PadPollSnapshot poll;
  {
    const std::lock_guard<std::mutex> lock(s_pad_poll_mutex);
    poll = s_pad_poll;
  }
  std::ostringstream out;
  out << " pad polls:" << poll.poll_count << " updates:"
      << s_input_update_count.load(std::memory_order_relaxed)
      << " input:" << std::hex << poll.input_mask << std::dec
      << " gen:" << poll.input_generation
      << " buttons:" << std::hex << poll.button_mask << std::dec
      << " stick:" << static_cast<int>(poll.stick_x) << ","
      << static_cast<int>(poll.stick_y)
      << " fastsw:" << DolphinWeb_FastSoftwareRaster();
  return out.str();
}

std::uint64_t ElapsedMicros(WebProfileClock::time_point start, WebProfileClock::time_point end)
{
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(end - start).count());
}

std::string FormatMicrosAsMs(std::uint64_t micros)
{
  std::ostringstream out;
  out << (micros / 1000) << "." << ((micros % 1000) / 100);
  return out.str();
}

std::string XfbProfileStats()
{
  std::ostringstream out;
  const std::uint64_t avg_interval =
      s_xfb_interval_count > 0 ? s_total_xfb_interval_us / s_xfb_interval_count : 0;
  const std::uint64_t avg_decode =
      s_xfb_decode_count > 0 ? s_total_xfb_decode_us / s_xfb_decode_count : 0;
  out << " coreprof xfb_dt:" << FormatMicrosAsMs(s_last_xfb_interval_us)
      << " avg:" << FormatMicrosAsMs(avg_interval)
      << " max:" << FormatMicrosAsMs(s_max_xfb_interval_us)
      << " decode:" << FormatMicrosAsMs(s_last_xfb_decode_us)
      << " avg:" << FormatMicrosAsMs(avg_decode)
      << " max:" << FormatMicrosAsMs(s_max_xfb_decode_us)
      << " vo_sync:" << FormatMicrosAsMs(s_last_video_sync_us.load(std::memory_order_relaxed))
      << "/max" << FormatMicrosAsMs(s_max_video_sync_us.load(std::memory_order_relaxed))
      << " vo_pub:" << FormatMicrosAsMs(s_last_video_publish_us.load(std::memory_order_relaxed))
      << "/max" << FormatMicrosAsMs(s_max_video_publish_us.load(std::memory_order_relaxed))
      << " vo_total:" << FormatMicrosAsMs(s_last_video_total_us.load(std::memory_order_relaxed))
      << "/max" << FormatMicrosAsMs(s_max_video_total_us.load(std::memory_order_relaxed))
      << " swxfb:" << FormatMicrosAsMs(s_last_sw_xfb_total_us.load(std::memory_order_relaxed))
      << " conv:" << FormatMicrosAsMs(s_last_sw_xfb_convert_us.load(std::memory_order_relaxed))
      << " copy:" << FormatMicrosAsMs(s_last_sw_xfb_copy_us.load(std::memory_order_relaxed))
      << " sz:" << s_last_sw_xfb_width.load(std::memory_order_relaxed) << "x"
      << s_last_sw_xfb_height.load(std::memory_order_relaxed) << "->"
      << s_last_sw_xfb_dst_height.load(std::memory_order_relaxed)
      << " xfbfast:" << s_xfb_fast_paths.load(std::memory_order_relaxed)
      << " rowreuse:" << s_xfb_encoded_rows_reused.load(std::memory_order_relaxed)
      << " identitydecode:" << s_xfb_identity_frames_decoded.load(std::memory_order_relaxed);
  return out.str();
}

constexpr std::size_t RASTER_CASE_TOP_COUNT = 8;

std::string TextureCaseStats(const DolphinWeb::RasterProfile::TextureCaseTableSnapshot& cases)
{
  using Entry = DolphinWeb::RasterProfile::CaseEntry<DolphinWeb::RasterProfile::TextureCaseKey>;
  std::vector<const Entry*> ranked;
  ranked.reserve(cases.entries.size());
  for (const Entry& entry : cases.entries)
  {
    if (entry.occupied)
      ranked.push_back(&entry);
  }
  std::sort(ranked.begin(), ranked.end(), [](const Entry* left, const Entry* right) {
    if (left->samples != right->samples)
      return left->samples > right->samples;
    return left->key.packed < right->key.packed;
  });

  std::uint64_t other_samples = cases.other_samples;
  std::uint64_t other_work = cases.other_work;
  for (std::size_t i = RASTER_CASE_TOP_COUNT; i < ranked.size(); ++i)
  {
    other_samples += ranked[i]->samples;
    other_work += ranked[i]->work;
  }

  std::ostringstream out;
  out << " texcase:" << cases.total_samples << "/" << cases.total_work << "/"
      << other_samples << "/" << other_work << "/" << cases.collision_count << ":";
  const std::size_t count = std::min(RASTER_CASE_TOP_COUNT, ranked.size());
  if (count == 0)
    out << "-";
  for (std::size_t i = 0; i < count; ++i)
  {
    if (i != 0)
      out << ",";
    out << std::hex << ranked[i]->key.packed << std::dec << "=" << ranked[i]->samples << "/"
        << ranked[i]->work;
  }
  return out.str();
}

std::string TevCaseStats(const DolphinWeb::RasterProfile::TevCaseTableSnapshot& cases)
{
  using Entry = DolphinWeb::RasterProfile::CaseEntry<DolphinWeb::RasterProfile::TevCaseKey>;
  std::vector<const Entry*> ranked;
  ranked.reserve(cases.entries.size());
  for (const Entry& entry : cases.entries)
  {
    if (entry.occupied)
      ranked.push_back(&entry);
  }
  std::sort(ranked.begin(), ranked.end(), [](const Entry* left, const Entry* right) {
    if (left->samples != right->samples)
      return left->samples > right->samples;
    if (left->key.structure != right->key.structure)
      return left->key.structure < right->key.structure;
    if (left->key.program_fingerprint != right->key.program_fingerprint)
      return left->key.program_fingerprint < right->key.program_fingerprint;
    if (left->key.exact_word_count != right->key.exact_word_count)
      return left->key.exact_word_count < right->key.exact_word_count;
    return left->key.exact_words < right->key.exact_words;
  });

  std::uint64_t other_samples = cases.other_samples;
  std::uint64_t other_work = cases.other_work;
  for (std::size_t i = RASTER_CASE_TOP_COUNT; i < ranked.size(); ++i)
  {
    other_samples += ranked[i]->samples;
    other_work += ranked[i]->work;
  }

  std::ostringstream out;
  out << " tevcase:" << cases.total_samples << "/" << cases.total_work << "/"
      << other_samples << "/" << other_work << "/" << cases.collision_count << ":";
  const std::size_t count = std::min(RASTER_CASE_TOP_COUNT, ranked.size());
  if (count == 0)
    out << "-";
  for (std::size_t i = 0; i < count; ++i)
  {
    if (i != 0)
      out << ",";
    out << std::hex << ranked[i]->key.structure << "." << ranked[i]->key.program_fingerprint
        << std::dec;
    if (ranked[i]->key.HasExactTuple())
    {
      out << "@1" << std::hex;
      for (const std::uint32_t word : ranked[i]->key.exact_words)
        out << "." << word;
      out << std::dec;
    }
    out << "=" << ranked[i]->samples << "/" << ranked[i]->work;
  }
  return out.str();
}

std::string RasterProfileStats()
{
  if (!DolphinWeb::RasterProfile::Enabled())
    return {};
  const DolphinWeb::RasterProfile::Snapshot profile = DolphinWeb::RasterProfile::Capture();

  std::ostringstream out;
  out << " swphase:1"
      << " caseseed:" << profile.case_sample_seed
      << " rast:" << profile.raster.calls << "/" << profile.raster.timed_samples << "/"
      << profile.raster.sampled_total_us << "/" << profile.raster_candidate_pixels
      << " tev:" << profile.tev.calls << "/" << profile.tev_stages << "/"
      << profile.tev.timed_samples << "/" << profile.tev.sampled_total_us
      << " tevhot:" << s_software_tev_hot_case_mode.load(std::memory_order_relaxed) << "/"
      << profile.tev_hot_classified_batches << "/" << profile.tev_hot_classified_pixels << "/"
      << profile.tev_hot_specialized_pixels << "/" << profile.tev_hot_shadow_pixels << "/"
      << profile.tev_hot_shadow_mismatches
      << " tex:" << profile.texture.calls << "/" << profile.texture.timed_samples << "/"
      << profile.texture.sampled_total_us
      << TextureCaseStats(profile.texture_cases)
      << TevCaseStats(profile.tev_cases)
      << " fifo:" << profile.fifo_burst_count << "/" << profile.fifo_consume_count << "/"
      << profile.fifo_bytes_last << "/" << profile.fifo_bytes_max << "/"
      << profile.fifo_age_last_us << "/" << profile.fifo_age_max_us << "/"
      << profile.fifo_age_sample_count
      << " fifouf:" << profile.fifo_distance_underflow_count
      << " xfbgen:" << profile.xfb_generation_count << "/" << profile.xfb_generation_last_us
      << "/" << profile.xfb_generation_total_us << "/" << profile.xfb_generation_max_us
      << " framegen:" << profile.frame_generation_count << "/"
      << profile.frame_interval_last_us << "/" << profile.frame_interval_total_us << "/"
      << profile.frame_interval_max_us << "/" << profile.frame_interval_count;
  return out.str();
}

std::string OglSwapStats()
{
  std::ostringstream out;
  out << " ogl_swap:" << s_ogl_swap_count.load(std::memory_order_relaxed)
      << " worker:" << s_last_ogl_worker_owned.load(std::memory_order_relaxed)
      << " commit:" << s_last_ogl_commit_result.load(std::memory_order_relaxed)
      << " bb:" << s_last_ogl_width.load(std::memory_order_relaxed) << "x"
      << s_last_ogl_height.load(std::memory_order_relaxed)
      << " bits:" << s_last_ogl_debug_bits.load(std::memory_order_relaxed) << " rb:0x"
      << std::hex << s_last_ogl_readback_rgba.load(std::memory_order_relaxed)
      << " glerr:0x" << s_last_ogl_gl_error.load(std::memory_order_relaxed) << std::dec;
  return out.str();
}

const char* PlatformName(DiscIO::Platform platform)
{
  switch (platform)
  {
  case DiscIO::Platform::GameCubeDisc:
    return "GameCube";
  case DiscIO::Platform::WiiDisc:
    return "Wii";
  case DiscIO::Platform::WiiWAD:
    return "Wii WAD";
  case DiscIO::Platform::ELFOrDOL:
    return "ELF/DOL";
  case DiscIO::Platform::Triforce:
    return "Triforce";
  default:
    return "Unknown";
  }
}

const char* RegionName(DiscIO::Region region)
{
  switch (region)
  {
  case DiscIO::Region::NTSC_J:
    return "NTSC-J";
  case DiscIO::Region::NTSC_U:
    return "NTSC-U";
  case DiscIO::Region::PAL:
    return "PAL";
  case DiscIO::Region::NTSC_K:
    return "NTSC-K";
  default:
    return "Unknown";
  }
}

double OptionalToDouble(std::optional<std::uint64_t> value)
{
  return value ? static_cast<double>(*value) : -1.0;
}

double OptionalToDouble(std::optional<std::uint32_t> value)
{
  return value ? static_cast<double>(*value) : -1.0;
}

std::uint8_t ClampPadByte(int value)
{
  if (value <= 0)
    return 0;
  if (value >= 0xff)
    return 0xff;
  return static_cast<std::uint8_t>(value);
}

void ClearDiscMetadata()
{
  s_game_id.clear();
  s_game_title.clear();
  s_maker_id.clear();
  s_platform = "Unknown";
  s_region = "Unknown";
  s_apploader_date.clear();
  s_apploader_size = -1.0;
  s_boot_dol_offset = -1.0;
  s_boot_dol_size = -1.0;
  s_fst_offset = -1.0;
  s_fst_size = -1.0;
  s_raw_size = -1.0;
  s_data_size = -1.0;
  s_root_entry_count = -1;
  s_root_entries.clear();
}

void RefreshBootMetadata()
{
  if (!s_disc)
  {
    ClearDiscMetadata();
    return;
  }

  const DiscIO::Partition partition = s_disc->GetGamePartition();
  s_apploader_date = s_disc->GetApploaderDate(partition);
  s_apploader_size = OptionalToDouble(DiscIO::GetApploaderSize(*s_disc, partition));

  const std::optional<std::uint64_t> dol_offset = DiscIO::GetBootDOLOffset(*s_disc, partition);
  s_boot_dol_offset = OptionalToDouble(dol_offset);
  s_boot_dol_size =
      dol_offset ? OptionalToDouble(DiscIO::GetBootDOLSize(*s_disc, partition, *dol_offset)) : -1.0;

  s_fst_offset = OptionalToDouble(DiscIO::GetFSTOffset(*s_disc, partition));
  s_fst_size = OptionalToDouble(DiscIO::GetFSTSize(*s_disc, partition));
  s_raw_size = static_cast<double>(s_disc->GetRawSize());
  s_data_size = static_cast<double>(s_disc->GetDataSize());

  const DiscIO::FileSystem* file_system = s_disc->GetFileSystem(partition);
  s_root_entries.clear();
  if (file_system && file_system->IsValid())
  {
    const DiscIO::FileInfo& root = file_system->GetRoot();
    for (const DiscIO::FileInfo& child : root)
    {
      s_root_entries.push_back({
          child.GetName(),
          child.GetPath(),
          static_cast<double>(child.GetOffset()),
          static_cast<double>(child.GetSize()),
          child.IsDirectory() ? 1 : 0,
      });
    }
    s_root_entry_count = static_cast<int>(s_root_entries.size());
  }
  else
  {
    s_root_entry_count = -1;
  }
}

void RenderMetadataFrame()
{
  s_frame_width = METADATA_FRAME_WIDTH;
  s_frame_height = METADATA_FRAME_HEIGHT;
  s_using_xfb_frame = false;

  std::uint32_t id_seed = 0x504f5254u;
  for (std::size_t i = 0; i < s_game_id.size() && i < 4; ++i)
    id_seed = (id_seed << 8) ^ static_cast<unsigned char>(s_game_id[i]);

  std::uint32_t input_mask = 0;
  {
    const std::lock_guard<std::mutex> lock(s_input_state_mutex);
    input_mask = s_input_states[0].mask;
  }

  for (int y = 0; y < METADATA_FRAME_HEIGHT; ++y)
  {
    for (int x = 0; x < METADATA_FRAME_WIDTH; ++x)
    {
      const std::uint8_t r = static_cast<std::uint8_t>((x + s_frame + (id_seed & 0xff)) & 0xff);
      const std::uint8_t g =
          static_cast<std::uint8_t>((y + (s_frame >> 1) + ((id_seed >> 8) & 0xff)) & 0xff);
      const std::uint8_t b =
          static_cast<std::uint8_t>((x ^ y ^ input_mask ^ ((id_seed >> 16) & 0xff)) & 0xff);
      s_framebuffer[static_cast<std::size_t>(y) * METADATA_FRAME_WIDTH + x] =
          0xff000000u | (static_cast<std::uint32_t>(b) << 16) |
          (static_cast<std::uint32_t>(g) << 8) | static_cast<std::uint32_t>(r);
    }
  }
}
}  // namespace

extern "C"
{
int DolphinWeb_XfbFastPaths()
{
  return static_cast<int>(s_xfb_fast_paths.load(std::memory_order_relaxed));
}

void DolphinWeb_RecordXfbEncodedRowReuse()
{
  s_xfb_encoded_rows_reused.fetch_add(1, std::memory_order_relaxed);
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int SetXfbFastPaths(int flags)
{
  const std::uint32_t normalized = static_cast<std::uint32_t>(flags) &
                                   DolphinWeb::XfbFastPaths::ALL;
  s_xfb_fast_paths.store(normalized, std::memory_order_relaxed);
  s_xfb_encoded_rows_reused.store(0, std::memory_order_relaxed);
  s_xfb_identity_frames_decoded.store(0, std::memory_order_relaxed);
  return static_cast<int>(normalized);
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int SetSoftwareRasterProfileEnabled(int enabled)
{
  DolphinWeb::RasterProfile::SetEnabled(enabled != 0);
  return DolphinWeb::RasterProfile::Enabled() ? 1 : 0;
}

int DolphinWeb_SoftwareTevHotCaseMode()
{
  return static_cast<int>(s_software_tev_hot_case_mode.load(std::memory_order_acquire));
}

unsigned int DolphinWeb_SoftwareTevHotCaseGeneration()
{
  return s_software_tev_hot_case_generation.load(std::memory_order_acquire);
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int SetSoftwareTevHotCaseMode(int mode)
{
  const std::uint32_t normalized = static_cast<std::uint32_t>(mode) & 0x3;
  s_software_tev_hot_case_mode.store(normalized, std::memory_order_release);
  // Reapplying the same mode deliberately clears a previously latched shadow
  // mismatch at the next draw-batch classification boundary.
  s_software_tev_hot_case_generation.fetch_add(1, std::memory_order_release);
  return static_cast<int>(normalized);
}

void DolphinWeb_RecordVideoOutputProfile(std::uint32_t sync_us, std::uint32_t publish_us,
                                         std::uint32_t total_us)
{
  s_last_video_sync_us.store(sync_us, std::memory_order_relaxed);
  s_last_video_publish_us.store(publish_us, std::memory_order_relaxed);
  s_last_video_total_us.store(total_us, std::memory_order_relaxed);
  // §28cs CAS-update lifetime maxes so we can see which sub-component
  // spikes during the 41-47ms VICallback stalls.
  auto cas_max = [](std::atomic<std::uint32_t>& a, std::uint32_t v) {
    std::uint32_t prev = a.load(std::memory_order_relaxed);
    while (v > prev && !a.compare_exchange_weak(prev, v, std::memory_order_relaxed)) {}
  };
  cas_max(s_max_video_sync_us, sync_us);
  cas_max(s_max_video_publish_us, publish_us);
  cas_max(s_max_video_total_us, total_us);
  // VideoBackendBase::Video_OutputXFB reaches this bridge on the browser
  // software path even when the native Presenter is headless and never calls
  // SWGfx::ShowImage. Publish frame cadence at the reached XFB boundary.
  DolphinWeb::RasterProfile::PublishGeneratedFrame();
}

void DolphinWeb_RecordSoftwareXfbEncodeProfile(std::uint32_t convert_us, std::uint32_t copy_us,
                                               std::uint32_t total_us, std::uint32_t width,
                                               std::uint32_t height,
                                               std::uint32_t dst_height)
{
  s_last_sw_xfb_convert_us.store(convert_us, std::memory_order_relaxed);
  s_last_sw_xfb_copy_us.store(copy_us, std::memory_order_relaxed);
  s_last_sw_xfb_total_us.store(total_us, std::memory_order_relaxed);
  s_last_sw_xfb_width.store(width, std::memory_order_relaxed);
  s_last_sw_xfb_height.store(height, std::memory_order_relaxed);
  s_last_sw_xfb_dst_height.store(dst_height, std::memory_order_relaxed);
  DolphinWeb::RasterProfile::RecordXfbGeneration(total_us);
}

int MountDisc(const char* path)
{
  if (!path)
    return 0;

  s_disc = DiscIO::CreateDisc(std::string(path));
  if (!s_disc)
  {
    ClearDiscMetadata();
    RenderMetadataFrame();
    return 0;
  }

  s_game_id = s_disc->GetGameID();
  s_game_title = s_disc->GetInternalName();
  s_maker_id = s_disc->GetMakerID();
  s_platform = PlatformName(s_disc->GetVolumeType());
  s_region = RegionName(s_disc->GetRegion());
  RefreshBootMetadata();
  RenderMetadataFrame();
  return 1;
}

void Reset()
{
  s_frame = 0;
  RenderMetadataFrame();
}

void SetInputMask(std::uint32_t mask)
{
  {
    const std::lock_guard<std::mutex> lock(s_input_state_mutex);
    s_input_states[0] = {};
    s_input_states[0].mask = mask;
  }
  s_input_update_count.fetch_add(1, std::memory_order_relaxed);
}

// Port 0-3. connected = 0 unplugs the port (its state returns to neutral).
// Returns 0 for a port out of range.
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int SetPadState(int port, int connected, std::uint32_t mask, int stick_x, int stick_y,
                int c_stick_x, int c_stick_y, int trigger_left, int trigger_right, int analog_a,
                int analog_b, std::uint32_t generation)
{
  if (port < 0 || port >= PAD_PORT_COUNT)
    return 0;

  InputStateSnapshot next;
  next.generation = generation;
  if (connected)
  {
    next.mask = mask;
    next.stick_x = ClampPadByte(stick_x);
    next.stick_y = ClampPadByte(stick_y);
    next.c_stick_x = ClampPadByte(c_stick_x);
    next.c_stick_y = ClampPadByte(c_stick_y);
    next.trigger_left = ClampPadByte(trigger_left);
    next.trigger_right = ClampPadByte(trigger_right);
    next.analog_a = ClampPadByte(analog_a);
    next.analog_b = ClampPadByte(analog_b);
  }
  {
    const std::lock_guard<std::mutex> lock(s_input_state_mutex);
    s_input_states[port] = next;
    s_pad_connected[port] = connected != 0;
  }
  s_input_update_count.fetch_add(1, std::memory_order_relaxed);
  return 1;
}

void SetInputState(std::uint32_t mask, int stick_x, int stick_y, int c_stick_x, int c_stick_y,
                   int trigger_left, int trigger_right, int analog_a, int analog_b,
                   std::uint32_t generation)
{
  SetPadState(0, 1, mask, stick_x, stick_y, c_stick_x, c_stick_y, trigger_left, trigger_right,
              analog_a, analog_b, generation);
}

// Bit n set when port n is connected.
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int GetPadConnectedMask()
{
  const std::lock_guard<std::mutex> lock(s_input_state_mutex);
  int mask = 0;
  for (int port = 0; port < PAD_PORT_COUNT; ++port)
    mask |= s_pad_connected[port] ? 1 << port : 0;
  return mask;
}

int SetPresentationScale(float scale)
{
  if (scale < 0.25f || scale > 1.0f)
    return 0;

  s_presentation_scale = scale;
  return 1;
}

void RunFrame()
{
  ++s_frame;
  if (!s_using_xfb_frame)
    RenderMetadataFrame();
  PublishFrameSignal();
}

int FrameWidth()
{
  return s_frame_width;
}

int FrameHeight()
{
  return s_frame_height;
}

std::uint32_t* FrameBuffer()
{
  return s_framebuffer.data();
}

int SaveState(int slot)
{
  return slot >= 0 ? 1 : 0;
}

int LoadState(int slot)
{
  return slot >= 0 ? 1 : 0;
}

std::uint32_t GetFrame()
{
  return s_frame;
}

std::uint32_t* GetFrameSignalPtr()
{
  return &s_frame_signal;
}

// ---- QA harness hooks (harness/README.md) --------------------------------
// Off unless the harness turns them on (DolphinWeb_HarnessEnable, sent by the
// worker on validationEnableHarness): production pays two counter
// increments and one relaxed atomic load per VI output, nothing else.
//
// Every VI output (one per emulated field the game scans out, on the CPU
// thread) is counted from boot and from the last savestate load; those
// indices are the frame identity the harness uses. When enabled, each output
// is logged in a ring with its emulated ticks and host time
// (emscripten_get_now: timeOrigin + performance.now(), the same clock the
// worker uses for presentations), and a capture can be armed for one exact
// output: after a GPU fence, the guest XFB is decoded at native size, or the
// capture is marked missed. The harness never infers a frame from wall time.
#ifndef EMSCRIPTEN_KEEPALIVE
#define EMSCRIPTEN_KEEPALIVE
#endif
// Per-entry seqlock: `seq` is odd while the entry is being written and
// 2 * (n + 1) once entry n is complete. The reader (src/harness-vi-ring.js)
// accepts an entry only if seq is even, is the value expected for that
// slot, and is unchanged after reading the fields.
struct DolphinWebHarnessViEntry
{
  std::atomic<std::uint32_t> seq;
  std::uint32_t vi_since_boot;
  double host_ms;
  std::uint64_t ticks;
  std::uint32_t vi_since_load;
  std::uint32_t pad;
};
static_assert(sizeof(DolphinWebHarnessViEntry) == 32, "harness VI entry layout is read from JS");

constexpr std::uint32_t HARNESS_VI_RING_CAPACITY = 8192;  // > 2 min at 60 Hz between drains
static std::array<DolphinWebHarnessViEntry, HARNESS_VI_RING_CAPACITY> s_harness_vi_ring{};
static std::atomic<std::uint32_t> s_harness_vi_head{0};
static std::uint32_t s_harness_vi_since_boot = 0;
static std::uint32_t s_harness_vi_since_load = 0;
static std::atomic<std::uint32_t> s_harness_load_generation{0};
static std::atomic<int> s_harness_enabled{0};

// 0 idle, 1 armed, 2 ready, 3 missed
static std::atomic<int> s_harness_capture_state{0};
static std::uint32_t s_harness_capture_target = 0;
static int s_harness_capture_from_load = 0;
static std::vector<std::uint32_t> s_harness_capture_pixels;
static std::uint32_t s_harness_capture_width = 0;
static std::uint32_t s_harness_capture_height = 0;
static std::uint32_t s_harness_capture_index = 0;
static std::uint64_t s_harness_capture_ticks = 0;

// Called on the CPU thread at the end of a savestate load.
void DolphinWeb_HarnessOnStateLoaded()
{
  s_harness_vi_since_load = 0;
  s_harness_load_generation.fetch_add(1, std::memory_order_release);
}

static void HarnessOnViOutput(const std::uint8_t* xfb, std::uint32_t width, std::uint32_t stride,
                              std::uint32_t height)
{
  ++s_harness_vi_since_boot;
  ++s_harness_vi_since_load;
  if (!s_harness_enabled.load(std::memory_order_relaxed))
    return;
  // Informational: GetTicks() includes the event's lateness, so ticks are
  // not a frame identity; the VI indices are.
  const std::uint64_t ticks = Core::System::GetInstance().GetCoreTiming().GetTicks();
  const std::uint32_t head = s_harness_vi_head.load(std::memory_order_relaxed);
#ifdef __EMSCRIPTEN__
  const double host_ms = emscripten_get_now();
#else
  const double host_ms = 0.0;
#endif
  DolphinWebHarnessViEntry& e = s_harness_vi_ring[head % HARNESS_VI_RING_CAPACITY];
  e.seq.store(2 * head + 1, std::memory_order_relaxed);  // odd: being written
  std::atomic_thread_fence(std::memory_order_release);
  e.vi_since_boot = s_harness_vi_since_boot;
  e.host_ms = host_ms;
  e.ticks = ticks;
  e.vi_since_load = s_harness_vi_since_load;
  e.seq.store(2 * head + 2, std::memory_order_release);  // even: entry `head` complete
  s_harness_vi_head.store(head + 1, std::memory_order_release);

  if (s_harness_capture_state.load(std::memory_order_acquire) != 1)
    return;
  const std::uint32_t index = s_harness_capture_from_load ? s_harness_vi_since_load : s_harness_vi_since_boot;
  if (index < s_harness_capture_target)
    return;
  if (index > s_harness_capture_target)
  {
    s_harness_capture_state.store(3, std::memory_order_release);
    return;
  }
  // Fence: in dual core the video thread may still be writing this XFB
  // (SyncGPU only waits in deterministic-GPU mode). FlushGpu blocks until
  // the video thread has drained everything the CPU sent before this output.
  // Only on the captured output.
  Core::System::GetInstance().GetFifo().FlushGpu();
  s_harness_capture_pixels.resize(static_cast<std::size_t>(width) * height);
  for (std::uint32_t y = 0; y < height; ++y)
  {
    const std::uint8_t* row = xfb + static_cast<std::size_t>(y) * stride;
    for (std::uint32_t x = 0; x < width; ++x)
    {
      const std::uint8_t* pair = row + static_cast<std::size_t>(x & ~1u) * 2;
      s_harness_capture_pixels[static_cast<std::size_t>(y) * width + x] =
          YuvToRgba((x & 1u) ? pair[2] : pair[0], pair[1], pair[3]);
    }
  }
  s_harness_capture_width = width;
  s_harness_capture_height = height;
  s_harness_capture_index = index;
  s_harness_capture_ticks = ticks;
  s_harness_capture_state.store(2, std::memory_order_release);
}

EMSCRIPTEN_KEEPALIVE void DolphinWeb_HarnessEnable(int enabled)
{
  s_harness_enabled.store(enabled ? 1 : 0, std::memory_order_relaxed);
}

// The GPU-sync counters have a switch of their own, turned on only by the
// freeze probe (validationEnableGpuSyncDiag): other harness sessions, the
// perf gate among them, never count.
EMSCRIPTEN_KEEPALIVE void DolphinWeb_GpuSyncDiagEnable(int enabled)
{
  DolphinWeb::GpuSyncDiag::s_enabled.store(enabled != 0, std::memory_order_relaxed);
}

// Harness diagnostics for a dual-core GPU stall (validationReadWgpuReplayState):
// the CP FIFO as the GPU thread sees it, the pixel engine's token/finish
// handshake, and the counters of VideoCommon/WasmGpuSyncDiag.h. JSON.
// Read from the worker while the CPU and GPU threads run: each field is one
// atomic load, but the fields are not one snapshot (the read pointer can
// move between "read" and "rwDistance"). Good for a stall, where nothing
// moves; not for arithmetic between fields of a running FIFO.
EMSCRIPTEN_KEEPALIVE const char* DolphinWeb_GpuSyncDiag()
{
  static std::string out;
  auto& system = Core::System::GetInstance();
  auto& command_processor = system.GetCommandProcessor();
  auto& fifo = command_processor.GetFifo();
  const auto pe = system.GetPixelEngine().GetSyncState();
  const auto& c = DolphinWeb::GpuSyncDiag::s_counters;
  const auto load = [](const auto& a) { return static_cast<unsigned long long>(a.load(std::memory_order_relaxed)); };
  std::ostringstream o;
  o << "{\"enabled\":" << (DolphinWeb::GpuSyncDiag::Enabled() ? 1 : 0)
    << ",\"fifo\":{\"base\":" << load(fifo.CPBase) << ",\"end\":" << load(fifo.CPEnd)
    << ",\"rwDistance\":" << load(fifo.CPReadWriteDistance)
    << ",\"read\":" << load(fifo.CPReadPointer) << ",\"write\":" << load(fifo.CPWritePointer)
    << ",\"safeRead\":" << load(fifo.SafeCPReadPointer)
    << ",\"breakpoint\":" << load(fifo.CPBreakpoint)
    << ",\"gpLink\":" << load(fifo.bFF_GPLinkEnable) << ",\"gpRead\":" << load(fifo.bFF_GPReadEnable)
    << ",\"bpEnable\":" << load(fifo.bFF_BPEnable) << ",\"bpInt\":" << load(fifo.bFF_BPInt)
    << ",\"atBreakpoint\":" << load(fifo.bFF_Breakpoint)
    << ",\"hiWatermark\":" << load(fifo.bFF_HiWatermark) << ",\"loWatermark\":" << load(fifo.bFF_LoWatermark)
    << ",\"interruptWaiting\":" << (command_processor.IsInterruptWaiting() ? 1 : 0) << "}"
    << ",\"pe\":{\"token\":" << pe.token << ",\"tokenPending\":" << pe.token_pending
    << ",\"tokenInterruptPending\":" << pe.token_interrupt_pending
    << ",\"finishInterruptPending\":" << pe.finish_interrupt_pending
    << ",\"eventRaised\":" << pe.event_raised
    << ",\"signalToken\":" << pe.signal_token_interrupt
    << ",\"signalFinish\":" << pe.signal_finish_interrupt << "}"
    << ",\"piCause\":" << system.GetProcessorInterface().GetCause()
    << ",\"counters\":{\"gpuLoop\":" << load(c.gpu_loop_iterations)
    << ",\"fifoChunks\":" << load(c.fifo_chunks_decoded)
    << ",\"tokenRequests\":" << load(c.pe_token_requests)
    << ",\"finishRequests\":" << load(c.pe_finish_requests)
    << ",\"eventsScheduled\":" << load(c.pe_events_scheduled)
    << ",\"eventsRun\":" << load(c.pe_events_run)
    << ",\"finishSignalled\":" << load(c.pe_finish_signalled)
    << ",\"tokenSignalled\":" << load(c.pe_token_signalled) << "}}";
  out = o.str();
  return out.c_str();
}
EMSCRIPTEN_KEEPALIVE int DolphinWeb_HarnessEnabled() { return s_harness_enabled.load(std::memory_order_relaxed); }
EMSCRIPTEN_KEEPALIVE std::uint32_t DolphinWeb_HarnessViSinceBoot() { return s_harness_vi_since_boot; }
EMSCRIPTEN_KEEPALIVE std::uint32_t DolphinWeb_HarnessViSinceLoad() { return s_harness_vi_since_load; }

// Arm a capture of VI output `index` (counted from boot, or from the last
// load when from_load != 0). Returns 0 when that output has already passed.
EMSCRIPTEN_KEEPALIVE int DolphinWeb_HarnessArmCapture(std::uint32_t index, int from_load)
{
  if (!s_harness_enabled.load(std::memory_order_relaxed))
    return 0;
  const std::uint32_t now = from_load ? s_harness_vi_since_load : s_harness_vi_since_boot;
  if (index <= now)
    return 0;
  s_harness_capture_target = index;
  s_harness_capture_from_load = from_load;
  s_harness_capture_state.store(1, std::memory_order_release);
  return 1;
}
EMSCRIPTEN_KEEPALIVE void DolphinWeb_HarnessDisarmCapture() { s_harness_capture_state.store(0, std::memory_order_release); }
EMSCRIPTEN_KEEPALIVE int DolphinWeb_HarnessCaptureState() { return s_harness_capture_state.load(std::memory_order_acquire); }
EMSCRIPTEN_KEEPALIVE std::uint32_t* DolphinWeb_HarnessCapturePixels() { return s_harness_capture_pixels.data(); }
EMSCRIPTEN_KEEPALIVE std::uint32_t DolphinWeb_HarnessCaptureWidth() { return s_harness_capture_width; }
EMSCRIPTEN_KEEPALIVE std::uint32_t DolphinWeb_HarnessCaptureHeight() { return s_harness_capture_height; }
EMSCRIPTEN_KEEPALIVE std::uint32_t DolphinWeb_HarnessCaptureIndex() { return s_harness_capture_index; }
EMSCRIPTEN_KEEPALIVE double DolphinWeb_HarnessCaptureTicks() { return static_cast<double>(s_harness_capture_ticks); }
EMSCRIPTEN_KEEPALIVE DolphinWebHarnessViEntry* DolphinWeb_HarnessViRing() { return s_harness_vi_ring.data(); }
EMSCRIPTEN_KEEPALIVE std::uint32_t DolphinWeb_HarnessViRingCapacity() { return HARNESS_VI_RING_CAPACITY; }
EMSCRIPTEN_KEEPALIVE std::uint32_t DolphinWeb_HarnessViRingHead() { return s_harness_vi_head.load(std::memory_order_acquire); }
EMSCRIPTEN_KEEPALIVE std::uint32_t DolphinWeb_HarnessLoadGeneration() { return s_harness_load_generation.load(std::memory_order_acquire); }

void DolphinWeb_OnXfb(const std::uint8_t* xfb, std::uint32_t width, std::uint32_t stride,
                      std::uint32_t height)
{
  const auto callback_start = WebProfileClock::now();
  if (s_last_xfb_profile_time.time_since_epoch().count() != 0)
  {
    s_last_xfb_interval_us = ElapsedMicros(s_last_xfb_profile_time, callback_start);
    s_total_xfb_interval_us += s_last_xfb_interval_us;
    s_max_xfb_interval_us = std::max(s_max_xfb_interval_us, s_last_xfb_interval_us);
    ++s_xfb_interval_count;
  }
  s_last_xfb_profile_time = callback_start;

  if (!xfb || width == 0 || height == 0 || width > MAX_XFB_WIDTH || height > MAX_XFB_HEIGHT ||
      stride < width * 2)
  {
    return;
  }
  HarnessOnViOutput(xfb, width, stride, height);

  const int presentation_width = ScaledPresentationDimension(width);
  const int presentation_height = ScaledPresentationDimension(height);
  DecodeXfbToPresentationBuffer(xfb, width, stride, height, presentation_width,
                                 presentation_height);
  const auto decode_done = WebProfileClock::now();
  s_last_xfb_decode_us = ElapsedMicros(callback_start, decode_done);
  s_total_xfb_decode_us += s_last_xfb_decode_us;
  s_max_xfb_decode_us = std::max(s_max_xfb_decode_us, s_last_xfb_decode_us);
  ++s_xfb_decode_count;

  std::uint32_t hash = 2166136261u;
  std::uint32_t nonzero_samples = 0;
  const std::size_t frame_bytes = static_cast<std::size_t>(stride) * height;
  const std::size_t sample_count = std::min<std::size_t>(frame_bytes / 4, 2048);
  const std::size_t sample_step =
      std::max<std::size_t>(4, ((frame_bytes / std::max<std::size_t>(1, sample_count)) / 4) * 4);
  for (std::size_t i = 0; i < frame_bytes; i += sample_step)
  {
    const std::uint8_t luma = xfb[i];
    hash ^= luma;
    hash *= 16777619u;
    hash ^= xfb[std::min<std::size_t>(i + 1, frame_bytes - 1)];
    hash *= 16777619u;
    hash ^= xfb[std::min<std::size_t>(i + 2, frame_bytes - 1)];
    hash *= 16777619u;
    if (luma != 0)
      ++nonzero_samples;
  }

  s_frame_width = presentation_width;
  s_frame_height = presentation_height;
  s_using_xfb_frame = true;
  ++s_frame;
  PublishFrameSignal();

  std::ostringstream out;
  out << "xfb:" << s_frame << " " << width << "x" << height << " stride:" << stride
      << " present:" << presentation_width << "x" << presentation_height
      << " hash:" << std::hex << hash << std::dec << " nz:" << nonzero_samples
      << " bp:" << g_stats.this_frame.num_bp_loads << " cp:" << g_stats.this_frame.num_cp_loads
      << " xf:" << g_stats.this_frame.num_xf_loads
      << " prim:" << g_stats.this_frame.num_prims
      << " draw:" << g_stats.this_frame.num_draw_calls
      << " rast:" << g_stats.this_frame.rasterized_pixels
      << " verts:" << g_stats.this_frame.num_vertices_loaded << PadDebugStats()
      << XfbProfileStats();
  s_video_stats = out.str();
}

void DolphinWeb_OnGlBackbuffer(const std::uint8_t* rgba, std::uint32_t width, std::uint32_t height)
{
  const auto callback_start = WebProfileClock::now();
  if (s_last_xfb_profile_time.time_since_epoch().count() != 0)
  {
    s_last_xfb_interval_us = ElapsedMicros(s_last_xfb_profile_time, callback_start);
    s_total_xfb_interval_us += s_last_xfb_interval_us;
    s_max_xfb_interval_us = std::max(s_max_xfb_interval_us, s_last_xfb_interval_us);
    ++s_xfb_interval_count;
  }
  s_last_xfb_profile_time = callback_start;

  if (!rgba || width == 0 || height == 0 || width > MAX_XFB_WIDTH || height > MAX_XFB_HEIGHT)
  {
    return;
  }

  const int presentation_width = ScaledPresentationDimension(width);
  const int presentation_height = ScaledPresentationDimension(height);
  CopyRgbaToPresentationBuffer(rgba, width, height, presentation_width, presentation_height);
  const auto decode_done = WebProfileClock::now();
  s_last_xfb_decode_us = ElapsedMicros(callback_start, decode_done);
  s_total_xfb_decode_us += s_last_xfb_decode_us;
  s_max_xfb_decode_us = std::max(s_max_xfb_decode_us, s_last_xfb_decode_us);
  ++s_xfb_decode_count;

  std::uint32_t hash = 2166136261u;
  std::uint32_t nonzero_samples = 0;
  const std::size_t pixel_count = static_cast<std::size_t>(presentation_width) * presentation_height;
  const std::size_t sample_step = std::max<std::size_t>(1, pixel_count / 2048);
  for (std::size_t i = 0; i < pixel_count; i += sample_step)
  {
    const std::uint32_t pixel = s_framebuffer[i];
    hash ^= pixel & 0xffu;
    hash *= 16777619u;
    hash ^= (pixel >> 8) & 0xffu;
    hash *= 16777619u;
    hash ^= (pixel >> 16) & 0xffu;
    hash *= 16777619u;
    if ((pixel & 0x00ffffffu) != 0)
      ++nonzero_samples;
  }

  s_frame_width = presentation_width;
  s_frame_height = presentation_height;
  s_using_xfb_frame = false;
  ++s_frame;
  PublishFrameSignal();

  std::ostringstream out;
  out << "glfb:" << s_frame << " " << width << "x" << height
      << " present:" << presentation_width << "x" << presentation_height
      << " hash:" << std::hex << hash << std::dec << " nz:" << nonzero_samples
      << " bp:" << g_stats.this_frame.num_bp_loads << " cp:" << g_stats.this_frame.num_cp_loads
      << " xf:" << g_stats.this_frame.num_xf_loads
      << " prim:" << g_stats.this_frame.num_prims
      << " draw:" << g_stats.this_frame.num_draw_calls
      << " rast:" << g_stats.this_frame.rasterized_pixels
      << " verts:" << g_stats.this_frame.num_vertices_loaded << PadDebugStats()
      << XfbProfileStats();
  s_video_stats = out.str();
}

void DolphinWeb_OnOglSwap(int worker_owned, int commit_result, std::uint32_t width,
                          std::uint32_t height, std::uint32_t debug_bits,
                          std::uint32_t readback_rgba, int gl_error)
{
  s_ogl_swap_count.fetch_add(1, std::memory_order_relaxed);
  s_last_ogl_worker_owned.store(worker_owned, std::memory_order_relaxed);
  s_last_ogl_commit_result.store(commit_result, std::memory_order_relaxed);
  s_last_ogl_width.store(width, std::memory_order_relaxed);
  s_last_ogl_height.store(height, std::memory_order_relaxed);
  s_last_ogl_debug_bits.store(debug_bits, std::memory_order_relaxed);
  s_last_ogl_readback_rgba.store(readback_rgba, std::memory_order_relaxed);
  s_last_ogl_gl_error.store(gl_error, std::memory_order_relaxed);
  ++s_frame;
  PublishFrameSignal();

  // Day-1 instrumentation: push a frame-ring entry. xfb_hash uses the most
  // recently published readback hash; for direct OGL contexts where readback
  // isn't computed each frame, we substitute the per-swap readback_rgba so
  // any value change is still visible. g_stats.this_frame may be stale on
  // backends that don't run the VideoCommon present path each swap — that's
  // a known limitation of taking the recording at swap rather than present.
  PushFrameRingEntry(s_frame, g_stats.this_frame.num_prims, g_stats.this_frame.num_draw_calls,
                     g_stats.this_frame.num_vertices_loaded, readback_rgba,
                     static_cast<std::uint32_t>(gl_error), commit_result, debug_bits);

}

// Day-3 investigation note: attempted to capture rendered frames on the GPU
// pthread via canvas.transferToImageBitmap() inside this function, then post
// them to discio-worker via self.postMessage. The capture *succeeds*
// (transferToImageBitmap returns a valid bitmap from GL.currentContext.GLctx.canvas
// on the pthread, where Emscripten transferred Module.canvas at GL init time),
// but Emscripten's pthread runtime intercepts user-level self.postMessage
// calls — the discio-worker never receives the bitmap messages despite
// 3000+ captures per minute. Confirmed empirically by adding a catch-all
// message counter in discio-worker: only "load"/"mixAudio" messages arrive,
// no "detachedOglFrame" ever lands. See SESSION-2026-05-12-DAY-3-NOTES.md
// for the full trail. Worker-mode painting requires a SAB-backed pixel
// transport instead; that's deferred to Day 4.

const char* GetVideoStats()
{
  static std::string current_video_stats;
  if (s_video_stats == "xfb:0")
  {
    const auto& vi = Core::System::GetInstance().GetVideoInterface();
    std::ostringstream out;
    out << "xfb:0 vi_top:" << std::hex << vi.GetXFBAddressTop()
        << " vi_bottom:" << vi.GetXFBAddressBottom() << std::dec
        << " hz:" << vi.GetTargetRefreshRate() << PadDebugStats() << OglSwapStats()
        << RasterProfileStats();
    current_video_stats = out.str();
    return current_video_stats.c_str();
  }
  current_video_stats = s_video_stats + OglSwapStats() + RasterProfileStats();
  return current_video_stats.c_str();
}

// Answers every port, so Dolphin's own controller config is never consulted.
int DolphinWeb_GetPadStatus(int pad_num, GCPadStatus* status)
{
  if (!status || pad_num < 0 || pad_num >= PAD_PORT_COUNT)
    return 0;

  const std::uint64_t ticks = Core::System::GetInstance().GetCoreTiming().GetTicks();
  PadPoll poll;
  {
    const std::lock_guard<std::mutex> lock(s_input_state_mutex);
    poll = s_pad_latches[pad_num].Poll(ticks, [pad_num] {
      return PadPoll{s_input_states[pad_num], s_pad_connected[pad_num]};
    });
  }
  const InputStateSnapshot& input = poll.input;
  const bool connected = poll.connected;

  *status = {};
  status->isConnected = connected;
  if (!connected)
    return 1;

  status->stickX = input.stick_x;
  status->stickY = input.stick_y;
  status->substickX = input.c_stick_x;
  status->substickY = input.c_stick_y;
  status->triggerLeft = input.trigger_left;
  status->triggerRight = input.trigger_right;
  status->analogA = input.analog_a;
  status->analogB = input.analog_b;

  const std::uint32_t mask = input.mask;
  if (mask & INPUT_A)
  {
    status->button |= PAD_BUTTON_A;
    status->analogA = std::max<std::uint8_t>(status->analogA, 0xff);
  }
  if (mask & INPUT_B)
  {
    status->button |= PAD_BUTTON_B;
    status->analogB = std::max<std::uint8_t>(status->analogB, 0xff);
  }
  if (mask & INPUT_X)
    status->button |= PAD_BUTTON_X;
  if (mask & INPUT_Y)
    status->button |= PAD_BUTTON_Y;
  if (mask & INPUT_START)
    status->button |= PAD_BUTTON_START;
  if (mask & INPUT_L)
  {
    status->button |= PAD_TRIGGER_L;
    status->triggerLeft = std::max<std::uint8_t>(status->triggerLeft, 0xff);
  }
  if (mask & INPUT_R)
  {
    status->button |= PAD_TRIGGER_R;
    status->triggerRight = std::max<std::uint8_t>(status->triggerRight, 0xff);
  }
  if (mask & INPUT_Z)
    status->button |= PAD_TRIGGER_Z;
  if (mask & INPUT_D_UP)
    status->button |= PAD_BUTTON_UP;
  if (mask & INPUT_D_DOWN)
    status->button |= PAD_BUTTON_DOWN;
  if (mask & INPUT_D_LEFT)
    status->button |= PAD_BUTTON_LEFT;
  if (mask & INPUT_D_RIGHT)
    status->button |= PAD_BUTTON_RIGHT;

  // Digital directions (mask-only callers) drive a stick axis only while it
  // rests, at the gate of a genuine controller (Dolphin: 0.794 and 0.722 of
  // 127 around the centre), so they never clobber analog input.
  constexpr int MAIN_FULL_TILT = 101;
  constexpr int C_FULL_TILT = 92;
  const auto digital_axis = [mask](std::uint8_t& axis, std::uint8_t center, int tilt,
                                   std::uint32_t negative, std::uint32_t positive) {
    if (axis != center || !(mask & negative) == !(mask & positive))
      return;
    axis = static_cast<std::uint8_t>(center + ((mask & positive) ? tilt : -tilt));
  };
  digital_axis(status->stickX, GCPadStatus::MAIN_STICK_CENTER_X, MAIN_FULL_TILT,
               INPUT_STICK_LEFT, INPUT_STICK_RIGHT);
  digital_axis(status->stickY, GCPadStatus::MAIN_STICK_CENTER_Y, MAIN_FULL_TILT,
               INPUT_STICK_DOWN, INPUT_STICK_UP);
  digital_axis(status->substickX, GCPadStatus::C_STICK_CENTER_X, C_FULL_TILT,
               INPUT_C_STICK_LEFT, INPUT_C_STICK_RIGHT);
  digital_axis(status->substickY, GCPadStatus::C_STICK_CENTER_Y, C_FULL_TILT,
               INPUT_C_STICK_DOWN, INPUT_C_STICK_UP);

  if (pad_num == 0)
  {
    const std::lock_guard<std::mutex> lock(s_pad_poll_mutex);
    ++s_pad_poll.poll_count;
    s_pad_poll.input_mask = mask;
    s_pad_poll.input_generation = input.generation;
    s_pad_poll.button_mask = status->button;
    s_pad_poll.stick_x = status->stickX;
    s_pad_poll.stick_y = status->stickY;
  }

  return 1;
}

const char* GetGameId()
{
  return s_game_id.c_str();
}

const char* GetGameTitle()
{
  return s_game_title.c_str();
}

const char* GetMakerId()
{
  return s_maker_id.c_str();
}

const char* GetPlatform()
{
  return s_platform.c_str();
}

const char* GetRegion()
{
  return s_region.c_str();
}

int GetDiscNumber()
{
  const std::optional<std::uint8_t> disc_number = s_disc ? s_disc->GetDiscNumber() : std::nullopt;
  return disc_number ? static_cast<int>(*disc_number) : -1;
}

const char* GetApploaderDate()
{
  return s_apploader_date.c_str();
}

double GetApploaderSize()
{
  return s_apploader_size;
}

double GetBootDolOffset()
{
  return s_boot_dol_offset;
}

double GetBootDolSize()
{
  return s_boot_dol_size;
}

double GetFstOffset()
{
  return s_fst_offset;
}

double GetFstSize()
{
  return s_fst_size;
}

double GetRawSize()
{
  return s_raw_size;
}

double GetDataSize()
{
  return s_data_size;
}

int GetRootEntryCount()
{
  return s_root_entry_count;
}

const char* GetRootEntryName(int index)
{
  if (index < 0 || index >= static_cast<int>(s_root_entries.size()))
    return "";

  return s_root_entries[static_cast<std::size_t>(index)].name.c_str();
}

const char* GetRootEntryPath(int index)
{
  if (index < 0 || index >= static_cast<int>(s_root_entries.size()))
    return "";

  return s_root_entries[static_cast<std::size_t>(index)].path.c_str();
}

int GetRootEntryIsDirectory(int index)
{
  if (index < 0 || index >= static_cast<int>(s_root_entries.size()))
    return 0;

  return s_root_entries[static_cast<std::size_t>(index)].is_directory;
}

double GetRootEntryOffset(int index)
{
  if (index < 0 || index >= static_cast<int>(s_root_entries.size()))
    return -1.0;

  return s_root_entries[static_cast<std::size_t>(index)].offset;
}

double GetRootEntrySize(int index)
{
  if (index < 0 || index >= static_cast<int>(s_root_entries.size()))
    return -1.0;

  return s_root_entries[static_cast<std::size_t>(index)].size;
}

int ReadDisc(double offset, int length, std::uint8_t* buffer)
{
  if (!s_disc || !buffer || offset < 0 || length < 0)
    return 0;

  const bool read =
      s_disc->Read(static_cast<std::uint64_t>(offset), static_cast<std::uint64_t>(length), buffer,
                   s_disc->GetGamePartition());
  return read ? length : 0;
}

int ReadDiscFile(const char* path, double offset, int length, std::uint8_t* buffer)
{
  if (!s_disc || !path || !buffer || offset < 0 || length < 0)
    return 0;

  const std::uint64_t read =
      DiscIO::ReadFile(*s_disc, s_disc->GetGamePartition(), path, buffer,
                       static_cast<std::uint64_t>(length), static_cast<std::uint64_t>(offset));
  return read > static_cast<std::uint64_t>(std::numeric_limits<int>::max()) ?
             std::numeric_limits<int>::max() :
             static_cast<int>(read);
}
}
