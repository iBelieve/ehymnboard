#include "shown_images.h"

#include <vector>

#include <gtest/gtest.h>
#include <rapidcheck/gtest.h>

namespace
{

constexpr std::size_t PANEL_BYTES = 81600;

std::vector<uint8_t> unpack(const std::vector<uint8_t> &packed, std::size_t size, bool &ok)
{
    std::vector<uint8_t> image;
    ok = unpack_pixel_runs(packed, size, [&image](const uint8_t *chunk, std::size_t length) {
        EXPECT_GT(length, 0U);
        EXPECT_LE(length, UNPACK_CHUNK_BYTES);
        image.insert(image.end(), chunk, chunk + length);
    });
    return image;
}

// A white panel with black bars across it, like lines of large text
std::vector<uint8_t> panel_with_bars(std::size_t bars)
{
    std::vector<uint8_t> image(PANEL_BYTES, 0xFF);
    for (std::size_t bar = 0; bar < bars; bar++)
    {
        for (std::size_t row = 0; row < 40; row++)
        {
            for (std::size_t col = 10; col < 100; col++)
            {
                image.at((100 + bar * 120 + row) * 120 + col) = (col % 7 == 0) ? 0x0F : 0x00;
            }
        }
    }
    return image;
}

// Images that are mostly runs, with some noise, as screens of text are
rc::Gen<std::vector<uint8_t>> image()
{
    return rc::gen::container<std::vector<uint8_t>>(rc::gen::weightedOneOf<uint8_t>(
        {{4, rc::gen::just<uint8_t>(0xFF)}, {3, rc::gen::just<uint8_t>(0x00)}, {2, rc::gen::arbitrary<uint8_t>()}}));
}

} // namespace

TEST(PixelRuns, PacksAWhitePanelToOneRun)
{
    const std::vector<uint8_t> white(PANEL_BYTES, 0xFF);
    const auto packed = pack_pixel_runs(white.data(), white.size(), 100);
    ASSERT_TRUE(packed);
    // 652,800 white pixels: one varint
    EXPECT_EQ(*packed, (std::vector<uint8_t>{0x80, 0xEC, 0x27}));
}

TEST(PixelRuns, StartsWithAnEmptyRunOfWhiteForABlackFirstPixel)
{
    const std::vector<uint8_t> image{0x7F, 0xFF};
    const auto packed = pack_pixel_runs(image.data(), image.size(), 100);
    ASSERT_TRUE(packed);
    EXPECT_EQ(*packed, (std::vector<uint8_t>{0, 1, 15}));
}

TEST(PixelRuns, PacksScreensOfTextToAFewKB)
{
    const auto image = panel_with_bars(4);
    const auto packed = pack_pixel_runs(image.data(), image.size(), ShownImages::BUDGET_BYTES);
    ASSERT_TRUE(packed);
    EXPECT_LT(packed->size(), 8000U);
    bool ok = false;
    EXPECT_EQ(unpack(*packed, image.size(), ok), image);
    EXPECT_TRUE(ok);
}

TEST(PixelRuns, GivesUpOnAnImageOverTheLimit)
{
    // Every other pixel black: 652,800 runs
    const std::vector<uint8_t> checkered(PANEL_BYTES, 0xAA);
    EXPECT_FALSE(pack_pixel_runs(checkered.data(), checkered.size(), ShownImages::BUDGET_BYTES));
    // Exactly at the limit is fine
    const std::vector<uint8_t> image{0xAA};
    ASSERT_TRUE(pack_pixel_runs(image.data(), image.size(), 8));
    EXPECT_FALSE(pack_pixel_runs(image.data(), image.size(), 7));
}

RC_GTEST_PROP(PixelRuns, UnpacksWhatItPacked, ())
{
    const auto original = *image();
    const auto packed = pack_pixel_runs(original.data(), original.size(), original.size() * 8 * 4 + 4);
    RC_ASSERT(packed.has_value());
    bool ok = false;
    RC_ASSERT(unpack(*packed, original.size(), ok) == original);
    RC_ASSERT(ok);
}

RC_GTEST_PROP(PixelRuns, RejectsPackedImagesOfAnotherSize, ())
{
    const auto original = *image().as("image");
    const auto packed = pack_pixel_runs(original.data(), original.size(), original.size() * 32 + 4);
    RC_ASSERT(packed.has_value());
    const auto other = *rc::gen::suchThat(rc::gen::inRange<std::size_t>(0, 200),
                                          [&original](std::size_t s) { return s != original.size(); });
    bool ok = true;
    unpack(*packed, other, ok);
    RC_ASSERT(!ok);
}

RC_GTEST_PROP(PixelRuns, NeverOverrunsOnGarbage, (const std::vector<uint8_t> &garbage))
{
    const auto size = *rc::gen::inRange<std::size_t>(0, 100);
    bool ok = false;
    const auto image = unpack(garbage, size, ok);
    RC_ASSERT(image.size() <= size);
    RC_ASSERT(!ok || image.size() == size);
}

TEST(PixelRuns, RejectsACutShortVarint)
{
    bool ok = true;
    unpack({0x80}, 1, ok);
    EXPECT_FALSE(ok);
    // Five varint bytes is more than any panel needs
    unpack({0x80, 0x80, 0x80, 0x80, 0x00}, 1, ok);
    EXPECT_FALSE(ok);
}

TEST(ShownImages, NeedsAFullUpdateFirst)
{
    ShownImages shown;
    for (std::size_t screen = 0; screen < SCREEN_COUNT; screen++)
    {
        EXPECT_EQ(shown.for_partial(screen), nullptr);
    }
    EXPECT_EQ(shown.packed_bytes(), 0U);
}

TEST(ShownImages, KeepsWhatAPanelShowsForItsNextPartialUpdate)
{
    ShownImages shown;
    const auto image = panel_with_bars(2);
    shown.drawn(1, image.data(), image.size(), false);
    ASSERT_NE(shown.for_partial(1), nullptr);
    EXPECT_EQ(shown.for_partial(0), nullptr);
    bool ok = false;
    EXPECT_EQ(unpack(*shown.for_partial(1), image.size(), ok), image);
    EXPECT_TRUE(ok);
    EXPECT_EQ(shown.packed_bytes(), shown.for_partial(1)->size());
}

TEST(ShownImages, MakesEveryFifthUpdateAFullOne)
{
    ShownImages shown;
    const auto image = panel_with_bars(1);
    shown.drawn(0, image.data(), image.size(), false);
    for (int i = 0; i < ShownImages::PARTIALS_BEFORE_FULL; i++)
    {
        ASSERT_NE(shown.for_partial(0), nullptr) << "partial update " << i + 1;
        shown.drawn(0, image.data(), image.size(), true);
    }
    EXPECT_EQ(shown.for_partial(0), nullptr);
    // The full update starts the count again
    shown.drawn(0, image.data(), image.size(), false);
    EXPECT_NE(shown.for_partial(0), nullptr);
}

TEST(ShownImages, DropsAnImageThatDoesntFitBesideTheOthers)
{
    ShownImages shown;
    // About 10 KB packed each: two fit the budget, the third doesn't
    std::vector<uint8_t> busy(PANEL_BYTES, 0xFF);
    for (std::size_t i = 0; i < 5000; i++)
    {
        busy.at(i * 16) = 0x00;
    }
    for (std::size_t screen = 0; screen < SCREEN_COUNT; screen++)
    {
        shown.drawn(screen, busy.data(), busy.size(), false);
    }
    EXPECT_NE(shown.for_partial(0), nullptr);
    EXPECT_NE(shown.for_partial(1), nullptr);
    EXPECT_EQ(shown.for_partial(2), nullptr);
    EXPECT_LE(shown.packed_bytes(), ShownImages::BUDGET_BYTES);

    // A panel's own old image doesn't count against its new one
    shown.drawn(1, busy.data(), busy.size(), false);
    EXPECT_NE(shown.for_partial(1), nullptr);
}

TEST(ShownImages, ForgetsEveryPanel)
{
    ShownImages shown;
    const auto image = panel_with_bars(3);
    for (std::size_t screen = 0; screen < SCREEN_COUNT; screen++)
    {
        shown.drawn(screen, image.data(), image.size(), false);
    }
    shown.forget();
    for (std::size_t screen = 0; screen < SCREEN_COUNT; screen++)
    {
        EXPECT_EQ(shown.for_partial(screen), nullptr);
    }
    EXPECT_EQ(shown.packed_bytes(), 0U);
}
