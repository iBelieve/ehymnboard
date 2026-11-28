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

#pragma once

// A/B boot control: which of the two firmware slots the bootloader starts,
// whether that firmware is still on trial, and each slot's image size and
// CRC-32. The firmware runs in place from either slot (it's linked once for
// each), so installing an update is writing the other slot and then one boot
// record, and a rollback is starting the other slot again: nothing is ever
// copied between slots.
//
// The record is kept in two flash sectors. A new one always goes into the
// sector that doesn't hold the newest valid record, so a power cut while
// writing it leaves the previous one in place; each record carries a
// sequence number and a CRC, so a half-written one is ignored.
//
// Pure logic, shared by the bootloader (bootloader_main.cpp) and the firmware
// (ota.cpp through boot_flash.cpp), and tested on the host with simulated
// power cuts (test/test_boot_control.cpp).

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>

namespace boot
{

constexpr uint32_t SECTOR_SIZE = 4096;
constexpr uint32_t PAGE_SIZE = 256;

// Flash layout, as offsets from the start of flash. Slots A and B are where
// pico_fota_bootloader kept its application and download slots, so firmware
// linked for slot A runs under either bootloader. Matches the EHB_* layout in
// CMakeLists.txt.
//
// The first sector holds boot2 and a stub that starts the bootloader, or the
// firmware in slot A if the bootloader isn't complete (see boot_stub.S)
constexpr uint32_t STUB_OFFSET = 0x0000;
constexpr uint32_t BOOTLOADER_OFFSET = 0x1000;
// The bootloader's marker sits at the end of its area, written after the
// rest of it, so the stub only ever starts a complete bootloader
constexpr uint32_t BOOTLOADER_MARKER_OFFSET = 0x7FF0;
constexpr uint32_t BOOTLOADER_MAX_SIZE = BOOTLOADER_MARKER_OFFSET - BOOTLOADER_OFFSET;
constexpr std::array<uint32_t, 2> RECORD_OFFSETS = {0x8000, 0x9000};
constexpr std::array<uint32_t, 2> SLOT_OFFSETS = {0xA000, 0x104000};
constexpr uint32_t SLOT_SIZE = 0xFA000;

constexpr uint32_t BOOTLOADER_MARKER_MAGIC = 0x4C424845; // "EHBL"

constexpr uint8_t SLOT_A = 0;
constexpr uint8_t SLOT_B = 1;
constexpr uint8_t other_slot(uint8_t slot)
{
    return slot == SLOT_A ? SLOT_B : SLOT_A;
}

// New firmware gets this many boots to prove itself (commit) before the
// bootloader goes back to the other slot. More than one, so a single power cut
// or reboot during the trial doesn't throw away a good update.
constexpr uint8_t TRIAL_BOOTS = 3;

// The image in a slot, as the firmware wrote it: its size in bytes and its
// CRC-32. A size of 0 means the record doesn't describe that slot.
struct Image
{
    uint32_t size = 0;
    uint32_t crc = 0;

    bool operator==(const Image &other) const
    {
        return size == other.size && crc == other.crc;
    }
};

enum class State : uint8_t
{
    // The active slot's firmware has proven itself
    CONFIRMED = 1,
    // The active slot's firmware is new and has `tries_left` boots to commit
    TRIAL = 2,
};

struct Record
{
    uint32_t seq = 0;
    uint8_t active = SLOT_A;
    State state = State::CONFIRMED;
    uint8_t tries_left = 0;
    // The bootloader went back to the active slot because the other one
    // failed; cleared by the next install
    bool rolled_back = false;
    std::array<Image, 2> images{};

    bool operator==(const Record &other) const;
};

constexpr size_t RECORD_BYTES = 32;
using RecordBytes = std::array<uint8_t, RECORD_BYTES>;

// CRC-32 (IEEE, as zlib's crc32()), continuing from `crc`
uint32_t crc32(const uint8_t *data, size_t length, uint32_t crc = 0);

RecordBytes encode(const Record &record);
// Nothing if `bytes` (at least RECORD_BYTES long) isn't a whole, valid record
std::optional<Record> decode(const uint8_t *bytes);

// The newest valid record in the two sectors, and which sector a new record
// must go into
struct Records
{
    std::optional<Record> newest;
    int write_sector = 0;
};
Records find_records(const uint8_t *sector0, const uint8_t *sector1);

// `record`, numbered to supersede the newest one
Record next(const Records &records, Record record);

// What the bootloader does on this boot
struct Decision
{
    uint8_t slot = SLOT_A;
    // Arm the watchdog before starting it: it's a trial boot, so a hang
    // anywhere must reboot (and so count against the trial)
    bool watchdog = false;
    // Save this record (numbered with next()) before starting the slot
    std::optional<Record> write;
};

// `image_ok[s]`: whether slot s holds a usable image. When the record
// describes the slot, that's its size and CRC matching; otherwise whether it
// looks like firmware at all (see plausible_vectors()).
Decision decide(const std::optional<Record> &newest, const std::array<bool, 2> &image_ok);

// Whether the start of a slot looks like firmware linked for it: a stack in
// RAM and a reset handler inside the slot. `vectors` is the slot's first
// 8 bytes.
bool plausible_vectors(uint8_t slot, const uint8_t *vectors);

// --- What the firmware writes ------------------------------------------------

// Starts the image just written to `slot` on trial
Record installing(const std::optional<Record> &current, uint8_t slot, Image image);
// The running firmware in `slot` (whose own image is `image`) works. Nothing
// if the record already says so.
std::optional<Record> committed(const std::optional<Record> &current, uint8_t slot, Image image);

// The firmware on trial in `slot` knows it's broken: the bootloader goes back
// to the other slot on the next boot, without spending the trial's other
// boots. Nothing if it isn't on trial.
std::optional<Record> abandoned(const std::optional<Record> &current, uint8_t slot);

// The firmware in `slot` has reported that the bootloader went back to it:
// the flag cleared. Nothing if it isn't set.
std::optional<Record> rollback_forgotten(const std::optional<Record> &current, uint8_t slot);

// The running firmware's view of the record
bool on_trial(const std::optional<Record> &current, uint8_t slot);
bool after_rollback(const std::optional<Record> &current, uint8_t slot);

} // namespace boot
