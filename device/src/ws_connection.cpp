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

#include "ws_connection.h"

uint32_t jitter_seed_for(std::string_view board_id)
{
    // FNV-1a
    uint32_t hash = 2166136261U;
    for (const char c : board_id)
    {
        hash ^= static_cast<uint8_t>(c);
        hash *= 16777619U;
    }
    return hash;
}

ConnectionPolicy::ConnectionPolicy(uint32_t jitter_seed, uint64_t now_ms)
    // xorshift32 needs a non-zero state
    : random_(jitter_seed == 0 ? 0x9E3779B9 : jitter_seed), retry_at_(now_ms), down_since_(now_ms)
{
}

uint32_t ConnectionPolicy::next_random()
{
    random_ ^= random_ << 13U;
    random_ ^= random_ >> 17U;
    random_ ^= random_ << 5U;
    return random_;
}

uint64_t ConnectionPolicy::next_delay()
{
    uint64_t base = BACKOFF_FIRST_MS;
    for (uint32_t i = 0; i < attempts_ && base < BACKOFF_MAX_MS; i++)
    {
        base *= 2;
    }
    if (base > BACKOFF_MAX_MS)
    {
        base = BACKOFF_MAX_MS;
    }
    attempts_++;

    // 50% to 150% of the base delay
    return base / 2 + (static_cast<uint64_t>(next_random()) % (base + 1));
}

ConnectionPolicy::Action ConnectionPolicy::poll(uint64_t now_ms)
{
    switch (state_)
    {
    case State::BACKOFF:
        if (now_ms - down_since_ >= REBOOT_AFTER_MS)
        {
            return Action::REBOOT;
        }
        if (now_ms >= retry_at_)
        {
            state_ = State::CONNECTING;
            connect_started_ = now_ms;
            return Action::CONNECT;
        }
        return Action::NONE;

    case State::CONNECTING:
        if (now_ms - down_since_ >= REBOOT_AFTER_MS)
        {
            return Action::REBOOT;
        }
        return now_ms - connect_started_ >= CONNECT_TIMEOUT_MS ? Action::ABORT : Action::NONE;

    case State::LIVE:
        if (awaiting_pong_)
        {
            return now_ms - last_ping_ >= PONG_TIMEOUT_MS ? Action::ABORT : Action::NONE;
        }
        if (now_ms - last_ping_ >= PING_INTERVAL_MS)
        {
            last_ping_ = now_ms;
            awaiting_pong_ = true;
            return Action::SEND_PING;
        }
        return Action::NONE;
    }
    return Action::NONE;
}

void ConnectionPolicy::on_live(uint64_t now_ms)
{
    if (state_ != State::CONNECTING)
    {
        return;
    }
    state_ = State::LIVE;
    live_since_ = now_ms;
    last_ping_ = now_ms;
    awaiting_pong_ = false;
}

void ConnectionPolicy::on_pong()
{
    awaiting_pong_ = false;
}

void ConnectionPolicy::on_closed(uint64_t now_ms)
{
    if (state_ == State::BACKOFF)
    {
        return;
    }
    if (state_ == State::LIVE)
    {
        down_since_ = now_ms;
        if (now_ms - live_since_ >= STABLE_MS)
        {
            attempts_ = 0;
        }
    }
    state_ = State::BACKOFF;
    awaiting_pong_ = false;
    retry_at_ = now_ms + next_delay();
}
