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

#include <string>
#include <string_view>

// Returns the value of the ETag header in a raw HTTP response header block
// (status line, then "Name: value" lines separated by CRLF), or an empty string
// if there isn't one. Header names are matched case-insensitively.
std::string find_etag(std::string_view headers);
