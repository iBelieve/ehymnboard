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

// Builds the query strings the board sends with every request. No pico-sdk
// dependencies, so it's unit tested on the host (see test/).

#include <string>

// What the board reports about itself on every request, so the server can show
// its status and spot reboots.
struct DeviceStatus
{
    std::string board_id;
    int saved_state_writes = 0;
    bool watchdog_caused_reboot = false;
    // From cmake/firmware_version.cmake (letters, digits and '-'); omitted
    // when empty
    std::string firmware_version;
};

// Appends the device status (and the etag, when there is one) to path as query
// parameters. The values are hex IDs, digits and version strings, so they need
// no URL encoding.
std::string build_request_path(const std::string &path, const DeviceStatus &status, const std::string &etag = "");
