/*
 * eHymnBoard device emulator
 * Copyright (C) 2026  Michael Spencer <sonrisesoftware@gmail.com>

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

// Makes OTA images for the firmware under test. The build makes one for each
// of the A/B bootloader's slots (ehymnboard_fota_image_encrypted.bin for slot
// A, ehymnboard_b_fota_image_encrypted.bin for B, the same code linked to run
// from each): the firmware's binary, a 256 byte trailer ending in the binary's
// SHA-256, all AES-256-ECB encrypted with the key from secrets.cmake (padded
// to 32 characters with 'x'). A "new" firmware is those images with their
// version string swapped for another of the same length, re-hashed and
// re-encrypted, so it's the same code reporting a different version. The
// server is sent both in one bundle (ehymnboard_ota_bundle.bin).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TRAILER_BYTES = 256;
const SHA256_BYTES = 32;
const AES_KEY_CHARS = 32;
const BUNDLE_MAGIC = Buffer.from("EHBOTA2\0");

const DEVICE_DIR = path.join(import.meta.dirname, "..", "..");

/**
 * The key the build encrypted its image with: $PFB_AES_KEY, else the one in
 * device/secrets.cmake, else secrets.example.cmake's (which CI builds with).
 */
export function aesKey() {
  let key = process.env.PFB_AES_KEY;
  for (const file of ["secrets.cmake", "secrets.example.cmake"]) {
    const secrets = path.join(DEVICE_DIR, file);
    if (!key && fs.existsSync(secrets)) {
      key = /set\s*\(\s*PFB_AES_KEY\s+"([^"]*)"/.exec(fs.readFileSync(secrets, "utf8"))?.[1];
    }
  }
  if (!key) {
    throw new Error("no PFB_AES_KEY: set it, or copy secrets.example.cmake to secrets.cmake");
  }
  return Buffer.from(key.padEnd(AES_KEY_CHARS, "x"));
}

function aes(key: Buffer, data: Uint8Array, encrypt: boolean) {
  const cipher = encrypt
    ? crypto.createCipheriv("aes-256-ecb", key, null)
    : crypto.createDecipheriv("aes-256-ecb", key, null);
  cipher.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([cipher.update(data), cipher.final()]));
}

function sha256(data: Uint8Array) {
  return new Uint8Array(crypto.createHash("sha256").update(data).digest());
}

/** The firmware's binary with the trailer the bootloader checks, encrypted. */
export function sealImage(binary: Uint8Array, key: Buffer = aesKey()) {
  const plain = new Uint8Array(binary.length + TRAILER_BYTES);
  plain.set(binary);
  plain.set(sha256(binary), plain.length - SHA256_BYTES);
  return aes(key, plain, true);
}

/** Both slots' OTA images in one file, as the server takes them. */
export function bundle(imageA: Uint8Array, imageB: Uint8Array) {
  const lengths = Buffer.alloc(8);
  lengths.writeUInt32LE(imageA.length, 0);
  lengths.writeUInt32LE(imageB.length, 4);
  return new Uint8Array(Buffer.concat([BUNDLE_MAGIC, lengths, imageA, imageB]));
}

/** An image decrypted, its SHA-256 checked, without its trailer. */
function openImage(file: string, key: Buffer) {
  const plain = aes(key, fs.readFileSync(file), false);
  const binary = plain.subarray(0, plain.length - TRAILER_BYTES);
  const expected = Buffer.from(plain.subarray(plain.length - SHA256_BYTES));
  if (!expected.equals(sha256(binary))) {
    throw new Error(`${path.basename(file)} doesn't decrypt with this PFB_AES_KEY`);
  }
  return binary;
}

/** The build's OTA images, decrypted and checked. */
export class OtaBuild {
  readonly version: string;
  /** Each slot's binary: [A, B]. */
  readonly binaries: readonly [Uint8Array, Uint8Array];
  readonly key: Buffer;

  /** Reads the images and version from the build directory of `uf2`. */
  constructor(uf2: string, key: Buffer = aesKey()) {
    const dir = path.dirname(uf2);
    const base = path.basename(uf2, ".uf2");
    this.version = fs.readFileSync(path.join(dir, "firmware_version.txt"), "utf8").trim();
    this.key = key;
    this.binaries = [
      openImage(path.join(dir, `${base}_fota_image_encrypted.bin`), key),
      openImage(path.join(dir, `${base}_b_fota_image_encrypted.bin`), key),
    ];
  }

  /**
   * A version the build can be relabelled as: the same length as its own, so
   * the string fits where the old one was.
   */
  nextVersion(tag: string) {
    return (tag + this.version.slice(tag.length)).slice(0, this.version.length);
  }

  /** This build's binary for `slot` (0 for A, 1 for B), reporting `version` instead of its own. */
  binaryFor(version: string, slot: 0 | 1 = 0) {
    if (version.length !== this.version.length) {
      throw new Error(`"${version}" isn't ${this.version.length} characters long`);
    }
    const binary = Buffer.from(this.binaries[slot]);
    const from = Buffer.from(this.version + "\0");
    const to = Buffer.from(version + "\0");
    let found = 0;
    for (let at = binary.indexOf(from); at >= 0; at = binary.indexOf(from, at + from.length)) {
      binary.set(to, at);
      found++;
    }
    if (!found) {
      throw new Error(`version "${this.version}" isn't in the firmware binary`);
    }
    return new Uint8Array(binary);
  }

  /** This build's OTA image for `slot` (0 for A, 1 for B), reporting `version` instead of its own. */
  imageFor(version: string, slot: 0 | 1 = 0) {
    return sealImage(this.binaryFor(version, slot), this.key);
  }

  /** Both slots' images reporting `version`: [A, B]. */
  imagesFor(version: string): [Uint8Array, Uint8Array] {
    return [this.imageFor(version, 0), this.imageFor(version, 1)];
  }

  /** The bundle to upload for this build reporting `version`. */
  bundleFor(version: string) {
    return bundle(...this.imagesFor(version));
  }
}
