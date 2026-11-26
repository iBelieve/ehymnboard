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

#include <gtest/gtest.h>
#include <rapidcheck/gtest.h>

#include <map>
#include <set>
#include <string>

#include "diagnostics.h"

namespace
{

// "&a=1&b=2" as a map, failing on a repeated name
std::map<std::string, std::string> parse(const std::string &query)
{
    std::map<std::string, std::string> params;
    std::size_t start = 0;
    while (start < query.size())
    {
        EXPECT_EQ(query[start], '&');
        auto end = query.find('&', start + 1);
        if (end == std::string::npos)
        {
            end = query.size();
        }
        const auto pair = query.substr(start + 1, end - start - 1);
        const auto equals = pair.find('=');
        EXPECT_NE(equals, std::string::npos) << pair;
        EXPECT_TRUE(params.emplace(pair.substr(0, equals), pair.substr(equals + 1)).second) << pair;
        start = end;
    }
    return params;
}

// Query values need no URL encoding: letters, digits, '_' and '-'
bool url_safe(const std::string &query)
{
    for (const char c : query)
    {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' ||
                        c == '-' || c == '&' || c == '=';
        if (!ok)
        {
            return false;
        }
    }
    return true;
}

constexpr auto LAST_SOCKET_END = static_cast<uint8_t>(SocketEnd::PONG_TIMEOUT);
constexpr auto LAST_RESET_REASON = static_cast<uint8_t>(ResetReason::OTA_UNHEALTHY);
constexpr auto LAST_PHASE = static_cast<uint8_t>(Phase::OTA_DOWNLOAD);

} // namespace

TEST(SocketLog, NothingToSayAtFirst)
{
    const SocketLog log;
    EXPECT_EQ(log.connect_query(), "");
}

TEST(SocketLog, ReportsTheDropThenTheFailuresSince)
{
    SocketLog log;
    log.on_live(10'000);
    log.on_end({SocketEnd::TCP_ERROR, -14}, 75'500);
    EXPECT_EQ(log.connect_query(), "&drop=tcp_error&drop_detail=-14&drop_up=65");

    log.on_end({SocketEnd::DNS_FAILED, 0}, 80'000);
    log.on_end({SocketEnd::HANDSHAKE_REFUSED, 503}, 90'000);
    EXPECT_EQ(log.connect_query(), "&drop=tcp_error&drop_detail=-14&drop_up=65&fails=2&fail=handshake&fail_detail=503");

    // Live again: the failures are over, the drop stays until the next one
    log.on_live(95'000);
    EXPECT_EQ(log.connect_query(), "&drop=tcp_error&drop_detail=-14&drop_up=65");
    log.on_end({SocketEnd::PONG_TIMEOUT, 0}, 195'000);
    EXPECT_EQ(log.connect_query(), "&drop=pong_timeout&drop_detail=0&drop_up=100");

    EXPECT_EQ(log.drops(), 2U);
    EXPECT_EQ(log.connect_fails(), 2U);
    EXPECT_EQ(log.pong_timeouts(), 1U);
}

TEST(SocketLog, FailuresBeforeTheFirstSocket)
{
    SocketLog log;
    log.on_end({SocketEnd::CONNECT_TIMEOUT, 0}, 30'000);
    EXPECT_EQ(log.connect_query(), "&fails=1&fail=connect_timeout&fail_detail=0");
    EXPECT_EQ(log.drops(), 0U);
}

TEST(SocketEnd, EveryReasonHasItsOwnName)
{
    std::set<std::string_view> names;
    for (uint8_t i = 0; i <= LAST_SOCKET_END; i++)
    {
        const auto name = socket_end_name(static_cast<SocketEnd>(i));
        EXPECT_STRNE(name, "unknown");
        EXPECT_TRUE(url_safe(name)) << name;
        names.insert(name);
    }
    EXPECT_EQ(names.size(), LAST_SOCKET_END + 1U);
    EXPECT_STREQ(socket_end_name(static_cast<SocketEnd>(LAST_SOCKET_END + 1)), "unknown");
}

TEST(ResetReason, EveryReasonAndPhaseHasItsOwnName)
{
    std::set<std::string_view> reasons;
    for (uint8_t i = 0; i <= LAST_RESET_REASON; i++)
    {
        reasons.insert(reset_reason_name(static_cast<ResetReason>(i)));
    }
    EXPECT_EQ(reasons.size(), LAST_RESET_REASON + 1U);
    EXPECT_STREQ(reset_reason_name(static_cast<ResetReason>(LAST_RESET_REASON + 1)), "unknown");

    std::set<std::string_view> phases;
    for (uint8_t i = 0; i <= LAST_PHASE; i++)
    {
        const auto name = phase_name(static_cast<Phase>(i));
        EXPECT_STRNE(name, "unknown");
        phases.insert(name);
    }
    EXPECT_EQ(phases.size(), LAST_PHASE + 1U);
    EXPECT_STREQ(phase_name(static_cast<Phase>(LAST_PHASE + 1)), "unknown");
}

TEST(DecodeReset, FromTheFlagsWhenNothingWasRecorded)
{
    ResetFlags flags;
    EXPECT_EQ(decode_reset(flags).reason, ResetReason::UNKNOWN);
    flags.had_por = true;
    EXPECT_EQ(decode_reset(flags).reason, ResetReason::POWER_ON);
    flags.had_run = true;
    EXPECT_EQ(decode_reset(flags).reason, ResetReason::RUN_PIN);
    flags.had_psm_restart = true;
    EXPECT_EQ(decode_reset(flags).reason, ResetReason::DEBUGGER);
    // POR stays set through a watchdog reset
    flags.watchdog = true;
    const auto record = decode_reset(flags);
    EXPECT_EQ(record.reason, ResetReason::WATCHDOG);
    EXPECT_FALSE(record.recorded);
    EXPECT_EQ(reset_query(record), "&reset=watchdog");
}

TEST(DecodeReset, ARecordOnlyCountsAfterAWatchdogReset)
{
    ResetRecord crash;
    crash.reason = ResetReason::CRASH;
    crash.phase = Phase::PANEL;
    crash.detail = 0x10001234;
    crash.extra = 0x10005679;
    crash.uptime_s = 3600;

    ResetFlags flags;
    flags.scratch = encode_reset(crash);
    flags.had_por = true;
    // Left over from before a power cut
    EXPECT_EQ(decode_reset(flags).reason, ResetReason::POWER_ON);

    flags.watchdog = true;
    const auto record = decode_reset(flags);
    EXPECT_TRUE(record.recorded);
    EXPECT_EQ(reset_query(record), "&reset=crash&reset_phase=panel&reset_detail=268440116&reset_extra=268457593"
                                   "&reset_uptime=3600");
}

TEST(DecodeReset, IgnoresScratchThatIsntARecord)
{
    ResetFlags flags;
    flags.watchdog = true;
    // Another firmware's values, or ours from a newer build with more reasons
    for (const uint32_t head : {0U, 0xFFFFFFFFU, 0x12340001U, 0xD1A60000U | (LAST_RESET_REASON + 1U),
                                0xD1A60000U | ((LAST_PHASE + 1U) << 8U)})
    {
        flags.scratch = {head, 1, 2, 3};
        EXPECT_EQ(decode_reset(flags).reason, ResetReason::WATCHDOG) << std::hex << head;
        EXPECT_FALSE(decode_reset_record(flags.scratch));
    }
}

TEST(ResetQuery, LeavesOutWhatIsntKnown)
{
    ResetRecord record;
    record.reason = ResetReason::NO_SOCKET;
    record.recorded = true;
    record.phase = Phase::RUNNING;
    record.uptime_s = 200;
    EXPECT_EQ(reset_query(record), "&reset=no_socket&reset_phase=running&reset_uptime=200");

    record.reason = ResetReason::PANEL_BUSY;
    record.phase = Phase::PANEL;
    record.detail = 2;
    EXPECT_EQ(reset_query(record), "&reset=panel_busy&reset_phase=panel&reset_detail=2&reset_uptime=200");
}

RC_GTEST_PROP(ResetRecord, SurvivesTheScratchRegisters, ())
{
    ResetRecord record;
    record.reason = static_cast<ResetReason>(*rc::gen::inRange<int>(0, LAST_RESET_REASON + 1));
    record.recorded = true;
    record.phase = static_cast<Phase>(*rc::gen::inRange<int>(0, LAST_PHASE + 1));
    record.detail = *rc::gen::arbitrary<uint32_t>();
    record.extra = *rc::gen::arbitrary<uint32_t>();
    record.uptime_s = *rc::gen::arbitrary<uint32_t>();

    ResetFlags flags;
    flags.scratch = encode_reset(record);
    flags.watchdog = true;
    flags.had_por = *rc::gen::arbitrary<bool>();
    const auto decoded = decode_reset(flags);

    RC_ASSERT(decoded.reason == record.reason);
    RC_ASSERT(decoded.recorded);
    RC_ASSERT(decoded.phase == record.phase);
    RC_ASSERT(decoded.detail == record.detail);
    RC_ASSERT(decoded.extra == record.extra);
    RC_ASSERT(decoded.uptime_s == record.uptime_s);

    const auto query = reset_query(decoded);
    RC_ASSERT(url_safe(query));
    const auto params = parse(query);
    RC_ASSERT(params.at("reset") == std::string(reset_reason_name(record.reason)));
    RC_ASSERT(params.at("reset_uptime") == std::to_string(record.uptime_s));
}

TEST(Health, QueriesAndTheDiagMessage)
{
    Health health;
    health.uptime_s = 86400;
    health.rssi = -61;
    health.heap_free = 120000;
    health.heap_min = 40000;
    health.drops = 3;
    health.connect_fails = 4;
    health.pong_timeouts = 1;
    health.image_fails = 2;
    health.wifi_drops = 1;
    health.tls_oom = 0;

    EXPECT_EQ(link_query(health), "&uptime=86400&rssi=-61");
    EXPECT_EQ(health_query(health), "&uptime=86400&rssi=-61&heap_free=120000&heap_min=40000&drops=3"
                                    "&connect_fails=4&pong_timeouts=1&image_fails=2&wifi_drops=1&tls_oom=0");
    EXPECT_EQ(format_diag_message(health), "diag uptime=86400 rssi=-61 heap_free=120000 heap_min=40000 drops=3 "
                                           "connect_fails=4 pong_timeouts=1 image_fails=2 wifi_drops=1 tls_oom=0");

    // Off WiFi there's no signal to report
    health.rssi.reset();
    EXPECT_EQ(link_query(health), "&uptime=86400");
}

RC_GTEST_PROP(SocketLog, QueryParsesBackWithoutEncoding, ())
{
    SocketLog log;
    uint64_t now = 0;
    const auto steps = *rc::gen::inRange(0, 20);
    for (int i = 0; i < steps; i++)
    {
        now += *rc::gen::inRange<uint64_t>(0, 1'000'000);
        if (*rc::gen::arbitrary<bool>())
        {
            log.on_live(now);
        }
        else
        {
            const auto reason = static_cast<SocketEnd>(*rc::gen::inRange<int>(0, LAST_SOCKET_END + 1));
            log.on_end({reason, *rc::gen::arbitrary<int32_t>()}, now);
        }
    }
    const auto query = log.connect_query();
    RC_ASSERT(url_safe(query));
    const auto params = parse(query);
    RC_ASSERT(params.count("drop") == params.count("drop_up"));
    RC_ASSERT(params.count("fails") == params.count("fail"));
    RC_ASSERT(log.drops() + log.connect_fails() <= static_cast<uint32_t>(steps));
}
