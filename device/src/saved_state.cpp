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

// The flash-independent half of SavedState, split out of state.cpp so it
// builds (and is unit tested) on the host.

#include <cstddef>
#include <string>

#include "http_headers.h"
#include "pico/assert.h"
#include "state.h"

static_assert(sizeof(SavedState::etag1) == MAX_ETAG_LENGTH + 1, "SavedState etags must fit any etag find_etag accepts");

template <std::size_t N> static void copy_string(char (&dest)[N], const std::string &value)
{
    hard_assert(value.length() < N);

    value.copy(dest, value.length());
    dest[value.length()] = '\0';
}

// Flash contents aren't trusted to be terminated, so this stops at N - 1
template <std::size_t N> static std::string read_string(const char (&src)[N])
{
    std::size_t length = 0;
    while (length < N - 1 && src[length] != '\0')
    {
        length++;
    }
    return {src, length};
}

SavedState::SavedState(const SavedState *prev_state, const std::string &etag1, const std::string &etag2,
                       const std::string &etag3)
    : write_count(prev_state->write_count + 1)
{
    copy_string(this->etag1, etag1);
    copy_string(this->etag2, etag2);
    copy_string(this->etag3, etag3);

    copy_string(ota_attempted_version, prev_state->attempted_version());
    copy_string(ota_rejected_version, prev_state->rejected_version());
}

SavedState SavedState::with_ota(const std::string &attempted_version, const std::string &rejected_version) const
{
    SavedState next(this, read_string(etag1), read_string(etag2), read_string(etag3));

    copy_string(next.ota_attempted_version, attempted_version);
    copy_string(next.ota_rejected_version, rejected_version);

    return next;
}

std::string SavedState::attempted_version() const
{
    return read_string(ota_attempted_version);
}

std::string SavedState::rejected_version() const
{
    return read_string(ota_rejected_version);
}
