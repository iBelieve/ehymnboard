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

// The A/B bootloader (see boot_control.h): reads the boot record, checks the
// slots' images, saves a new record if this boot changes anything (a trial
// boot, or a rollback), and starts the chosen slot. An ordinary boot writes
// nothing to flash. It has no stdio, to stay small; the firmware reports what
// it did.
//
// Starting the firmware (start_firmware()) is derived from
// pico_fota_bootloader (MIT, Copyright (c) 2024 Jakub Zimnol), itself from
// the Leaf Labs Cortex-M3 bootloader (MIT, Copyright (c) 2010 LeafLabs LLC,
// modified 2021 Brian Starkey).

#include "boot_flash.h"
#include "hardware/resets.h"
#include "hardware/structs/nvic.h"
#include "hardware/structs/scb.h"
#include "hardware/structs/systick.h"
#include "hardware/sync.h"
#include "hardware/watchdog.h"
#include "pico/bootrom.h"

// The RP2040's watchdog can't be set much longer (8.3 s). The firmware sets
// its own within a second of starting.
static constexpr uint32_t TRIAL_WATCHDOG_MS = 8000;

[[noreturn]] static void start_firmware(uint32_t vectors)
{
    systick_hw->csr = 0;
    nvic_hw->icer = 0xFFFFFFFF;
    nvic_hw->icpr = 0xFFFFFFFF;
    reset_block(~(RESETS_RESET_IO_QSPI_BITS | RESETS_RESET_PADS_QSPI_BITS | RESETS_RESET_SYSCFG_BITS |
                  RESETS_RESET_PLL_SYS_BITS));

    // NOLINTBEGIN(performance-no-int-to-ptr): the slot's vector table
    const uint32_t stack = *reinterpret_cast<const volatile uint32_t *>(vectors);
    const uint32_t reset = *reinterpret_cast<const volatile uint32_t *>(vectors + 4);
    // NOLINTEND(performance-no-int-to-ptr)
    scb_hw->vtor = vectors;
    // NOLINTNEXTLINE(portability-no-assembler): the stack pointer and the jump need it
    asm volatile("msr msp, %0\n"
                 "bx %1\n"
                 :
                 : "r"(stack), "r"(reset));
    __builtin_unreachable();
}

int main()
{
    const auto records = boot::read_records();
    const auto decision = boot::decide(records.newest, boot::check_images(records.newest));

    if (decision.write)
    {
        const auto page = boot::record_page(boot::next(records, *decision.write));
        const uint32_t interrupts = save_and_disable_interrupts();
        boot::erase_and_program(boot::RECORD_OFFSETS[records.write_sector], page);
        restore_interrupts(interrupts);
    }

    const uint32_t offset = boot::SLOT_OFFSETS[decision.slot];
    if (!boot::plausible_vectors(decision.slot, boot::flash_at(offset)))
    {
        // No firmware anywhere: wait for one over USB
        reset_usb_boot(0, 0);
    }

    if (decision.watchdog)
    {
        watchdog_enable(TRIAL_WATCHDOG_MS, true);
    }

    start_firmware(XIP_BASE + offset);
}
