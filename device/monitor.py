#!/usr/bin/env python3
import serial
import time

DEVICE = "/dev/tty.usbmodem2101"  # Replace with your device path
BAUDRATE = 115200

while True:
    try:
        with serial.Serial(DEVICE, BAUDRATE, timeout=1) as ser:
            print(f"Connected to {DEVICE}")
            while True:
                line = ser.readline().decode(errors="ignore").strip()
                if line:
                    print(line)
    except serial.SerialException:
        print(f"Lost connection to {DEVICE}, retrying in 1s...")
        time.sleep(1)
