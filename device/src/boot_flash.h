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

// The flash side of boot_control.h, shared by the bootloader and the
// firmware: reading the boot records and checking the slots' images.

#include <array>
#include <cstdint>

#include "boot_control.h"

namespace boot
{

// The memory-mapped (XIP) address of a flash offset
const uint8_t *flash_at(uint32_t offset);

Records read_records();

// Whether each slot holds a usable image (see decide())
std::array<bool, 2> check_images(const std::optional<Record> &newest);

// CRC-32 of the first `size` bytes of a slot
uint32_t slot_crc(uint8_t slot, uint32_t size);

// The flash page that stores `record` (the rest of the page erased)
std::array<uint8_t, PAGE_SIZE> record_page(const Record &record);

// Erases the sector at `offset` and programs `page` at its start. The caller
// makes it safe to touch flash (interrupts off, the other core paused).
void erase_and_program(uint32_t offset, const std::array<uint8_t, PAGE_SIZE> &page);

} // namespace boot
