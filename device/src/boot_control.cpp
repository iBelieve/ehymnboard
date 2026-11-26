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

#include "boot_control.h"

namespace boot
{

// "EHB1": changes if the record's layout ever does
static constexpr uint32_t RECORD_MAGIC = 0x31424845;
static constexpr uint8_t FLAG_ROLLED_BACK = 0x01;
static constexpr size_t CRC_OFFSET = RECORD_BYTES - 4;

static constexpr uint32_t RAM_START = 0x20000000;
static constexpr uint32_t RAM_END = 0x20042000;
static constexpr uint32_t XIP_BASE_ADDRESS = 0x10000000;

static constexpr std::array<uint32_t, 256> make_crc_table()
{
    std::array<uint32_t, 256> table{};
    for (uint32_t i = 0; i < table.size(); i++)
    {
        uint32_t crc = i;
        for (int bit = 0; bit < 8; bit++)
        {
            crc = (crc & 1U) != 0 ? (crc >> 1U) ^ 0xEDB88320U : crc >> 1U;
        }
        table[i] = crc;
    }
    return table;
}

static constexpr std::array<uint32_t, 256> CRC_TABLE = make_crc_table();

uint32_t crc32(const uint8_t *data, size_t length, uint32_t crc)
{
    crc = ~crc;
    for (size_t i = 0; i < length; i++)
    {
        crc = CRC_TABLE[(crc ^ data[i]) & 0xFFU] ^ (crc >> 8U);
    }
    return ~crc;
}

static void put32(uint8_t *out, uint32_t value)
{
    for (int i = 0; i < 4; i++)
    {
        out[i] = static_cast<uint8_t>(value >> (8U * i));
    }
}

static uint32_t get32(const uint8_t *in)
{
    uint32_t value = 0;
    for (int i = 0; i < 4; i++)
    {
        value |= static_cast<uint32_t>(in[i]) << (8U * i);
    }
    return value;
}

bool Record::operator==(const Record &other) const
{
    return seq == other.seq && active == other.active && state == other.state && tries_left == other.tries_left &&
           rolled_back == other.rolled_back && images == other.images;
}

RecordBytes encode(const Record &record)
{
    RecordBytes bytes{};
    put32(&bytes[0], RECORD_MAGIC);
    put32(&bytes[4], record.seq);
    bytes[8] = record.active;
    bytes[9] = static_cast<uint8_t>(record.state);
    bytes[10] = record.tries_left;
    bytes[11] = record.rolled_back ? FLAG_ROLLED_BACK : 0;
    for (size_t slot = 0; slot < 2; slot++)
    {
        put32(&bytes[12 + 8 * slot], record.images[slot].size);
        put32(&bytes[16 + 8 * slot], record.images[slot].crc);
    }
    put32(&bytes[CRC_OFFSET], crc32(bytes.data(), CRC_OFFSET));
    return bytes;
}

std::optional<Record> decode(const uint8_t *bytes)
{
    if (get32(bytes) != RECORD_MAGIC || get32(bytes + CRC_OFFSET) != crc32(bytes, CRC_OFFSET))
    {
        return std::nullopt;
    }

    Record record;
    record.seq = get32(bytes + 4);
    record.active = bytes[8];
    record.tries_left = bytes[10];
    record.rolled_back = (bytes[11] & FLAG_ROLLED_BACK) != 0;
    // A CRC that matches over values this firmware never writes means a
    // newer layout under the same magic; don't guess at it
    if (record.active > SLOT_B ||
        (bytes[9] != static_cast<uint8_t>(State::CONFIRMED) && bytes[9] != static_cast<uint8_t>(State::TRIAL)))
    {
        return std::nullopt;
    }
    record.state = static_cast<State>(bytes[9]);
    for (size_t slot = 0; slot < 2; slot++)
    {
        record.images[slot].size = get32(bytes + 12 + 8 * slot);
        record.images[slot].crc = get32(bytes + 16 + 8 * slot);
    }
    return record;
}

Records find_records(const uint8_t *sector0, const uint8_t *sector1)
{
    const auto first = decode(sector0);
    const auto second = decode(sector1);

    if (second && (!first || second->seq > first->seq))
    {
        return {second, 0};
    }
    // With neither valid, sector 0 is as good as any
    return {first, first ? 1 : 0};
}

Record next(const Records &records, Record record)
{
    record.seq = records.newest ? records.newest->seq + 1 : 1;
    return record;
}

// The trial of the active slot is over without a commit, or its image is bad:
// go back to the other slot, if that one's usable
static Decision end_trial(const Record &record, const std::array<bool, 2> &image_ok)
{
    const uint8_t previous = other_slot(record.active);
    if (!image_ok[previous])
    {
        // Nothing better to go back to: keep trying the new firmware
        return {record.active, true, std::nullopt};
    }

    Record rolled_back = record;
    rolled_back.active = previous;
    rolled_back.state = State::CONFIRMED;
    rolled_back.tries_left = 0;
    rolled_back.rolled_back = true;
    return {previous, false, rolled_back};
}

Decision decide(const std::optional<Record> &newest, const std::array<bool, 2> &image_ok)
{
    if (!newest)
    {
        // Fresh from USB or from pico_fota_bootloader: slot A, as that
        // bootloader would have started
        return {image_ok[SLOT_A] || !image_ok[SLOT_B] ? SLOT_A : SLOT_B, false, std::nullopt};
    }

    const Record &record = *newest;
    if (record.state == State::TRIAL)
    {
        if (record.tries_left == 0 || !image_ok[record.active])
        {
            return end_trial(record, image_ok);
        }
        Record tried = record;
        tried.tries_left--;
        return {record.active, true, tried};
    }

    if (image_ok[record.active] || !image_ok[other_slot(record.active)])
    {
        return {record.active, false, std::nullopt};
    }
    // The confirmed firmware's image went bad, but the other slot's is fine
    Record fallback = record;
    fallback.active = other_slot(record.active);
    fallback.rolled_back = true;
    return {fallback.active, false, fallback};
}

bool plausible_vectors(uint8_t slot, const uint8_t *vectors)
{
    const uint32_t stack = get32(vectors);
    const uint32_t reset = get32(vectors + 4);
    const uint32_t start = XIP_BASE_ADDRESS + SLOT_OFFSETS[slot];
    return stack > RAM_START && stack <= RAM_END && reset > start && reset < start + SLOT_SIZE;
}

Record installing(const std::optional<Record> &current, uint8_t slot, Image image)
{
    Record record = current.value_or(Record{});
    record.active = slot;
    record.state = State::TRIAL;
    record.tries_left = TRIAL_BOOTS;
    record.rolled_back = false;
    record.images[slot] = image;
    return record;
}

std::optional<Record> committed(const std::optional<Record> &current, uint8_t slot, Image image)
{
    if (current && current->active == slot && current->state == State::CONFIRMED && current->images[slot].size != 0)
    {
        return std::nullopt;
    }

    Record record = current.value_or(Record{});
    // On trial, the installer recorded the image (with its trailer); keep it
    if (!current || current->active != slot || record.images[slot].size == 0)
    {
        record.images[slot] = image;
    }
    record.active = slot;
    record.state = State::CONFIRMED;
    record.tries_left = 0;
    return record;
}

std::optional<Record> abandoned(const std::optional<Record> &current, uint8_t slot)
{
    if (!current || !on_trial(current, slot))
    {
        return std::nullopt;
    }
    Record record = *current;
    record.tries_left = 0;
    return record;
}

bool on_trial(const std::optional<Record> &current, uint8_t slot)
{
    return current && current->active == slot && current->state == State::TRIAL;
}

bool after_rollback(const std::optional<Record> &current, uint8_t slot)
{
    return current && current->active == slot && current->rolled_back;
}

} // namespace boot
