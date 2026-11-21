/*
 * Host stand-in for pico-sdk's pico/assert.h.
 *
 * On the board a failed hard_assert halts; here it throws, so tests can check
 * that bad input is rejected.
 */

#pragma once

#include <stdexcept>

// NOLINTNEXTLINE(cppcoreguidelines-macro-usage): mirrors the SDK's macro
#define hard_assert(condition)                                                                                         \
    do                                                                                                                 \
    {                                                                                                                  \
        if (!(condition))                                                                                              \
        {                                                                                                              \
            throw std::logic_error("hard_assert failed: " #condition);                                                 \
        }                                                                                                              \
    } while (false)
