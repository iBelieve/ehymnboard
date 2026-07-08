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

int flash_safe_execute(std::function<void()> func, uint32_t enter_exit_timeout_ms)
{
    return flash_safe_execute(
        [](void *arg) {
            auto func = static_cast<std::function<void()> *>(arg);
            (*func)();
        },
        &func, enter_exit_timeout_ms);
}

SavedState::SavedState(const SavedState *prev_state, const std::string &etag1, const std::string &etag2,
                       const std::string &etag3)
    : write_count(prev_state->write_count + 1)
{
    hard_assert(etag1.length() <= 40);
    hard_assert(etag2.length() <= 40);
    hard_assert(etag3.length() <= 40);

    snprintf(this->etag1, sizeof(this->etag1), "%s", etag1.c_str());
    snprintf(this->etag2, sizeof(this->etag2), "%s", etag2.c_str());
    snprintf(this->etag3, sizeof(this->etag3), "%s", etag3.c_str());
}

void SavedState::save()
{
    uint8_t page_buf[FLASH_PAGE_SIZE];

    memcpy(page_buf, this, sizeof(SavedState));

    int res = flash_safe_execute(
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
