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

// The messages the board and the server exchange over the WebSocket (see
// web/src/worker/hymn-board.ts): short text, space-separated, so no JSON
// parser is needed. No pico-sdk dependencies, so it's unit tested on the host
// (see test/).
//
//   server -> board  "state 1 <etag1> <etag2> <etag3> <firmware version or ->"
//   board -> server  "ping"  (answered "pong" without waking the server)
//   board -> server  "shown <etag1> <etag2> <etag3>"
//   server -> board  "redraw"  (nightly: download every panel's image again,
//                               with &redraw=1, and redraw it with a full
//                               refresh, which clears any ghosting)
//   server -> board  "diag"  (the admin's "Refresh now")
//   board -> server  "diag uptime=<s> rssi=<dBm> ..." (see diagnostics.h)
//
// Unknown messages, and state messages of another version, are ignored, so
// the server can add to the protocol without breaking older boards.

#include <array>
#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

inline constexpr std::size_t SCREEN_COUNT = 3;

// The longest message either side sends; anything bigger closes the socket
inline constexpr std::size_t MAX_BOARD_MESSAGE = 256;

inline constexpr std::string_view PING_MESSAGE = "ping";
inline constexpr std::string_view PONG_MESSAGE = "pong";
inline constexpr std::string_view REDRAW_MESSAGE = "redraw";

using ScreenEtags = std::array<std::string, SCREEN_COUNT>;

// What the server wants the board to show and run
struct BoardState
{
    ScreenEtags etags;
    // Empty when the server has no firmware uploaded
    std::string firmware_version;

    bool operator==(const BoardState &other) const
    {
        return etags == other.etags && firmware_version == other.firmware_version;
    }
};

// The first word of a message
std::string_view message_type(std::string_view message);

// A version 1 state message, or nothing if `message` isn't one (or has an
// etag or version the board couldn't keep)
std::optional<BoardState> parse_state_message(std::string_view message);

std::string format_state_message(const BoardState &state);

std::string format_shown_message(const ScreenEtags &etags);

// Firmware versions are 1 to 47 letters, digits, '.', '_' or '-'
bool is_valid_firmware_version(std::string_view version);
