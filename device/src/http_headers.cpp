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

#include "http_headers.h"

#include <cctype>
#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

static bool iequals(std::string_view a, std::string_view b)
{
    if (a.size() != b.size())
    {
        return false;
    }
    for (std::size_t i = 0; i < a.size(); i++)
    {
        if (std::tolower(static_cast<unsigned char>(a[i])) != std::tolower(static_cast<unsigned char>(b[i])))
        {
            return false;
        }
    }
    return true;
}

static std::string_view trim(std::string_view s)
{
    constexpr std::string_view whitespace = " \t";
    const auto start = s.find_first_not_of(whitespace);
    if (start == std::string_view::npos)
    {
        return {};
    }
    const auto end = s.find_last_not_of(whitespace);
    return s.substr(start, end - start + 1);
}

static std::string_view unquote(std::string_view s)
{
    if (s.size() >= 2 && s.front() == '"' && s.back() == '"')
    {
        return s.substr(1, s.size() - 2);
    }
    return s;
}

bool is_safe_word(std::string_view word, std::size_t max_length)
{
    if (word.empty() || word.size() > max_length)
    {
        return false;
    }
    for (const char c : word)
    {
        if (std::isalnum(static_cast<unsigned char>(c)) == 0 && c != '.' && c != '_' && c != '-')
        {
            return false;
        }
    }
    return true;
}

bool is_safe_etag(std::string_view etag)
{
    return is_safe_word(etag, MAX_ETAG_LENGTH);
}

std::optional<std::string_view> find_header(std::string_view headers, std::string_view name)
{
    constexpr std::string_view crlf = "\r\n";

    // Skip the status line; only header lines have a name.
    auto line_start = headers.find(crlf);

    while (line_start != std::string_view::npos)
    {
        line_start += crlf.size();
        const auto line_end = headers.find(crlf, line_start);
        if (line_end == std::string_view::npos)
        {
            // An unterminated line means the block was cut short; don't trust
            // a value that might be truncated.
            break;
        }

        const auto line = headers.substr(line_start, line_end - line_start);
        const auto colon = line.find(':');
        if (colon != std::string_view::npos && iequals(line.substr(0, colon), name))
        {
            return trim(line.substr(colon + 1));
        }

        line_start = line_end;
    }

    return std::nullopt;
}

bool header_has_token(std::string_view value, std::string_view token)
{
    while (!value.empty())
    {
        const auto comma = value.find(',');
        if (iequals(trim(value.substr(0, comma)), token))
        {
            return true;
        }
        if (comma == std::string_view::npos)
        {
            break;
        }
        value.remove_prefix(comma + 1);
    }
    return false;
}

std::string find_etag(std::string_view headers)
{
    const auto value = find_header(headers, "etag");
    if (!value)
    {
        return {};
    }
    const auto etag = unquote(*value);
    return is_safe_etag(etag) ? std::string(etag) : std::string();
}
