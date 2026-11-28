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

// Remote diagnostics: what the board tells the server about its own health.
// It all rides on requests the board makes anyway, as extra query parameters
// that older servers ignore, so it costs the server no extra requests (see
// web/src/worker/diagnostics.ts):
//
//   /ws, every connect        why the last live socket ended and how long it
//                             was up, failed attempts since, signal, uptime
//   /device_booted, each boot why the board reset, kept through the reset in
//                             the watchdog's scratch registers (no flash wear)
//   /firmware/latest, hourly  signal, heap, uptime and counters since boot
//   "diag" on the socket      the same as hourly, when the admin asks for it
//
// Counters live in RAM only and start again at each boot. This file has no
// pico-sdk dependencies, so it's unit tested on the host (see test/);
// diagnostics_board.cpp reads the hardware.

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

// Why a socket (or an attempt at one) ended
enum class SocketEnd : uint8_t
{
    // The DNS lookup failed, or couldn't start
    DNS_FAILED,
    // No memory for a connection
    NO_MEMORY,
    // TCP or TLS failed before the upgrade request went out (detail: lwIP err)
    CONNECT_ERROR,
    // The connection failed after that (detail: lwIP err, -14 a reset)
    TCP_ERROR,
    // A write to the connection failed
    WRITE_FAILED,
    // The server didn't accept the upgrade (detail: its HTTP status, or 0)
    HANDSHAKE_REFUSED,
    // The server sent a close frame (detail: its close code)
    SERVER_CLOSED,
    // The server's end closed the TCP connection without a close frame
    SERVER_DROPPED,
    // The board closed the socket over a protocol error (detail: close code)
    PROTOCOL_ERROR,
    // The board closed it on purpose
    CLOSED_LOCALLY,
    // No state message within ConnectionPolicy::CONNECT_TIMEOUT_MS
    CONNECT_TIMEOUT,
    // No pong within ConnectionPolicy::PONG_TIMEOUT_MS of a ping
    PONG_TIMEOUT,
};

struct SocketEndInfo
{
    SocketEnd reason = SocketEnd::CLOSED_LOCALLY;
    int32_t detail = 0;
};

// The name the server sees, such as "pong_timeout"
const char *socket_end_name(SocketEnd reason);

// Every socket and attempt at one, as the main loop sees them
class SocketLog
{
  public:
    // The first state message on a new socket
    void on_live(uint64_t now_ms);
    // The socket, or the attempt at one, ended
    void on_end(const SocketEndInfo &end, uint64_t now_ms);

    // For the next /ws connect: why the last live socket ended and how long it
    // had been live (drop, drop_detail, drop_up, in seconds), then how many
    // attempts failed since and why the last one did (fails, fail,
    // fail_detail). Each part only once there is one.
    std::string connect_query() const;

    // Since boot: live sockets that ended, attempts that never got live, and
    // live sockets dropped for want of a pong
    uint32_t drops() const
    {
        return drops_;
    }
    uint32_t connect_fails() const
    {
        return connect_fails_;
    }
    uint32_t pong_timeouts() const
    {
        return pong_timeouts_;
    }

  private:
    bool live_ = false;
    uint64_t live_since_ms_ = 0;
    std::optional<SocketEndInfo> drop_;
    uint64_t drop_up_ms_ = 0;
    std::optional<SocketEndInfo> last_fail_;
    uint32_t fails_since_live_ = 0;

    uint32_t drops_ = 0;
    uint32_t connect_fails_ = 0;
    uint32_t pong_timeouts_ = 0;
};

// --- Why the board reset ------------------------------------------------------

enum class ResetReason : uint8_t
{
    // Nothing recorded and no reset flag set
    UNKNOWN,
    // Power on, or a brownout
    POWER_ON,
    // The RUN pin (a reset button)
    RUN_PIN,
    // A debugger restarted the chip
    DEBUGGER,
    // The hardware watchdog fired with nothing recorded: something kept
    // interrupts off for over 5 s
    WATCHDOG,
    // The main loop stopped feeding the 60 s watchdog (see long_watchdog.h)
    HANG,
    // A hard fault (detail: the faulting PC, extra: LR)
    CRASH,
    // No live socket for ConnectionPolicy::REBOOT_AFTER_MS
    NO_SOCKET,
    // Image downloads kept failing for 3 minutes
    DOWNLOADS_FAILING,
    // A panel stayed busy for 30 s (detail: the screen, 1-3)
    PANEL_BUSY,
    // Saving the state to flash failed (detail: the error)
    FLASH_SAVE_FAILED,
    // Rebooting into the bootloader to install an update
    OTA_INSTALL,
    // Newly installed firmware couldn't make requests, so it's rolled back
    OTA_UNHEALTHY,
};

// What the board was doing, so a hang or crash says where
enum class Phase : uint8_t
{
    STARTING,
    WIFI,
    BOOT_REPORT,
    RUNNING,
    IMAGE_DOWNLOAD,
    PANEL,
    FLASH_SAVE,
    OTA_CHECK,
    OTA_DOWNLOAD,
};

// The names the server sees, such as "panel_busy" and "image_download"
const char *reset_reason_name(ResetReason reason);
const char *phase_name(Phase phase);

struct ResetRecord
{
    ResetReason reason = ResetReason::UNKNOWN;
    // Whether the firmware recorded it (with the phase and uptime) rather
    // than the board working it out from the reset flags
    bool recorded = false;
    Phase phase = Phase::STARTING;
    uint32_t detail = 0;
    uint32_t extra = 0;
    uint32_t uptime_s = 0;
};

// The RP2040 watchdog's scratch registers 0-3, which keep their values
// through a watchdog reset (pico-sdk uses 4-7)
using ScratchWords = std::array<uint32_t, 4>;

ScratchWords encode_reset(const ResetRecord &record);

// The record encode_reset() made, if `scratch` holds one
std::optional<ResetRecord> decode_reset_record(const ScratchWords &scratch);

// What the hardware says about the last reset
struct ResetFlags
{
    ScratchWords scratch{};
    // The watchdog's REASON register is set
    bool watchdog = false;
    // vreg_and_chip_reset's CHIP_RESET flags
    bool had_por = false;
    bool had_run = false;
    bool had_psm_restart = false;
};

// Why the board reset: what the firmware recorded if it did, otherwise what
// the flags say
ResetRecord decode_reset(const ResetFlags &flags);

// For /device_booted: reset, then reset_phase, reset_detail, reset_extra and
// reset_uptime when they're known
std::string reset_query(const ResetRecord &record);

// --- Health -------------------------------------------------------------------

struct Health
{
    uint32_t uptime_s = 0;
    // dBm, when the board is on WiFi
    std::optional<int32_t> rssi;
    // Bytes free on the heap now, and at the least since boot
    uint32_t heap_free = 0;
    uint32_t heap_min = 0;
    uint32_t drops = 0;
    uint32_t connect_fails = 0;
    uint32_t pong_timeouts = 0;
    uint32_t image_fails = 0;
    uint32_t wifi_drops = 0;
    uint32_t tls_oom = 0;
};

// "&uptime=...&rssi=..." for every /ws connect
std::string link_query(const Health &health);

// link_query() and the heap and counters, for the hourly /firmware/latest
std::string health_query(const Health &health);

// The admin's "diag" request and the board's answer, "diag uptime=... rssi=..."
// with health_query()'s fields
inline constexpr std::string_view DIAG_MESSAGE = "diag";
std::string format_diag_message(const Health &health);
