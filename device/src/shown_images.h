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

// What each panel shows, kept packed in RAM for partial refresh. A partial
// update only drives the pixels that change, so the controller needs the old
// image as well as the new one, and its RAM is lost when the board cuts the
// panel's power after each update. An 81,600-byte image is mostly long runs
// of white and black pixels, so it packs to a few KB as run lengths. No
// pico-sdk dependencies, so it's unit tested on the host (see test/).

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <vector>

#include "board_messages.h"

// Packs `size` bytes of a 1-bit image (MSB first) as the lengths of its runs
// of 1 and 0 bits, alternately and starting with 1 (the first may be 0
// long), each as a LEB128 varint. Nothing if it would take more than
// `max_packed` bytes.
std::optional<std::vector<uint8_t>> pack_pixel_runs(const uint8_t *image, std::size_t size, std::size_t max_packed);

// How many bytes unpack_pixel_runs hands its sink at a time, at most
inline constexpr std::size_t UNPACK_CHUNK_BYTES = 512;

// Unpacks what pack_pixel_runs made, in order, a chunk at a time, so the
// image never needs a second buffer. False if `packed` isn't exactly an
// image of `size` bytes (the sink may have had some of it by then).
bool unpack_pixel_runs(const std::vector<uint8_t> &packed, std::size_t size,
                       const std::function<void(const uint8_t *chunk, std::size_t length)> &sink);

// The packed image on each panel, and how many partial updates it has had
// since its last full one
class ShownImages
{
  public:
    // All three packed images together stay under this, so a download's TLS
    // still has the 24 KB of spare heap the emulator's tests ask for at its
    // peak (about 46 KB is free there without the images)
    static constexpr std::size_t BUDGET_BYTES = 20 * 1024;
    // Partial updates leave a little ghosting behind, so every fifth update
    // of a panel is a full one (Waveshare's manual says to fully refresh
    // after about five partial ones)
    static constexpr int PARTIALS_BEFORE_FULL = 4;

    // The packed image a partial update of `screen` would start from, or
    // nothing if its next update must be a full one: what it shows isn't
    // known (since boot, or it didn't fit the budget), or it's had
    // PARTIALS_BEFORE_FULL partial updates in a row
    const std::vector<uint8_t> *for_partial(std::size_t screen) const;

    // `screen` now shows `image` (`size` bytes), after a partial update or a
    // full one. Keeps it packed if it fits the budget beside the others.
    void drawn(std::size_t screen, const uint8_t *image, std::size_t size, bool partial);

    // Forgets every panel's image, freeing their memory: partial refresh was
    // turned off, so the next update of each is a full one
    void forget();

    // How much the packed images take
    std::size_t packed_bytes() const;

  private:
    struct Shown
    {
        std::optional<std::vector<uint8_t>> packed;
        int partials = 0;
    };
    std::array<Shown, SCREEN_COUNT> screens_;
};
