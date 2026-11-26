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

// Moves a board from pico_fota_bootloader to the A/B bootloader over the air.
// The firmware carries both parts of the new one: flash's first sector (boot2
// and the stub, boot_stub.S) and the bootloader proper.
//
// 1. Write the first sector. From here the stub starts slot A directly, since
//    the bootloader isn't there yet, and pico_fota_bootloader is gone. A
//    power cut while this one sector is rewritten (about 50 ms) is the only
//    moment the board can't boot.
// 2. Erase the boot record sectors (one was pico_fota_bootloader's flags), so
//    the new bootloader starts with none and keeps to slot A.
// 3. Write the bootloader, then its marker, after which the stub starts it.
//
// A power cut during 2 or 3 restarts the firmware in slot A, which carries on.

#include <cstdint>

enum class BootloaderKind : uint8_t
{
    // pico_fota_bootloader: flash's first sector isn't the stub
    OLD,
    // The stub is in place but the A/B bootloader isn't complete
    STUB_ONLY,
    A_B,
};

BootloaderKind running_bootloader();

// Installs the A/B bootloader (see above). Run from slot A only, by firmware
// that has proven itself. Returns false if a write didn't read back right
// (the board still boots; try again later).
bool install_bootloader();

// pico_fota_bootloader's flags, read and written as it does, for firmware
// that pico_fota_bootloader started
namespace old_bootloader
{
bool after_firmware_update();
bool after_rollback();
// Stops it rolling back this firmware
void commit();
} // namespace old_bootloader
