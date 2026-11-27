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

#include "board_link.h"

#include <cstdio>
#include <string_view>

#include "pico/cyw43_arch.h"

BoardLink::BoardLink() : client_(buffer_.data(), buffer_.size(), *this)
{
}

BoardLink::Events BoardLink::take_events()
{
    cyw43_arch_lwip_begin();
    Events events = events_;
    events_ = Events{};
    cyw43_arch_lwip_end();
    return events;
}

void BoardLink::on_open()
{
    printf("WS: connected, waiting for the board state\n");
}

void BoardLink::on_message(ws::Opcode opcode, const uint8_t *data, std::size_t length)
{
    if (opcode != ws::Opcode::TEXT)
    {
        return;
    }
    const std::string_view message(reinterpret_cast<const char *>(data), length);
    const auto type = message_type(message);

    if (type == PONG_MESSAGE)
    {
        events_.pong = true;
    }
    else if (type == REDRAW_MESSAGE)
    {
        events_.redraw = true;
    }
    else if (type == "state")
    {
        auto state = parse_state_message(message);
        if (state)
        {
            events_.state = std::move(state);
        }
        else
        {
            printf("WS: ignoring state message: %.*s\n", static_cast<int>(length), data);
        }
    }
}

void BoardLink::on_closed()
{
    events_.closed = true;
}
