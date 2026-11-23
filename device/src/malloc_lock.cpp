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

// Makes newlib's malloc and free safe to call from lwIP's callbacks.
//
// With pico_cyw43_arch_lwip_threadsafe_background, lwIP and its callbacks
// run in a low-priority interrupt. The WebSocket and HTTP callbacks allocate
// (std::string, std::vector), and so does the main loop, but newlib's malloc
// isn't reentrant and pico_malloc only adds a mutex with pico_multicore
// (which an interrupt couldn't wait on anyway). newlib brackets every heap
// change with these two hooks, which are no-ops by default; here they keep
// interrupts off for the few microseconds a malloc or free takes. The RP2040
// runs this firmware on one core, so that's all the locking it needs.

#include <cstdint>

#include "hardware/sync.h"

struct _reent; // NOLINT(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp): newlib's name

// Interrupts as they were when the outermost lock was taken
static uint32_t saved_interrupts = 0;
// newlib's calls nest (realloc calls malloc), so only the outermost counts
static uint32_t lock_depth = 0;

// NOLINTNEXTLINE(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp): newlib's hook
extern "C" void __malloc_lock([[maybe_unused]] struct _reent *reent)
{
    const uint32_t status = save_and_disable_interrupts();
    if (lock_depth++ == 0)
    {
        saved_interrupts = status;
    }
}

// NOLINTNEXTLINE(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp): newlib's hook
extern "C" void __malloc_unlock([[maybe_unused]] struct _reent *reent)
{
    if (--lock_depth == 0)
    {
        restore_interrupts(saved_interrupts);
    }
}
