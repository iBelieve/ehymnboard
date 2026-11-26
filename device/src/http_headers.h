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
#include <cstdint>
#include <optional>
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

// Whether `word` is 1 to `max_length` letters, digits, '.', '_' or '-': safe
// to save to flash and to send back in a URL or a message without escaping.
bool is_safe_word(std::string_view word, std::size_t max_length);

// Whether an etag is one the board keeps: a safe word of at most
// MAX_ETAG_LENGTH.
bool is_safe_etag(std::string_view etag);

// The value of the first header called `name` (matched case-insensitively) in
// a raw header block like find_etag's, without surrounding whitespace. Empty
// if there's no such header, or if the block ends before that line does.
std::optional<std::string_view> find_header(std::string_view headers, std::string_view name);

// The Content-Length header's value (matched case-insensitively, as lwIP's
// HTTP client doesn't), if it's all digits and fits in 32 bits
std::optional<uint32_t> find_content_length(std::string_view headers);

// Whether a comma-separated header value (such as Connection's) holds `token`,
// matched case-insensitively.
bool header_has_token(std::string_view value, std::string_view token);
