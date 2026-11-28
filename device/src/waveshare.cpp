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

#include "shown_images.h"

// Waveshare's waveform for partial updates of this panel, from their
// epd13in3k drivers (github.com/waveshareteam/e-Paper, Lut_Partial): 105
// bytes for the LUT register (0x32), then the gate (0x03), source (0x04) and
// VCOM (0x2C) voltages it was made for. The OTP's own waveforms are for full
// updates only.
static constexpr std::array<uint8_t, 105> PARTIAL_LUT = {
    0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2A, 0x88, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x15, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01,
    0x00, 0x0A, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x22, 0x22, 0x22, 0x22, 0x22,
};
static constexpr uint8_t PARTIAL_GATE_VOLTAGE = 0x17;
static constexpr std::array<uint8_t, 3> PARTIAL_SOURCE_VOLTAGES = {0x41, 0xA8, 0x32};
static constexpr uint8_t PARTIAL_VCOM = 0x18;

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

    setRamCounters();
}

void Waveshare13K::setRamCounters()
{
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

// As Waveshare's EPD_13IN3K_Init_Part does after a full init
void Waveshare13K::loadPartialWaveform()
{
    // Border waveform: leave the border as it is
    sendCommand(0x3C);
    sendData(0x80);

    sendCommand(0x32);
    sendData(PARTIAL_LUT.data(), PARTIAL_LUT.size());
    sendCommand(0x03);
    sendData(PARTIAL_GATE_VOLTAGE);
    sendCommand(0x04);
    sendData(PARTIAL_SOURCE_VOLTAGES.data(), PARTIAL_SOURCE_VOLTAGES.size());
    sendCommand(0x2C);
    sendData(PARTIAL_VCOM);

    // Write register for display option: as Waveshare's (RAM ping-pong for
    // display mode 2, which doesn't matter here: both images are written)
    sendCommand(0x37);
    static constexpr std::array<uint8_t, 10> DISPLAY_OPTION = {0x00, 0x00, 0x00, 0x00, 0x00,
                                                               0x40, 0x00, 0x00, 0x00, 0x00};
    sendData(DISPLAY_OPTION.data(), DISPLAY_OPTION.size());

    // Enable the clock and analog circuits
    sendCommand(0x22);
    sendData(0xC0);
    sendCommand(0x20);
    waitUntilIdle();
}

bool Waveshare13K::displayPartial(const std::vector<uint8_t> &old_packed, const std::array<uint8_t, 81600> &buffer)
{
    printf("[%d] -> Displaying image (partial)...\n", id);
    // The old image goes in the "red" RAM, which display mode 2 compares
    // the new one in the black and white RAM with. Checked first, so a bad
    // one draws nothing
    if (!unpack_pixel_runs(old_packed, buffer.size(), [](const uint8_t *, std::size_t) {}))
    {
        printf("[%d] -> The panel's old image doesn't unpack\n", id);
        return false;
    }
    loadPartialWaveform();
    sendCommand(0x26);
    unpack_pixel_runs(old_packed, buffer.size(),
                      [this](const uint8_t *chunk, std::size_t length) { sendData(chunk, length); });
    setRamCounters();
    sendCommand(0x24);
    sendData(buffer.data(), buffer.size());

    printf("[%d] -> Turning on display (partial)...\n", id);
    // Display update control: clock and analog on, display mode 2 with the
    // waveform loaded above, then analog and clock off (Waveshare's 0xCF)
    sendCommand(0x22);
    sendData(0xCF);
    sendCommand(0x20);
    waitUntilIdle();
    return true;
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

        // Timeout and reboot after 30 seconds (1000 * 30ms)
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
