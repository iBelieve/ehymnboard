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

#include "ota_slots.h"

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>

#include "boot_flash.h"
#include "bootloader_install.h"
#include "flash_write.h"
#include "hardware/flash.h"
#include "hardware/watchdog.h"
#include "long_watchdog.h"
#include "mbedtls/aes.h"
#include "mbedtls/sha256.h"

#ifndef EHYMNBOARD_OTA_AES_KEY
#error "Set EHYMNBOARD_OTA_AES_KEY (CMakeLists.txt does)"
#endif

// The image's trailer: 256 bytes ending in the SHA-256 of what comes before
static constexpr size_t TRAILER_SIZE = 256;
static constexpr size_t SHA256_SIZE = 32;
static constexpr size_t AES_BLOCK_SIZE = 16;

// From the linker script: where this firmware's image starts and ends
// NOLINTBEGIN(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp): the linker script's names
extern "C" char __flash_binary_start[];
extern "C" char __flash_binary_end[];
// NOLINTEND(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp)

static mbedtls_aes_context aes;
// The update slot is erased up to here (an offset in the slot)
static size_t erased_to = 0;

uint8_t running_slot()
{
    // NOLINTNEXTLINE(performance-no-int-to-ptr): comparing addresses
    return reinterpret_cast<const uint8_t *>(__flash_binary_start) == boot::flash_at(boot::SLOT_OFFSETS[boot::SLOT_B])
               ? boot::SLOT_B
               : boot::SLOT_A;
}

const char *slot_name(uint8_t slot)
{
    return slot == boot::SLOT_B ? "b" : "a";
}

uint8_t update_slot()
{
    return boot::other_slot(running_slot());
}

size_t slot_capacity()
{
    return boot::SLOT_SIZE;
}

static boot::Image running_image()
{
    const auto size = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(__flash_binary_end) -
                                            reinterpret_cast<uintptr_t>(__flash_binary_start));
    return {size, boot::slot_crc(running_slot(), size)};
}

bool can_install_updates()
{
    return running_bootloader() == BootloaderKind::A_B;
}

bool after_firmware_update()
{
    switch (running_bootloader())
    {
    case BootloaderKind::OLD:
        return old_bootloader::after_firmware_update();
    case BootloaderKind::A_B:
        return boot::on_trial(boot::read_records().newest, running_slot());
    case BootloaderKind::STUB_ONLY:
        break;
    }
    return false;
}

bool after_rollback()
{
    switch (running_bootloader())
    {
    case BootloaderKind::OLD:
        return old_bootloader::after_rollback();
    case BootloaderKind::A_B:
        return boot::after_rollback(boot::read_records().newest, running_slot());
    case BootloaderKind::STUB_ONLY:
        break;
    }
    return false;
}

static void save_record(const boot::Records &records, const boot::Record &record)
{
    const auto page = boot::record_page(boot::next(records, record));
    const uint32_t offset = boot::RECORD_OFFSETS[records.write_sector];
    if (!flash_write_safely([&page, offset]() { boot::erase_and_program(offset, page); }))
    {
        printf("OTA: couldn't save the boot record\n");
    }
}

void commit_running_firmware()
{
    if (running_bootloader() != BootloaderKind::A_B)
    {
        // Replacing pico_fota_bootloader commits this firmware with it. Only
        // if that fails is pico_fota_bootloader told: rewriting its flash info
        // sector is a moment a power cut leaves it nothing to start.
        if (running_slot() != boot::SLOT_A || !install_bootloader())
        {
            if (running_bootloader() == BootloaderKind::OLD)
            {
                old_bootloader::commit();
            }
            return;
        }
    }

    const auto records = boot::read_records();
    const auto record = boot::committed(records.newest, running_slot(), running_image());
    if (record)
    {
        save_record(records, *record);
    }
}

void forget_rollback()
{
    if (!can_install_updates())
    {
        return;
    }
    const auto records = boot::read_records();
    const auto record = boot::rollback_forgotten(records.newest, running_slot());
    if (record)
    {
        save_record(records, *record);
    }
}

void abandon_update()
{
    if (!can_install_updates())
    {
        return;
    }
    const auto records = boot::read_records();
    const auto record = boot::abandoned(records.newest, running_slot());
    if (record)
    {
        save_record(records, *record);
    }
}

bool begin_update()
{
    erased_to = 0;
    mbedtls_aes_free(&aes);
    mbedtls_aes_init(&aes);
    return mbedtls_aes_setkey_dec(&aes, reinterpret_cast<const unsigned char *>(EHYMNBOARD_OTA_AES_KEY),
                                  strlen(EHYMNBOARD_OTA_AES_KEY) * 8) == 0;
}

bool write_update(uint8_t *encrypted, size_t offset, size_t length)
{
    if (offset % boot::PAGE_SIZE != 0 || length % boot::PAGE_SIZE != 0 || offset + length > slot_capacity())
    {
        return false;
    }
    for (size_t at = 0; at < length; at += AES_BLOCK_SIZE)
    {
        if (mbedtls_aes_crypt_ecb(&aes, MBEDTLS_AES_DECRYPT, encrypted + at, encrypted + at) != 0)
        {
            return false;
        }
    }

    const uint32_t slot = boot::SLOT_OFFSETS[update_slot()];
    const size_t erase_from = erased_to;
    // Whole sectors, as far as this write reaches
    const size_t reach = (offset + length + boot::SECTOR_SIZE - 1) / boot::SECTOR_SIZE * boot::SECTOR_SIZE;
    const size_t erase_to = std::max(erased_to, reach);
    const bool written = flash_write_safely([=]() {
        if (erase_to > erase_from)
        {
            flash_range_erase(slot + erase_from, erase_to - erase_from);
        }
        flash_range_program(slot + offset, encrypted, length);
    });
    if (!written)
    {
        return false;
    }
    erased_to = erase_to;
    return memcmp(boot::flash_at(slot + offset), encrypted, length) == 0;
}

bool verify_update(size_t size)
{
    if (size < TRAILER_SIZE || size % boot::PAGE_SIZE != 0 || size > erased_to)
    {
        return false;
    }
    long_watchdog_update();
    const uint8_t *image = boot::flash_at(boot::SLOT_OFFSETS[update_slot()]);
    std::array<unsigned char, SHA256_SIZE> digest{};
    if (mbedtls_sha256(image, size - TRAILER_SIZE, digest.data(), 0) != 0)
    {
        return false;
    }
    return memcmp(digest.data(), image + size - SHA256_SIZE, SHA256_SIZE) == 0;
}

bool update_runs_in_its_slot()
{
    const uint8_t slot = update_slot();
    return boot::plausible_vectors(slot, boot::flash_at(boot::SLOT_OFFSETS[slot]));
}

void install_update(size_t size)
{
    mbedtls_aes_free(&aes);
    const uint8_t slot = update_slot();
    const auto records = boot::read_records();
    const boot::Image image = {static_cast<uint32_t>(size), boot::slot_crc(slot, static_cast<uint32_t>(size))};
    save_record(records, boot::installing(records.newest, slot, image));

    // Reboots into the bootloader, which starts the new firmware on trial
    watchdog_enable(1, true);
    while (true)
    {
        tight_loop_contents();
    }
}
