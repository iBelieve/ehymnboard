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

#include "board_messages.h"

#include <vector>

#include "http_headers.h"

static constexpr std::string_view STATE_VERSION_1 = "1";
static constexpr std::size_t MAX_FIRMWARE_VERSION = 47;
static constexpr std::string_view PARTIAL_OPTION = "partial";

static std::vector<std::string_view> split_words(std::string_view message)
{
    std::vector<std::string_view> words;
    while (!message.empty())
    {
        const auto space = message.find(' ');
        words.push_back(message.substr(0, space));
        if (space == std::string_view::npos)
        {
            break;
        }
        message.remove_prefix(space + 1);
    }
    return words;
}

std::string_view message_type(std::string_view message)
{
    return message.substr(0, message.find(' '));
}

bool is_valid_firmware_version(std::string_view version)
{
    return is_safe_word(version, MAX_FIRMWARE_VERSION);
}

std::optional<BoardState> parse_state_message(std::string_view message)
{
    // Later versions may add words after these
    const auto words = split_words(message);
    if (words.size() < 3 + SCREEN_COUNT || words[0] != "state" || words[1] != STATE_VERSION_1)
    {
        return std::nullopt;
    }

    BoardState state;
    for (std::size_t i = 0; i < SCREEN_COUNT; i++)
    {
        const auto etag = words[2 + i];
        if (!is_safe_etag(etag))
        {
            return std::nullopt;
        }
        state.etags.at(i) = std::string(etag);
    }

    const auto version = words[2 + SCREEN_COUNT];
    if (version != "-")
    {
        if (!is_valid_firmware_version(version))
        {
            return std::nullopt;
        }
        state.firmware_version = std::string(version);
    }
    for (std::size_t i = 3 + SCREEN_COUNT; i < words.size(); i++)
    {
        state.partial_refresh = state.partial_refresh || words[i] == PARTIAL_OPTION;
    }
    return state;
}

std::string format_state_message(const BoardState &state)
{
    std::string message = "state ";
    message += STATE_VERSION_1;
    for (const auto &etag : state.etags)
    {
        message += ' ';
        message += etag;
    }
    message += ' ';
    message += state.firmware_version.empty() ? "-" : state.firmware_version;
    if (state.partial_refresh)
    {
        message += ' ';
        message += PARTIAL_OPTION;
    }
    return message;
}

std::string format_shown_message(const ScreenEtags &etags)
{
    std::string message = "shown";
    for (const auto &etag : etags)
    {
        message += ' ';
        message += etag.empty() ? "-" : etag;
    }
    return message;
}
