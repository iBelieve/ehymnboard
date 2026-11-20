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

// The flash-independent half of SavedState, split out of state.cpp so it
// builds (and is unit tested) on the host.

#include <cstddef>
#include <string>

#include "pico/assert.h"
#include "state.h"

template <std::size_t N> static void copy_etag(char (&dest)[N], const std::string &etag)
{
    hard_assert(etag.length() < N);

    etag.copy(dest, etag.length());
    dest[etag.length()] = '\0';
}

SavedState::SavedState(const SavedState *prev_state, const std::string &etag1, const std::string &etag2,
                       const std::string &etag3)
    : write_count(prev_state->write_count + 1)
{
    copy_etag(this->etag1, etag1);
    copy_etag(this->etag2, etag2);
    copy_etag(this->etag3, etag3);
}
