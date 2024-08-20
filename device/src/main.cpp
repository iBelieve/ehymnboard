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

#include "fetch_image.h"
#include "hardware/watchdog.h"
#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"
#include "pico/unique_id.h"
#include "state.h"
#include "utils.h"
#include "waveshare.h"
#include "wifi.h"
#include <array>
#include <iostream>
#include <stdio.h>

void stall()
{
    printf("Stalling...\n");
    while (true)
    {
        printf(".");
        sleep_ms(1000);
    }
}

bool refresh_screen(int screen_id, Waveshare13K &screen, std::string &etag)
{
    printf("Refreshing screen %d\n", screen_id);
    auto ret = fetch_image(screen_id, etag);

    if (ret == FetchImageResult::NEW_IMAGE)
    {
        printf("New image for screen %d\n", screen_id);
        screen.init();
        screen.display(image_buffer);
        screen.shutdown();
        return true;
    }
    else if (ret == FetchImageResult::NO_CHANGE)
    {
        printf("No change for screen %d\n", screen_id);
    }
    else if (ret == FetchImageResult::ERROR)
    {
        printf("Refreshing screen %d failed: %d\n", screen_id, ret);
        reset_pico();
    }
    else
    {
        printf("Unknown result for screen %d: %d\n", screen_id, ret);
        reset_pico();
    }

    return false;
}

int main()
{
    stdio_init_all();

    unique_board_id = get_unique_board_id();

    sleep_ms(3000);

    printf("eHymnboard starting...\n");
    printf("Pico SDK version: %s\n", PICO_SDK_VERSION_STRING);
    printf("Device ID: %s\n", unique_board_id.c_str());

    if (!flash_saved_state->is_valid())
    {
        printf("Flash saved state is invalid, resetting...\n");
        SavedState new_state;
        new_state.save();
    }
    else if (flash_saved_state->is_wrong_version())
    {
        printf("Flash saved state is wrong version (flash=%d, current=%d), resetting...\n", flash_saved_state->version,
               STATE_VERSION);
        SavedState new_state;
        new_state.save();
    }

    printf("Saved state version=%d, write count=%d\n", flash_saved_state->version, flash_saved_state->write_count);

    setup_wifi();

    SPI spi(spi0, SPI_1MHZ,
            2, // SCK pin
            3, // MOSI pin
            4  // MISO pin
    );

    Waveshare13K screen1(spi,
                         1, // Screen ID
                         9, // Power pin
                         5, // Chip Select pin
                         6, // Data/Command pin
                         7, // Reset pin
                         8  // Busy pin
    );
    std::string etag1 = flash_saved_state->etag1;

    Waveshare13K screen2(spi,
                         2,  // Screen ID
                         14, // Power pin
                         10, // Chip Select pin
                         11, // Data/Command pin
                         12, // Reset pin
                         13  // Busy pin
    );
    std::string etag2 = flash_saved_state->etag2;

    Waveshare13K screen3(spi,
                         3,  // Screen ID
                         26, // Power pin
                         19, // Chip Select pin
                         20, // Data/Command pin
                         21, // Reset pin
                         22  // Busy pin
    );
    std::string etag3 = flash_saved_state->etag3;

    printf("Screen 1 ETag: %s\n", etag1.c_str());
    printf("Screen 2 ETag: %s\n", etag2.c_str());
    printf("Screen 3 ETag: %s\n", etag3.c_str());

    while (true)
    {
        printf("Refreshing screens...\n");
        bool updated1 = refresh_screen(1, screen1, etag1);
        bool updated2 = refresh_screen(2, screen2, etag2);
        bool updated3 = refresh_screen(3, screen3, etag3);

        if (updated1 || updated2 || updated3)
        {
            printf("One or more screens updated, saving state...\n");
            printf("- Screen 1 ETag: %s\n", etag1.c_str());
            printf("- Screen 2 ETag: %s\n", etag2.c_str());
            printf("- Screen 3 ETag: %s\n", etag3.c_str());

            SavedState new_state(flash_saved_state, etag1, etag2, etag3);
            new_state.save();

            printf("State saved to flash, %d total writes.\n", new_state.write_count);
        }

        printf("Sleeping for 10 seconds...\n");
        sleep_ms(10000);
    }
}
