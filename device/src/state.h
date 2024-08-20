/*
 * eHymnBoard device firmware
 * Copyright (C) 2025  Michael Spencer <sonrisesoftware@gmail.com>

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

#include <cstdint>
#include <string>

inline constexpr auto SAVED_STATE_MAGIC = 0x0123456789ABCDEF;
inline constexpr uint16_t STATE_VERSION = 1;

// Example Etag: 2e16e58b5d7ca51f8e5972e3de922816bab545bf
struct SavedState
{
    uint64_t magic = SAVED_STATE_MAGIC;
    uint16_t version = STATE_VERSION;
    int write_count = 0;
    char etag1[41]; // 40 + 1 for null terminator
    char etag2[41]; // 40 + 1 for null terminator
    char etag3[41]; // 40 + 1 for null terminator

    SavedState() : write_count(1)
    {
        etag1[0] = '\0';
        etag2[0] = '\0';
        etag3[0] = '\0';
    }

    SavedState(const SavedState *prev_state, std::string etag1, std::string etag2, std::string etag3);

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
