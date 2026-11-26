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

// The firmware's side of A/B updates (see boot_control.h): it runs from slot A
// or B, downloads an update into the other slot, and asks the bootloader to
// try it. Under pico_fota_bootloader it does no updates, only moves the board
// to the A/B bootloader once it has proven itself (see bootloader_install.h).

#include <cstddef>
#include <cstdint>

// The slot this firmware is linked for and runs from: 0 is A, 1 is B
uint8_t running_slot();

// What the server calls a slot in the image URL: "a" or "b"
const char *slot_name(uint8_t slot);

// The slot an update goes into
uint8_t update_slot();

// The largest image (with its trailer) a slot holds
size_t slot_capacity();

// Whether this boot runs newly installed firmware that hasn't committed yet,
// and whether the bootloader went back to it after another one failed
bool after_firmware_update();
bool after_rollback();

// Whether the A/B bootloader started this firmware, so it can install updates
bool can_install_updates();

// This firmware works: tells the bootloader to keep it. Under
// pico_fota_bootloader, also installs the A/B bootloader (from slot A).
// Writes flash only when something changes; safe to call again.
void commit_running_firmware();

// This firmware, on trial, is broken: on the next boot the bootloader goes
// back to the other slot at once (pico_fota_bootloader does on any reboot)
void abandon_update();

// Erases the update slot ahead of the writes as they come, and sets up
// decryption. Returns false on failure.
bool begin_update();
// Decrypts `length` bytes (whole 256-byte pages) in place and writes them
// at `offset` in the update slot
bool write_update(uint8_t *encrypted, size_t offset, size_t length);
// Whether the first `size` bytes written are an image whose SHA-256 trailer
// matches
bool verify_update(size_t size);
// Whether the written image was linked to run from the slot it's in
bool update_runs_in_its_slot();
// Tells the bootloader to try the update on the next boot, and reboots
[[noreturn]] void install_update(size_t size);
