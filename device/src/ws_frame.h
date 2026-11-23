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

// The client side of RFC 6455 WebSocket framing: encoding the frames a client
// sends (always masked) and incrementally decoding the frames a server sends
// (never masked), with message reassembly, control frames and UTF-8
// validation. No pico-sdk dependencies, so it's unit tested on the host (see
// test/) and checked against the Autobahn test suite.

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace ws
{

enum class Opcode : uint8_t
{
    CONTINUATION = 0x0,
    TEXT = 0x1,
    BINARY = 0x2,
    CLOSE = 0x8,
    PING = 0x9,
    PONG = 0xA,
};

// Close codes this client sends (RFC 6455 section 7.4.1)
inline constexpr uint16_t CLOSE_NORMAL = 1000;
inline constexpr uint16_t CLOSE_PROTOCOL_ERROR = 1002;
inline constexpr uint16_t CLOSE_INVALID_DATA = 1007;
inline constexpr uint16_t CLOSE_TOO_BIG = 1009;
// The code a received close frame without a payload stands for; never sent
inline constexpr uint16_t CLOSE_NO_STATUS = 1005;

// Control frames carry at most this many payload bytes
inline constexpr std::size_t MAX_CONTROL_PAYLOAD = 125;

// Appends one masked client frame to `out`. `fin` is false for every fragment
// of a fragmented message but the last.
void encode_frame(std::vector<uint8_t> &out, Opcode opcode, const uint8_t *payload, std::size_t length,
                  const std::array<uint8_t, 4> &mask, bool fin = true);

// Appends a masked close frame with `code` (and no reason) to `out`. A
// CLOSE_NO_STATUS code gives an empty close frame.
void encode_close(std::vector<uint8_t> &out, uint16_t code, const std::array<uint8_t, 4> &mask);

// Whether a close code received from the server is one an endpoint may send
bool is_valid_close_code(uint16_t code);

// Validates UTF-8 a piece at a time (Bjoern Hoehrmann's DFA), so a message can
// be rejected as soon as its first bad byte arrives.
class Utf8Validator
{
  public:
    // Returns false once the bytes seen so far can't be the start of valid
    // UTF-8 (and keeps returning false until reset)
    bool feed(const uint8_t *data, std::size_t length);
    // True when everything fed so far is complete, valid UTF-8
    bool complete() const
    {
        return state_ == ACCEPT;
    }
    void reset()
    {
        state_ = ACCEPT;
    }

  private:
    static constexpr uint8_t ACCEPT = 0;
    static constexpr uint8_t REJECT = 12;
    uint8_t state_ = ACCEPT;
};

// What the decoder hands to its owner. Each pointer is only valid during the
// call.
class FrameSink
{
  public:
    virtual ~FrameSink() = default;
    // A complete text (validated UTF-8) or binary message
    virtual void on_message(Opcode opcode, const uint8_t *data, std::size_t length) = 0;
    virtual void on_ping(const uint8_t *data, std::size_t length) = 0;
    virtual void on_pong(const uint8_t *data, std::size_t length) = 0;
    // The server's close frame: CLOSE_NO_STATUS if it had no code. The reason
    // is validated UTF-8.
    virtual void on_close(uint16_t code, const uint8_t *reason, std::size_t length) = 0;
    // The server broke the protocol; the connection must be failed with
    // `close_code`. Nothing more is decoded after this.
    virtual void on_error(uint16_t close_code) = 0;
};

// Decodes the byte stream from a server, however it's split up. Messages are
// assembled in a buffer the owner provides; a message bigger than it fails
// the connection with CLOSE_TOO_BIG.
class FrameDecoder
{
  public:
    FrameDecoder(uint8_t *buffer, std::size_t capacity) : buffer_(buffer), capacity_(capacity)
    {
    }

    // Feeds bytes in order. Stops at the first error or after a close frame,
    // and ignores everything fed after that.
    void feed(const uint8_t *data, std::size_t length, FrameSink &sink);

    // Starts over for a new connection
    void reset();

    bool failed() const
    {
        return state_ == State::DONE;
    }

  private:
    enum class State : uint8_t
    {
        HEADER,
        LENGTH,
        PAYLOAD,
        DONE,
    };

    std::size_t take_header(const uint8_t *data, std::size_t length, FrameSink &sink);
    std::size_t take_length(const uint8_t *data, std::size_t length, FrameSink &sink);
    std::size_t take_payload(const uint8_t *data, std::size_t length, FrameSink &sink);
    bool start_frame(FrameSink &sink);
    bool check_header(FrameSink &sink);
    void finish_frame(FrameSink &sink);
    void finish_control(FrameSink &sink);
    void fail(FrameSink &sink, uint16_t code);

    uint8_t *buffer_;
    std::size_t capacity_;

    State state_ = State::HEADER;
    std::array<uint8_t, 8> header_{};
    std::size_t header_have_ = 0;
    std::size_t length_bytes_ = 0;

    // The frame being decoded
    bool fin_ = false;
    Opcode opcode_ = Opcode::CONTINUATION;
    uint64_t payload_length_ = 0;
    uint64_t payload_have_ = 0;

    // The message being assembled across fragments
    bool in_message_ = false;
    Opcode message_opcode_ = Opcode::TEXT;
    std::size_t message_length_ = 0;
    Utf8Validator utf8_;

    std::array<uint8_t, MAX_CONTROL_PAYLOAD> control_{};
};

} // namespace ws
