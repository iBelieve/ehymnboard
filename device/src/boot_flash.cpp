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

#include "boot_flash.h"

#include <algorithm>

#include "hardware/flash.h"
#include "hardware/regs/addressmap.h"

namespace boot
{

static_assert(SECTOR_SIZE == FLASH_SECTOR_SIZE && PAGE_SIZE == FLASH_PAGE_SIZE);

const uint8_t *flash_at(uint32_t offset)
{
    // NOLINTNEXTLINE(performance-no-int-to-ptr): memory-mapped flash
    return reinterpret_cast<const uint8_t *>(XIP_BASE + offset);
}

Records read_records()
{
    return find_records(flash_at(RECORD_OFFSETS[0]), flash_at(RECORD_OFFSETS[1]));
}

std::array<bool, 2> check_images(const std::optional<Record> &newest)
{
    std::array<bool, 2> ok{};
    for (uint8_t slot = SLOT_A; slot <= SLOT_B; slot++)
    {
        const uint8_t *start = flash_at(SLOT_OFFSETS[slot]);
        const Image image = newest ? newest->images[slot] : Image{};
        if (image.size == 0)
        {
            ok[slot] = plausible_vectors(slot, start);
        }
        else
        {
            ok[slot] =
                image.size <= SLOT_SIZE && plausible_vectors(slot, start) && crc32(start, image.size) == image.crc;
        }
    }
    return ok;
}

uint32_t slot_crc(uint8_t slot, uint32_t size)
{
    return crc32(flash_at(SLOT_OFFSETS[slot]), size);
}

std::array<uint8_t, PAGE_SIZE> record_page(const Record &record)
{
    std::array<uint8_t, PAGE_SIZE> page{};
    page.fill(0xFF);
    const auto bytes = encode(record);
    std::copy(bytes.begin(), bytes.end(), page.begin());
    return page;
}

void erase_and_program(uint32_t offset, const std::array<uint8_t, PAGE_SIZE> &page)
{
    flash_range_erase(offset, SECTOR_SIZE);
    flash_range_program(offset, page.data(), page.size());
}

} // namespace boot
