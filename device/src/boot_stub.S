/*
 * eHymnBoard device firmware
 * Copyright (C) 2026  Michael Spencer <sonrisesoftware@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/*
 * Flash's first sector: boot2 (linked in from pico-sdk), then this stub,
 * which boot2 starts through the vector table below. It starts the A/B
 * bootloader if that is complete, which its marker says (written after the
 * rest of it), else the firmware in slot A directly. So the bootloader can be
 * (re)written behind it with no moment where nothing boots: the firmware
 * moving a board off pico_fota_bootloader writes this sector first, and only
 * then the bootloader (see bootloader_install.cpp). Offsets as in
 * boot_control.h.
 */

    .syntax unified
    .cpu cortex-m0plus
    .thumb

    .equ MARKER, 0x10007FF0
    .equ MARKER_MAGIC, 0x4C424845
    .equ BOOTLOADER, 0x10001000
    .equ SLOT_A, 0x1000A000
    .equ VTOR, 0xE000ED08

    .section .vectors, "a"
    .word 0x20042000
    .word stub_reset

    .section .text, "ax"
    .thumb_func
    .global stub_reset
stub_reset:
    ldr r0, =MARKER
    ldr r1, [r0]
    ldr r2, =MARKER_MAGIC
    cmp r1, r2
    bne 1f
    /* The marker's last word is the magic's complement */
    ldr r1, [r0, #12]
    mvns r2, r2
    cmp r1, r2
    bne 1f
    ldr r0, =BOOTLOADER
    b 2f
1:
    ldr r0, =SLOT_A
2:
    ldr r1, =VTOR
    str r0, [r1]
    ldmia r0!, {r1, r2}
    msr msp, r1
    bx r2
