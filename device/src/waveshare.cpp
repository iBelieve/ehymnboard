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

#include "waveshare.h"

void Waveshare13K::init()
{
    printf("[%d] -> Initializing display...\n", id);
    power.set(HIGH);

    hardwareReset();
    softwareReset();

    // Undocumented command
    sendCommand(0x0C);
    sendData(0xAE);
    sendData(0xC7);
    sendData(0xC3);
    sendData(0xC0);
    sendData(0x80);

    // Driver output control
    sendCommand(0x01);
    sendData(0xA7);
    sendData(0x02);
    sendData(0x00);

    // Data entry mode setting
    sendCommand(0x11);
    sendData(0x03);

    // Set RAM X address start/end position
    sendCommand(0x44);
    sendData(0x00);
    sendData(0x00);
    sendData(0xBF);
    sendData(0x03);

    // Set RAM Y address start/end position
    sendCommand(0x45);
    sendData(0x00);
    sendData(0x00);
    sendData(0xA7);
    sendData(0x02);

    // Border waveform control
    sendCommand(0x3C);
    sendData(0x05);

    // Set temperature sensor control to internal sensor
    sendCommand(0x18);
    sendData(0x80);

    // Set RAM X address counter
    sendCommand(0x4E);
    sendData(0x00);
    sendData(0x00);

    // Set RAM Y address counter
    sendCommand(0x4F);
    sendData(0x00);
    sendData(0x00);
}

void Waveshare13K::shutdown()
{
    printf("[%d] -> Shutting down display...\n", id);
    reset.set(LOW);
    dc.set(LOW);
    power.set(LOW);
}

void Waveshare13K::turnOnDisplay()
{
    printf("[%d] -> Turning on display...\n", id);
    // Display Update Control
    sendCommand(0x22);
    sendData(0xF7);
    // Activate Display Update Sequence
    sendCommand(0x20);
    waitUntilIdle();
}

void Waveshare13K::display(const std::array<uint8_t, 81600> &buffer)
{
    printf("[%d] -> Displaying image...\n", id);
    sendCommand(0x24);
    sendData(buffer.data(), buffer.size());
    turnOnDisplay();
}

void Waveshare13K::sendCommand(uint8_t command)
{
    cs.set(LOW);
    dc.set(LOW);
    spi.write(command);
    cs.set(HIGH);
}

void Waveshare13K::sendData(uint8_t data)
{
    cs.set(LOW);
    dc.set(HIGH);
    spi.write(data);
    cs.set(HIGH);
}

void Waveshare13K::sendData(const uint8_t *data, size_t len)
{
    cs.set(LOW);
    dc.set(HIGH);
    spi.write(data, len);
    cs.set(HIGH);
}

void Waveshare13K::waitUntilIdle()
{
    printf("[%d] --> Waiting for display to go idle...\n", id);
    int count = 0;

    while (busy.isHigh())
    {
        sleep_ms(30);
        count++;

        if (count > 1000)
        {
            printf("Timeout waiting for busy pin to go low\n");
            shutdown();
            reset_pico();
        }
    }
}

void Waveshare13K::hardwareReset()
{
    reset.set(HIGH);
    sleep_ms(20);
    reset.set(LOW);
    sleep_ms(2);
    reset.set(HIGH);
    waitUntilIdle();
}

void Waveshare13K::softwareReset()
{
    sendCommand(0x12);
    waitUntilIdle();
}
