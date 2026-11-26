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

#include "diagnostics.h"

#include <algorithm>

// Marks scratch register 0 as a reset record: the top 16 bits
static constexpr uint32_t RESET_MAGIC = 0xD1A6;

static std::string param(std::string_view name, std::string_view value)
{
    std::string result = "&";
    result += name;
    result += '=';
    result += value;
    return result;
}

static std::string param(std::string_view name, int64_t value)
{
    return param(name, std::to_string(value));
}

static uint64_t seconds(uint64_t ms)
{
    return ms / 1000;
}

const char *socket_end_name(SocketEnd reason)
{
    switch (reason)
    {
    case SocketEnd::DNS_FAILED:
        return "dns";
    case SocketEnd::NO_MEMORY:
        return "no_memory";
    case SocketEnd::CONNECT_ERROR:
        return "connect_error";
    case SocketEnd::TCP_ERROR:
        return "tcp_error";
    case SocketEnd::WRITE_FAILED:
        return "write_failed";
    case SocketEnd::HANDSHAKE_REFUSED:
        return "handshake";
    case SocketEnd::SERVER_CLOSED:
        return "server_close";
    case SocketEnd::SERVER_DROPPED:
        return "server_dropped";
    case SocketEnd::PROTOCOL_ERROR:
        return "protocol_error";
    case SocketEnd::CLOSED_LOCALLY:
        return "closed";
    case SocketEnd::CONNECT_TIMEOUT:
        return "connect_timeout";
    case SocketEnd::PONG_TIMEOUT:
        return "pong_timeout";
    }
    return "unknown";
}

void SocketLog::on_live(uint64_t now_ms)
{
    live_ = true;
    live_since_ms_ = now_ms;
    fails_since_live_ = 0;
    last_fail_.reset();
}

void SocketLog::on_end(const SocketEndInfo &end, uint64_t now_ms)
{
    if (live_)
    {
        live_ = false;
        drop_ = end;
        drop_up_ms_ = now_ms - live_since_ms_;
        drops_++;
        if (end.reason == SocketEnd::PONG_TIMEOUT)
        {
            pong_timeouts_++;
        }
        return;
    }
    last_fail_ = end;
    fails_since_live_++;
    connect_fails_++;
}

std::string SocketLog::connect_query() const
{
    std::string query;
    if (drop_)
    {
        query += param("drop", socket_end_name(drop_->reason));
        query += param("drop_detail", drop_->detail);
        query += param("drop_up", static_cast<int64_t>(seconds(drop_up_ms_)));
    }
    if (last_fail_)
    {
        query += param("fails", fails_since_live_);
        query += param("fail", socket_end_name(last_fail_->reason));
        query += param("fail_detail", last_fail_->detail);
    }
    return query;
}

// --- Why the board reset ------------------------------------------------------

const char *reset_reason_name(ResetReason reason)
{
    switch (reason)
    {
    case ResetReason::UNKNOWN:
        return "unknown";
    case ResetReason::POWER_ON:
        return "power_on";
    case ResetReason::RUN_PIN:
        return "run_pin";
    case ResetReason::DEBUGGER:
        return "debugger";
    case ResetReason::WATCHDOG:
        return "watchdog";
    case ResetReason::HANG:
        return "hang";
    case ResetReason::CRASH:
        return "crash";
    case ResetReason::NO_SOCKET:
        return "no_socket";
    case ResetReason::DOWNLOADS_FAILING:
        return "downloads_failing";
    case ResetReason::PANEL_BUSY:
        return "panel_busy";
    case ResetReason::FLASH_SAVE_FAILED:
        return "flash_save_failed";
    case ResetReason::OTA_INSTALL:
        return "ota_install";
    case ResetReason::OTA_UNHEALTHY:
        return "ota_unhealthy";
    }
    return "unknown";
}

const char *phase_name(Phase phase)
{
    switch (phase)
    {
    case Phase::STARTING:
        return "starting";
    case Phase::WIFI:
        return "wifi";
    case Phase::BOOT_REPORT:
        return "boot_report";
    case Phase::RUNNING:
        return "running";
    case Phase::IMAGE_DOWNLOAD:
        return "image_download";
    case Phase::PANEL:
        return "panel";
    case Phase::FLASH_SAVE:
        return "flash_save";
    case Phase::OTA_CHECK:
        return "ota_check";
    case Phase::OTA_DOWNLOAD:
        return "ota_download";
    }
    return "unknown";
}

ScratchWords encode_reset(const ResetRecord &record)
{
    return {
        (RESET_MAGIC << 16U) | (static_cast<uint32_t>(record.phase) << 8U) | static_cast<uint32_t>(record.reason),
        record.detail,
        record.extra,
        record.uptime_s,
    };
}

// The last of each enum, so a value from other firmware that's out of range
// isn't taken for one
static constexpr auto LAST_REASON = static_cast<uint32_t>(ResetReason::OTA_UNHEALTHY);
static constexpr auto LAST_PHASE = static_cast<uint32_t>(Phase::OTA_DOWNLOAD);

std::optional<ResetRecord> decode_reset_record(const ScratchWords &scratch)
{
    const uint32_t head = scratch[0];
    const uint32_t reason = head & 0xFFU;
    const uint32_t phase = (head >> 8U) & 0xFFU;
    if ((head >> 16U) != RESET_MAGIC || reason > LAST_REASON || phase > LAST_PHASE)
    {
        return std::nullopt;
    }
    ResetRecord record;
    record.reason = static_cast<ResetReason>(reason);
    record.recorded = true;
    record.phase = static_cast<Phase>(phase);
    record.detail = scratch[1];
    record.extra = scratch[2];
    record.uptime_s = scratch[3];
    return record;
}

ResetRecord decode_reset(const ResetFlags &flags)
{
    // Anything the firmware recorded came with a watchdog reset; without
    // one, the scratch registers are left over from before a power cut or a
    // press of the reset button
    if (flags.watchdog)
    {
        if (auto record = decode_reset_record(flags.scratch))
        {
            return *record;
        }
    }
    ResetRecord record;
    if (flags.watchdog)
    {
        record.reason = ResetReason::WATCHDOG;
    }
    else if (flags.had_psm_restart)
    {
        record.reason = ResetReason::DEBUGGER;
    }
    else if (flags.had_run)
    {
        record.reason = ResetReason::RUN_PIN;
    }
    else if (flags.had_por)
    {
        record.reason = ResetReason::POWER_ON;
    }
    return record;
}

std::string reset_query(const ResetRecord &record)
{
    std::string query = param("reset", reset_reason_name(record.reason));
    if (!record.recorded)
    {
        return query;
    }
    query += param("reset_phase", phase_name(record.phase));
    if (record.detail != 0)
    {
        query += param("reset_detail", record.detail);
    }
    if (record.extra != 0)
    {
        query += param("reset_extra", record.extra);
    }
    query += param("reset_uptime", record.uptime_s);
    return query;
}

// --- Health -------------------------------------------------------------------

std::string link_query(const Health &health)
{
    std::string query = param("uptime", health.uptime_s);
    if (health.rssi)
    {
        query += param("rssi", *health.rssi);
    }
    return query;
}

std::string health_query(const Health &health)
{
    return link_query(health) + param("heap_free", health.heap_free) + param("heap_min", health.heap_min) +
           param("drops", health.drops) + param("connect_fails", health.connect_fails) +
           param("pong_timeouts", health.pong_timeouts) + param("image_fails", health.image_fails) +
           param("wifi_drops", health.wifi_drops) + param("tls_oom", health.tls_oom);
}

std::string format_diag_message(const Health &health)
{
    // The same fields as the query, space separated: "&a=1&b=2" -> " a=1 b=2"
    std::string message = health_query(health);
    std::replace(message.begin(), message.end(), '&', ' ');
    return std::string(DIAG_MESSAGE) + message;
}
