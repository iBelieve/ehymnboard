#include "ws_frame.h"

#include <cstdint>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <rapidcheck/gtest.h>

using ws::FrameDecoder;
using ws::Opcode;

namespace
{

using Bytes = std::vector<uint8_t>;

// Everything the decoder reported, in order, as text that's easy to compare
struct RecordingSink : ws::FrameSink
{
    std::vector<std::string> events;

    void on_message(Opcode opcode, const uint8_t *data, std::size_t length) override
    {
        events.push_back((opcode == Opcode::TEXT ? "text:" : "binary:") + std::string(data, data + length));
    }
    void on_ping(const uint8_t *data, std::size_t length) override
    {
        events.push_back("ping:" + std::string(data, data + length));
    }
    void on_pong(const uint8_t *data, std::size_t length) override
    {
        events.push_back("pong:" + std::string(data, data + length));
    }
    void on_close(uint16_t code, const uint8_t *reason, std::size_t length) override
    {
        events.push_back("close:" + std::to_string(code) + ":" + std::string(reason, reason + length));
    }
    void on_error(uint16_t close_code) override
    {
        events.push_back("error:" + std::to_string(close_code));
    }
};

// A frame as a server sends it: unmasked
Bytes server_frame(uint8_t opcode, const Bytes &payload, bool fin = true, uint8_t extra_first_byte_bits = 0)
{
    Bytes out;
    out.push_back(static_cast<uint8_t>((fin ? 0x80 : 0) | extra_first_byte_bits | opcode));
    const auto length = payload.size();
    if (length < 126)
    {
        out.push_back(static_cast<uint8_t>(length));
    }
    else if (length <= 0xFFFF)
    {
        out.push_back(126);
        out.push_back(static_cast<uint8_t>(length >> 8));
        out.push_back(static_cast<uint8_t>(length));
    }
    else
    {
        out.push_back(127);
        for (int shift = 56; shift >= 0; shift -= 8)
        {
            out.push_back(static_cast<uint8_t>(static_cast<uint64_t>(length) >> shift));
        }
    }
    out.insert(out.end(), payload.begin(), payload.end());
    return out;
}

Bytes bytes(const std::string &s)
{
    return Bytes(s.begin(), s.end());
}

Bytes concat(std::initializer_list<Bytes> parts)
{
    Bytes out;
    for (const auto &part : parts)
    {
        out.insert(out.end(), part.begin(), part.end());
    }
    return out;
}

struct Decoded
{
    std::vector<std::string> events;
    bool failed;
};

// Decodes `stream` fed in one piece, with a decoder that holds `capacity`
// bytes
Decoded decode(const Bytes &stream, std::size_t capacity = 1024)
{
    std::vector<uint8_t> buffer(capacity);
    FrameDecoder decoder(buffer.data(), buffer.size());
    RecordingSink sink;
    decoder.feed(stream.data(), stream.size(), sink);
    return {sink.events, decoder.failed()};
}

// Decodes `stream` fed in pieces of the given sizes (the rest in one piece)
std::vector<std::string> decode_split(const Bytes &stream, const std::vector<std::size_t> &sizes,
                                      std::size_t capacity = 1024)
{
    std::vector<uint8_t> buffer(capacity);
    FrameDecoder decoder(buffer.data(), buffer.size());
    RecordingSink sink;
    std::size_t offset = 0;
    for (const auto size : sizes)
    {
        const auto n = std::min(size, stream.size() - offset);
        decoder.feed(stream.data() + offset, n, sink);
        offset += n;
    }
    decoder.feed(stream.data() + offset, stream.size() - offset, sink);
    return sink.events;
}

// Unmasks a client frame, checking its header
struct ClientFrame
{
    bool fin;
    uint8_t opcode;
    Bytes payload;
    std::size_t size;
};

ClientFrame parse_client_frame(const Bytes &frame)
{
    ClientFrame out{};
    out.fin = (frame.at(0) & 0x80) != 0;
    out.opcode = frame.at(0) & 0x0F;
    EXPECT_EQ(frame.at(0) & 0x70, 0);
    EXPECT_NE(frame.at(1) & 0x80, 0) << "client frames must be masked";
    uint64_t length = frame.at(1) & 0x7F;
    std::size_t pos = 2;
    if (length == 126)
    {
        length = (frame.at(2) << 8) | frame.at(3);
        pos = 4;
        EXPECT_GE(length, 126U) << "16-bit length used for a short payload";
    }
    else if (length == 127)
    {
        length = 0;
        for (int i = 0; i < 8; i++)
        {
            length = (length << 8) | frame.at(2 + i);
        }
        pos = 10;
        EXPECT_GT(length, 0xFFFFU) << "64-bit length used for a short payload";
    }
    const std::array<uint8_t, 4> mask = {frame.at(pos), frame.at(pos + 1), frame.at(pos + 2), frame.at(pos + 3)};
    pos += 4;
    for (uint64_t i = 0; i < length; i++)
    {
        out.payload.push_back(frame.at(pos + i) ^ mask.at(i % 4));
    }
    out.size = pos + length;
    return out;
}

} // namespace

// --- Encoding ----------------------------------------------------------------

TEST(WsEncode, MasksTextFrame)
{
    // RFC 6455 section 5.7: a masked "Hello"
    Bytes out;
    const std::string hello = "Hello";
    ws::encode_frame(out, Opcode::TEXT, reinterpret_cast<const uint8_t *>(hello.data()), hello.size(),
                     {0x37, 0xfa, 0x21, 0x3d});
    EXPECT_EQ(out, (Bytes{0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58}));
}

TEST(WsEncode, UsesTheShortestLengthEncoding)
{
    for (const std::size_t length : {0U, 1U, 125U, 126U, 127U, 65535U, 65536U, 70000U})
    {
        const Bytes payload(length, 'x');
        Bytes out;
        ws::encode_frame(out, Opcode::BINARY, payload.data(), payload.size(), {1, 2, 3, 4});
        const auto frame = parse_client_frame(out);
        EXPECT_EQ(frame.size, out.size());
        EXPECT_EQ(frame.payload, payload);
        EXPECT_TRUE(frame.fin);
        EXPECT_EQ(frame.opcode, 2);
    }
}

TEST(WsEncode, Fragments)
{
    Bytes out;
    const uint8_t a = 'a';
    ws::encode_frame(out, Opcode::TEXT, &a, 1, {0, 0, 0, 0}, false);
    const auto frame = parse_client_frame(out);
    EXPECT_FALSE(frame.fin);
    EXPECT_EQ(frame.opcode, 1);
}

TEST(WsEncode, Close)
{
    Bytes out;
    ws::encode_close(out, 1000, {9, 9, 9, 9});
    auto frame = parse_client_frame(out);
    EXPECT_EQ(frame.opcode, 8);
    EXPECT_EQ(frame.payload, (Bytes{0x03, 0xE8}));

    out.clear();
    ws::encode_close(out, ws::CLOSE_NO_STATUS, {9, 9, 9, 9});
    frame = parse_client_frame(out);
    EXPECT_EQ(frame.opcode, 8);
    EXPECT_TRUE(frame.payload.empty());
}

RC_GTEST_PROP(WsEncode, RoundTripsAnyPayload, (const std::vector<uint8_t> &payload, uint32_t mask_bits, bool fin))
{
    const std::array<uint8_t, 4> mask = {static_cast<uint8_t>(mask_bits), static_cast<uint8_t>(mask_bits >> 8),
                                         static_cast<uint8_t>(mask_bits >> 16), static_cast<uint8_t>(mask_bits >> 24)};
    Bytes out;
    ws::encode_frame(out, Opcode::BINARY, payload.data(), payload.size(), mask, fin);
    const auto frame = parse_client_frame(out);
    RC_ASSERT(frame.payload == payload);
    RC_ASSERT(frame.fin == fin);
    RC_ASSERT(frame.size == out.size());
}

// --- Close codes ---------------------------------------------------------------

TEST(WsCloseCodes, ValidAndReserved)
{
    for (const uint16_t code :
         {1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 3999, 4000, 4999})
    {
        EXPECT_TRUE(ws::is_valid_close_code(code)) << code;
    }
    for (const uint16_t code : {0, 999, 1004, 1005, 1006, 1015, 1016, 1100, 2000, 2999, 5000, 65535})
    {
        EXPECT_FALSE(ws::is_valid_close_code(code)) << code;
    }
}

// --- UTF-8 -----------------------------------------------------------------------

namespace
{

// A plain, slow reference: decodes each sequence and checks its range
bool reference_utf8(const Bytes &data)
{
    std::size_t i = 0;
    while (i < data.size())
    {
        const uint8_t b = data[i];
        std::size_t n = 0;
        uint32_t cp = 0;
        uint32_t min = 0;
        if (b < 0x80)
        {
            i++;
            continue;
        }
        if ((b & 0xE0) == 0xC0)
        {
            n = 1, cp = b & 0x1F, min = 0x80;
        }
        else if ((b & 0xF0) == 0xE0)
        {
            n = 2, cp = b & 0x0F, min = 0x800;
        }
        else if ((b & 0xF8) == 0xF0)
        {
            n = 3, cp = b & 0x07, min = 0x10000;
        }
        else
        {
            return false;
        }
        if (i + n >= data.size())
        {
            return false;
        }
        for (std::size_t k = 1; k <= n; k++)
        {
            if ((data[i + k] & 0xC0) != 0x80)
            {
                return false;
            }
            cp = (cp << 6) | (data[i + k] & 0x3F);
        }
        if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF))
        {
            return false;
        }
        i += n + 1;
    }
    return true;
}

bool validate(const Bytes &data)
{
    ws::Utf8Validator v;
    return v.feed(data.data(), data.size()) && v.complete();
}

Bytes encode_code_point(uint32_t cp)
{
    if (cp < 0x80)
    {
        return {static_cast<uint8_t>(cp)};
    }
    if (cp < 0x800)
    {
        return {static_cast<uint8_t>(0xC0 | (cp >> 6)), static_cast<uint8_t>(0x80 | (cp & 0x3F))};
    }
    if (cp < 0x10000)
    {
        return {static_cast<uint8_t>(0xE0 | (cp >> 12)), static_cast<uint8_t>(0x80 | ((cp >> 6) & 0x3F)),
                static_cast<uint8_t>(0x80 | (cp & 0x3F))};
    }
    return {static_cast<uint8_t>(0xF0 | (cp >> 18)), static_cast<uint8_t>(0x80 | ((cp >> 12) & 0x3F)),
            static_cast<uint8_t>(0x80 | ((cp >> 6) & 0x3F)), static_cast<uint8_t>(0x80 | (cp & 0x3F))};
}

} // namespace

TEST(WsUtf8, KnownSequences)
{
    EXPECT_TRUE(validate(bytes("")));
    EXPECT_TRUE(validate(bytes("Hello-\xc2\xb5@\xc3\x9f\xc3\xb6\xc3\xa4\xc3\xbc\xc3\xa0\xc3\xa1-UTF-8!!")));
    EXPECT_TRUE(validate(bytes("\xce\xba\xe1\xbd\xb9\xcf\x83\xce\xbc\xce\xb5"))); // "kosme"
    EXPECT_TRUE(validate(bytes("\xf4\x8f\xbf\xbf")));                             // U+10FFFF
    EXPECT_TRUE(validate(bytes("\xef\xbf\xbf")));                                 // U+FFFF

    EXPECT_FALSE(validate(bytes("\xc0\x80")));         // overlong NUL
    EXPECT_FALSE(validate(bytes("\xe0\x80\xaf")));     // overlong '/'
    EXPECT_FALSE(validate(bytes("\xed\xa0\x80")));     // a surrogate
    EXPECT_FALSE(validate(bytes("\xf4\x90\x80\x80"))); // past U+10FFFF
    EXPECT_FALSE(validate(bytes("\xff")));
    EXPECT_FALSE(validate(bytes("\x80")));
    EXPECT_FALSE(validate(bytes("\xce\xba\xe1"))); // cut short
}

TEST(WsUtf8, RejectsAsSoonAsItCan)
{
    ws::Utf8Validator v;
    const Bytes start = bytes("\xce\xba\xe1\xbd\xb9\xcf\x83\xce\xbc\xce\xb5\xf4\x90");
    EXPECT_FALSE(v.feed(start.data(), start.size()));
    const Bytes more = bytes("abc");
    EXPECT_FALSE(v.feed(more.data(), more.size()));
    v.reset();
    EXPECT_TRUE(v.feed(more.data(), more.size()));
    EXPECT_TRUE(v.complete());
}

RC_GTEST_PROP(WsUtf8, MatchesTheReferenceOnAnyBytes, (const std::vector<uint8_t> &data))
{
    RC_ASSERT(validate(data) == reference_utf8(data));
}

RC_GTEST_PROP(WsUtf8, AcceptsAnyCodePoints, ())
{
    const auto points = *rc::gen::container<std::vector<uint32_t>>(rc::gen::suchThat(
        rc::gen::inRange<uint32_t>(0, 0x110000), [](uint32_t cp) { return cp < 0xD800 || cp > 0xDFFF; }));
    Bytes data;
    for (const auto cp : points)
    {
        const auto encoded = encode_code_point(cp);
        data.insert(data.end(), encoded.begin(), encoded.end());
    }
    RC_ASSERT(validate(data));

    // Validating in any two pieces gives the same answer
    const auto split = *rc::gen::inRange<std::size_t>(0, data.size() + 1);
    ws::Utf8Validator v;
    RC_ASSERT(v.feed(data.data(), split));
    RC_ASSERT(v.feed(data.data() + split, data.size() - split));
    RC_ASSERT(v.complete());
}

// --- Decoding --------------------------------------------------------------------

TEST(WsDecode, Messages)
{
    const auto stream =
        concat({server_frame(1, bytes("hello")), server_frame(2, Bytes{0, 1, 2}), server_frame(1, bytes(""))});
    const auto decoded = decode(stream);
    EXPECT_EQ(decoded.events, (std::vector<std::string>{"text:hello", "binary:" + std::string("\0\1\2", 3), "text:"}));
    EXPECT_FALSE(decoded.failed);
}

TEST(WsDecode, ExtendedLengths)
{
    const Bytes medium(300, 'm');
    const Bytes large(70000, 'L');
    const auto decoded = decode(concat({server_frame(2, medium), server_frame(2, large)}), 80000);
    ASSERT_EQ(decoded.events.size(), 2U);
    EXPECT_EQ(decoded.events[0], "binary:" + std::string(300, 'm'));
    EXPECT_EQ(decoded.events[1], "binary:" + std::string(70000, 'L'));
}

TEST(WsDecode, FragmentsWithControlFramesBetween)
{
    const auto stream = concat({server_frame(1, bytes("frag"), false), server_frame(9, bytes("p1")),
                                server_frame(0, bytes("men"), false), server_frame(10, bytes("p2")),
                                server_frame(0, bytes("ted"), true)});
    EXPECT_EQ(decode(stream).events, (std::vector<std::string>{"ping:p1", "pong:p2", "text:fragmented"}));
}

TEST(WsDecode, EmptyFragments)
{
    const auto stream = concat(
        {server_frame(1, bytes(""), false), server_frame(0, bytes(""), false), server_frame(0, bytes(""), true)});
    EXPECT_EQ(decode(stream).events, (std::vector<std::string>{"text:"}));
}

TEST(WsDecode, Close)
{
    auto decoded = decode(concat({server_frame(8, Bytes{0x03, 0xE8, 'b', 'y', 'e'}), server_frame(1, bytes("x"))}));
    EXPECT_EQ(decoded.events, (std::vector<std::string>{"close:1000:bye"}));
    EXPECT_TRUE(decoded.failed) << "nothing is decoded after a close";

    decoded = decode(server_frame(8, Bytes{}));
    EXPECT_EQ(decoded.events, (std::vector<std::string>{"close:1005:"}));
}

TEST(WsDecode, ProtocolErrors)
{
    const auto error = std::vector<std::string>{"error:1002"};

    // Reserved bits set
    EXPECT_EQ(decode(server_frame(1, bytes("x"), true, 0x40)).events, error);
    // Reserved opcodes
    for (const uint8_t opcode : {3, 4, 5, 6, 7, 11, 12, 13, 14, 15})
    {
        EXPECT_EQ(decode(server_frame(opcode, bytes("x"))).events, error) << int(opcode);
    }
    // A masked frame from the server
    EXPECT_EQ(decode(Bytes{0x81, 0x81, 1, 2, 3, 4, 'x'}).events, error);
    // A fragmented control frame
    EXPECT_EQ(decode(server_frame(9, bytes("x"), false)).events, error);
    // A control frame over 125 bytes
    EXPECT_EQ(decode(server_frame(9, Bytes(126, 'p'))).events, error);
    // A continuation with nothing to continue
    EXPECT_EQ(decode(server_frame(0, bytes("x"))).events, error);
    // A new message in the middle of a fragmented one
    EXPECT_EQ(decode(concat({server_frame(1, bytes("a"), false), server_frame(1, bytes("b"))})).events, error);
    // A 64-bit length with its top bit set
    EXPECT_EQ(decode(Bytes{0x82, 127, 0x80, 0, 0, 0, 0, 0, 0, 1}).events, error);
    // A close frame with a 1-byte payload, or an invalid code
    EXPECT_EQ(decode(server_frame(8, Bytes{0x03})).events, error);
    EXPECT_EQ(decode(server_frame(8, Bytes{0x03, 0xED})).events, error); // 1005
    EXPECT_EQ(decode(server_frame(8, Bytes{0x00, 0x00})).events, error);
}

TEST(WsDecode, InvalidUtf8)
{
    const auto error = std::vector<std::string>{"error:1007"};
    EXPECT_EQ(decode(server_frame(1, bytes("\xce\xba\xe1"))).events, error);
    EXPECT_EQ(decode(server_frame(8, concat({Bytes{0x03, 0xE8}, bytes("\xff")}))).events, error);

    // A bad first fragment fails before the message ends
    EXPECT_EQ(decode(server_frame(1, bytes("ok\xf4\x90"), false)).events, error);
    // Binary messages aren't checked
    EXPECT_EQ(decode(server_frame(2, bytes("\xff"))).events, (std::vector<std::string>{"binary:\xff"}));
}

TEST(WsDecode, TooBig)
{
    EXPECT_EQ(decode(server_frame(1, Bytes(11, 'x')), 10).events, (std::vector<std::string>{"error:1009"}));
    EXPECT_EQ(decode(server_frame(1, Bytes(10, 'x')), 10).events, (std::vector<std::string>{"text:xxxxxxxxxx"}));
    // Across fragments
    EXPECT_EQ(decode(concat({server_frame(1, Bytes(6, 'x'), false), server_frame(0, Bytes(6, 'x'))}), 10).events,
              (std::vector<std::string>{"error:1009"}));
    // Each message gets the whole buffer, however long the one before was
    EXPECT_EQ(decode(concat({server_frame(1, Bytes(8, 'x')), server_frame(1, Bytes(9, 'y'))}), 10).events,
              (std::vector<std::string>{"text:xxxxxxxx", "text:yyyyyyyyy"}));
}

TEST(WsDecode, StopsAfterAnError)
{
    std::vector<uint8_t> buffer(64);
    FrameDecoder decoder(buffer.data(), buffer.size());
    RecordingSink sink;
    const auto bad = server_frame(3, bytes("x"));
    decoder.feed(bad.data(), bad.size(), sink);
    const auto good = server_frame(1, bytes("x"));
    decoder.feed(good.data(), good.size(), sink);
    EXPECT_EQ(sink.events, (std::vector<std::string>{"error:1002"}));
    EXPECT_TRUE(decoder.failed());

    decoder.reset();
    decoder.feed(good.data(), good.size(), sink);
    EXPECT_EQ(sink.events, (std::vector<std::string>{"error:1002", "text:x"}));
}

namespace
{

// A random stream of valid server frames: whole text/binary messages, some
// fragmented, with pings and pongs between fragments
rc::Gen<Bytes> valid_stream()
{
    return rc::gen::map(rc::gen::container<std::vector<std::tuple<bool, std::string, uint8_t, std::string>>>(
                            rc::gen::tuple(rc::gen::arbitrary<bool>(), rc::gen::string<std::string>(),
                                           rc::gen::inRange<uint8_t>(1, 4), rc::gen::string<std::string>())),
                        [](const auto &messages) {
                            Bytes stream;
                            for (const auto &[binary, text, pieces, control] : messages)
                            {
                                // Binary payloads may be anything; text must be UTF-8, so keep it ASCII
                                std::string body = text;
                                if (!binary)
                                {
                                    for (auto &c : body)
                                    {
                                        c = static_cast<char>(static_cast<unsigned char>(c) & 0x7F);
                                    }
                                }
                                const auto piece = body.size() / pieces + 1;
                                for (std::size_t start = 0, i = 0; i == 0 || start < body.size(); i++)
                                {
                                    const auto part = body.substr(start, piece);
                                    start += piece;
                                    const bool last = start >= body.size();
                                    const uint8_t opcode = i == 0 ? (binary ? 2 : 1) : 0;
                                    const auto frame = server_frame(opcode, bytes(part), last);
                                    stream.insert(stream.end(), frame.begin(), frame.end());
                                    if (!last)
                                    {
                                        const auto ping = server_frame(9, bytes(control.substr(0, 125)));
                                        stream.insert(stream.end(), ping.begin(), ping.end());
                                    }
                                }
                            }
                            return stream;
                        });
}

} // namespace

RC_GTEST_PROP(WsDecode, AnySplitDecodesTheSame, ())
{
    const auto stream = *valid_stream();
    const auto sizes = *rc::gen::container<std::vector<std::size_t>>(rc::gen::inRange<std::size_t>(0, 20));

    const auto whole = decode(stream, 4096);
    RC_ASSERT(!whole.failed);
    RC_ASSERT(decode_split(stream, sizes, 4096) == whole.events);

    // One byte at a time, too
    RC_ASSERT(decode_split(stream, std::vector<std::size_t>(stream.size(), 1), 4096) == whole.events);
}

RC_GTEST_PROP(WsDecode, NeverCrashesOnGarbage, (const std::vector<uint8_t> &garbage))
{
    // Whatever arrives, the decoder stays inside its buffers (ASan checks)
    // and reports at most one error, last
    const auto decoded = decode(garbage, 16);
    for (std::size_t i = 0; i + 1 < decoded.events.size(); i++)
    {
        RC_ASSERT(decoded.events[i].rfind("error:", 0) != 0U);
    }
}
