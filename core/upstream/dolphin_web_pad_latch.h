// Copyright 2026
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <cstdint>

namespace DolphinWeb
{
// One SI command polls a controller more than once at the same emulated tick:
// CSIDevice_GCController::RunBuffer checks isConnected, then GetData polls
// again for CMD_DIRECT and its 8-byte answer is sent even if that second poll
// fails. The latch makes every poll of one port at one tick report the same
// snapshot, so a host unplugging the port between the two polls cannot
// produce a "connected" check followed by an uninitialized answer. The change
// shows at the next tick.
template <typename Snapshot>
class PadLatch
{
public:
  template <typename Read>
  Snapshot Poll(std::uint64_t ticks, Read&& read)
  {
    if (!m_valid || ticks != m_ticks)
    {
      m_value = read();
      m_ticks = ticks;
      m_valid = true;
    }
    return m_value;
  }

private:
  Snapshot m_value{};
  std::uint64_t m_ticks = 0;
  bool m_valid = false;
};
}  // namespace DolphinWeb
