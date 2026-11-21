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

#include "state.h"

#include "hardware/flash.h"
#include "hardware/sync.h"
#include "pico/flash.h"
#include "utils.h"
#include <functional>
#include <string.h>

constexpr auto FLASH_TARGET_OFFSET = PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE;

// NOLINTNEXTLINE(performance-no-int-to-ptr): memory-mapped flash address
const SavedState *flash_saved_state = (const SavedState *)(XIP_BASE + FLASH_TARGET_OFFSET);

static_assert(sizeof(SavedState) <= FLASH_PAGE_SIZE, "SavedState must fit in one flash page");

static int flash_safe_execute(std::function<void()> func, uint32_t enter_exit_timeout_ms)
{
    return flash_safe_execute(
        [](void *arg) {
            auto func = static_cast<std::function<void()> *>(arg);
            (*func)();
        },
        &func, enter_exit_timeout_ms);
}

void save_ota_state(const std::string &attempted_version, const std::string &rejected_version)
{
    flash_saved_state->with_ota(attempted_version, rejected_version).save();
}

void SavedState::save()
{
    uint8_t page_buf[FLASH_PAGE_SIZE] = {};

    memcpy(page_buf, this, sizeof(SavedState));

    const int res = flash_safe_execute(
        [page_buf]() {
            flash_range_erase(FLASH_TARGET_OFFSET, FLASH_SECTOR_SIZE);
            flash_range_program(FLASH_TARGET_OFFSET, page_buf, FLASH_PAGE_SIZE);
        },
        10000);

    if (res != PICO_OK)
    {
        printf("Failed to save state: %d\n", res);
        reset_pico();
    }
}
