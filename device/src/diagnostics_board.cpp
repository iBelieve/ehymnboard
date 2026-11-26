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

#include "diagnostics_board.h"

#include <algorithm>
#include <cstdio>

#include "hardware/structs/psm.h"
#include "hardware/structs/vreg_and_chip_reset.h"
#include "hardware/structs/watchdog.h"
#include "hardware/sync.h"
#include "pico/cyw43_arch.h"
#include "pico/time.h"
#include "tls.h"

static ResetRecord boot_reset;
static volatile Phase current_phase = Phase::STARTING;
static SocketLog sockets;
static uint32_t image_fails = 0;
static uint32_t wifi_drops = 0;
static bool wifi_up = false;

static ScratchWords read_scratch()
{
    return {watchdog_hw->scratch[0], watchdog_hw->scratch[1], watchdog_hw->scratch[2], watchdog_hw->scratch[3]};
}

static void write_scratch(const ScratchWords &words)
{
    for (std::size_t i = 0; i < words.size(); i++)
    {
        watchdog_hw->scratch[i] = words.at(i);
    }
}

static uint32_t uptime_s()
{
    // Not to_ms_since_boot(), whose 32 bits wrap after 49 days
    return static_cast<uint32_t>(to_us_since_boot(get_absolute_time()) / 1'000'000);
}

void diag_read_reset()
{
    const uint32_t chip = vreg_and_chip_reset_hw->chip_reset;
    ResetFlags flags;
    flags.scratch = read_scratch();
    flags.watchdog = watchdog_hw->reason != 0;
    flags.had_por = (chip & VREG_AND_CHIP_RESET_CHIP_RESET_HAD_POR_BITS) != 0;
    flags.had_run = (chip & VREG_AND_CHIP_RESET_CHIP_RESET_HAD_RUN_BITS) != 0;
    flags.had_psm_restart = (chip & VREG_AND_CHIP_RESET_CHIP_RESET_HAD_PSM_RESTART_BITS) != 0;
    boot_reset = decode_reset(flags);
    write_scratch({});
}

void diag_log_reset()
{
    printf("Reset reason: %s", reset_reason_name(boot_reset.reason));
    if (boot_reset.recorded)
    {
        printf(" (while %s, after %lu s, detail 0x%08lx 0x%08lx)", phase_name(boot_reset.phase),
               static_cast<unsigned long>(boot_reset.uptime_s), static_cast<unsigned long>(boot_reset.detail),
               static_cast<unsigned long>(boot_reset.extra));
    }
    printf("\n");
}

const ResetRecord &diag_boot_reset()
{
    return boot_reset;
}

// Records a reset reason unless one is already recorded (see
// diag_record_reset()); only the hard fault handler passes `extra`
static void record_reset(ResetReason reason, uint32_t detail, uint32_t extra)
{
    const uint32_t interrupts = save_and_disable_interrupts();
    // diag_read_reset() cleared the scratch registers, so anything there now
    // was recorded this boot
    const auto existing = decode_reset_record(read_scratch());
    if (!existing || (existing->reason == ResetReason::HANG && reason != ResetReason::HANG))
    {
        ResetRecord record;
        record.reason = reason;
        record.recorded = true;
        record.phase = current_phase;
        record.detail = detail;
        record.extra = extra;
        record.uptime_s = uptime_s();
        write_scratch(encode_reset(record));
    }
    restore_interrupts(interrupts);
}

void diag_record_reset(ResetReason reason, uint32_t detail)
{
    record_reset(reason, detail, 0);
}

void diag_cancel_hang()
{
    const uint32_t interrupts = save_and_disable_interrupts();
    const auto existing = decode_reset_record(read_scratch());
    if (existing && existing->reason == ResetReason::HANG)
    {
        write_scratch({});
    }
    restore_interrupts(interrupts);
}

PhaseScope::PhaseScope(Phase phase) : previous_(current_phase)
{
    current_phase = phase;
}

PhaseScope::~PhaseScope()
{
    current_phase = previous_;
}

SocketLog &diag_sockets()
{
    return sockets;
}

void diag_count_image_fail()
{
    image_fails++;
}

void diag_poll_wifi()
{
    // Up with an address: the driver takes the link down when the AP goes away
    const bool up = cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA) == CYW43_LINK_UP;
    if (wifi_up && !up)
    {
        wifi_drops++;
        printf("WiFi: link down\n");
    }
    wifi_up = up;
}

Health diag_health()
{
    Health health;
    health.uptime_s = uptime_s();
    int32_t rssi = 0;
    if (cyw43_wifi_get_rssi(&cyw43_state, &rssi) == 0)
    {
        health.rssi = rssi;
    }
    const auto memory = tls_memory();
    health.heap_free = static_cast<uint32_t>(memory.heap_size - memory.heap_now);
    // The peak is only sampled as mbedTLS allocates
    health.heap_min = static_cast<uint32_t>(memory.heap_size - std::max(memory.heap_peak, memory.heap_now));
    health.drops = sockets.drops();
    health.connect_fails = sockets.connect_fails();
    health.pong_timeouts = sockets.pong_timeouts();
    health.image_fails = image_fails;
    health.wifi_drops = wifi_drops;
    health.tls_oom = memory.alloc_failures;
    return health;
}

// --- Hard faults --------------------------------------------------------------

// Records the crash and resets at once. `frame` is the exception stack frame:
// r0-r3, r12, lr, pc, xpsr.
extern "C" [[noreturn]] void ehymnboard_hard_fault(const uint32_t *frame)
{
    record_reset(ResetReason::CRASH, frame[6], frame[5]);
    // A watchdog reset, as pico-sdk's watchdog_enable() sets one up, keeps
    // the scratch registers
    hw_set_bits(&psm_hw->wdsel, PSM_WDSEL_BITS & ~(PSM_WDSEL_ROSC_BITS | PSM_WDSEL_XOSC_BITS));
    watchdog_hw->ctrl = WATCHDOG_CTRL_TRIGGER_BITS;
    while (true)
    {
        // The reset takes a few cycles
    }
}

// Replaces pico-sdk's weak handler, a breakpoint that leaves the hardware
// watchdog to reset the board with nothing said. Passes the stack the fault
// pushed its frame on (bit 2 of EXC_RETURN in lr) to ehymnboard_hard_fault.
// NOLINTNEXTLINE(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp): pico-sdk's name
extern "C" [[gnu::naked]] void isr_hardfault()
{
    // NOLINTNEXTLINE(portability-no-assembler): only assembly can read the stack pointers
    __asm volatile("movs r0, #4\n"
                   "mov r1, lr\n"
                   "tst r0, r1\n"
                   "beq 1f\n"
                   "mrs r0, psp\n"
                   "b 2f\n"
                   "1:\n"
                   "mrs r0, msp\n"
                   "2:\n"
                   "ldr r1, =ehymnboard_hard_fault\n"
                   "bx r1\n"
                   ".ltorg\n");
}
