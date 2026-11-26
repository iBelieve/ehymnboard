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

#include <stdio.h>

#include <string>

#include "diagnostics.h"
#include "hardware/watchdog.h"
#include "pico/stdlib.h"
#include "request_path.h"

// Every request and the socket go to https:// and wss:// on this host (see
// tls.h). CMake sets it (EHYMNBOARD_SERVER_HOST), so a build can talk to a
// Worker preview instead.
#ifndef EHYMNBOARD_SERVER_HOST
#error "Set EHYMNBOARD_SERVER_HOST (CMakeLists.txt does)"
#endif
inline constexpr const char *SERVER_HOST = EHYMNBOARD_SERVER_HOST;
inline constexpr uint16_t SERVER_PORT = 443;

inline std::string unique_board_id;

std::string get_unique_board_id();

// This board's ID, flash write count and why it last booted.
DeviceStatus current_device_status();

// Records why (see diagnostics_board.h), waits 30 s, then reboots
[[noreturn]] void reset_pico(ResetReason reason, uint32_t detail = 0);
void stall_spin();
