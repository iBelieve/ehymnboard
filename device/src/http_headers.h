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

// Pure helpers for parsing HTTP response headers. No pico-sdk dependencies, so
// they're unit tested on the host (see test/).

#include <cstddef>
#include <string>
#include <string_view>

// The longest etag the board keeps: a SHA-1 hex digest, which is what the
// server sends. SavedState stores etags in fixed buffers of this size + 1.
inline constexpr std::size_t MAX_ETAG_LENGTH = 40;

// Returns the value of the ETag header in a raw HTTP response header block
// (status line, then "Name: value" lines separated by CRLF), with surrounding
// double quotes removed. Header names are matched case-insensitively.
//
// Returns an empty string if there's no ETag, or if its value is anything but
// 1 to MAX_ETAG_LENGTH letters, digits, '.', '_' or '-': the board saves the
// etag to flash and sends it back in a URL, and anything else wouldn't fit or
// would need escaping. The board then just re-downloads the image each time.
std::string find_etag(std::string_view headers);
