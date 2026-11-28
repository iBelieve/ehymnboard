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

// The board's WebSocket to the server: a WsClient plus a listener that
// collects what arrives (in lwIP's callbacks) until the main loop picks it up.

#include <array>
#include <cstdint>
#include <optional>

#include "board_messages.h"
#include "ws_client.h"

class BoardLink : private WsClient::Listener
{
  public:
    // What happened since the last call
    struct Events
    {
        // The latest state message, if any arrived
        std::optional<BoardState> state;
        bool pong = false;
        // The server asked for a diagnostics snapshot
        bool diag = false;
        // The server asked for every panel to be redrawn
        bool redraw = false;
        // The socket closed, and why
        std::optional<SocketEndInfo> closed;
    };

    BoardLink();

    // Takes the events collected so far
    Events take_events();

    WsClient &client()
    {
        return client_;
    }

  private:
    void on_open() override;
    void on_message(ws::Opcode opcode, const uint8_t *data, std::size_t length) override;
    void on_closed(const SocketEndInfo &end) override;

    std::array<uint8_t, MAX_BOARD_MESSAGE> buffer_{};
    WsClient client_;
    Events events_;
};
