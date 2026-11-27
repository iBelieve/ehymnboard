#include "request_path.h"

#include <map>
#include <string>

#include <gtest/gtest.h>
#include <rapidcheck/gtest.h>

namespace
{

// Splits "/path?a=1&b=2" into its path and query parameters.
std::pair<std::string, std::map<std::string, std::string>> parse(const std::string &url)
{
    const auto question = url.find('?');
    std::map<std::string, std::string> params;

    std::size_t start = question + 1;
    while (start <= url.size())
    {
        auto end = url.find('&', start);
        if (end == std::string::npos)
        {
            end = url.size();
        }
        const auto pair = url.substr(start, end - start);
        const auto equals = pair.find('=');
        params[pair.substr(0, equals)] = pair.substr(equals + 1);
        start = end + 1;
    }

    return {url.substr(0, question), params};
}

rc::Gen<std::string> hex(std::size_t length)
{
    return rc::gen::container<std::string>(length, rc::gen::elementOf(std::string("0123456789abcdefABCDEF")));
}

} // namespace

TEST(BuildRequestPath, ImageRequest)
{
    const DeviceStatus status{"E6614103E71F8D26", 12, false, ""};

    EXPECT_EQ(build_request_path("/images/1", status, "2e16e58b5d7ca51f8e5972e3de922816bab545bf"),
              "/images/1?device_id=E6614103E71F8D26&saved_state_writes=12&watchdog_caused_reboot=0"
              "&etag=2e16e58b5d7ca51f8e5972e3de922816bab545bf");
}

TEST(BuildRequestPath, HealthcheckAfterWatchdogReboot)
{
    const DeviceStatus status{"E661A4D41787452B", 3, true, ""};

    // The server checks watchdog_caused_reboot == "1".
    EXPECT_EQ(build_request_path("/device_booted", status),
              "/device_booted?device_id=E661A4D41787452B&saved_state_writes=3&watchdog_caused_reboot=1");
}

TEST(BuildRequestPath, NoEtagBeforeFirstImage)
{
    const auto url = build_request_path("/images/2", DeviceStatus{"AB", 1, false, ""}, "");

    EXPECT_EQ(url.find("etag"), std::string::npos);
}

RC_GTEST_PROP(BuildRequestPath, ServerCanParseItBack, ())
{
    const auto board_id = *hex(16);
    const auto writes = *rc::gen::inRange(0, 1000000);
    const auto watchdog = *rc::gen::arbitrary<bool>();
    const auto etag = *rc::gen::oneOf(rc::gen::just(std::string()), hex(40));
    const auto path = "/images/" + std::to_string(*rc::gen::inRange(1, 4));
    const auto firmware_version = *rc::gen::oneOf(rc::gen::just(std::string()), hex(7));

    const auto [parsed_path, params] =
        parse(build_request_path(path, DeviceStatus{board_id, writes, watchdog, firmware_version}, etag));

    RC_ASSERT(parsed_path == path);
    RC_ASSERT(params.at("device_id") == board_id);
    RC_ASSERT(params.at("saved_state_writes") == std::to_string(writes));
    RC_ASSERT(params.at("watchdog_caused_reboot") == (watchdog ? "1" : "0"));
    if (firmware_version.empty())
    {
        RC_ASSERT(params.count("firmware_version") == 0U);
    }
    else
    {
        RC_ASSERT(params.at("firmware_version") == firmware_version);
    }
    if (etag.empty())
    {
        RC_ASSERT(params.count("etag") == 0U);
    }
    else
    {
        RC_ASSERT(params.at("etag") == etag);
    }
}

TEST(BuildRequestPath, ReportsFirmwareVersion)
{
    const DeviceStatus status{"AB", 1, false, "022cdbf-dirty-20261121154951"};

    EXPECT_EQ(build_request_path("/device_booted", status),
              "/device_booted?device_id=AB&saved_state_writes=1&watchdog_caused_reboot=0"
              "&firmware_version=022cdbf-dirty-20261121154951");
}

TEST(BuildRequestPath, FirmwareVersionComesBeforeEtag)
{
    const auto [path, params] = parse(build_request_path("/images/1", DeviceStatus{"AB", 1, false, "v2"}, "abc"));

    EXPECT_EQ(params.at("firmware_version"), "v2");
    EXPECT_EQ(params.at("etag"), "abc");
}
