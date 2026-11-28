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

#include "board_link.h"
#include "board_messages.h"
#include "diagnostics_board.h"
#include "fetch_image.h"
#include "firmware_version.h"
#include "healthchecks.h"
#include "long_watchdog.h"
#include "ota.h"
#include "pico/binary_info.h"
#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"
#include "pico/unique_id.h"
#include "request_path.h"
#include "state.h"
#include "tls.h"
#include "utils.h"
#include "waveshare.h"
#include "wifi.h"
#include "ws_connection.h"
#include <algorithm>
#include <array>
#include <optional>
#include <stdio.h>
#include <string>

// How long to wait before retrying screens whose download failed
static constexpr uint64_t FETCH_RETRY_MS = 15'000;
// How long downloads may keep failing before the board reboots
static constexpr uint64_t DOWNLOADS_FAILING_REBOOT_MS = 180'000;
// How long a redraw's downloads may keep failing before the board gives up on
// it until the next night. It doesn't reboot: its panels show the right images
static constexpr uint64_t REDRAW_GIVE_UP_MS = 180'000;
// How often the main loop runs
static constexpr uint32_t LOOP_MS = 100;

static uint64_t now_ms()
{
    // Not to_ms_since_boot(), whose 32 bits wrap after 49 days
    return to_us_since_boot(get_absolute_time()) / 1000;
}

// Downloads one screen's image and draws it if it changed. On transient HTTP
// failures we just log and bail out; the caller retries later.
static FetchImageResult refresh_screen(int screen_id, Waveshare13K &screen, std::string &etag, bool redraw)
{
    long_watchdog_update();

    printf("Refreshing screen %d%s\n", screen_id, redraw ? " (redraw)" : "");
    const auto ret = [&] {
        const PhaseScope phase(Phase::IMAGE_DOWNLOAD);
        return fetch_image(screen_id, etag, redraw);
    }();

    if (ret == FetchImageResult::NEW_IMAGE)
    {
        printf(redraw ? "Redrawing screen %d\n" : "New image for screen %d\n", screen_id);
        const PhaseScope phase(Phase::PANEL);
        screen.init();
        screen.display(image_buffer);
        screen.shutdown();
    }
    else if (ret == FetchImageResult::NO_CHANGE)
    {
        printf("No change for screen %d\n", screen_id);
    }
    else
    {
        printf("Refreshing screen %d failed (ret=%d), will retry\n", screen_id, (int)ret);
    }

    return ret;
}

namespace
{

// The three panels, what they show, and what the server wants them to show
struct Screens
{
    std::array<Waveshare13K *, SCREEN_COUNT> panels{};
    // The etag of the image on each panel (saved in flash)
    ScreenEtags shown;
    // The etag the server's last state message asked for
    ScreenEtags wanted;
    // The screens to download and draw again though they show what the server
    // wants: it asked for a redraw ("redraw"), and a full refresh clears ghosting
    std::array<bool, SCREEN_COUNT> redraw{};
    // When the server asked for the redraw still under way, if one is
    std::optional<uint64_t> redraw_since_ms;
    // When to retry after a failed download
    uint64_t retry_at_ms = 0;
    // Since when downloads have kept failing, if they have
    std::optional<uint64_t> failing_since_ms;
};

// The panels, the socket to the server, and what the server last offered
struct Board
{
    Board(uint32_t jitter_seed, uint64_t now) : policy(jitter_seed, now)
    {
    }

    Screens screens;
    BoardLink link;
    ConnectionPolicy policy;
    std::string offered_version;
};

} // namespace

static void service(Board &board);

// Whether a screen needs downloading and drawing
static bool needs_drawing(const Screens &screens, std::size_t i)
{
    return screens.redraw.at(i) || screens.shown.at(i) != screens.wanted.at(i);
}

static bool any_needs_drawing(const Screens &screens)
{
    for (std::size_t i = 0; i < SCREEN_COUNT; i++)
    {
        if (needs_drawing(screens, i))
        {
            return true;
        }
    }
    return false;
}

// After a round of downloads: when to try the failed ones again, and whether
// downloads keep failing. Only a screen that still wants a new image counts
// as failing (a state message serviced meanwhile may have made it unwanted,
// whatever the other screens want); a redraw that keeps failing is given up
// instead, as the panels already show the right images.
static void note_failures(Screens &screens, const std::array<bool, SCREEN_COUNT> &failed)
{
    const auto now = now_ms();
    bool still_failing = false;
    bool any_failed = false;
    for (std::size_t i = 0; i < SCREEN_COUNT; i++)
    {
        still_failing = still_failing || (failed.at(i) && screens.wanted.at(i) != screens.shown.at(i));
        any_failed = any_failed || (failed.at(i) && needs_drawing(screens, i));
    }
    if (any_failed)
    {
        screens.retry_at_ms = now + FETCH_RETRY_MS;
    }
    if (!still_failing)
    {
        screens.failing_since_ms.reset();
    }
    else if (!screens.failing_since_ms)
    {
        screens.failing_since_ms = now;
    }

    const auto redrawing = [&screens] {
        return std::find(screens.redraw.begin(), screens.redraw.end(), true) != screens.redraw.end();
    };
    if (redrawing() && screens.redraw_since_ms && now - *screens.redraw_since_ms >= REDRAW_GIVE_UP_MS)
    {
        printf("Redraw kept failing for >3 minutes, giving up until the server asks again\n");
        screens.redraw.fill(false);
    }
    if (!redrawing())
    {
        screens.redraw_since_ms.reset();
    }
}

// Downloads and draws every screen that doesn't show what the server wants,
// or that it asked to redraw, keeping the socket serviced in between. Returns
// true if any download got an answer (a new image or a 304), so the server
// should hear what's shown.
static bool update_screens(Board &board)
{
    auto &screens = board.screens;
    bool any_updated = false;
    bool any_answered = false;
    // The screens whose download failed this time
    std::array<bool, SCREEN_COUNT> failed{};

    for (std::size_t i = 0; i < SCREEN_COUNT; i++)
    {
        if (!needs_drawing(screens, i))
        {
            continue;
        }
        std::string etag = screens.shown.at(i);
        const auto ret = refresh_screen(static_cast<int>(i + 1), *screens.panels.at(i), etag, screens.redraw.at(i));
        if (ret == FetchImageResult::NEW_IMAGE || ret == FetchImageResult::NO_CHANGE)
        {
            // A redraw of the same image has nothing new to save
            if (etag != screens.shown.at(i))
            {
                screens.shown.at(i) = etag;
                any_updated = true;
            }
            screens.redraw.at(i) = false;
            any_answered = true;
            // The server's answer is current: a 304 means the state message
            // was older than the image, and an image without a usable ETag
            // mustn't be downloaded again and again
            screens.wanted.at(i) = screens.shown.at(i);
        }
        else
        {
            failed.at(i) = true;
            diag_count_image_fail();
        }
        // A download and a redraw take seconds: keep pinging meanwhile
        service(board);
    }

    // How close TLS came to running out of memory, downloading beside the socket
    tls_log_memory();

    note_failures(screens, failed);

    if (any_updated)
    {
        printf("One or more screens updated, saving state...\n");
        printf("- Screen 1 Etag: %s\n", screens.shown[0].c_str());
        printf("- Screen 2 Etag: %s\n", screens.shown[1].c_str());
        printf("- Screen 3 Etag: %s\n", screens.shown[2].c_str());

        SavedState new_state(flash_saved_state, screens.shown[0], screens.shown[1], screens.shown[2]);
        const PhaseScope phase(Phase::FLASH_SAVE);
        new_state.save();

        printf("State saved to flash, %d total writes.\n", new_state.write_count);
    }

    return any_answered;
}

// Carries out what the connection policy asks for
static void act(ConnectionPolicy &policy, BoardLink &link, uint64_t now)
{
    auto &sockets = diag_sockets();
    switch (policy.poll(now))
    {
    case ConnectionPolicy::Action::CONNECT: {
        printf("WS: connecting...\n");
        // With why the last socket ended, for the server to log and show
        const auto path = build_request_path("/ws", current_device_status()) + "&proto=1" + sockets.connect_query() +
                          link_query(diag_health());
        if (!link.client().connect(SERVER_HOST, SERVER_PORT, path, server_tls_allocator()))
        {
            sockets.on_end({SocketEnd::DNS_FAILED, 0}, now);
            policy.on_closed(now);
        }
        break;
    }
    case ConnectionPolicy::Action::SEND_PING:
        link.client().send_text(PING_MESSAGE);
        break;
    case ConnectionPolicy::Action::ABORT:
        printf("WS: socket is dead, dropping it\n");
        link.client().abort();
        sockets.on_end(
            {policy.state() == ConnectionPolicy::State::LIVE ? SocketEnd::PONG_TIMEOUT : SocketEnd::CONNECT_TIMEOUT, 0},
            now);
        policy.on_closed(now);
        printf("WS: retrying in %llums\n", policy.retry_at() - now);
        break;
    case ConnectionPolicy::Action::REBOOT:
        printf("No live socket for >3 minutes, rebooting to recover\n");
        reset_pico(ResetReason::NO_SOCKET);
        break;
    case ConnectionPolicy::Action::NONE:
        break;
    }
}

// Takes what arrived on the socket, then does what the connection policy asks
static void service(Board &board)
{
    const auto now = now_ms();
    auto &screens = board.screens;
    auto &policy = board.policy;

    const auto events = board.link.take_events();
    if (events.state)
    {
        if (policy.state() == ConnectionPolicy::State::CONNECTING)
        {
            printf("WS: live\n");
            policy.on_live(now);
            diag_sockets().on_live(now);
        }
        screens.wanted = events.state->etags;
        screens.retry_at_ms = now;
        board.offered_version = events.state->firmware_version;

        // Let the server know what the panels show, if they're current. Then
        // no new image needs downloading, so no download is failing either (a
        // redraw's failures don't count)
        if (screens.wanted == screens.shown)
        {
            screens.failing_since_ms.reset();
            board.link.client().send_text(format_shown_message(screens.shown));
        }
    }
    if (events.redraw)
    {
        printf("Server asked for every screen to be redrawn\n");
        screens.redraw.fill(true);
        screens.redraw_since_ms = now;
        screens.retry_at_ms = now;
    }
    if (events.pong)
    {
        policy.on_pong();
    }
    if (events.diag)
    {
        board.link.client().send_text(format_diag_message(diag_health()));
    }
    if (events.closed)
    {
        // Unless the policy already gave up on it (ABORT, which counted it)
        // and lwIP ended it just before the abort
        if (policy.state() != ConnectionPolicy::State::BACKOFF)
        {
            diag_sockets().on_end(*events.closed, now);
        }
        policy.on_closed(now);
        printf("WS: socket closed, retrying in %llums\n", policy.retry_at() - now);
    }

    act(policy, board.link, now);
}

// Shown by `picotool info`
bi_decl(bi_program_version_string(FIRMWARE_VERSION));

int main()
{
    // Before anything can crash and record a reset over the last boot's
    diag_read_reset();
    stdio_init_all();

    long_watchdog_enable(60 /* seconds */);

    unique_board_id = get_unique_board_id();

    sleep_ms(3000);

    printf("eHymnboard starting...\n");
    printf("Pico SDK version: %s\n", PICO_SDK_VERSION_STRING);
    printf("Device ID: %s\n", unique_board_id.c_str());
    diag_log_reset();
#ifdef EHYMNBOARD_TEST_ROOT_CA
    printf("WARNING: test build, trusts the emulator's test CA: don't run it on a board\n");
#endif

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
        auto new_state = flash_saved_state->reset();
        new_state.save();
    }

    printf("Saved state version=%d, write count=%d\n", flash_saved_state->version, flash_saved_state->write_count);

    if (watchdog_caused_reboot())
    {
        printf("Rebooted due to watchdog timeout!\n");
    }

    ota_handle_boot();

    {
        const PhaseScope phase(Phase::WIFI);
        setup_wifi();
    }
    {
        const PhaseScope phase(Phase::BOOT_REPORT);
        report_device_booted();
    }

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

    Waveshare13K screen2(spi,
                         2,  // Screen ID
                         14, // Power pin
                         10, // Chip Select pin
                         11, // Data/Command pin
                         12, // Reset pin
                         13  // Busy pin
    );

    Waveshare13K screen3(spi,
                         3,  // Screen ID
                         26, // Power pin
                         19, // Chip Select pin
                         20, // Data/Command pin
                         21, // Reset pin
                         22  // Busy pin
    );

    // The server pushes the board's state over a WebSocket; images still come
    // over HTTPS requests (fetch_image), only when one changes
    Board board(jitter_seed_for(unique_board_id), now_ms());
    auto &screens = board.screens;
    screens.panels = {&screen1, &screen2, &screen3};
    screens.shown = {flash_saved_state->etag1, flash_saved_state->etag2, flash_saved_state->etag3};
    screens.wanted = screens.shown;

    printf("Screen 1 Etag: %s\n", screens.shown[0].c_str());
    printf("Screen 2 Etag: %s\n", screens.shown[1].c_str());
    printf("Screen 3 Etag: %s\n", screens.shown[2].c_str());

    const PhaseScope running(Phase::RUNNING);
    while (true)
    {
        long_watchdog_update();
        diag_poll_wifi();
        service(board);

        const auto now = now_ms();
        const bool live = board.policy.state() == ConnectionPolicy::State::LIVE;
        if (live && any_needs_drawing(screens) && now >= screens.retry_at_ms && update_screens(board))
        {
            board.link.client().send_text(format_shown_message(screens.shown));
        }

        // A board that can't download its images, however long its socket
        // stays up, may have run out of something only a reboot gives back
        if (screens.failing_since_ms && now_ms() - *screens.failing_since_ms >= DOWNLOADS_FAILING_REBOOT_MS)
        {
            printf("Image downloads failing for >3 minutes, rebooting to recover\n");
            reset_pico(ResetReason::DOWNLOADS_FAILING);
        }

        ota_loop(board.policy.state() == ConnectionPolicy::State::LIVE, board.offered_version);

        sleep_ms(LOOP_MS);
    }
}
