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

#include "utils.h"

#include "pico/unique_id.h"

std::string get_unique_board_id()
{
    char buf[2 * PICO_UNIQUE_BOARD_ID_SIZE_BYTES + 1];

    pico_get_unique_board_id_string(buf, sizeof(buf));

    return std::string(buf);
}

void reset_pico()
{
    printf("Rebooting in 30 seconds...\n");

    sleep_ms(30 * 1000);

    watchdog_enable(1, 1);
    while (1)
    {
        // Do nothing, watchdog should fire and reboot
    }
}

void stall_spin()
{
    printf("Stopping and spinning...\n");
    while (true)
    {
        printf(".");
        sleep_ms(1000);
    }
}
