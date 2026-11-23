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

#include "ws_handshake.h"

#include <string>

#include "http_headers.h"

namespace ws
{

// --- SHA-1 (FIPS 180-4) ------------------------------------------------------

static uint32_t rotl(uint32_t value, unsigned bits)
{
    return (value << bits) | (value >> (32U - bits));
}

static void sha1_block(std::array<uint32_t, 5> &h, const uint8_t *block)
{
    std::array<uint32_t, 80> w{};
    for (std::size_t i = 0; i < 16; i++)
    {
        w.at(i) = (static_cast<uint32_t>(block[4 * i]) << 24U) | (static_cast<uint32_t>(block[4 * i + 1]) << 16U) |
                  (static_cast<uint32_t>(block[4 * i + 2]) << 8U) | static_cast<uint32_t>(block[4 * i + 3]);
    }
    for (std::size_t i = 16; i < 80; i++)
    {
        w.at(i) = rotl(w.at(i - 3) ^ w.at(i - 8) ^ w.at(i - 14) ^ w.at(i - 16), 1);
    }

    uint32_t a = h[0];
    uint32_t b = h[1];
    uint32_t c = h[2];
    uint32_t d = h[3];
    uint32_t e = h[4];

    for (std::size_t i = 0; i < 80; i++)
    {
        uint32_t f = 0;
        uint32_t k = 0;
        if (i < 20)
        {
            f = (b & c) | (~b & d);
            k = 0x5A827999;
        }
        else if (i < 40)
        {
            f = b ^ c ^ d;
            k = 0x6ED9EBA1;
        }
        else if (i < 60)
        {
            f = (b & c) | (b & d) | (c & d);
            k = 0x8F1BBCDC;
        }
        else
        {
            f = b ^ c ^ d;
            k = 0xCA62C1D6;
        }
        const uint32_t temp = rotl(a, 5) + f + e + k + w.at(i);
        e = d;
        d = c;
        c = rotl(b, 30);
        b = a;
        a = temp;
    }

    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
}

std::array<uint8_t, 20> sha1(const uint8_t *data, std::size_t length)
{
    std::array<uint32_t, 5> h = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};

    std::size_t offset = 0;
    for (; offset + 64 <= length; offset += 64)
    {
        sha1_block(h, data + offset);
    }

    // The rest, a 1 bit, zeros, then the length in bits: one or two blocks
    std::array<uint8_t, 128> tail{};
    const std::size_t rest = length - offset;
    for (std::size_t i = 0; i < rest; i++)
    {
        tail.at(i) = data[offset + i];
    }
    tail.at(rest) = 0x80;
    const std::size_t tail_length = rest + 9 <= 64 ? 64 : 128;
    const uint64_t bits = static_cast<uint64_t>(length) * 8;
    for (std::size_t i = 0; i < 8; i++)
    {
        tail.at(tail_length - 1 - i) = static_cast<uint8_t>(bits >> (8 * i));
    }
    for (std::size_t block = 0; block < tail_length; block += 64)
    {
        sha1_block(h, tail.data() + block);
    }

    std::array<uint8_t, 20> digest{};
    for (std::size_t i = 0; i < 20; i++)
    {
        digest.at(i) = static_cast<uint8_t>(h.at(i / 4) >> (24 - 8 * (i % 4)));
    }
    return digest;
}

// --- base64 (RFC 4648) -------------------------------------------------------

std::string base64_encode(const uint8_t *data, std::size_t length)
{
    static constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    std::string out;
    out.reserve((length + 2) / 3 * 4);
    for (std::size_t i = 0; i < length; i += 3)
    {
        const std::size_t n = length - i < 3 ? length - i : 3;
        uint32_t group = static_cast<uint32_t>(data[i]) << 16U;
        if (n > 1)
        {
            group |= static_cast<uint32_t>(data[i + 1]) << 8U;
        }
        if (n > 2)
        {
            group |= static_cast<uint32_t>(data[i + 2]);
        }
        out += alphabet[(group >> 18U) & 0x3FU];
        out += alphabet[(group >> 12U) & 0x3FU];
        out += n > 1 ? alphabet[(group >> 6U) & 0x3FU] : '=';
        out += n > 2 ? alphabet[group & 0x3FU] : '=';
    }
    return out;
}

// --- Handshake ---------------------------------------------------------------

std::string make_key(const std::array<uint8_t, 16> &random)
{
    return base64_encode(random.data(), random.size());
}

std::string expected_accept(std::string_view key)
{
    static constexpr std::string_view guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    std::string input(key);
    input += guid;
    const auto digest = sha1(reinterpret_cast<const uint8_t *>(input.data()), input.size());
    return base64_encode(digest.data(), digest.size());
}

std::string build_upgrade_request(std::string_view host, uint16_t port, std::string_view target, std::string_view key,
                                  std::string_view user_agent)
{
    constexpr uint16_t DEFAULT_PORT = 80;

    std::string request = "GET ";
    request += target;
    request += " HTTP/1.1\r\nHost: ";
    request += host;
    if (port != DEFAULT_PORT)
    {
        request += ':';
        request += std::to_string(port);
    }
    request += "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ";
    request += key;
    request += "\r\nSec-WebSocket-Version: 13\r\n";
    if (!user_agent.empty())
    {
        request += "User-Agent: ";
        request += user_agent;
        request += "\r\n";
    }
    request += "\r\n";
    return request;
}

int response_status(std::string_view head)
{
    // "HTTP/1.1 101 Switching Protocols"
    constexpr std::string_view prefix = "HTTP/1.1 ";
    if (head.substr(0, prefix.size()) != prefix || head.size() < prefix.size() + 3)
    {
        return 0;
    }
    int status = 0;
    for (std::size_t i = prefix.size(); i < prefix.size() + 3; i++)
    {
        const char c = head[i];
        if (c < '0' || c > '9')
        {
            return 0;
        }
        status = status * 10 + (c - '0');
    }
    const auto after = prefix.size() + 3;
    if (head.size() > after && head[after] != ' ' && head[after] != '\r')
    {
        return 0;
    }
    return status;
}

HandshakeResult check_upgrade_response(std::string_view head, std::string_view key)
{
    if (response_status(head) != 101)
    {
        return HandshakeResult::BAD_STATUS;
    }

    const auto upgrade = find_header(head, "upgrade");
    const auto connection = find_header(head, "connection");
    if (!upgrade || !header_has_token(*upgrade, "websocket") || !connection ||
        !header_has_token(*connection, "upgrade"))
    {
        return HandshakeResult::NOT_UPGRADED;
    }

    const auto accept = find_header(head, "sec-websocket-accept");
    if (!accept || *accept != expected_accept(key))
    {
        return HandshakeResult::BAD_ACCEPT;
    }

    if (find_header(head, "sec-websocket-extensions") || find_header(head, "sec-websocket-protocol"))
    {
        return HandshakeResult::UNEXPECTED_EXTENSION;
    }

    return HandshakeResult::OK;
}

} // namespace ws
