// Copyright 2026
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <atomic>
#include <bit>
#include <cstdint>

// Direct pad input: the page's main thread writes each port's state into this
// block of the core's shared memory (seqlock), and the SI poll reads it at
// once, without waiting for the worker's presentation loop to copy it in
// (up to one display frame later). Streaming guests' presses also arrive as
// "taps": rising edges recovered from press counters, which the poll keeps
// visible until a poll of a later frame has reported them, so a press shorter
// than a poll interval, or squeezed together with its release by network
// jitter, is still read by the game. The core writes back what each poll
// read, for the guests' feedback (applied input sequence, reception → poll
// delay) and for tests (rising edges reported per button), plus the rumble
// state the game set.
//
// Layout: DIRECT_PAD_PORTS blocks of DIRECT_PAD_SLOTS 32-bit slots. Mirror in
// src/direct-pad.js; bump DIRECT_PAD_LAYOUT on any change.
namespace DolphinWeb::DirectPad
{
constexpr std::uint32_t DIRECT_PAD_LAYOUT = 2;
constexpr int DIRECT_PAD_PORTS = 4;
constexpr int DIRECT_PAD_SLOTS = 36;  // 144 bytes: f64 slots stay 8-byte aligned
constexpr int DIRECT_PAD_BUTTONS = 12;

enum Slot : int
{
  // Written by the page.
  SEQ = 0,        // seqlock: odd while the page writes
  ENABLED = 1,    // 1 once the page writes this port here
  CONNECTED = 2,
  MASK = 3,
  AXES0 = 4,      // stickX | stickY << 8 | cStickX << 16 | cStickY << 24
  AXES1 = 5,      // triggerL | triggerR << 8 | analogA << 16 | analogB << 24
  TAPS = 6,       // presses to inject, 4-bit count per button: buttons 0-7 here,
                  // 8-11 in TAPS_HIGH; page: compare-exchange add (saturating);
                  // core: exchange(0) at a poll
  INPUT_SEQ = 7,  // caller's sequence number for this state (stream guest seq)
  RX_TIME = 8,    // f64 (slots 8-9): reception time, ms, performance.timeOrigin + now()
  // Written by the core at each poll (once per emulated tick).
  APPLIED_SEQ = 10,
  POLL_COUNT = 11,
  APPLIED_RX_TIME = 12,  // f64 (12-13)
  POLL_TIME = 14,        // f64 (14-15), emscripten_get_now(): same epoch as RX_TIME
  RUMBLE = 16,           // 0 off, 1 on (the game's CMD_WRITE, via Pad::Rumble)
  RUMBLE_GEN = 17,       // +1 per rumble change
  PRESSES = 18,          // 18-29: rising edges reported, per button
  REPORTED_MASK = 30,
  TAPS_HIGH = 31,
  EDGE_POLL_TIME = 32,   // f64 (32-33): poll time of the last rising edge reported
};

struct Block
{
  std::atomic<std::uint32_t> slots[DIRECT_PAD_PORTS][DIRECT_PAD_SLOTS];
};
static_assert(sizeof(Block) == DIRECT_PAD_PORTS * DIRECT_PAD_SLOTS * 4);

struct State
{
  bool connected = false;
  std::uint32_t mask = 0;
  std::uint32_t axes0 = 0x80808080u;
  std::uint32_t axes1 = 0;
  std::uint32_t input_seq = 0;
  double rx_time = 0;
};

inline double LoadF64(const std::atomic<std::uint32_t>* s)
{
  const std::uint64_t lo = s[0].load(std::memory_order_relaxed);
  const std::uint64_t hi = s[1].load(std::memory_order_relaxed);
  return std::bit_cast<double>(lo | (hi << 32));
}

inline void StoreF64(std::atomic<std::uint32_t>* s, double v)
{
  const std::uint64_t bits = std::bit_cast<std::uint64_t>(v);
  s[0].store(static_cast<std::uint32_t>(bits), std::memory_order_relaxed);
  s[1].store(static_cast<std::uint32_t>(bits >> 32), std::memory_order_relaxed);
}

// False when the page never wrote this port, or kept writing during every
// attempt (the caller then falls back to the presentation-loop copy).
inline bool Read(const std::atomic<std::uint32_t>* port, State* out, int attempts = 4)
{
  if (port[ENABLED].load(std::memory_order_acquire) != 1)
    return false;
  for (int i = 0; i < attempts; ++i)
  {
    const std::uint32_t before = port[SEQ].load(std::memory_order_acquire);
    if (before & 1)
      continue;
    State s;
    s.connected = port[CONNECTED].load(std::memory_order_relaxed) != 0;
    s.mask = port[MASK].load(std::memory_order_relaxed);
    s.axes0 = port[AXES0].load(std::memory_order_relaxed);
    s.axes1 = port[AXES1].load(std::memory_order_relaxed);
    s.input_seq = port[INPUT_SEQ].load(std::memory_order_relaxed);
    s.rx_time = LoadF64(port + RX_TIME);
    std::atomic_thread_fence(std::memory_order_acquire);
    if (port[SEQ].load(std::memory_order_relaxed) == before)
    {
      *out = s;
      return true;
    }
  }
  return false;
}

// Minimum hold (research/deep-stream-input.md §8.6 step 5; reference
// implementation and tests: Salon's PollLatch). A tap stays reported until a
// poll of a later frame window has reported it. A second tap of a button
// still held by the latch is not merged into the first: it waits, the button
// then reads released for one window, and the tap is reported again (up to
// MAX_PENDING_TAPS queued per button).
class TapLatch
{
public:
  static constexpr std::uint8_t MAX_PENDING_TAPS = 3;

  // `taps`: one press per set bit (bitmask callers).
  std::uint32_t Poll(std::uint32_t state_mask, std::uint32_t taps, std::uint64_t frame)
  {
    std::uint8_t counts[DIRECT_PAD_BUTTONS]{};
    for (int i = 0; i < DIRECT_PAD_BUTTONS; ++i)
      counts[i] = (taps >> i) & 1;
    return PollCounts(state_mask, counts, frame);
  }

  // `counts[i]` presses of button i since the last poll (a lossy channel
  // may reveal several at once): the first is reported now, the others are
  // queued, each after a release window.
  std::uint32_t PollCounts(std::uint32_t state_mask, const std::uint8_t* counts, std::uint64_t frame)
  {
    for (int i = 0; i < DIRECT_PAD_BUTTONS; ++i)
    {
      const std::uint32_t bit = 1u << i;
      // A release gap is over: the queued tap goes out now.
      if ((m_gap & bit) && frame > m_gap_at[i])
      {
        m_gap &= ~bit;
        --m_pending[i];
        Arm(i, frame);
      }
      for (std::uint8_t n = 0; n < counts[i]; ++n)
      {
        if ((m_latched | m_gap) & bit)
        {
          if (m_pending[i] < MAX_PENDING_TAPS)
            ++m_pending[i];
        }
        else
        {
          Arm(i, frame);
        }
      }
    }
    const std::uint32_t reported = state_mask | m_latched;
    for (int i = 0; i < DIRECT_PAD_BUTTONS; ++i)
    {
      const std::uint32_t bit = 1u << i;
      if (!(m_latched & bit) || frame <= m_armed_at[i])
        continue;
      m_latched &= ~bit;
      if (m_pending[i])
      {
        m_gap |= bit;
        m_gap_at[i] = frame;
      }
    }
    return reported;
  }

  void Clear()
  {
    m_latched = 0;
    m_gap = 0;
    for (auto& p : m_pending)
      p = 0;
  }

private:
  void Arm(int i, std::uint64_t frame)
  {
    m_latched |= 1u << i;
    m_armed_at[i] = frame;
  }

  std::uint32_t m_latched = 0;
  std::uint32_t m_gap = 0;
  std::uint64_t m_armed_at[DIRECT_PAD_BUTTONS]{};
  std::uint64_t m_gap_at[DIRECT_PAD_BUTTONS]{};
  std::uint8_t m_pending[DIRECT_PAD_BUTTONS]{};
};

// The buttons the poll reports: the state's own mask (digital stick bits
// included) plus the held taps; nothing when unplugged.
inline std::uint32_t ComposeMask(const State& s, std::uint32_t reported)
{
  return s.connected ? (s.mask | (reported & ((1u << DIRECT_PAD_BUTTONS) - 1))) : 0;
}

// What one poll of a port does with the block: read the state (or fall back),
// consume the taps, apply the hold, and write back what was read.
// `fallback` is called when the page does not write this port here.
template <typename Fallback>
State PollPort(std::atomic<std::uint32_t>* port, TapLatch& latch, std::uint64_t frame, double now,
               Fallback&& fallback, std::uint32_t* reported_mask, bool* direct)
{
  State s;
  *direct = Read(port, &s);
  if (!*direct)
    s = fallback();
  std::uint8_t counts[DIRECT_PAD_BUTTONS]{};
  if (*direct)
  {
    const std::uint32_t low = port[TAPS].exchange(0, std::memory_order_acq_rel);
    const std::uint32_t high = port[TAPS_HIGH].exchange(0, std::memory_order_acq_rel);
    for (int i = 0; i < DIRECT_PAD_BUTTONS; ++i)
      counts[i] = static_cast<std::uint8_t>(((i < 8 ? low >> (4 * i) : high >> (4 * (i - 8)))) & 0xf);
  }
  std::uint32_t reported;
  if (s.connected)
  {
    reported = latch.PollCounts(s.mask, counts, frame);
  }
  else
  {
    latch.Clear();
    reported = 0;
  }
  *reported_mask = reported;
  const std::uint32_t previous = port[REPORTED_MASK].load(std::memory_order_relaxed);
  const std::uint32_t rising = reported & ~previous;
  for (int i = 0; i < DIRECT_PAD_BUTTONS; ++i)
    if (rising & (1u << i))
      port[PRESSES + i].fetch_add(1, std::memory_order_relaxed);
  if (rising)
    StoreF64(port + EDGE_POLL_TIME, now);
  port[REPORTED_MASK].store(reported, std::memory_order_relaxed);
  if (*direct)
  {
    port[APPLIED_SEQ].store(s.input_seq, std::memory_order_relaxed);
    StoreF64(port + APPLIED_RX_TIME, s.rx_time);
  }
  StoreF64(port + POLL_TIME, now);
  port[POLL_COUNT].fetch_add(1, std::memory_order_release);
  return s;
}
}  // namespace DolphinWeb::DirectPad
