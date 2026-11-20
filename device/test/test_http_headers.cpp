#include "http_headers.h"

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

// A header-safe token: printable ASCII without ':' or whitespace.
rc::Gen<std::string> token()
{
    return rc::gen::nonEmpty(rc::gen::container<std::string>(rc::gen::inRange('!', '~')));
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
    const auto etag = *header_value();

    std::string headers = "HTTP/1.1 200 OK\r\n";
    for (const auto &[name, value] : before)
    {
        // Another header named "etag" would legitimately win; skip it.
        RC_PRE(find_etag("HTTP/1.1 200 OK\r\n" + name + ": x\r\n\r\n").empty());
        headers += name + ": " + value + "\r\n";
    }
    headers += "Etag: " + etag + "\r\n";
    for (const auto &[name, value] : after)
    {
        headers += name + ": " + value + "\r\n";
    }
    headers += "\r\n";

    RC_ASSERT(find_etag(headers) == etag);
}

RC_GTEST_PROP(FindEtag, NeverReturnsLineBreaksOrPadding, (const std::string &headers))
{
    const auto etag = find_etag(headers);

    RC_ASSERT(etag.find('\r') == std::string::npos);
    RC_ASSERT(etag.find('\n') == std::string::npos);
    if (!etag.empty())
    {
        RC_ASSERT(etag.front() != ' ');
        RC_ASSERT(etag.back() != ' ');
    }
}
