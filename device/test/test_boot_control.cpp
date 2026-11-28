#include "boot_control.h"

#include <algorithm>
#include <cstring>
#include <map>
#include <random>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <rapidcheck/gtest.h>

using boot::Decision;
using boot::Image;
using boot::Record;
using boot::SLOT_A;
using boot::SLOT_B;
using boot::State;

namespace
{

Record trial(uint8_t active, uint8_t tries)
{
    Record record;
    record.seq = 7;
    record.active = active;
    record.state = State::TRIAL;
    record.tries_left = tries;
    record.images = {Image{1000, 0x11}, Image{2000, 0x22}};
    return record;
}

Record confirmed(uint8_t active)
{
    Record record = trial(active, 0);
    record.state = State::CONFIRMED;
    return record;
}

rc::Gen<Record> any_record()
{
    return rc::gen::apply(
        [](uint32_t seq, bool b, bool on_trial, uint8_t tries, bool rolled_back, uint32_t a_size, uint32_t a_crc,
           uint32_t b_size, uint32_t b_crc) {
            Record record;
            record.seq = seq;
            record.active = b ? SLOT_B : SLOT_A;
            record.state = on_trial ? State::TRIAL : State::CONFIRMED;
            record.tries_left = tries;
            record.rolled_back = rolled_back;
            record.images = {Image{a_size, a_crc}, Image{b_size, b_crc}};
            return record;
        },
        rc::gen::arbitrary<uint32_t>(), rc::gen::arbitrary<bool>(), rc::gen::arbitrary<bool>(),
        rc::gen::arbitrary<uint8_t>(), rc::gen::arbitrary<bool>(), rc::gen::arbitrary<uint32_t>(),
        rc::gen::arbitrary<uint32_t>(), rc::gen::arbitrary<uint32_t>(), rc::gen::arbitrary<uint32_t>());
}

std::vector<uint8_t> sector_with(const Record &record)
{
    std::vector<uint8_t> sector(boot::SECTOR_SIZE, 0xFF);
    const auto bytes = boot::encode(record);
    std::copy(bytes.begin(), bytes.end(), sector.begin());
    return sector;
}

const std::vector<uint8_t> ERASED(boot::SECTOR_SIZE, 0xFF);

} // namespace

// --- CRC and the record's bytes ----------------------------------------------

TEST(BootControl, Crc32MatchesZlib)
{
    const std::string check = "123456789";
    EXPECT_EQ(boot::crc32(reinterpret_cast<const uint8_t *>(check.data()), check.size()), 0xCBF43926U);
    EXPECT_EQ(boot::crc32(nullptr, 0), 0U);
}

TEST(BootControl, Crc32Continues)
{
    const std::string data = "hymn board";
    const auto *bytes = reinterpret_cast<const uint8_t *>(data.data());
    EXPECT_EQ(boot::crc32(bytes + 4, data.size() - 4, boot::crc32(bytes, 4)), boot::crc32(bytes, data.size()));
}

RC_GTEST_PROP(BootControl, RecordsRoundTrip, ())
{
    Record record = *any_record();
    record.tries_left = *rc::gen::inRange<uint8_t>(0, 255);
    const auto bytes = boot::encode(record);
    const auto decoded = boot::decode(bytes.data());
    RC_ASSERT(decoded.has_value());
    RC_ASSERT(*decoded == record);
}

RC_GTEST_PROP(BootControl, AnyFlippedBitInvalidatesARecord, ())
{
    auto bytes = boot::encode(*any_record());
    const auto bit = *rc::gen::inRange<size_t>(0, bytes.size() * 8);
    bytes[bit / 8] ^= static_cast<uint8_t>(1U << (bit % 8));
    RC_ASSERT(!boot::decode(bytes.data()).has_value());
}

TEST(BootControl, ErasedFlashHoldsNoRecord)
{
    EXPECT_FALSE(boot::decode(ERASED.data()).has_value());
}

TEST(BootControl, UnknownSlotOrStateIsNotARecord)
{
    // Re-sealed with a good CRC, as a newer layout would be
    auto reseal = [](boot::RecordBytes bytes) {
        const uint32_t crc = boot::crc32(bytes.data(), bytes.size() - 4);
        std::memcpy(&bytes[bytes.size() - 4], &crc, 4);
        return bytes;
    };
    auto bad_slot = boot::encode(confirmed(SLOT_A));
    bad_slot[8] = 2;
    EXPECT_FALSE(boot::decode(reseal(bad_slot).data()).has_value());
    auto bad_state = boot::encode(confirmed(SLOT_A));
    bad_state[9] = 3;
    EXPECT_FALSE(boot::decode(reseal(bad_state).data()).has_value());
}

// --- Which record is newest, and where the next one goes ---------------------

TEST(BootControl, NoRecordsWriteToTheFirstSector)
{
    const auto records = boot::find_records(ERASED.data(), ERASED.data());
    EXPECT_FALSE(records.newest.has_value());
    EXPECT_EQ(records.write_sector, 0);
    EXPECT_EQ(boot::next(records, confirmed(SLOT_A)).seq, 1U);
}

RC_GTEST_PROP(BootControl, TheHigherSequenceWinsAndTheOtherSectorIsWritten, ())
{
    Record older = *any_record();
    older.seq = *rc::gen::inRange<uint32_t>(0, 1000);
    Record newer = *any_record();
    newer.seq = older.seq + *rc::gen::inRange<uint32_t>(1, 1000);
    const bool newer_first = *rc::gen::arbitrary<bool>();

    const auto a = sector_with(newer_first ? newer : older);
    const auto b = sector_with(newer_first ? older : newer);
    const auto records = boot::find_records(a.data(), b.data());

    RC_ASSERT(records.newest == std::optional<Record>(newer));
    RC_ASSERT(records.write_sector == (newer_first ? 1 : 0));
    RC_ASSERT(boot::next(records, older).seq == newer.seq + 1);
}

TEST(BootControl, OneValidRecordIsTheNewestWhicheverSector)
{
    const auto record = sector_with(confirmed(SLOT_B));
    EXPECT_EQ(boot::find_records(record.data(), ERASED.data()).write_sector, 1);
    EXPECT_EQ(boot::find_records(ERASED.data(), record.data()).write_sector, 0);
    EXPECT_EQ(boot::find_records(ERASED.data(), record.data()).newest->active, SLOT_B);
}

// --- What the bootloader decides ---------------------------------------------

TEST(BootControl, WithNoRecordSlotAStarts)
{
    const auto decision = boot::decide(std::nullopt, {true, true});
    EXPECT_EQ(decision.slot, SLOT_A);
    EXPECT_FALSE(decision.watchdog);
    EXPECT_FALSE(decision.write.has_value());
    EXPECT_EQ(boot::decide(std::nullopt, {false, true}).slot, SLOT_B);
    EXPECT_EQ(boot::decide(std::nullopt, {false, false}).slot, SLOT_A);
}

TEST(BootControl, AConfirmedSlotStartsWithoutWriting)
{
    for (const uint8_t slot : {SLOT_A, SLOT_B})
    {
        const auto decision = boot::decide(confirmed(slot), {true, true});
        EXPECT_EQ(decision.slot, slot);
        EXPECT_FALSE(decision.watchdog);
        EXPECT_FALSE(decision.write.has_value());
    }
}

TEST(BootControl, ABrokenConfirmedImageFallsBackToTheOtherSlot)
{
    const auto decision = boot::decide(confirmed(SLOT_B), {true, false});
    EXPECT_EQ(decision.slot, SLOT_A);
    ASSERT_TRUE(decision.write.has_value());
    EXPECT_EQ(decision.write->active, SLOT_A);
    EXPECT_EQ(decision.write->state, State::CONFIRMED);
    EXPECT_TRUE(decision.write->rolled_back);
}

TEST(BootControl, WithBothImagesBrokenTheConfirmedSlotStillStarts)
{
    const auto decision = boot::decide(confirmed(SLOT_B), {false, false});
    EXPECT_EQ(decision.slot, SLOT_B);
    EXPECT_FALSE(decision.write.has_value());
}

TEST(BootControl, ATrialBootUsesUpATryUnderTheWatchdog)
{
    const auto decision = boot::decide(trial(SLOT_B, 2), {true, true});
    EXPECT_EQ(decision.slot, SLOT_B);
    EXPECT_TRUE(decision.watchdog);
    ASSERT_TRUE(decision.write.has_value());
    EXPECT_EQ(decision.write->tries_left, 1);
    EXPECT_EQ(decision.write->state, State::TRIAL);
}

TEST(BootControl, ATrialWithNoTriesLeftRollsBack)
{
    const auto decision = boot::decide(trial(SLOT_B, 0), {true, true});
    EXPECT_EQ(decision.slot, SLOT_A);
    EXPECT_FALSE(decision.watchdog);
    ASSERT_TRUE(decision.write.has_value());
    EXPECT_EQ(decision.write->active, SLOT_A);
    EXPECT_EQ(decision.write->state, State::CONFIRMED);
    EXPECT_TRUE(decision.write->rolled_back);
    // The failed image stays described, for a check on the next boot
    EXPECT_EQ(decision.write->images, trial(SLOT_B, 0).images);
}

TEST(BootControl, ATrialWhoseImageIsBrokenRollsBackAtOnce)
{
    const auto decision = boot::decide(trial(SLOT_A, 3), {false, true});
    EXPECT_EQ(decision.slot, SLOT_B);
    EXPECT_TRUE(decision.write->rolled_back);
}

TEST(BootControl, ATrialWithNothingToGoBackToKeepsTrying)
{
    const auto decision = boot::decide(trial(SLOT_A, 0), {true, false});
    EXPECT_EQ(decision.slot, SLOT_A);
    EXPECT_TRUE(decision.watchdog);
    EXPECT_FALSE(decision.write.has_value());
}

TEST(BootControl, PlausibleVectorsPointIntoTheSlot)
{
    auto vectors = [](uint32_t stack, uint32_t reset) {
        std::array<uint8_t, 8> bytes{};
        std::memcpy(bytes.data(), &stack, 4);
        std::memcpy(bytes.data() + 4, &reset, 4);
        return bytes;
    };
    EXPECT_TRUE(boot::plausible_vectors(SLOT_A, vectors(0x20042000, 0x1000A0F7).data()));
    EXPECT_TRUE(boot::plausible_vectors(SLOT_B, vectors(0x20042000, 0x101040F7).data()));
    // Linked for the other slot
    EXPECT_FALSE(boot::plausible_vectors(SLOT_A, vectors(0x20042000, 0x101040F7).data()));
    EXPECT_FALSE(boot::plausible_vectors(SLOT_B, vectors(0x20042000, 0x1000A0F7).data()));
    // Erased flash
    EXPECT_FALSE(boot::plausible_vectors(SLOT_A, vectors(0xFFFFFFFF, 0xFFFFFFFF).data()));
    EXPECT_FALSE(boot::plausible_vectors(SLOT_A, vectors(0x10000000, 0x1000A0F7).data()));
}

// --- What the firmware writes ------------------------------------------------

TEST(BootControl, InstallingPutsTheNewSlotOnTrial)
{
    Record current = confirmed(SLOT_A);
    current.rolled_back = true;
    const auto record = boot::installing(current, SLOT_B, Image{3000, 0x33});
    EXPECT_EQ(record.active, SLOT_B);
    EXPECT_EQ(record.state, State::TRIAL);
    EXPECT_EQ(record.tries_left, boot::TRIAL_BOOTS);
    EXPECT_FALSE(record.rolled_back);
    EXPECT_EQ(record.images[SLOT_A], current.images[SLOT_A]);
    EXPECT_EQ(record.images[SLOT_B], (Image{3000, 0x33}));
    EXPECT_TRUE(boot::on_trial(record, SLOT_B));
    EXPECT_FALSE(boot::on_trial(record, SLOT_A));
}

TEST(BootControl, CommittingConfirmsTheTrialAndKeepsItsImage)
{
    const auto record = boot::committed(trial(SLOT_B, 1), SLOT_B, Image{5, 5});
    ASSERT_TRUE(record.has_value());
    EXPECT_EQ(record->state, State::CONFIRMED);
    EXPECT_EQ(record->active, SLOT_B);
    EXPECT_EQ(record->tries_left, 0);
    EXPECT_EQ(record->images, trial(SLOT_B, 1).images);
}

TEST(BootControl, CommittingWithNoRecordDescribesTheRunningImage)
{
    const auto record = boot::committed(std::nullopt, SLOT_A, Image{4096, 0x44});
    ASSERT_TRUE(record.has_value());
    EXPECT_EQ(record->active, SLOT_A);
    EXPECT_EQ(record->state, State::CONFIRMED);
    EXPECT_EQ(record->images[SLOT_A], (Image{4096, 0x44}));
    EXPECT_EQ(record->images[SLOT_B], Image{});
}

TEST(BootControl, CommittingAgainWritesNothing)
{
    EXPECT_FALSE(boot::committed(confirmed(SLOT_A), SLOT_A, Image{1, 1}).has_value());
}

TEST(BootControl, CommittingFromTheOtherSlotTakesItOver)
{
    const auto record = boot::committed(confirmed(SLOT_A), SLOT_B, Image{9, 9});
    ASSERT_TRUE(record.has_value());
    EXPECT_EQ(record->active, SLOT_B);
    EXPECT_EQ(record->images[SLOT_B], (Image{9, 9}));
}

TEST(BootControl, AbandoningATrialRollsBackOnTheNextBoot)
{
    const auto record = boot::abandoned(trial(SLOT_B, 3), SLOT_B);
    ASSERT_TRUE(record.has_value());
    EXPECT_EQ(record->tries_left, 0);
    EXPECT_EQ(record->state, State::TRIAL);
    const auto decision = boot::decide(*record, {true, true});
    EXPECT_EQ(decision.slot, SLOT_A);
    EXPECT_TRUE(decision.write->rolled_back);
}

TEST(BootControl, OnlyTheSlotOnTrialCanAbandonIt)
{
    EXPECT_FALSE(boot::abandoned(trial(SLOT_B, 3), SLOT_A).has_value());
    EXPECT_FALSE(boot::abandoned(confirmed(SLOT_B), SLOT_B).has_value());
    EXPECT_FALSE(boot::abandoned(std::nullopt, SLOT_A).has_value());
}

TEST(BootControl, AReportedRollbackIsForgotten)
{
    Record record = confirmed(SLOT_A);
    record.rolled_back = true;
    const auto forgotten = boot::rollback_forgotten(record, SLOT_A);
    ASSERT_TRUE(forgotten.has_value());
    EXPECT_FALSE(boot::after_rollback(forgotten, SLOT_A));
    EXPECT_EQ(forgotten->active, SLOT_A);
    EXPECT_EQ(forgotten->state, State::CONFIRMED);
    EXPECT_EQ(forgotten->images, record.images);
    // Nothing to forget
    EXPECT_FALSE(boot::rollback_forgotten(confirmed(SLOT_A), SLOT_A).has_value());
    EXPECT_FALSE(boot::rollback_forgotten(record, SLOT_B).has_value());
    EXPECT_FALSE(boot::rollback_forgotten(std::nullopt, SLOT_A).has_value());
}

TEST(BootControl, AfterRollbackIsTheActiveSlotsFlag)
{
    Record record = confirmed(SLOT_A);
    record.rolled_back = true;
    EXPECT_TRUE(boot::after_rollback(record, SLOT_A));
    EXPECT_FALSE(boot::after_rollback(record, SLOT_B));
    EXPECT_FALSE(boot::after_rollback(std::nullopt, SLOT_A));
    EXPECT_FALSE(boot::on_trial(std::nullopt, SLOT_A));
}

// --- Whole updates, with the power cut at any flash operation ----------------

namespace
{

// The two record sectors and the two slots, in a flash whose every erase and
// program can be cut short. A slot holds an image by number (0: erased or
// torn); a number's image is "good" (its firmware commits) when it's even.
class SimulatedBoard
{
  public:
    explicit SimulatedBoard(uint32_t seed, int cut_one_in) : rng(seed), cut_one_in(cut_one_in)
    {
        for (auto &sector : sectors)
        {
            sector.assign(boot::SECTOR_SIZE, 0xFF);
        }
    }

    // The power was cut during the last operation: everything stops until the
    // next boot
    bool cut = false;
    std::array<std::vector<uint8_t>, 2> sectors;
    std::array<uint32_t, 2> slots = {2, 0};

    static Image image_of(uint32_t number)
    {
        return number == 0 ? Image{} : Image{4096 + number * 256, number * 2654435761U};
    }

    static bool good(uint32_t number)
    {
        return number != 0 && number % 2 == 0;
    }

    boot::Records records() const
    {
        return boot::find_records(sectors[0].data(), sectors[1].data());
    }

    std::array<bool, 2> check_images() const
    {
        const auto newest = records().newest;
        std::array<bool, 2> ok{};
        for (uint8_t slot = SLOT_A; slot <= SLOT_B; slot++)
        {
            const Image described = newest ? newest->images[slot] : Image{};
            ok[slot] = slots[slot] != 0 && (described.size == 0 || described == image_of(slots[slot]));
        }
        return ok;
    }

    // An erase or a program: false (and the flash left torn) if the power
    // is cut during it
    bool operation()
    {
        if (cut || std::uniform_int_distribution<int>(1, cut_one_in)(rng) == 1)
        {
            cut = true;
        }
        return !cut;
    }

    void save(const Record &record)
    {
        const auto records = this->records();
        auto &sector = sectors[records.write_sector];
        if (!operation())
        {
            // A torn erase leaves anything at all
            for (auto &byte : sector)
            {
                byte = static_cast<uint8_t>(rng());
            }
            return;
        }
        std::fill(sector.begin(), sector.end(), 0xFF);
        const auto bytes = boot::encode(boot::next(records, record));
        const bool whole = operation();
        for (size_t i = 0; i < bytes.size(); i++)
        {
            // A torn program sets only some of the bits it would have
            sector[i] = whole ? bytes[i] : static_cast<uint8_t>(bytes[i] | rng());
        }
    }

    void write_slot(uint8_t slot, uint32_t number)
    {
        slots[slot] = 0;
        if (operation())
        {
            slots[slot] = number;
        }
    }

    std::mt19937 rng;

  private:
    int cut_one_in;
};

} // namespace

// Through any run of boots, commits and updates (good and bad), with power cuts
// anywhere: the bootloader only ever starts an intact image, a board that ran
// good firmware never loses its last good image, and a bad image gets no more
// than its trial boots (counting those whose record was saved, since a power
// cut before that leaves the count where it was).
RC_GTEST_PROP(BootControl, PowerCutsNeverLeaveTheBoardWithoutGoodFirmware, ())
{
    const auto seed = *rc::gen::arbitrary<uint32_t>();
    const int cut_one_in = *rc::gen::inRange(2, 20);
    SimulatedBoard board(seed, cut_one_in);
    uint32_t next_number = 3;
    std::map<uint32_t, int> bad_boots;

    for (int boot_count = 0; boot_count < 60; boot_count++)
    {
        board.cut = false;
        const auto records = board.records();
        const Decision decision = boot::decide(records.newest, board.check_images());
        if (decision.write)
        {
            board.save(*decision.write);
            if (board.cut)
            {
                continue;
            }
        }

        const uint32_t running = board.slots[decision.slot];
        RC_ASSERT(running != 0U);
        const bool other_good = SimulatedBoard::good(board.slots[boot::other_slot(decision.slot)]);
        RC_ASSERT(SimulatedBoard::good(running) || other_good);

        if (!SimulatedBoard::good(running))
        {
            RC_ASSERT(++bad_boots[running] <= int{boot::TRIAL_BOOTS});
            continue; // crashes, and reboots
        }
        const auto commit = boot::committed(board.records().newest, decision.slot, SimulatedBoard::image_of(running));
        if (commit)
        {
            board.save(*commit);
            if (board.cut)
            {
                continue;
            }
        }
        if (board.rng() % 2 == 0)
        {
            const uint8_t target = boot::other_slot(decision.slot);
            const uint32_t number = next_number++;
            board.write_slot(target, number);
            if (!board.cut)
            {
                board.save(boot::installing(board.records().newest, target, SimulatedBoard::image_of(number)));
            }
        }
    }
}

// With no power cuts: a bad update is rolled back after its trial boots, and
// a good one stays
TEST(BootControl, ABadUpdateIsRolledBackAfterItsTrialBoots)
{
    SimulatedBoard board(1, 1 << 30);
    const auto first = boot::committed(std::nullopt, SLOT_A, SimulatedBoard::image_of(2));
    board.save(*first);
    board.write_slot(SLOT_B, 3);
    board.save(boot::installing(board.records().newest, SLOT_B, SimulatedBoard::image_of(3)));

    for (int i = 0; i < boot::TRIAL_BOOTS; i++)
    {
        const Decision decision = boot::decide(board.records().newest, board.check_images());
        EXPECT_EQ(decision.slot, SLOT_B);
        EXPECT_TRUE(decision.watchdog);
        board.save(*decision.write);
    }
    const Decision decision = boot::decide(board.records().newest, board.check_images());
    EXPECT_EQ(decision.slot, SLOT_A);
    board.save(*decision.write);
    EXPECT_TRUE(boot::after_rollback(board.records().newest, SLOT_A));
    EXPECT_FALSE(boot::decide(board.records().newest, board.check_images()).write.has_value());
}
