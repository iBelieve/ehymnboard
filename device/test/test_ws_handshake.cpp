#include "ws_handshake.h"

#include <string>

#include <gtest/gtest.h>
#include <rapidcheck/gtest.h>

namespace
{

std::string hex(const std::array<uint8_t, 20> &digest)
{
    static constexpr const char *digits = "0123456789abcdef";
    std::string out;
    for (const auto b : digest)
    {
        out += digits[b >> 4];
        out += digits[b & 0xF];
    }
    return out;
}

std::string sha1_hex(const std::string &s)
{
    return hex(ws::sha1(reinterpret_cast<const uint8_t *>(s.data()), s.size()));
}

std::string b64(const std::string &s)
{
    return ws::base64_encode(reinterpret_cast<const uint8_t *>(s.data()), s.size());
}

// The RFC 6455 section 1.3 example
constexpr const char *RFC_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
constexpr const char *RFC_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

std::string response(const std::string &status_line, const std::string &headers)
{
    return status_line + "\r\n" + headers + "\r\n";
}

} // namespace

TEST(WsSha1, KnownDigests)
{
    EXPECT_EQ(sha1_hex("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    EXPECT_EQ(sha1_hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
              "84983e441c3bd26ebaae4aa1f95129e5e54670f1");

    // Lengths either side of the padding boundaries (from Python's hashlib)
    const std::pair<std::size_t, const char *> vectors[] = {
        {0, "da39a3ee5e6b4b0d3255bfef95601890afd80709"},    {1, "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"},
        {55, "c1c8bbdc22796e28c0e15163d20899b65621d65a"},   {56, "c2db330f6083854c99d4b5bfb6e8f29f201be699"},
        {63, "03f09f5b158a7a8cdad920bddc29b81c18a551f5"},   {64, "0098ba824b5c16427bd7a1122a5a442a25ec644d"},
        {65, "11655326c708d70319be2610e8a57d9a5b959d3b"},   {119, "ee971065aaa017e0632a8ca6c77bb3bf8b1dfc56"},
        {120, "f34c1488385346a55709ba056ddd08280dd4c6d6"},  {128, "ad5b3fdbcb526778c2839d2f151ea753995e26a0"},
        {1000, "291e9a6c66994949b57ba5e650361e98fc36b1ba"},
    };
    for (const auto &[length, digest] : vectors)
    {
        EXPECT_EQ(sha1_hex(std::string(length, 'a')), digest) << length;
    }
}

TEST(WsBase64, Rfc4648Vectors)
{
    EXPECT_EQ(b64(""), "");
    EXPECT_EQ(b64("f"), "Zg==");
    EXPECT_EQ(b64("fo"), "Zm8=");
    EXPECT_EQ(b64("foo"), "Zm9v");
    EXPECT_EQ(b64("foob"), "Zm9vYg==");
    EXPECT_EQ(b64("fooba"), "Zm9vYmE=");
    EXPECT_EQ(b64("foobar"), "Zm9vYmFy");
    EXPECT_EQ(b64("\xff\xfe\xfd"), "//79");
}

RC_GTEST_PROP(WsBase64, LengthAndAlphabet, (const std::string &data))
{
    const auto encoded = b64(data);
    RC_ASSERT(encoded.size() == (data.size() + 2) / 3 * 4);
    RC_ASSERT(encoded.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=") ==
              std::string::npos);
}

TEST(WsHandshake, RfcExample)
{
    EXPECT_EQ(ws::expected_accept(RFC_KEY), RFC_ACCEPT);
    // "the sample nonce"
    const std::string nonce = "the sample nonce";
    std::array<uint8_t, 16> random{};
    std::copy(nonce.begin(), nonce.end(), random.begin());
    EXPECT_EQ(ws::make_key(random), RFC_KEY);
}

TEST(WsHandshake, Request)
{
    EXPECT_EQ(ws::build_upgrade_request("api.example.com", 80, false, "/ws?device_id=AB", RFC_KEY, "Board/1.0"),
              "GET /ws?device_id=AB HTTP/1.1\r\n"
              "Host: api.example.com\r\n"
              "Upgrade: websocket\r\n"
              "Connection: Upgrade\r\n"
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
              "Sec-WebSocket-Version: 13\r\n"
              "User-Agent: Board/1.0\r\n"
              "\r\n");
    EXPECT_EQ(ws::build_upgrade_request("h", 80, false, "/", RFC_KEY, "").find("User-Agent"), std::string::npos);
}

TEST(WsHandshake, RequestNamesAPortOtherThan80)
{
    const auto request = ws::build_upgrade_request("localhost", 8000, false, "/ws", RFC_KEY, "");
    EXPECT_NE(request.find("\r\nHost: localhost:8000\r\n"), std::string::npos);
}

TEST(WsHandshake, RequestLeavesOut443ForWss)
{
    const auto request = ws::build_upgrade_request("example.com", 443, true, "/ws", RFC_KEY, "");
    EXPECT_NE(request.find("\r\nHost: example.com\r\n"), std::string::npos);
}

TEST(WsHandshake, RequestNamesEachSchemesOtherDefault)
{
    EXPECT_NE(
        ws::build_upgrade_request("example.com", 80, true, "/ws", RFC_KEY, "").find("\r\nHost: example.com:80\r\n"),
        std::string::npos);
    EXPECT_NE(
        ws::build_upgrade_request("example.com", 443, false, "/ws", RFC_KEY, "").find("\r\nHost: example.com:443\r\n"),
        std::string::npos);
}

TEST(WsHandshake, AcceptsAValidResponse)
{
    using ws::HandshakeResult;
    const std::string ok = response(
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + std::string(RFC_ACCEPT) + "\r\n");
    EXPECT_EQ(ws::check_upgrade_response(ok, RFC_KEY), HandshakeResult::OK);

    // Header names and token values in any case, Connection with more tokens
    const std::string odd =
        response("HTTP/1.1 101 Switching Protocols", "upgrade: WebSocket\r\nCONNECTION: keep-alive, upgrade\r\n"
                                                     "sec-websocket-accept:   " +
                                                         std::string(RFC_ACCEPT) + "\r\n");
    EXPECT_EQ(ws::check_upgrade_response(odd, RFC_KEY), HandshakeResult::OK);
}

TEST(WsHandshake, RejectsBadResponses)
{
    using ws::HandshakeResult;
    const std::string good_headers =
        "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + std::string(RFC_ACCEPT) + "\r\n";

    EXPECT_EQ(ws::check_upgrade_response(response("HTTP/1.1 403 Forbidden", good_headers), RFC_KEY),
              HandshakeResult::BAD_STATUS);
    EXPECT_EQ(ws::check_upgrade_response(response("HTTP/1.1 200 OK", good_headers), RFC_KEY),
              HandshakeResult::BAD_STATUS);
    EXPECT_EQ(ws::check_upgrade_response("garbage", RFC_KEY), HandshakeResult::BAD_STATUS);
    EXPECT_EQ(ws::check_upgrade_response(response("HTTP/1.1 101 OK", "Connection: Upgrade\r\nSec-WebSocket-Accept: " +
                                                                         std::string(RFC_ACCEPT) + "\r\n"),
                                         RFC_KEY),
              HandshakeResult::NOT_UPGRADED);
    EXPECT_EQ(ws::check_upgrade_response(
                  response("HTTP/1.1 101 OK", "Upgrade: websocket\r\nConnection: close\r\nSec-WebSocket-Accept: " +
                                                  std::string(RFC_ACCEPT) + "\r\n"),
                  RFC_KEY),
              HandshakeResult::NOT_UPGRADED);
    EXPECT_EQ(ws::check_upgrade_response(response("HTTP/1.1 101 OK", "Upgrade: websocket\r\nConnection: Upgrade\r\n"),
                                         RFC_KEY),
              HandshakeResult::BAD_ACCEPT);
    EXPECT_EQ(ws::check_upgrade_response(response("HTTP/1.1 101 OK", "Upgrade: websocket\r\nConnection: "
                                                                     "Upgrade\r\nSec-WebSocket-Accept: abc=\r\n"),
                                         RFC_KEY),
              HandshakeResult::BAD_ACCEPT);
    EXPECT_EQ(
        ws::check_upgrade_response(
            response("HTTP/1.1 101 OK", good_headers + "Sec-WebSocket-Extensions: permessage-deflate\r\n"), RFC_KEY),
        HandshakeResult::UNEXPECTED_EXTENSION);
}

TEST(WsHandshake, ResponseStatus)
{
    EXPECT_EQ(ws::response_status("HTTP/1.1 101 Switching Protocols\r\n"), 101);
    EXPECT_EQ(ws::response_status("HTTP/1.1 503\r\n"), 503);
    EXPECT_EQ(ws::response_status("HTTP/1.1 503"), 503);
    EXPECT_EQ(ws::response_status("HTTP/1.1 50"), 0);
    EXPECT_EQ(ws::response_status("HTTP/1.1 5x3 Nope"), 0);
    EXPECT_EQ(ws::response_status("HTTP/1.1 1011 Nope"), 0);
    EXPECT_EQ(ws::response_status("HTTP/1.0 101 Old"), 0);
}
