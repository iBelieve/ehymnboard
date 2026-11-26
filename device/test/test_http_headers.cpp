#include "http_headers.h"

#include <algorithm>
#include <cctype>
#include <string>

#include <gtest/gtest.h>
#include <rapidcheck/gtest.h>

namespace
{

// What gunicorn sends for GET /images/<n>.
constexpr const char *SERVER_RESPONSE = "HTTP/1.1 200 OK\r\n"
                                        "Server: gunicorn\r\n"
                                        "Date: Fri, 20 Nov 2026 12:00:00 GMT\r\n"
                                        "Connection: close\r\n"
                                        "Content-Type: application/octet-stream\r\n"
                                        "Content-Length: 81600\r\n"
                                        "Etag: 2e16e58b5d7ca51f8e5972e3de922816bab545bf\r\n"
                                        "\r\n";

// A header name: printable ASCII without ':' or whitespace.
rc::Gen<std::string> token()
{
    return rc::gen::nonEmpty(rc::gen::container<std::string>(
        rc::gen::suchThat(rc::gen::inRange('!', '~'), [](char c) { return c != ':'; })));
}

const std::string ETAG_CHARS = "0123456789abcdefABCDEFxyzXYZ._-";

// An etag the board accepts: 1 to MAX_ETAG_LENGTH safe characters.
rc::Gen<std::string> etag_token()
{
    return rc::gen::mapcat(rc::gen::inRange<std::size_t>(1, MAX_ETAG_LENGTH + 1), [](std::size_t length) {
        return rc::gen::container<std::string>(length, rc::gen::elementOf(ETAG_CHARS));
    });
}

bool is_safe(const std::string &etag)
{
    return etag.size() <= MAX_ETAG_LENGTH && std::all_of(etag.begin(), etag.end(), [](char c) {
               return std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '_' || c == '-';
           });
}

// A header value: printable ASCII, no leading or trailing whitespace.
rc::Gen<std::string> header_value()
{
    return rc::gen::map(rc::gen::container<std::string>(rc::gen::inRange(' ', '~')), [](std::string value) {
        while (!value.empty() && value.back() == ' ')
        {
            value.pop_back();
        }
        while (!value.empty() && value.front() == ' ')
        {
            value.erase(0, 1);
        }
        return value;
    });
}

} // namespace

TEST(FindEtag, ReadsServerResponse)
{
    EXPECT_EQ(find_etag(SERVER_RESPONSE), "2e16e58b5d7ca51f8e5972e3de922816bab545bf");
}

TEST(FindEtag, MissingHeader)
{
    EXPECT_EQ(find_etag("HTTP/1.1 304 NOT MODIFIED\r\nServer: gunicorn\r\n\r\n"), "");
}

TEST(FindEtag, HeaderNameIsCaseInsensitive)
{
    EXPECT_EQ(find_etag("HTTP/1.1 200 OK\r\nETag: abc\r\n\r\n"), "abc");
    EXPECT_EQ(find_etag("HTTP/1.1 200 OK\r\netag:abc\r\n\r\n"), "abc");
}

TEST(FindEtag, TrimsWhitespace)
{
    EXPECT_EQ(find_etag("HTTP/1.1 200 OK\r\nEtag: \t abc \t\r\n\r\n"), "abc");
}

TEST(FindEtag, IgnoresEtagInStatusLineAndOtherValues)
{
    EXPECT_EQ(find_etag("Etag: status\r\nX-Note: Etag: nope\r\n\r\n"), "");
}

TEST(FindEtag, StripsQuotes)
{
    // A standard strong ETag, which a proxy or another server might send.
    EXPECT_EQ(find_etag("HTTP/1.1 200 OK\r\nETag: \"2e16e58b5d7ca51f8e5972e3de922816bab545bf\"\r\n\r\n"),
              "2e16e58b5d7ca51f8e5972e3de922816bab545bf");
}

TEST(FindEtag, RejectsValuesTheBoardCantKeep)
{
    // Too long to save to flash...
    EXPECT_EQ(find_etag("HTTP/1.1 200 OK\r\nEtag: " + std::string(MAX_ETAG_LENGTH + 1, 'a') + "\r\n\r\n"), "");
    // ...or would need escaping in the request URL.
    EXPECT_EQ(find_etag("HTTP/1.1 200 OK\r\nEtag: a&b=c\r\n\r\n"), "");
    EXPECT_EQ(find_etag("HTTP/1.1 200 OK\r\nEtag: W/\"abc\"\r\n\r\n"), "");
    EXPECT_EQ(find_etag("HTTP/1.1 200 OK\r\nEtag: \"\"\r\n\r\n"), "");
}

TEST(FindEtag, AcceptsLongestEtag)
{
    const std::string etag(MAX_ETAG_LENGTH, 'f');
    EXPECT_EQ(find_etag("HTTP/1.1 200 OK\r\nEtag: " + etag + "\r\n\r\n"), etag);
}

TEST(FindEtag, IgnoresTruncatedLine)
{
    // The header block was cut off mid-value: don't trust a partial etag.
    EXPECT_EQ(find_etag("HTTP/1.1 200 OK\r\nEtag: 2e16e58b"), "");
}

TEST(FindEtag, FirstEtagWins)
{
    EXPECT_EQ(find_etag("HTTP/1.1 200 OK\r\nEtag: one\r\nEtag: two\r\n\r\n"), "one");
}

TEST(FindEtag, EmptyInput)
{
    EXPECT_EQ(find_etag(""), "");
}

RC_GTEST_PROP(FindEtag, FindsEtagAmongOtherHeaders, ())
{
    const auto before =
        *rc::gen::container<std::vector<std::pair<std::string, std::string>>>(rc::gen::pair(token(), header_value()));
    const auto after =
        *rc::gen::container<std::vector<std::pair<std::string, std::string>>>(rc::gen::pair(token(), header_value()));
    const auto etag = *etag_token();
    const auto quoted = *rc::gen::arbitrary<bool>();

    std::string headers = "HTTP/1.1 200 OK\r\n";
    for (const auto &[name, value] : before)
    {
        // Another header named "etag" would legitimately win; skip it.
        RC_PRE(find_etag("HTTP/1.1 200 OK\r\n" + name + ": x\r\n\r\n").empty());
        headers += name + ": " + value + "\r\n";
    }
    headers += "Etag: " + (quoted ? "\"" + etag + "\"" : etag) + "\r\n";
    for (const auto &[name, value] : after)
    {
        headers += name + ": " + value + "\r\n";
    }
    headers += "\r\n";

    RC_ASSERT(find_etag(headers) == etag);
}

RC_GTEST_PROP(FindEtag, OnlyReturnsEtagsTheBoardCanKeep, (const std::string &headers))
{
    // Whatever the server sends, the result fits SavedState and is URL-safe.
    RC_ASSERT(is_safe(find_etag(headers)));
}

TEST(FindContentLength, MatchesTheHeaderInAnyCase)
{
    EXPECT_EQ(find_content_length("HTTP/1.1 200 OK\r\nContent-Length: 609280\r\n\r\n"), 609280U);
    EXPECT_EQ(find_content_length("HTTP/1.1 200 OK\r\ncontent-length: 256\r\n\r\n"), 256U);
    EXPECT_EQ(find_content_length("HTTP/1.1 200 OK\r\nCONTENT-LENGTH:0\r\n\r\n"), 0U);
}

TEST(FindContentLength, RejectsAnythingButAWholeNumberThatFits)
{
    EXPECT_FALSE(find_content_length("HTTP/1.1 200 OK\r\n\r\n").has_value());
    EXPECT_FALSE(find_content_length("HTTP/1.1 200 OK\r\nContent-Length: \r\n\r\n").has_value());
    EXPECT_FALSE(find_content_length("HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n").has_value());
    EXPECT_FALSE(find_content_length("HTTP/1.1 200 OK\r\nContent-Length: 12 34\r\n\r\n").has_value());
    EXPECT_FALSE(find_content_length("HTTP/1.1 200 OK\r\nContent-Length: 4294967296\r\n\r\n").has_value());
    EXPECT_FALSE(find_content_length("HTTP/1.1 200 OK\r\nContent-Length: 99999999999\r\n\r\n").has_value());
    EXPECT_EQ(find_content_length("HTTP/1.1 200 OK\r\nContent-Length: 4294967295\r\n\r\n"), 4294967295U);
}

RC_GTEST_PROP(FindContentLength, ReadsBackAnyLength, (uint32_t length))
{
    const auto headers = "HTTP/1.1 200 OK\r\ncontent-length: " + std::to_string(length) + "\r\n\r\n";
    RC_ASSERT(find_content_length(headers) == std::optional<uint32_t>(length));
}
