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

#include "request_path.h"

#include <string>

std::string build_request_path(const std::string &path, const DeviceStatus &status, const std::string &etag)
{
    std::string result = path + "?device_id=" + status.board_id +
                         "&saved_state_writes=" + std::to_string(status.saved_state_writes) +
                         "&watchdog_caused_reboot=" + (status.watchdog_caused_reboot ? "1" : "0");

    if (!etag.empty())
    {
        result += "&etag=" + etag;
    }

    return result;
}
