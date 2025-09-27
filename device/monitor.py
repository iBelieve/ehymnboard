#!/usr/bin/env python3
import serial
import time
import os

DEVICE = "/dev/tty.usbmodem2101"  # Replace with your device path
BAUDRATE = 115200


def find_device():
    for device in os.listdir("/dev"):
        if device.startswith("tty.usbmodem"):
            return f"/dev/{device}"
    return None


def device_loop(device: str):
    try:
        with serial.Serial(device, BAUDRATE, timeout=1) as ser:
            print(f"Connected to {device}")
            while True:
                line = ser.readline().decode(errors="ignore").strip()
                if line:
                    print(line)
    except serial.SerialException:
        print(f"Lost connection to {DEVICE}, retrying in 1s...")
        time.sleep(1)


def main():
    try:
        while True:
            device = find_device()

            if device:
                device_loop(device)
            else:
                print("Device not found, retrying in 1s...")
                time.sleep(1)
    except KeyboardInterrupt:
        # Graceful exit on Ctrl+C
        print("Exiting...")


if __name__ == "__main__":
    main()
