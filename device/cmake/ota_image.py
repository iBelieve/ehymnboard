"""Builds the OTA files from the firmware and bootloader binaries.

seal: a firmware binary as an OTA image: the binary, then a 256-byte trailer
    ending in its SHA-256, all AES-256-ECB encrypted. The format
    pico_fota_bootloader's boards check, kept so they can install the slot A
    image.
bundle: both slots' OTA images in one file to upload: an 8-byte magic, each
    image's length (little-endian 32-bit), then the images, A first.
bootloader-uf2: the A/B bootloader for installing over USB: flash's first
    sector (boot2 and the stub), the bootloader, its marker (see
    src/boot_control.h), and erased boot record sectors.
"""

import argparse
import hashlib
import struct
import zlib
from pathlib import Path

from Crypto.Cipher import AES

PAGE = 256
TRAILER = 256
KEY_LENGTH = 32

BUNDLE_MAGIC = b"EHBOTA2\0"

# As in src/boot_control.h
FLASH = 0x10000000
BOOTLOADER = 0x1000
MARKER = 0x7FF0
MARKER_MAGIC = 0x4C424845
RECORDS = (0x8000, 0x9000)

UF2_MAGIC = (0x0A324655, 0x9E5D5157)
UF2_MAGIC_END = 0x0AB16F30
UF2_FAMILY_ID_PRESENT = 0x00002000
RP2040_FAMILY = 0xE48BFF56


def seal(binary: bytes, key: bytes) -> bytes:
    if len(binary) % PAGE:
        binary += b"\xff" * (PAGE - len(binary) % PAGE)
    trailer = b"\0" * (TRAILER - 32) + hashlib.sha256(binary).digest()
    return AES.new(key, AES.MODE_ECB).encrypt(binary + trailer)


def bundle(image_a: bytes, image_b: bytes) -> bytes:
    return (
        BUNDLE_MAGIC
        + struct.pack("<II", len(image_a), len(image_b))
        + image_a
        + image_b
    )


def pages(offset: int, data: bytes) -> list[tuple[int, bytes]]:
    """`data` at `offset` as whole 256-byte pages, the last padded with 0xFF."""
    if len(data) % PAGE:
        data += b"\xff" * (PAGE - len(data) % PAGE)
    return [(offset + at, data[at : at + PAGE]) for at in range(0, len(data), PAGE)]


def bootloader_pages(stub: bytes, bootloader: bytes) -> list[tuple[int, bytes]]:
    marker_page = MARKER - (PAGE - 16)
    if len(stub) > BOOTLOADER:
        raise ValueError(f"the stub is {len(stub)} bytes, more than its sector")
    if BOOTLOADER + len(bootloader) > marker_page:
        raise ValueError(
            f"the bootloader is {len(bootloader)} bytes, past its marker's page"
        )
    marker = struct.pack(
        "<IIII",
        MARKER_MAGIC,
        len(bootloader),
        zlib.crc32(bootloader),
        ~MARKER_MAGIC & 0xFFFFFFFF,
    )
    return [
        *pages(0, stub),
        *pages(BOOTLOADER, bootloader),
        (marker_page, b"\xff" * (PAGE - 16) + marker),
        # Writing a page erases its sector: no stale boot record survives
        *[(offset, b"\xff" * PAGE) for offset in RECORDS],
    ]


def uf2(blocks: list[tuple[int, bytes]]) -> bytes:
    out = bytearray()
    for number, (offset, data) in enumerate(blocks):
        header = struct.pack(
            "<IIIIIIII",
            *UF2_MAGIC,
            UF2_FAMILY_ID_PRESENT,
            FLASH + offset,
            len(data),
            number,
            len(blocks),
            RP2040_FAMILY,
        )
        out += header + data.ljust(476, b"\0") + struct.pack("<I", UF2_MAGIC_END)
    return bytes(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    seal_args = commands.add_parser("seal")
    seal_args.add_argument(
        "--key", required=True, help=f"the AES key, {KEY_LENGTH} characters"
    )
    seal_args.add_argument("binary", type=Path)
    seal_args.add_argument("out", type=Path)
    bundle_args = commands.add_parser("bundle")
    bundle_args.add_argument("image_a", type=Path)
    bundle_args.add_argument("image_b", type=Path)
    bundle_args.add_argument("out", type=Path)
    uf2_args = commands.add_parser("bootloader-uf2")
    uf2_args.add_argument("stub", type=Path)
    uf2_args.add_argument("bootloader", type=Path)
    uf2_args.add_argument("out", type=Path)
    args = parser.parse_args()

    if args.command == "seal":
        if len(args.key) != KEY_LENGTH:
            parser.error(f"the key must be {KEY_LENGTH} characters")
        args.out.write_bytes(seal(args.binary.read_bytes(), args.key.encode()))
    elif args.command == "bundle":
        args.out.write_bytes(
            bundle(args.image_a.read_bytes(), args.image_b.read_bytes())
        )
    else:
        blocks = bootloader_pages(args.stub.read_bytes(), args.bootloader.read_bytes())
        args.out.write_bytes(uf2(blocks))


if __name__ == "__main__":
    main()
