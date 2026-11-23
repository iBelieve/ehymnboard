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

// The client side of the RFC 6455 opening handshake: the HTTP Upgrade request
// and the check of the server's 101 answer, with the SHA-1 and base64 it
// needs. No pico-sdk dependencies, so it's unit tested on the host (see
// test/).

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace ws
{

std::array<uint8_t, 20> sha1(const uint8_t *data, std::size_t length);

std::string base64_encode(const uint8_t *data, std::size_t length);

// The Sec-WebSocket-Key for 16 random bytes
std::string make_key(const std::array<uint8_t, 16> &random);

// The Sec-WebSocket-Accept a server must answer `key` with
std::string expected_accept(std::string_view key);

// The GET request that asks `host` to upgrade `target` (a path and query) to
// a WebSocket, with `user_agent` when it isn't empty. The Host header carries
// `port` unless it's the scheme's default: 443 for wss:// (`secure`), 80 for
// ws:// (RFC 9110 section 7.2)
std::string build_upgrade_request(std::string_view host, uint16_t port, bool secure, std::string_view target,
                                  std::string_view key, std::string_view user_agent);

enum class HandshakeResult : uint8_t
{
    OK,
    // The status line isn't HTTP/1.1 101
    BAD_STATUS,
    // Upgrade isn't websocket or Connection doesn't include upgrade
    NOT_UPGRADED,
    // Sec-WebSocket-Accept is missing or wrong
    BAD_ACCEPT,
    // The server picked an extension or subprotocol we never offered
    UNEXPECTED_EXTENSION,
};

// Checks the server's response head (status line and headers, up to and
// including the blank line) to the request made with `key`
HandshakeResult check_upgrade_response(std::string_view head, std::string_view key);

// The status code in a response head's status line, or 0 if there isn't one
int response_status(std::string_view head);

} // namespace ws
