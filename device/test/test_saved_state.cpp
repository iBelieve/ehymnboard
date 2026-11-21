#include "state.h"

#include <cstring>
#include <stdexcept>
#include <string>

#include <gtest/gtest.h>
#include <rapidcheck/gtest.h>

namespace
{

rc::Gen<std::string> etag()
{
    return rc::gen::container<std::string>(*rc::gen::inRange(0, 41), rc::gen::inRange('0', 'z'));
}

} // namespace

TEST(SavedState, InitialStateIsValidAndEmpty)
{
    const auto state = SavedState::initial();

    EXPECT_TRUE(state.is_valid());
    EXPECT_FALSE(state.is_wrong_version());
    EXPECT_EQ(state.write_count, 1);
    EXPECT_STREQ(state.etag1, "");
    EXPECT_STREQ(state.etag2, "");
    EXPECT_STREQ(state.etag3, "");
}

TEST(SavedState, ErasedFlashIsInvalid)
{
    // Erased flash reads as all 0xFF.
    SavedState state;
    std::memset(static_cast<void *>(&state), 0xFF, sizeof(state));

    EXPECT_FALSE(state.is_valid());
}

TEST(SavedState, OlderLayoutIsWrongVersion)
{
    SavedState state;
    state.version = STATE_VERSION - 1;

    EXPECT_TRUE(state.is_valid());
    EXPECT_TRUE(state.is_wrong_version());
}

TEST(SavedState, UpdateKeepsEtagsAndCountsWrites)
{
    const SavedState first;
    const SavedState second(&first, "aaa", "bbb", "2e16e58b5d7ca51f8e5972e3de922816bab545bf");

    EXPECT_EQ(second.write_count, 2);
    EXPECT_STREQ(second.etag1, "aaa");
    EXPECT_STREQ(second.etag2, "bbb");
    EXPECT_STREQ(second.etag3, "2e16e58b5d7ca51f8e5972e3de922816bab545bf");
    EXPECT_TRUE(second.is_valid());
}

TEST(SavedState, RejectsOversizedEtag)
{
    const SavedState first;

    EXPECT_THROW(SavedState(&first, std::string(41, 'a'), "", ""), std::logic_error);
    EXPECT_THROW(SavedState(&first, "", std::string(41, 'a'), ""), std::logic_error);
    EXPECT_THROW(SavedState(&first, "", "", std::string(41, 'a')), std::logic_error);
}

RC_GTEST_PROP(SavedState, RoundTripsAnyEtagThatFits, ())
{
    const auto writes = *rc::gen::inRange(0, 1000000);
    const auto etag1 = *etag();
    const auto etag2 = *etag();
    const auto etag3 = *etag();

    SavedState prev;
    prev.write_count = writes;

    const SavedState next(&prev, etag1, etag2, etag3);

    RC_ASSERT(next.write_count == writes + 1);
    RC_ASSERT(std::string(next.etag1) == etag1);
    RC_ASSERT(std::string(next.etag2) == etag2);
    RC_ASSERT(std::string(next.etag3) == etag3);
    RC_ASSERT(next.is_valid());
    RC_ASSERT(!next.is_wrong_version());
}

TEST(SavedState, InitialStateHasNoOtaHistory)
{
    const auto state = SavedState::initial();

    EXPECT_EQ(state.attempted_version(), "");
    EXPECT_EQ(state.rejected_version(), "");
}

TEST(SavedState, WithOtaKeepsEtagsAndCountsWrites)
{
    const SavedState first;
    const SavedState second(&first, "aaa", "bbb", "ccc");

    const auto third = second.with_ota("v2", "v1");

    EXPECT_EQ(third.write_count, 3);
    EXPECT_STREQ(third.etag1, "aaa");
    EXPECT_STREQ(third.etag2, "bbb");
    EXPECT_STREQ(third.etag3, "ccc");
    EXPECT_EQ(third.attempted_version(), "v2");
    EXPECT_EQ(third.rejected_version(), "v1");
}

TEST(SavedState, ScreenUpdateKeepsOtaHistory)
{
    const auto first = SavedState().with_ota("v2", "v1");

    const SavedState second(&first, "aaa", "", "");

    EXPECT_EQ(second.attempted_version(), "v2");
    EXPECT_EQ(second.rejected_version(), "v1");
}

TEST(SavedState, RejectsOversizedVersion)
{
    const SavedState state;

    EXPECT_THROW(state.with_ota(std::string(OTA_VERSION_SIZE, 'a'), ""), std::logic_error);
    EXPECT_THROW(state.with_ota("", std::string(OTA_VERSION_SIZE, 'a')), std::logic_error);
}

TEST(SavedState, UnterminatedFlashStringsAreCut)
{
    // Corrupt flash with no terminators reads as the longest string that fits
    SavedState state;
    std::memset(state.ota_attempted_version, 'a', sizeof(state.ota_attempted_version));
    std::memset(state.etag1, 'b', sizeof(state.etag1));

    EXPECT_EQ(state.attempted_version(), std::string(OTA_VERSION_SIZE - 1, 'a'));
    EXPECT_EQ(state.with_ota("", "").etag1, std::string(sizeof(state.etag1) - 1, 'b'));
}

RC_GTEST_PROP(SavedState, RoundTripsAnyVersionThatFits, ())
{
    const auto version = [] {
        return rc::gen::container<std::string>(*rc::gen::inRange<std::size_t>(0, OTA_VERSION_SIZE),
                                               rc::gen::inRange('0', 'z'));
    };
    const auto attempted = *version();
    const auto rejected = *version();

    const auto next = SavedState().with_ota(attempted, rejected);

    RC_ASSERT(next.attempted_version() == attempted);
    RC_ASSERT(next.rejected_version() == rejected);
}
