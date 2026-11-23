#include "ws_connection.h"

#include <gtest/gtest.h>
#include <rapidcheck/gtest.h>

using Action = ConnectionPolicy::Action;
using State = ConnectionPolicy::State;

namespace
{

// Polls every 100 ms from `from` until an action comes up (or `until`)
std::pair<Action, uint64_t> next_action(ConnectionPolicy &policy, uint64_t from, uint64_t until)
{
    for (uint64_t t = from; t <= until; t += 100)
    {
        const auto action = policy.poll(t);
        if (action != Action::NONE)
        {
            return {action, t};
        }
    }
    return {Action::NONE, until};
}

} // namespace

TEST(ConnectionPolicy, ConnectsRightAway)
{
    ConnectionPolicy policy(1, 5000);
    EXPECT_EQ(policy.poll(5000), Action::CONNECT);
    EXPECT_EQ(policy.state(), State::CONNECTING);
    EXPECT_EQ(policy.poll(5100), Action::NONE);
}

TEST(ConnectionPolicy, PingsWhileLiveAndAbortsWithoutPong)
{
    ConnectionPolicy policy(1, 0);
    ASSERT_EQ(policy.poll(0), Action::CONNECT);
    policy.on_live(1000);
    EXPECT_EQ(policy.state(), State::LIVE);

    auto [action, at] = next_action(policy, 1100, 100000);
    EXPECT_EQ(action, Action::SEND_PING);
    EXPECT_EQ(at, 1000 + ConnectionPolicy::PING_INTERVAL_MS);

    policy.on_pong();
    std::tie(action, at) = next_action(policy, at + 100, 200000);
    EXPECT_EQ(action, Action::SEND_PING);
    EXPECT_EQ(at, 1000 + 2 * ConnectionPolicy::PING_INTERVAL_MS);

    // No pong this time
    std::tie(action, at) = next_action(policy, at + 100, 300000);
    EXPECT_EQ(action, Action::ABORT);
    EXPECT_EQ(at, 1000 + 2 * ConnectionPolicy::PING_INTERVAL_MS + ConnectionPolicy::PONG_TIMEOUT_MS);
}

TEST(ConnectionPolicy, LiveSocketNeverReboots)
{
    ConnectionPolicy policy(1, 0);
    ASSERT_EQ(policy.poll(0), Action::CONNECT);
    policy.on_live(100);
    for (uint64_t t = 200; t < 60 * 60 * 1000; t += 1000)
    {
        const auto action = policy.poll(t);
        ASSERT_NE(action, Action::REBOOT);
        ASSERT_NE(action, Action::ABORT);
        if (action == Action::SEND_PING)
        {
            policy.on_pong();
        }
    }
}

TEST(ConnectionPolicy, AbortsAStuckConnect)
{
    ConnectionPolicy policy(1, 0);
    ASSERT_EQ(policy.poll(0), Action::CONNECT);
    const auto [action, at] = next_action(policy, 100, 100000);
    EXPECT_EQ(action, Action::ABORT);
    EXPECT_EQ(at, ConnectionPolicy::CONNECT_TIMEOUT_MS);
    policy.on_closed(at);
    EXPECT_EQ(policy.state(), State::BACKOFF);
}

TEST(ConnectionPolicy, RebootsAfterThreeMinutesDown)
{
    ConnectionPolicy policy(7, 0);
    uint64_t t = 0;
    for (;;)
    {
        const auto [action, at] = next_action(policy, t, 10 * 60 * 1000);
        t = at;
        ASSERT_NE(action, Action::NONE);
        if (action == Action::REBOOT)
        {
            break;
        }
        ASSERT_EQ(action, Action::CONNECT);
        policy.on_closed(t); // refused straight away
        t += 100;
    }
    EXPECT_GE(t, ConnectionPolicy::REBOOT_AFTER_MS);
    EXPECT_LT(t, ConnectionPolicy::REBOOT_AFTER_MS + 200);
}

TEST(ConnectionPolicy, DownTimeCountsFromTheLastLiveSocket)
{
    ConnectionPolicy policy(7, 0);
    ASSERT_EQ(policy.poll(0), Action::CONNECT);
    policy.on_live(1000);
    // Live for an hour
    const uint64_t dropped = 60 * 60 * 1000;
    policy.on_closed(dropped);
    for (uint64_t t = dropped; t < dropped + ConnectionPolicy::REBOOT_AFTER_MS; t += 100)
    {
        const auto action = policy.poll(t);
        ASSERT_NE(action, Action::REBOOT) << t - dropped;
        if (action == Action::CONNECT)
        {
            policy.on_closed(t);
        }
    }
    EXPECT_EQ(policy.poll(dropped + ConnectionPolicy::REBOOT_AFTER_MS), Action::REBOOT);
}

TEST(ConnectionPolicy, ClosedTwiceIsHarmless)
{
    ConnectionPolicy policy(1, 0);
    ASSERT_EQ(policy.poll(0), Action::CONNECT);
    policy.on_closed(10);
    const auto retry = policy.retry_at();
    policy.on_closed(20);
    EXPECT_EQ(policy.retry_at(), retry);
    policy.on_live(30); // not connecting: ignored
    EXPECT_EQ(policy.state(), State::BACKOFF);
}

RC_GTEST_PROP(ConnectionPolicy, BackoffDoublesWithJitterUpToAMinute, (uint32_t seed))
{
    ConnectionPolicy policy(seed, 0);
    uint64_t t = 0;
    RC_ASSERT(policy.poll(t) == Action::CONNECT);
    uint64_t base = ConnectionPolicy::BACKOFF_FIRST_MS;
    for (int attempt = 0; attempt < 10; attempt++)
    {
        policy.on_closed(t);
        const auto delay = policy.retry_at() - t;
        RC_ASSERT(delay >= base / 2);
        RC_ASSERT(delay <= base + base / 2);
        base = std::min(base * 2, ConnectionPolicy::BACKOFF_MAX_MS);
        t = policy.retry_at();
        // Keep clear of the reboot rule: pretend the board was briefly live
        RC_ASSERT(policy.poll(t) == Action::CONNECT);
        policy.on_live(t);
        t += 10;
    }
}

TEST(ConnectionPolicy, StableSocketResetsBackoff)
{
    ConnectionPolicy policy(3, 0);
    uint64_t t = 0;
    ASSERT_EQ(policy.poll(t), Action::CONNECT);
    // Fail a few times so the delay grows
    for (int i = 0; i < 5; i++)
    {
        policy.on_closed(t);
        t = policy.retry_at();
        ASSERT_EQ(policy.poll(t), Action::CONNECT);
    }
    policy.on_live(t);
    t += ConnectionPolicy::STABLE_MS;
    policy.on_closed(t);
    EXPECT_LE(policy.retry_at() - t, ConnectionPolicy::BACKOFF_FIRST_MS * 3 / 2);
}

TEST(ConnectionPolicy, ZeroSeedStillJitters)
{
    ConnectionPolicy a(0, 0);
    ASSERT_EQ(a.poll(0), Action::CONNECT);
    a.on_closed(0);
    EXPECT_GE(a.retry_at(), ConnectionPolicy::BACKOFF_FIRST_MS / 2);
}

TEST(ConnectionPolicy, JitterSeedsDifferByBoard)
{
    EXPECT_NE(jitter_seed_for("E6614103E71F8D26"), jitter_seed_for("E661A4D41787452B"));
    EXPECT_EQ(jitter_seed_for(""), 2166136261U);
    EXPECT_EQ(jitter_seed_for("a"), 0xE40C292CU);
}
