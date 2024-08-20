/*
 * eHymnBoard device firmware
 * Copyright (C) 2025  Michael Spencer <sonrisesoftware@gmail.com>

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

#include "hardware/gpio.h"
#include "pico/stdlib.h"

constexpr bool HIGH = true;
constexpr bool LOW = false;

class OutputPin
{
  public:
    OutputPin(uint gpio, bool initialValue) : gpio(gpio)
    {
        gpio_set_function(gpio, GPIO_FUNC_SIO);
        gpio_set_dir(gpio, GPIO_OUT);
        gpio_put(gpio, initialValue);
    }

    void set(bool value)
    {
        gpio_put(gpio, value);
    }

  private:
    const uint gpio;
};

class InputPin
{
  public:
    InputPin(uint gpio) : gpio(gpio)
    {
        gpio_set_function(gpio, GPIO_FUNC_SIO);
        gpio_set_dir(gpio, GPIO_IN);
    }

    bool get()
    {
        return gpio_get(gpio);
    }

    bool isHigh()
    {
        return get() == HIGH;
    }

    bool isLow()
    {
        return get() == LOW;
    }

  private:
    const uint gpio;
};
