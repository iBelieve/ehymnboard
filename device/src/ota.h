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

#include <string>

// Over-the-air firmware updates, using pico_fota_bootloader. The bootloader
// sits at the start of flash, followed by an application slot (the running
// firmware) and a download slot. An update is downloaded into the download
// slot and verified, then on reboot the bootloader swaps the two slots. If the
// new firmware reboots before it reaches the server (see ota_loop()), the
// bootloader swaps them back.
//
// The server decides which firmware a board should run: any board whose
// version differs from the one uploaded to the server installs it.

// What the bootloader did on this boot, reported to the server: "updated",
// "rolled_back" or empty, and the version it was installing
inline std::string ota_boot_status;
inline std::string ota_boot_version;

// Records what the bootloader did on this boot. Call early in main().
void ota_handle_boot();

// Called on every main loop iteration. Once the board's WebSocket is live
// (`live`) and an https:// request has worked too, tells the bootloader that
// newly installed firmware works (rebooting, so it's rolled back, if requests
// keep failing). Asks the
// server for an update over HTTP on the first call (once the firmware is
// committed), then hourly, and right away when the server's state message
// offers a different version (`offered_version`). The hourly check doesn't
// need the socket, so firmware with a broken socket can still be replaced. If
// there's an update, downloads, verifies and installs it, and doesn't return
// (the board reboots into the bootloader).
void ota_loop(bool live, const std::string &offered_version);
