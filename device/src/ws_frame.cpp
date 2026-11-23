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

#include "ws_frame.h"

#include <algorithm>
#include <cstring>

namespace ws
{

static constexpr uint8_t FIN_BIT = 0x80;
static constexpr uint8_t RSV_BITS = 0x70;
static constexpr uint8_t OPCODE_BITS = 0x0F;
static constexpr uint8_t MASK_BIT = 0x80;
static constexpr uint8_t LENGTH_BITS = 0x7F;
static constexpr uint8_t LENGTH_16 = 126;
static constexpr uint8_t LENGTH_64 = 127;

static bool is_control(Opcode opcode)
{
    return (static_cast<unsigned>(opcode) & 0x08U) != 0;
}

static bool is_known_opcode(uint8_t opcode)
{
    switch (static_cast<Opcode>(opcode))
    {
    case Opcode::CONTINUATION:
    case Opcode::TEXT:
    case Opcode::BINARY:
    case Opcode::CLOSE:
    case Opcode::PING:
    case Opcode::PONG:
        return true;
    }
    return false;
}

void encode_frame(std::vector<uint8_t> &out, Opcode opcode, const uint8_t *payload, std::size_t length,
                  const std::array<uint8_t, 4> &mask, bool fin)
{
    const std::size_t header = 2 + (length < LENGTH_16 ? 0 : length <= 0xFFFF ? 2 : 8) + mask.size();
    out.reserve(out.size() + header + length);
    out.push_back(static_cast<uint8_t>((fin ? FIN_BIT : 0U) | static_cast<unsigned>(opcode)));

    if (length < LENGTH_16)
    {
        out.push_back(static_cast<uint8_t>(MASK_BIT | length));
    }
    else if (length <= 0xFFFF)
    {
        out.push_back(MASK_BIT | LENGTH_16);
        out.push_back(static_cast<uint8_t>(length >> 8U));
        out.push_back(static_cast<uint8_t>(length));
    }
    else
    {
        out.push_back(MASK_BIT | LENGTH_64);
        const auto wide = static_cast<uint64_t>(length);
        for (unsigned byte = 8; byte-- > 0;)
        {
            out.push_back(static_cast<uint8_t>(wide >> (8U * byte)));
        }
    }

    out.insert(out.end(), mask.begin(), mask.end());
    // One allocation of exactly the right size: growing a 64 KB frame a byte
    // at a time would briefly need twice that, more than the board has spare
    const auto start = out.size();
    out.resize(start + length);
    for (std::size_t i = 0; i < length; i++)
    {
        out[start + i] = payload[i] ^ mask[i % 4];
    }
}

void encode_close(std::vector<uint8_t> &out, uint16_t code, const std::array<uint8_t, 4> &mask)
{
    if (code == CLOSE_NO_STATUS)
    {
        encode_frame(out, Opcode::CLOSE, nullptr, 0, mask);
        return;
    }
    const std::array<uint8_t, 2> payload = {static_cast<uint8_t>(code >> 8U), static_cast<uint8_t>(code)};
    encode_frame(out, Opcode::CLOSE, payload.data(), payload.size(), mask);
}

bool is_valid_close_code(uint16_t code)
{
    // 1004-1006 and 1015 are reserved and must never be sent; 1012-1014
    // (restart, try again later, bad gateway) are registered with IANA;
    // 3000-4999 are for libraries and applications.
    return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

// --- UTF-8 -------------------------------------------------------------------

// Character classes for Bjoern Hoehrmann's UTF-8 decoder DFA
// (https://bjoern.hoehrmann.de/utf-8/decoder/dfa/)
static uint8_t utf8_class(uint8_t byte)
{
    if (byte < 0x80)
    {
        return 0;
    }
    if (byte < 0x90)
    {
        return 1;
    }
    if (byte < 0xA0)
    {
        return 9;
    }
    if (byte < 0xC0)
    {
        return 7;
    }
    if (byte < 0xC2)
    {
        return 8;
    }
    if (byte < 0xE0)
    {
        return 2;
    }
    if (byte == 0xE0)
    {
        return 10;
    }
    if (byte == 0xED)
    {
        return 4;
    }
    if (byte < 0xF0)
    {
        return 3;
    }
    if (byte == 0xF0)
    {
        return 11;
    }
    if (byte < 0xF4)
    {
        return 6;
    }
    return byte == 0xF4 ? 5 : 8;
}

// The DFA's transitions: the next state is UTF8_TRANSITIONS[state + class],
// where states are multiples of 12 (0 accepts, 12 rejects)
static constexpr std::array<uint8_t, 108> UTF8_TRANSITIONS = {
    0,  12, 24, 36, 60, 96, 84, 12, 12, 12, 48, 72, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 0,  12,
    12, 12, 12, 12, 0,  12, 0,  12, 12, 12, 24, 12, 12, 12, 12, 12, 24, 12, 24, 12, 12, 12, 12, 12, 12, 12, 12,
    12, 24, 12, 12, 12, 12, 12, 24, 12, 12, 12, 12, 12, 12, 12, 24, 12, 12, 12, 12, 12, 12, 12, 12, 12, 36, 12,
    36, 12, 12, 12, 36, 12, 12, 12, 12, 12, 36, 12, 36, 12, 12, 12, 36, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12,
};

bool Utf8Validator::feed(const uint8_t *data, std::size_t length)
{
    for (std::size_t i = 0; i < length && state_ != REJECT; i++)
    {
        state_ = UTF8_TRANSITIONS.at(state_ + utf8_class(data[i]));
    }
    return state_ != REJECT;
}

// --- Decoding ----------------------------------------------------------------

void FrameDecoder::reset()
{
    state_ = State::HEADER;
    header_have_ = 0;
    in_message_ = false;
    message_length_ = 0;
    utf8_.reset();
}

void FrameDecoder::feed(const uint8_t *data, std::size_t length, FrameSink &sink)
{
    while (length > 0 && state_ != State::DONE)
    {
        std::size_t used = 0;
        switch (state_)
        {
        case State::HEADER:
            used = take_header(data, length, sink);
            break;
        case State::LENGTH:
            used = take_length(data, length, sink);
            break;
        case State::PAYLOAD:
            used = take_payload(data, length, sink);
            break;
        case State::DONE:
            return;
        }
        data += used;
        length -= used;
    }
}

std::size_t FrameDecoder::take_header(const uint8_t *data, std::size_t length, FrameSink &sink)
{
    const auto used = std::min<std::size_t>(2 - header_have_, length);
    std::memcpy(header_.data() + header_have_, data, used);
    header_have_ += used;

    if (header_have_ < 2)
    {
        return used;
    }
    header_have_ = 0;

    if (!check_header(sink))
    {
        return used;
    }

    const auto length7 = static_cast<uint8_t>(header_[1] & LENGTH_BITS);
    if (length7 == LENGTH_16 || length7 == LENGTH_64)
    {
        length_bytes_ = length7 == LENGTH_16 ? 2 : 8;
        state_ = State::LENGTH;
        return used;
    }

    payload_length_ = length7;
    start_frame(sink);
    return used;
}

bool FrameDecoder::check_header(FrameSink &sink)
{
    fin_ = (header_[0] & FIN_BIT) != 0;
    const auto opcode = static_cast<uint8_t>(header_[0] & OPCODE_BITS);
    const auto length7 = static_cast<uint8_t>(header_[1] & LENGTH_BITS);

    // No extensions were negotiated, so no reserved bits; servers never mask
    if ((header_[0] & RSV_BITS) != 0 || !is_known_opcode(opcode) || (header_[1] & MASK_BIT) != 0)
    {
        fail(sink, CLOSE_PROTOCOL_ERROR);
        return false;
    }
    opcode_ = static_cast<Opcode>(opcode);

    // Control frames can't be fragmented and carry at most 125 bytes
    if (is_control(opcode_) && (!fin_ || length7 > MAX_CONTROL_PAYLOAD))
    {
        fail(sink, CLOSE_PROTOCOL_ERROR);
        return false;
    }
    return true;
}

std::size_t FrameDecoder::take_length(const uint8_t *data, std::size_t length, FrameSink &sink)
{
    const auto used = std::min<std::size_t>(length_bytes_ - header_have_, length);
    std::memcpy(header_.data() + header_have_, data, used);
    header_have_ += used;

    if (header_have_ < length_bytes_)
    {
        return used;
    }
    header_have_ = 0;

    payload_length_ = 0;
    for (std::size_t i = 0; i < length_bytes_; i++)
    {
        payload_length_ = (payload_length_ << 8U) | static_cast<uint64_t>(header_[i]);
    }

    // The most significant bit of a 64-bit length must be 0
    if (length_bytes_ == 8 && (static_cast<unsigned>(header_[0]) & 0x80U) != 0)
    {
        fail(sink, CLOSE_PROTOCOL_ERROR);
        return used;
    }

    start_frame(sink);
    return used;
}

bool FrameDecoder::start_frame(FrameSink &sink)
{
    payload_have_ = 0;

    if (!is_control(opcode_))
    {
        // A continuation needs a message to continue, and a new message can't
        // start in the middle of another
        if ((opcode_ == Opcode::CONTINUATION) != in_message_)
        {
            fail(sink, CLOSE_PROTOCOL_ERROR);
            return false;
        }
        if (!in_message_)
        {
            in_message_ = true;
            message_opcode_ = opcode_;
            message_length_ = 0;
            utf8_.reset();
        }
        if (payload_length_ > capacity_ - message_length_)
        {
            fail(sink, CLOSE_TOO_BIG);
            return false;
        }
    }

    if (payload_length_ == 0)
    {
        finish_frame(sink);
    }
    else
    {
        state_ = State::PAYLOAD;
    }
    return true;
}

std::size_t FrameDecoder::take_payload(const uint8_t *data, std::size_t length, FrameSink &sink)
{
    const auto used = static_cast<std::size_t>(std::min<uint64_t>(payload_length_ - payload_have_, length));

    if (is_control(opcode_))
    {
        std::memcpy(control_.data() + payload_have_, data, used);
    }
    else
    {
        std::memcpy(buffer_ + message_length_, data, used);
        message_length_ += used;
        // Reject bad text as soon as it arrives
        if (message_opcode_ == Opcode::TEXT && !utf8_.feed(data, used))
        {
            fail(sink, CLOSE_INVALID_DATA);
            return used;
        }
    }
    payload_have_ += used;

    if (payload_have_ == payload_length_)
    {
        finish_frame(sink);
    }
    return used;
}

void FrameDecoder::finish_frame(FrameSink &sink)
{
    state_ = State::HEADER;

    if (is_control(opcode_))
    {
        finish_control(sink);
        return;
    }
    if (!fin_)
    {
        return;
    }
    if (message_opcode_ == Opcode::TEXT && !utf8_.complete())
    {
        fail(sink, CLOSE_INVALID_DATA);
        return;
    }
    in_message_ = false;
    sink.on_message(message_opcode_, buffer_, message_length_);
}

void FrameDecoder::finish_control(FrameSink &sink)
{
    const auto length = static_cast<std::size_t>(payload_length_);

    switch (opcode_)
    {
    case Opcode::PING:
        sink.on_ping(control_.data(), length);
        return;
    case Opcode::PONG:
        sink.on_pong(control_.data(), length);
        return;
    case Opcode::CLOSE:
        break;
    case Opcode::CONTINUATION:
    case Opcode::TEXT:
    case Opcode::BINARY:
        return;
    }

    if (length == 0)
    {
        state_ = State::DONE;
        sink.on_close(CLOSE_NO_STATUS, nullptr, 0);
        return;
    }

    const auto code = static_cast<uint16_t>((static_cast<unsigned>(control_[0]) << 8U) | control_[1]);
    if (length == 1 || !is_valid_close_code(code))
    {
        fail(sink, CLOSE_PROTOCOL_ERROR);
        return;
    }

    Utf8Validator reason;
    if (!reason.feed(control_.data() + 2, length - 2) || !reason.complete())
    {
        fail(sink, CLOSE_INVALID_DATA);
        return;
    }

    state_ = State::DONE;
    sink.on_close(code, control_.data() + 2, length - 2);
}

void FrameDecoder::fail(FrameSink &sink, uint16_t code)
{
    state_ = State::DONE;
    sink.on_error(code);
}

} // namespace ws
