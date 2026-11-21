/*
 * eHymnBoard device firmware
 * Copyright (C) 2025-2026  Michael Spencer <sonrisesoftware@gmail.com>

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

#include <cstddef>
#include <cstdint>
#include <string>

inline constexpr auto SAVED_STATE_MAGIC = 0x0123456789ABCDEF;
inline constexpr uint16_t STATE_VERSION = 2;

// Firmware versions come from and are capped at 47 characters by
// cmake/firmware_version.cmake
inline constexpr std::size_t OTA_VERSION_SIZE = 48; // 47 + 1 for null terminator

// Example Etag: 2e16e58b5d7ca51f8e5972e3de922816bab545bf
struct SavedState
{
    uint64_t magic = SAVED_STATE_MAGIC;
    uint16_t version = STATE_VERSION;
    int write_count = 0;
    char etag1[41] = {}; // 40 + 1 for null terminator
    char etag2[41] = {}; // 40 + 1 for null terminator
    char etag3[41] = {}; // 40 + 1 for null terminator

    // The OTA version being installed by the last reboot, so that if the
    // bootloader rolls it back we know which version failed
    char ota_attempted_version[OTA_VERSION_SIZE] = {};
    // A version that was rolled back; we don't retry it until the server
    // offers a different one
    char ota_rejected_version[OTA_VERSION_SIZE] = {};

    SavedState() : write_count(1)
    {
    }

    // The state after a screen update, keeping the OTA fields. Etags must be
    // at most 40 characters (a SHA-1 hex digest). Defined in saved_state.cpp,
    // which has no flash access, so it's unit tested on the host.
    SavedState(const SavedState *prev_state, const std::string &etag1, const std::string &etag2,
               const std::string &etag3);

    // A copy with the OTA fields replaced (each under OTA_VERSION_SIZE
    // characters), keeping the etags and counting the write
    SavedState with_ota(const std::string &attempted_version, const std::string &rejected_version) const;

    std::string attempted_version() const;
    std::string rejected_version() const;

    void save();

    bool is_valid() const
    {
        return magic == SAVED_STATE_MAGIC;
    }

    bool is_wrong_version() const
    {
        return version != STATE_VERSION;
    }

    static SavedState initial()
    {
        return SavedState();
    }
};

extern const SavedState *flash_saved_state;

// Saves a copy of the flash state with the OTA fields changed
void save_ota_state(const std::string &attempted_version, const std::string &rejected_version);
