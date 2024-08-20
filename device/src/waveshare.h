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

#include <stdio.h>

#include <array>

#include "gpio.h"
#include "pico/stdlib.h"
#include "spi.h"
#include "utils.h"

class Waveshare13K
{
  public:
    /**
     * @param pin_power Power pin (output). HIGH to power on.
     * @param power Power pin (output). HIGH to power on.
     * @param cs Chip Select pin (output). LOW to select the device.
     * @param dc Data/Command pin (output). HIGH for data, LOW for command.
     * @param reset Reset pin (output). LOW to reset.
     * @param busy Busy pin (input). HIGH when device is busy.
     */
    Waveshare13K(SPI &spi, int id, uint pin_power, uint pin_cs, uint pin_dc, uint pin_reset, uint pin_busy)
        : spi(spi), id(id), power(pin_power, LOW), cs(pin_cs, HIGH), dc(pin_dc, LOW), reset(pin_reset, HIGH),
          busy(pin_busy)
    {
    }

    void init();
    void shutdown();
    void turnOnDisplay();

    void display(const std::array<uint8_t, 81600> &buffer);

  private:
    void sendCommand(uint8_t command);
    void sendData(uint8_t data);
    void sendData(const uint8_t *data, size_t len);

    void waitUntilIdle();

    void hardwareReset();
    void softwareReset();

    SPI &spi;
    const int id;
    OutputPin power;
    OutputPin cs;
    OutputPin dc;
    OutputPin reset;
    InputPin busy;

    const uint16_t width = 960;
    const uint16_t height = 680;
};
