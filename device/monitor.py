#!/usr/bin/env python3
import argparse
import os
import sys
import time
from datetime import datetime

import serial

BAUDRATE = 115200


def find_device():
    for device in os.listdir("/dev"):
        if device.startswith("tty.usbmodem"):
            return f"/dev/{device}"
    return None


def emit(line: str, log_file):
    stamped = f"{datetime.now().strftime('%H:%M:%S')} | {line}"
    print(stamped, flush=True)
    if log_file is not None:
        log_file.write(stamped + "\n")
        log_file.flush()


def device_loop(device: str, log_file):
    try:
        with serial.Serial(device, BAUDRATE, timeout=1) as ser:
            emit(f"Connected to {device}", log_file)
            while True:
                line = ser.readline().decode(errors="ignore").strip()
                if line:
                    emit(line, log_file)
    except serial.SerialException:
        emit(f"Lost connection to {device}, retrying in 1s...", log_file)
        time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description="eHymnboard device serial monitor")
    parser.add_argument(
        "--log",
        metavar="PATH",
        help="Append timestamped output to this file in addition to stdout",
    )
    args = parser.parse_args()

    log_file = open(args.log, "a", buffering=1) if args.log else None

    try:
        while True:
            device = find_device()

            if device:
                device_loop(device, log_file)
            else:
                emit("Device not found, retrying in 1s...", log_file)
                time.sleep(1)
    except KeyboardInterrupt:
        # Graceful exit on Ctrl+C
        print("Exiting...")
    finally:
        if log_file is not None:
            log_file.close()


if __name__ == "__main__":
    main()
