#include "board_messages.h"

#include <string>

#include <gtest/gtest.h>
#include <rapidcheck/gtest.h>

namespace
{

const std::string E1 = "2e16e58b5d7ca51f8e5972e3de922816bab545bf";
const std::string E2 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const std::string E3 = "0098ba824b5c16427bd7a1122a5a442a25ec644d";

rc::Gen<std::string> word(const std::string &chars, std::size_t max)
{
    return rc::gen::mapcat(rc::gen::inRange<std::size_t>(1, max + 1), [chars](std::size_t length) {
        return rc::gen::container<std::string>(length, rc::gen::elementOf(chars));
    });
}

const std::string SAFE = "0123456789abcdefABCDEF._-xyz";

} // namespace

TEST(BoardMessages, ParsesState)
{
    const auto state = parse_state_message("state 1 " + E1 + " " + E2 + " " + E3 + " 2026.11.22-abc123");
    ASSERT_TRUE(state);
    EXPECT_EQ(state->etags, (ScreenEtags{E1, E2, E3}));
    EXPECT_EQ(state->firmware_version, "2026.11.22-abc123");

    const auto no_firmware = parse_state_message("state 1 " + E1 + " " + E2 + " " + E3 + " -");
    ASSERT_TRUE(no_firmware);
    EXPECT_EQ(no_firmware->firmware_version, "");
}

TEST(BoardMessages, IgnoresWordsAddedLater)
{
    const auto state = parse_state_message("state 1 " + E1 + " " + E2 + " " + E3 + " v1 more words");
    ASSERT_TRUE(state);
    EXPECT_EQ(state->firmware_version, "v1");
    EXPECT_FALSE(state->partial_refresh);
}

TEST(BoardMessages, ParsesThePartialOption)
{
    const auto base = "state 1 " + E1 + " " + E2 + " " + E3 + " v1";
    // value(): a message that stopped parsing fails the test, not dereferences nothing
    EXPECT_FALSE(parse_state_message(base).value().partial_refresh);
    EXPECT_TRUE(parse_state_message(base + " partial").value().partial_refresh);
    // Among options added later, in any order
    EXPECT_TRUE(parse_state_message(base + " later partial").value().partial_refresh);
    EXPECT_FALSE(parse_state_message(base + " partially").value().partial_refresh);
}

TEST(BoardMessages, RejectsOtherMessages)
{
    EXPECT_FALSE(parse_state_message(""));
    EXPECT_FALSE(parse_state_message("pong"));
    EXPECT_FALSE(parse_state_message("redraw"));
    EXPECT_FALSE(parse_state_message("state 2 " + E1 + " " + E2 + " " + E3 + " v1"));
    EXPECT_FALSE(parse_state_message("state 1 " + E1 + " " + E2 + " " + E3));
    EXPECT_FALSE(parse_state_message("state 1 " + E1 + " " + E2 + " \"quoted\" v1"));
    EXPECT_FALSE(parse_state_message("state 1 " + E1 + " " + E2 + " " + std::string(41, 'a') + " v1"));
    EXPECT_FALSE(parse_state_message("state 1 " + E1 + " " + E2 + " " + E3 + " " + std::string(48, 'v')));
    EXPECT_FALSE(parse_state_message("state 1 " + E1 + " " + E2 + " " + E3 + " bad/version"));
    EXPECT_FALSE(parse_state_message("state 1 " + E1 + "  " + E2 + " " + E3 + " v1")) << "an empty word";
    EXPECT_FALSE(parse_state_message("statement 1 " + E1 + " " + E2 + " " + E3 + " v1"));
}

TEST(BoardMessages, Type)
{
    EXPECT_EQ(message_type("state 1 a b c -"), "state");
    EXPECT_EQ(message_type("pong"), "pong");
    EXPECT_EQ(message_type("redraw"), REDRAW_MESSAGE);
    EXPECT_EQ(message_type(""), "");
}

TEST(BoardMessages, Shown)
{
    EXPECT_EQ(format_shown_message({E1, E2, E3}), "shown " + E1 + " " + E2 + " " + E3);
    EXPECT_EQ(format_shown_message({E1, "", E3}), "shown " + E1 + " - " + E3);
}

TEST(BoardMessages, FirmwareVersions)
{
    EXPECT_TRUE(is_valid_firmware_version("v1.2_3-dirty"));
    EXPECT_TRUE(is_valid_firmware_version(std::string(47, 'a')));
    EXPECT_FALSE(is_valid_firmware_version(std::string(48, 'a')));
    EXPECT_FALSE(is_valid_firmware_version(""));
    EXPECT_FALSE(is_valid_firmware_version("a b"));
}

RC_GTEST_PROP(BoardMessages, StateRoundTrips, ())
{
    BoardState state;
    for (auto &etag : state.etags)
    {
        etag = *word(SAFE, 40);
    }
    // "-" is how the message says "no firmware", so it can't be a version
    state.firmware_version = *rc::gen::oneOf(
        rc::gen::just(std::string()), rc::gen::suchThat(word(SAFE, 47), [](const std::string &v) { return v != "-"; }));
    state.partial_refresh = *rc::gen::arbitrary<bool>();

    const auto message = format_state_message(state);
    RC_ASSERT(message.size() <= MAX_BOARD_MESSAGE);
    const auto parsed = parse_state_message(message);
    RC_ASSERT(parsed.has_value());
    RC_ASSERT(*parsed == state);
}

RC_GTEST_PROP(BoardMessages, NeverAcceptsUnsafeEtags, (const std::string &message))
{
    const auto parsed = parse_state_message(message);
    if (parsed)
    {
        for (const auto &etag : parsed->etags)
        {
            RC_ASSERT(!etag.empty());
            RC_ASSERT(etag.size() <= 40U);
            RC_ASSERT(etag.find_first_not_of("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ._-") ==
                      std::string::npos);
        }
    }
}
