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
#include "hardware/spi.h"
#include "pico/stdlib.h"

constexpr uint SPI_1MHZ = 1000 * 1000;

// For more examples of SPI use see
// https://github.com/raspberrypi/pico-examples/tree/master/spi
class SPI
{
  public:
    SPI(spi_inst_t *spi, uint baudrate, uint pin_sck, uint pin_mosi, uint pin_miso) : spi(spi)
    {
        spi_init(spi, baudrate);
        gpio_set_function(pin_sck, GPIO_FUNC_SPI);
        gpio_set_function(pin_mosi, GPIO_FUNC_SPI);
        gpio_set_function(pin_miso, GPIO_FUNC_SPI);
    }

    void write(uint8_t byte)
    {
        write(&byte, 1);
    }

    void write(const uint8_t *data, size_t len)
    {
        spi_write_blocking(spi, data, len);
    }

  private:
    spi_inst_t *spi;
};
