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

#include "ota.h"

#include <array>
#include <cstring>
#include <optional>
#include <string>

#include "firmware_version.h"
#include "long_watchdog.h"
#include "lwip/apps/http_client.h"
#include "pico/async_context.h"
#include "pico/cyw43_arch.h"
#include "pico_fota_bootloader/core.h"
#include "state.h"
#include "tls.h"
#include "utils.h"

// Defined by the bootloader's linker script; the symbol's address is the size
// of each flash slot. Declared in the library's private linker_definitions.h.
// NOLINTNEXTLINE(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp)
extern "C" uint32_t __FLASH_SWAP_SPACE_LENGTH;

namespace
{

// What lwIP's http_client passes as the content length when the response has
// no Content-Length header (private to http_client.c)
constexpr u32_t HTTPC_CONTENT_LEN_INVALID = 0xFFFFFFFF;

// Give up on a download that makes no progress for this long, or takes longer
// than this overall
constexpr int64_t DOWNLOAD_STALL_TIMEOUT_US = 30LL * 1000 * 1000;
constexpr int64_t DOWNLOAD_TOTAL_TIMEOUT_US = 5LL * 60 * 1000 * 1000;
constexpr int64_t VERSION_CHECK_TIMEOUT_US = 60LL * 1000 * 1000;

size_t download_slot_size()
{
    return reinterpret_cast<size_t>(&__FLASH_SWAP_SPACE_LENGTH);
}

std::string ota_query()
{
    return "?device_id=" + unique_board_id + "&version=" + FIRMWARE_VERSION;
}

// Waits for an HTTP request to complete, giving up after timeout_us. The
// request state must outlive the request, so callers keep it static.
bool wait_for_completion(const volatile bool &complete, int64_t timeout_us)
{
    auto context = cyw43_arch_async_context();
    const auto start = get_absolute_time();

    while (!complete)
    {
        async_context_wait_for_work_ms(context, 100);
        // The timeout, not the watchdog, bounds the wait
        long_watchdog_update();

        if (absolute_time_diff_us(start, get_absolute_time()) > timeout_us)
        {
            return false;
        }
    }

    return true;
}

// --- Version check -----------------------------------------------------------

struct VersionCheckRequest
{
    volatile bool complete = true;
    httpc_result_t result = HTTPC_RESULT_OK;
    u32_t status_code = 0;

    // The body is just a version string; anything past this is dropped
    std::array<char, 64> body{};
    size_t body_len = 0;
};

VersionCheckRequest version_check;

err_t on_version_check_data(void *arg, struct altcp_pcb *conn, struct pbuf *p, [[maybe_unused]] err_t err)
{
    auto *req = static_cast<VersionCheckRequest *>(arg);

    req->body_len += pbuf_copy_partial(p, req->body.data() + req->body_len, req->body.size() - req->body_len, 0);

    altcp_recved(conn, p->tot_len);
    pbuf_free(p);

    return ERR_OK;
}

void on_version_check_completed(void *arg, httpc_result_t httpc_result, [[maybe_unused]] u32_t rx_content_len,
                                u32_t srv_res, [[maybe_unused]] err_t err)
{
    auto *req = static_cast<VersionCheckRequest *>(arg);

    req->result = httpc_result;
    req->status_code = srv_res;
    req->complete = true;
}

// Returns the version the server wants this board to run, an empty string if
// the board is up to date, or nothing if the check failed
std::optional<std::string> fetch_target_version()
{
    if (!version_check.complete)
    {
        printf("OTA: previous version check still running, skipping\n");
        return std::nullopt;
    }

    version_check.complete = false;
    version_check.result = HTTPC_RESULT_OK;
    version_check.status_code = 0;
    version_check.body_len = 0;

    static httpc_connection_t settings = {};
    settings.result_fn = on_version_check_completed;
    // Usually a 204, with no body for on_version_check_data
    settings.headers_done_fn = tls_remember_httpc_session;
    settings.altcp_allocator = server_tls_allocator();

    const std::string path = "/firmware/latest" + ota_query();

    cyw43_arch_lwip_begin();
    const auto ret = httpc_get_file_dns(SERVER_HOST, SERVER_PORT, path.c_str(), &settings, on_version_check_data,
                                        &version_check, nullptr);
    cyw43_arch_lwip_end();

    if (ret != ERR_OK)
    {
        printf("OTA: error starting version check: %d\n", ret);
        version_check.complete = true;
        return std::nullopt;
    }

    if (!wait_for_completion(version_check.complete, VERSION_CHECK_TIMEOUT_US))
    {
        printf("OTA: version check timed out\n");
        return std::nullopt;
    }

    if (version_check.result != HTTPC_RESULT_OK)
    {
        printf("OTA: version check failed: %d\n", version_check.result);
        return std::nullopt;
    }

    if (version_check.status_code == 204)
    {
        printf("OTA: firmware is up to date (%s)\n", FIRMWARE_VERSION);
        return std::string();
    }

    if (version_check.status_code != 200)
    {
        printf("OTA: version check failed with status %lu\n", (unsigned long)version_check.status_code);
        return std::nullopt;
    }

    std::string version(version_check.body.data(), version_check.body_len);
    while (!version.empty() && (version.back() == '\n' || version.back() == '\r' || version.back() == ' '))
    {
        version.pop_back();
    }

    if (version.empty() || version.length() >= OTA_VERSION_SIZE)
    {
        printf("OTA: server sent an invalid version (%u bytes)\n", (unsigned)version.length());
        return std::nullopt;
    }

    return version;
}

// --- Download ----------------------------------------------------------------

// Received body bytes wait here until the main loop writes them to flash.
// TCP flow control bounds how much can arrive: we only acknowledge bytes to
// lwIP (altcp_recved) once they're written, so at most TCP_WND bytes are ever
// buffered. (Over TLS that's still true of the decrypted bytes: lwIP's TLS
// layer counts them against the window until we acknowledge them.)
constexpr size_t STAGING_SIZE = 18 * 1024;
static_assert(STAGING_SIZE >= TCP_WND, "Staging buffer must hold a full TCP window");
static_assert(STAGING_SIZE % PFB_ALIGN_SIZE == 0, "Staging buffer must hold whole flash pages");

struct DownloadRequest
{
    volatile bool complete = true;
    httpc_result_t result = HTTPC_RESULT_OK;
    u32_t status_code = 0;

    // Set once the headers show a 200 with a usable Content-Length; until
    // then (and after the download is abandoned) the body is discarded
    bool accepting = false;
    u32_t content_length = 0;
    bool overflow = false;

    // Only valid while !complete
    struct altcp_pcb *conn = nullptr;

    size_t buffered = 0;
    std::array<uint8_t, STAGING_SIZE> buffer{};
};

DownloadRequest download;

err_t on_download_headers(httpc_state_t *connection, void *arg, struct pbuf *hdr, u16_t hdr_len, u32_t content_len)
{
    auto *req = static_cast<DownloadRequest *>(arg);
    tls_remember_httpc_session(connection, arg, hdr, hdr_len, content_len);

    // "HTTP/1.1 200 ..."
    if (pbuf_memcmp(hdr, 9, "200", 3) != 0)
    {
        return ERR_OK;
    }

    if (content_len == HTTPC_CONTENT_LEN_INVALID || content_len == 0 || content_len % PFB_ALIGN_SIZE != 0 ||
        content_len > download_slot_size())
    {
        printf("OTA: invalid firmware image size %lu\n", (unsigned long)content_len);
        return ERR_VAL; // aborts the request
    }

    req->content_length = content_len;
    req->accepting = true;

    return ERR_OK;
}

err_t on_download_data(void *arg, struct altcp_pcb *conn, struct pbuf *p, [[maybe_unused]] err_t err)
{
    auto *req = static_cast<DownloadRequest *>(arg);

    if (!req->accepting || req->overflow)
    {
        altcp_recved(conn, p->tot_len);
        pbuf_free(p);
        return ERR_OK;
    }

    req->conn = conn;

    if (req->buffered + p->tot_len > req->buffer.size())
    {
        // Shouldn't happen given the window; the main loop abandons the
        // download when it sees this
        req->overflow = true;
        altcp_recved(conn, p->tot_len);
        pbuf_free(p);
        return ERR_OK;
    }

    pbuf_copy_partial(p, req->buffer.data() + req->buffered, p->tot_len, 0);
    req->buffered += p->tot_len;

    // Not acknowledged (altcp_recved) until written to flash
    pbuf_free(p);

    return ERR_OK;
}

void on_download_completed(void *arg, httpc_result_t httpc_result, u32_t rx_content_len, u32_t srv_res, err_t err)
{
    auto *req = static_cast<DownloadRequest *>(arg);

    printf("OTA: download completed with result: %d, content length: %lu, server response: %lu, error: %d\n",
           httpc_result, (unsigned long)rx_content_len, (unsigned long)srv_res, err);

    req->result = httpc_result;
    req->status_code = srv_res;
    req->conn = nullptr;
    req->complete = true;
}

// Stops using the download, leaving the static request to soak up whatever
// the connection still delivers until it closes
void abandon_download()
{
    cyw43_arch_lwip_begin();
    download.accepting = false;
    if (!download.complete && download.conn != nullptr && download.buffered > 0)
    {
        altcp_recved(download.conn, download.buffered);
    }
    download.buffered = 0;
    cyw43_arch_lwip_end();
}

// Starts the HTTP request for the image; the callbacks fill `download`
bool start_download(const std::string &version)
{
    if (!download.complete)
    {
        printf("OTA: previous download still closing, skipping\n");
        return false;
    }

    download.complete = false;
    download.result = HTTPC_RESULT_OK;
    download.status_code = 0;
    download.accepting = false;
    download.content_length = 0;
    download.overflow = false;
    download.conn = nullptr;
    download.buffered = 0;

    static httpc_connection_t settings = {};
    settings.headers_done_fn = on_download_headers;
    settings.result_fn = on_download_completed;
    settings.altcp_allocator = server_tls_allocator();

    const std::string path = "/firmware/image" + ota_query() + "&target_version=" + version;

    cyw43_arch_lwip_begin();
    const auto ret =
        httpc_get_file_dns(SERVER_HOST, SERVER_PORT, path.c_str(), &settings, on_download_data, &download, nullptr);
    cyw43_arch_lwip_end();

    if (ret != ERR_OK)
    {
        printf("OTA: error starting download: %d\n", ret);
        download.complete = true;
        return false;
    }

    return true;
}

// Writes the first `length` staged bytes to flash at `offset`, then hands that
// part of the buffer back to the callbacks and acknowledges it to lwIP
bool write_staged(size_t offset, size_t length)
{
    // The callbacks only append past `buffered`, so this part of the buffer
    // is ours until we hand it back below
    const int ret = pfb_write_to_flash_aligned_256_bytes(download.buffer.data(), offset, length);
    if (ret != 0)
    {
        printf("OTA: error writing to flash at offset %u: %d\n", (unsigned)offset, ret);
        return false;
    }

    cyw43_arch_lwip_begin();
    memmove(download.buffer.data(), download.buffer.data() + length, download.buffered - length);
    download.buffered -= length;
    if (!download.complete && download.conn != nullptr)
    {
        altcp_recved(download.conn, length);
    }
    cyw43_arch_lwip_end();

    return true;
}

// Moves the body into flash as it arrives, until the request completes;
// returns the number of bytes written, or 0 on failure
size_t stream_download()
{
    auto context = cyw43_arch_async_context();
    const auto start = get_absolute_time();
    auto last_progress = start;
    size_t written = 0;

    while (true)
    {
        cyw43_arch_lwip_begin();
        const size_t to_write = download.buffered - (download.buffered % PFB_ALIGN_SIZE);
        const bool complete = download.complete;
        const bool overflow = download.overflow;
        cyw43_arch_lwip_end();

        if (overflow)
        {
            printf("OTA: receive buffer overflowed\n");
            return 0;
        }

        if (to_write > 0)
        {
            if (!write_staged(written, to_write))
            {
                return 0;
            }

            written += to_write;
            last_progress = get_absolute_time();
            long_watchdog_update();
        }
        else if (complete)
        {
            return written;
        }
        else
        {
            const auto now = get_absolute_time();
            if (absolute_time_diff_us(last_progress, now) > DOWNLOAD_STALL_TIMEOUT_US ||
                absolute_time_diff_us(start, now) > DOWNLOAD_TOTAL_TIMEOUT_US)
            {
                printf("OTA: download timed out after %u bytes\n", (unsigned)written);
                return 0;
            }

            async_context_wait_for_work_ms(context, 5);
        }
    }
}

// Streams the image into the download slot; returns the number of bytes
// written, or 0 on failure
size_t download_image(const std::string &version)
{
    if (!start_download(version))
    {
        return 0;
    }

    const auto written = stream_download();
    if (!download.complete)
    {
        abandon_download();
        return 0;
    }

    if (download.result != HTTPC_RESULT_OK || download.status_code != 200)
    {
        printf("OTA: download failed (result=%d, status=%lu)\n", download.result, (unsigned long)download.status_code);
        return 0;
    }

    if (download.buffered != 0 || written != download.content_length)
    {
        printf("OTA: download incomplete: wrote %u of %lu bytes\n", (unsigned)written,
               (unsigned long)download.content_length);
        return 0;
    }

    return written;
}

} // namespace

void ota_handle_boot()
{
    printf("Firmware version: %s\n", FIRMWARE_VERSION);

    const auto attempted = flash_saved_state->attempted_version();

    // The bootloader leaves the "after rollback" flag set until the next
    // successful update, so only act on it while an attempt is recorded
    if (pfb_is_after_rollback() && !attempted.empty())
    {
        printf("OTA: update to %s failed and was rolled back, won't retry it\n", attempted.c_str());
        ota_boot_status = "rolled_back";
        ota_boot_version = attempted;
        save_ota_state("", attempted);
    }
    else if (pfb_is_after_firmware_update())
    {
        printf("OTA: running newly installed firmware, will commit once healthy\n");
        ota_boot_status = "updated";
        ota_boot_version = FIRMWARE_VERSION;
    }
}

static bool firmware_committed = false;

// Tells the bootloader this firmware works, so it won't be rolled back. Only
// writes to flash on the first call after an update.
static void ota_commit_firmware()
{
    if (firmware_committed)
    {
        return;
    }

    firmware_committed = true;

    if (!pfb_is_after_firmware_update())
    {
        return;
    }

    printf("OTA: firmware is healthy, committing\n");
    pfb_firmware_commit();

    const auto rejected = flash_saved_state->rejected_version();
    if (!flash_saved_state->attempted_version().empty() || rejected == FIRMWARE_VERSION)
    {
        save_ota_state("", rejected == FIRMWARE_VERSION ? "" : rejected);
    }
}

// Newly installed firmware that hasn't proven itself yet: it mustn't install
// another update over itself, since then a broken build could never be rolled
// back
static bool awaiting_commit()
{
    return !firmware_committed && pfb_is_after_firmware_update();
}

// Whether newly installed firmware can make an https:// request (a version
// check), tried every half minute while the socket is live. Any answer from
// the server will do, even an error status: that's the server's trouble, not
// the firmware's. If the board keeps getting none, even with its socket up,
// the firmware is broken in a way the socket doesn't show, so reboot: the
// bootloader then rolls it back.
static bool commit_check_passed()
{
    constexpr int64_t RETRY_US = 30LL * 1000 * 1000;
    constexpr int MAX_FAILURES = 5;
    static std::optional<absolute_time_t> next_try;
    static int failures = 0;

    if (next_try && absolute_time_diff_us(get_absolute_time(), *next_try) > 0)
    {
        return false;
    }
    next_try = delayed_by_us(get_absolute_time(), RETRY_US);
    // An hourly check still running says nothing either way
    if (!version_check.complete)
    {
        return false;
    }
    fetch_target_version();
    if (version_check.complete && version_check.status_code != 0)
    {
        return true;
    }
    if (++failures >= MAX_FAILURES)
    {
        printf("OTA: new firmware can't make requests, rebooting to roll it back\n");
        reset_pico();
    }
    return false;
}

// Asks the server for a firmware update and installs it if there is one.
// Returns false if that failed part way (worth trying again soon).
static bool ota_check_for_update()
{
    long_watchdog_update();

    const auto target = fetch_target_version();
    if (!target)
    {
        return false;
    }
    const auto &version = *target;

    if (version.empty())
    {
        return true;
    }

    if (version == FIRMWARE_VERSION)
    {
        return true;
    }

    if (version == flash_saved_state->rejected_version())
    {
        printf("OTA: server offers %s, which was rolled back before, skipping\n", version.c_str());
        return true;
    }

    printf("OTA: updating from %s to %s\n", FIRMWARE_VERSION, version.c_str());

    // Erasing the whole download slot keeps interrupts disabled for a few
    // seconds, longer than the hardware watchdog allows
    printf("OTA: erasing download slot...\n");
    long_watchdog_pause();
    const int init_ret = pfb_initialize_download_slot();
    long_watchdog_resume();

    if (init_ret != 0)
    {
        printf("OTA: error initializing download slot: %d\n", init_ret);
        return false;
    }

    const auto size = download_image(version);
    if (size == 0)
    {
        return false;
    }

    long_watchdog_update();

    if (pfb_firmware_sha256_check(size) != 0)
    {
        printf("OTA: SHA-256 check failed, discarding image\n");
        return false;
    }

    printf("OTA: downloaded and verified %u bytes, installing %s\n", (unsigned)size, version.c_str());

    save_ota_state(version, flash_saved_state->rejected_version());
    pfb_mark_download_slot_as_valid();

    // Reboots into the bootloader, which swaps in the new firmware
    pfb_perform_update();
    return true;
}

void ota_loop(bool live, const std::string &offered_version)
{
    constexpr int64_t CHECK_INTERVAL_US = 60LL * 60 * 1000 * 1000;
    // After a check that failed part way (the server or WiFi was down)
    constexpr int64_t RETRY_INTERVAL_US = 5LL * 60 * 1000 * 1000;
    static std::optional<absolute_time_t> next_check;
    // The last version a state message offered, so each offer is checked once
    static std::string last_offer;

    if (!firmware_committed && live)
    {
        // A live socket proves newly installed firmware can reach the server
        // over wss://; one finished https:// request (this version check)
        // proves its requests work too. Until it's committed, any reboot
        // rolls it back.
        if (!pfb_is_after_firmware_update() || commit_check_passed())
        {
            ota_commit_firmware();
        }
    }

    if (awaiting_commit())
    {
        return;
    }

    const bool new_offer = live && !offered_version.empty() && offered_version != FIRMWARE_VERSION &&
                           offered_version != last_offer && offered_version != flash_saved_state->rejected_version();
    if (new_offer)
    {
        last_offer = offered_version;
    }

    const auto now = get_absolute_time();
    if (new_offer || !next_check || absolute_time_diff_us(*next_check, now) >= 0)
    {
        const bool done = ota_check_for_update();
        next_check = delayed_by_us(get_absolute_time(), done ? CHECK_INTERVAL_US : RETRY_INTERVAL_US);
    }
}
