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

#include "shown_images.h"

// A run is at most every bit of the image: 652,800 for a panel, which takes 3
// varint bytes. One more is let through (any run under 2^28 bits); a longer
// varint is garbage
static constexpr unsigned MAX_VARINT_BYTES = 4;

// Calls `run(length)` for each run of equal bits in the image, alternately 1s
// and 0s, starting with 1s; stops early (returning false) if `run` does
template <typename Run> static bool for_each_run(const uint8_t *image, std::size_t size, Run run)
{
    bool bit = true;
    std::size_t length = 0;
    for (std::size_t i = 0; i < size; i++)
    {
        const uint8_t byte = image[i];
        // Most bytes are all one color: no need to look at each bit
        if (byte == (bit ? 0xFFU : 0x00U))
        {
            length += 8;
            continue;
        }
        for (unsigned b = 8; b-- > 0;)
        {
            if (((static_cast<unsigned>(byte) >> b) & 1U) == (bit ? 1U : 0U))
            {
                length++;
                continue;
            }
            if (!run(length))
            {
                return false;
            }
            bit = !bit;
            length = 1;
        }
    }
    return run(length);
}

static std::size_t varint_bytes(std::size_t value)
{
    std::size_t bytes = 1;
    while (value >= 0x80U)
    {
        value >>= 7U;
        bytes++;
    }
    return bytes;
}

std::optional<std::vector<uint8_t>> pack_pixel_runs(const uint8_t *image, std::size_t size, std::size_t max_packed)
{
    // Measured first, so the vector is allocated once at its size: growing it
    // would take up to twice that while it's copied
    std::size_t bytes = 0;
    if (!for_each_run(image, size, [&bytes, max_packed](std::size_t length) {
            bytes += varint_bytes(length);
            return bytes <= max_packed;
        }))
    {
        return std::nullopt;
    }

    std::vector<uint8_t> packed;
    packed.reserve(bytes);
    for_each_run(image, size, [&packed](std::size_t length) {
        while (length >= 0x80U)
        {
            packed.push_back(static_cast<uint8_t>(0x80U | (length & 0x7FU)));
            length >>= 7U;
        }
        packed.push_back(static_cast<uint8_t>(length));
        return true;
    });
    return packed;
}

namespace
{

// Collects bits into bytes and bytes into chunks for the sink
class BitWriter
{
  public:
    BitWriter(std::size_t size, const std::function<void(const uint8_t *, std::size_t)> &sink)
        : left_(size), sink_(sink)
    {
    }

    // Writes `length` bits of `bit`; false if that's more than the image holds
    bool write(bool bit, std::size_t length)
    {
        while (length > 0)
        {
            if (pending_bits_ == 0 && length >= 8)
            {
                if (!put(bit ? 0xFF : 0x00))
                {
                    return false;
                }
                length -= 8;
                continue;
            }
            byte_ = static_cast<uint8_t>((static_cast<unsigned>(byte_) << 1U) | (bit ? 1U : 0U));
            pending_bits_++;
            length--;
            if (pending_bits_ == 8)
            {
                pending_bits_ = 0;
                if (!put(byte_))
                {
                    return false;
                }
            }
        }
        return true;
    }

    // Hands over the last chunk; false unless the image was exactly filled
    bool finish()
    {
        if (left_ != 0 || pending_bits_ != 0)
        {
            return false;
        }
        flush();
        return true;
    }

  private:
    bool put(uint8_t byte)
    {
        if (left_ == 0)
        {
            return false;
        }
        left_--;
        chunk_.at(used_++) = byte;
        if (used_ == chunk_.size())
        {
            flush();
        }
        return true;
    }

    void flush()
    {
        if (used_ > 0)
        {
            sink_(chunk_.data(), used_);
            used_ = 0;
        }
    }

    std::size_t left_;
    const std::function<void(const uint8_t *, std::size_t)> &sink_;
    std::array<uint8_t, UNPACK_CHUNK_BYTES> chunk_{};
    std::size_t used_ = 0;
    uint8_t byte_ = 0;
    int pending_bits_ = 0;
};

} // namespace

// Reads the varint at `at`, moving past it; nothing if it's cut short or too long
static std::optional<std::size_t> read_varint(const std::vector<uint8_t> &packed, std::size_t &at)
{
    std::size_t value = 0;
    for (unsigned i = 0; i < MAX_VARINT_BYTES && at < packed.size(); i++)
    {
        const unsigned byte = packed[at++];
        value |= static_cast<std::size_t>(byte & 0x7FU) << (7U * i);
        if ((byte & 0x80U) == 0)
        {
            return value;
        }
    }
    return std::nullopt;
}

bool unpack_pixel_runs(const std::vector<uint8_t> &packed, std::size_t size,
                       const std::function<void(const uint8_t *chunk, std::size_t length)> &sink)
{
    BitWriter out(size, sink);
    bool bit = true;
    for (std::size_t at = 0; at < packed.size();)
    {
        const auto length = read_varint(packed, at);
        if (!length || !out.write(bit, *length))
        {
            return false;
        }
        bit = !bit;
    }
    return out.finish();
}

const std::vector<uint8_t> *ShownImages::for_partial(std::size_t screen) const
{
    const auto &shown = screens_.at(screen);
    if (!shown.packed || shown.partials >= PARTIALS_BEFORE_FULL)
    {
        return nullptr;
    }
    return &*shown.packed;
}

void ShownImages::drawn(std::size_t screen, const uint8_t *image, std::size_t size, bool partial)
{
    auto &shown = screens_.at(screen);
    shown.partials = partial ? shown.partials + 1 : 0;
    // Freed first, so the old and new images are never both held
    shown.packed.reset();
    shown.packed = pack_pixel_runs(image, size, BUDGET_BYTES - packed_bytes());
}

void ShownImages::forget()
{
    for (auto &shown : screens_)
    {
        shown = Shown{};
    }
}

std::size_t ShownImages::packed_bytes() const
{
    std::size_t bytes = 0;
    for (const auto &shown : screens_)
    {
        bytes += shown.packed ? shown.packed->size() : 0;
    }
    return bytes;
}
