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

#include "long_watchdog.h"

#include "hardware/watchdog.h"
#include "pico/stdlib.h"
#include <stdio.h>

uint8_t long_watchdog_timeout_seconds = 0;
uint8_t seconds_until_watchdog_reset = 0;

repeating_timer_t watcher_timer;

bool watchdog_task(repeating_timer_t *rt)
{
    if (seconds_until_watchdog_reset > 0)
    {
        seconds_until_watchdog_reset -= 1;
        watchdog_update();
    }
    else
    {
        printf("Long watchdog expired, not updating watchdog, should reboot soon!\n");
    }

    return true;
}

void long_watchdog_enable(uint8_t timeout_seconds)
{
    long_watchdog_timeout_seconds = timeout_seconds;
    seconds_until_watchdog_reset = long_watchdog_timeout_seconds;

    watchdog_enable(5000, true /* pause on debugger */);
    add_repeating_timer_ms(1000, watchdog_task, nullptr, &watcher_timer);
}

void long_watchdog_update()
{
    seconds_until_watchdog_reset = long_watchdog_timeout_seconds;
}
