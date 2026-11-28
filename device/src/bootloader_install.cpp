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

#include "bootloader_install.h"

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>

#include "boot_flash.h"
#include "flash_write.h"
#include "hardware/flash.h"
#include "long_watchdog.h"

// The stub's sector and the bootloader, built alongside the firmware and
// included by bootloader_images.S
extern "C" const uint8_t ehb_stub_image[];
extern "C" const uint8_t ehb_stub_image_end[];
extern "C" const uint8_t ehb_bootloader_image[];
extern "C" const uint8_t ehb_bootloader_image_end[];

// The size of an image from its start and end symbols
static size_t image_size(const uint8_t *start, const uint8_t *end)
{
    return reinterpret_cast<uintptr_t>(end) - reinterpret_cast<uintptr_t>(start);
}

static size_t stub_size()
{
    return image_size(ehb_stub_image, ehb_stub_image_end);
}

static size_t bootloader_size()
{
    return image_size(ehb_bootloader_image, ehb_bootloader_image_end);
}

using Marker = std::array<uint32_t, 4>;

static Marker bootloader_marker()
{
    const auto size = static_cast<uint32_t>(bootloader_size());
    return {boot::BOOTLOADER_MARKER_MAGIC, size, boot::crc32(ehb_bootloader_image, size),
            ~boot::BOOTLOADER_MARKER_MAGIC};
}

static bool flash_matches(uint32_t offset, const void *data, size_t size)
{
    return memcmp(boot::flash_at(offset), data, size) == 0;
}

// The stub's vector table, after boot2's 256 bytes: its stack, and its reset
// handler just behind the table. pico_fota_bootloader's points past a whole
// vector table. Only this is compared, not the whole first sector, so a later
// build whose boot2 (pico-sdk's) or stub code differs still sees a board on
// the A/B bootloader as one, rather than as one on pico_fota_bootloader.
static constexpr uint32_t STUB_VECTORS_OFFSET = 256;
static constexpr size_t STUB_VECTORS_SIZE = 8;

static bool stub_in_place()
{
    return stub_size() >= STUB_VECTORS_OFFSET + STUB_VECTORS_SIZE &&
           flash_matches(boot::STUB_OFFSET + STUB_VECTORS_OFFSET, ehb_stub_image + STUB_VECTORS_OFFSET,
                         STUB_VECTORS_SIZE);
}

BootloaderKind running_bootloader()
{
    if (!stub_in_place())
    {
        return BootloaderKind::OLD;
    }
    Marker marker{};
    memcpy(marker.data(), boot::flash_at(boot::BOOTLOADER_MARKER_OFFSET), sizeof(marker));
    return marker[0] == boot::BOOTLOADER_MARKER_MAGIC && marker[3] == ~boot::BOOTLOADER_MARKER_MAGIC
               ? BootloaderKind::A_B
               : BootloaderKind::STUB_ONLY;
}

// Erases [offset, offset + erase_size) and programs `data` at its start,
// padded to whole pages with 0xFF, then checks it reads back
static bool rewrite(uint32_t offset, uint32_t erase_size, const uint8_t *data, size_t size)
{
    long_watchdog_update();
    const bool written = flash_write_safely([=]() {
        flash_range_erase(offset, erase_size);
        std::array<uint8_t, boot::PAGE_SIZE> page{};
        for (size_t at = 0; at < size; at += page.size())
        {
            page.fill(0xFF);
            memcpy(page.data(), data + at, std::min(page.size(), size - at));
            flash_range_program(offset + at, page.data(), page.size());
        }
    });
    return written && flash_matches(offset, data, size);
}

static bool erase(uint32_t offset)
{
    long_watchdog_update();
    const bool erased = flash_write_safely([=]() { flash_range_erase(offset, boot::SECTOR_SIZE); });
    const uint8_t *start = boot::flash_at(offset);
    return erased && std::all_of(start, start + boot::SECTOR_SIZE, [](uint8_t byte) { return byte == 0xFF; });
}

bool install_bootloader()
{
    static_assert(boot::BOOTLOADER_MARKER_OFFSET % boot::PAGE_SIZE == boot::PAGE_SIZE - sizeof(Marker),
                  "The marker must end its page");
    constexpr uint32_t MARKER_PAGE = boot::BOOTLOADER_MARKER_OFFSET - (boot::PAGE_SIZE - sizeof(Marker));
    if (stub_size() > boot::SECTOR_SIZE || bootloader_size() > MARKER_PAGE - boot::BOOTLOADER_OFFSET)
    {
        printf("Bootloader: images too large to install\n");
        return false;
    }

    if (running_bootloader() == BootloaderKind::OLD)
    {
        printf("Bootloader: replacing pico_fota_bootloader's first sector\n");
        if (!rewrite(boot::STUB_OFFSET, boot::SECTOR_SIZE, ehb_stub_image, stub_size()))
        {
            printf("Bootloader: first sector didn't read back\n");
            return false;
        }
    }

    printf("Bootloader: installing the A/B bootloader\n");
    for (const uint32_t offset : boot::RECORD_OFFSETS)
    {
        if (!erase(offset))
        {
            return false;
        }
    }
    if (!rewrite(boot::BOOTLOADER_OFFSET, boot::RECORD_OFFSETS[0] - boot::BOOTLOADER_OFFSET, ehb_bootloader_image,
                 bootloader_size()))
    {
        printf("Bootloader: bootloader didn't read back\n");
        return false;
    }

    // The sector is erased already, so the marker programs in place
    std::array<uint8_t, boot::PAGE_SIZE> page{};
    page.fill(0xFF);
    const Marker marker = bootloader_marker();
    memcpy(page.data() + page.size() - sizeof(marker), marker.data(), sizeof(marker));
    long_watchdog_update();
    const bool written = flash_write_safely([&page]() { flash_range_program(MARKER_PAGE, page.data(), page.size()); });
    if (!written || running_bootloader() != BootloaderKind::A_B)
    {
        printf("Bootloader: marker didn't read back\n");
        return false;
    }

    printf("Bootloader: A/B bootloader installed\n");
    return true;
}

namespace old_bootloader
{

// pico_fota_bootloader's flash info sector (its linker_definitions.in and
// flash_utils.h): four flags after the two slot addresses
static constexpr uint32_t INFO_OFFSET = 0x9000;
static constexpr uint32_t SWAPPED_OFFSET = INFO_OFFSET + 12;
static constexpr uint32_t AFTER_ROLLBACK_OFFSET = INFO_OFFSET + 16;
static constexpr uint32_t SHOULD_ROLLBACK_OFFSET = INFO_OFFSET + 20;
static constexpr uint32_t HAS_NEW_FIRMWARE_MAGIC = 0x12345678;
static constexpr uint32_t IS_AFTER_ROLLBACK_MAGIC = 0xbeefbeef;

static uint32_t read_flag(uint32_t offset)
{
    uint32_t value = 0;
    memcpy(&value, boot::flash_at(offset), sizeof(value));
    return value;
}

bool after_firmware_update()
{
    return read_flag(SWAPPED_OFFSET) == HAS_NEW_FIRMWARE_MAGIC;
}

bool after_rollback()
{
    return read_flag(AFTER_ROLLBACK_OFFSET) == IS_AFTER_ROLLBACK_MAGIC;
}

void commit()
{
    if (read_flag(SHOULD_ROLLBACK_OFFSET) == 0)
    {
        return;
    }
    // As it does: the whole sector rewritten with the one flag cleared
    // Static: more than the main stack would hold
    static std::array<uint8_t, boot::SECTOR_SIZE> sector{};
    memcpy(sector.data(), boot::flash_at(INFO_OFFSET), sector.size());
    memset(sector.data() + (SHOULD_ROLLBACK_OFFSET - INFO_OFFSET), 0, sizeof(uint32_t));
    rewrite(INFO_OFFSET, boot::SECTOR_SIZE, sector.data(), sector.size());
}

} // namespace old_bootloader
