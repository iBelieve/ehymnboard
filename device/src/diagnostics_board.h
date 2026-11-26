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

// The board's side of diagnostics.h: the reset record in the watchdog's
// scratch registers, the hard fault handler that fills it in, the counters
// and the health snapshot the server is sent.

#include <cstdint>

#include "diagnostics.h"

// Reads why the board last reset and clears the record, so that a later
// reset nothing records isn't mistaken for this one. Call first in main().
void diag_read_reset();

// Why the board last reset (once diag_read_reset() has run)
const ResetRecord &diag_boot_reset();

// Records why the board is about to reset, with what it was doing and its
// uptime, unless something already recorded a reason this boot: the first
// one is the cause, and a hang while waiting to reboot isn't. A hang is
// recorded only when nothing else is, and anything else replaces it, since
// the board may still recover (see diag_cancel_hang()). Safe in an
// interrupt.
void diag_record_reset(ResetReason reason, uint32_t detail = 0);

// Forgets a recorded hang: the main loop fed the watchdog again in time
void diag_cancel_hang();

// What the board is doing, for a hang or crash to report. Sets the phase
// until it goes out of scope, then puts the old one back.
class PhaseScope
{
  public:
    explicit PhaseScope(Phase phase);
    ~PhaseScope();

    PhaseScope(const PhaseScope &) = delete;
    PhaseScope &operator=(const PhaseScope &) = delete;

  private:
    Phase previous_;
};

// The main loop's record of its sockets
SocketLog &diag_sockets();

// An image download that failed
void diag_count_image_fail();

// Counts WiFi drops; call from the main loop
void diag_poll_wifi();

// Uptime, signal, heap and counters now
Health diag_health();
