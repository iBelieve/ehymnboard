/*
 * eHymnBoard device firmware
 * Copyright (C) 2026  Michael Spencer <sonrisesoftware@gmail.com>

 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.

 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.

 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

#pragma once

// When the board connects, pings, gives up on a dead socket, backs off and
// reboots: the WebSocket connection's state machine, with time passed in so
// it's unit tested on the host (see test/). ws_client does the networking;
// main.cpp feeds its events in here and carries out the actions.

#include <cstdint>
#include <string_view>

// A jitter seed from the board's ID, so each board backs off differently
uint32_t jitter_seed_for(std::string_view board_id);

class ConnectionPolicy
{
  public:
    // Send "ping" this often, and give up on the socket if "pong" doesn't come
    // back in time. Cloudflare closes sockets idle for 100 s.
    static constexpr uint64_t PING_INTERVAL_MS = 30'000;
    static constexpr uint64_t PONG_TIMEOUT_MS = 10'000;
    // DNS, TCP, TLS, the upgrade and the first state message
    static constexpr uint64_t CONNECT_TIMEOUT_MS = 30'000;
    // Retry delays double from the first to the last, then stay there, each
    // with +-50% jitter so boards don't all reconnect at once
    static constexpr uint64_t BACKOFF_FIRST_MS = 1000;
    static constexpr uint64_t BACKOFF_MAX_MS = 60'000;
    // A socket that stays up this long resets the backoff
    static constexpr uint64_t STABLE_MS = 60'000;
    // Reboot after this long without a live socket
    static constexpr uint64_t REBOOT_AFTER_MS = 180'000;

    enum class State : uint8_t
    {
        // Waiting to connect
        BACKOFF,
        // Connecting, upgrading, waiting for the first state message
        CONNECTING,
        // Got a state message; pinging
        LIVE,
    };

    enum class Action : uint8_t
    {
        NONE,
        CONNECT,
        SEND_PING,
        // Abort the socket, then report it with on_closed()
        ABORT,
        REBOOT,
    };

    // `jitter_seed` spreads boards out (any value; 0 is fine). Starts ready to
    // connect at `now_ms`.
    ConnectionPolicy(uint32_t jitter_seed, uint64_t now_ms);

    // What to do now. Call often (every 100 ms or so).
    Action poll(uint64_t now_ms);

    // The first state message on a new socket
    void on_live(uint64_t now_ms);
    void on_pong();
    // The socket closed, failed to connect, or was aborted
    void on_closed(uint64_t now_ms);

    State state() const
    {
        return state_;
    }

    // When the next connection attempt is due (while in BACKOFF)
    uint64_t retry_at() const
    {
        return retry_at_;
    }

  private:
    uint64_t next_delay();
    uint32_t next_random();

    State state_ = State::BACKOFF;
    uint32_t random_;
    uint32_t attempts_ = 0;

    uint64_t retry_at_;
    uint64_t connect_started_ = 0;
    uint64_t live_since_ = 0;
    // Since boot, or since the last live socket went away
    uint64_t down_since_;

    uint64_t last_ping_ = 0;
    bool awaiting_pong_ = false;
};
