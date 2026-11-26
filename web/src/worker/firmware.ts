// OTA firmware uploads and downloads. A release is uploaded as a bundle of
// two images, one for each of the A/B bootloader's slots (the same firmware,
// linked to run from each; the build's ehymnboard_ota_bundle.bin): an 8-byte
// magic, each image's length (little-endian 32-bit), then image A and image B.
// A board asks for the image for the slot it isn't running from
// (`/firmware/image?slot=a|b`); one on pico_fota_bootloader doesn't say, and
// gets slot A's, the only one it can run. A single image, from a build
// before the A/B bootloader, is slot A's alone.

// Must match the device: images are written to flash in 256-byte pages and a
// slot is 1000 KB
export const FIRMWARE_PAGE_SIZE = 256;
export const FIRMWARE_MAX_SIZE = 1000 * 1024;

const BUNDLE_MAGIC = new TextEncoder().encode("EHBOTA2\0");
const BUNDLE_HEADER_SIZE = BUNDLE_MAGIC.length + 8;

export type Slot = "a" | "b";

type Bytes = Uint8Array<ArrayBuffer>;

function isBundle(data: Bytes) {
  return data.length >= BUNDLE_HEADER_SIZE && BUNDLE_MAGIC.every((byte, i) => data[i] === byte);
}

/** The images in an upload: [A, B], or [A] for a single image. */
function splitImages(data: Bytes): Bytes[] | string {
  if (!isBundle(data)) {
    return [data];
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lengthA = view.getUint32(BUNDLE_MAGIC.length, true);
  const lengthB = view.getUint32(BUNDLE_MAGIC.length + 4, true);
  if (BUNDLE_HEADER_SIZE + lengthA + lengthB !== data.length) {
    return "Bundle is cut short or has extra bytes";
  }
  return [
    data.subarray(BUNDLE_HEADER_SIZE, BUNDLE_HEADER_SIZE + lengthA),
    data.subarray(BUNDLE_HEADER_SIZE + lengthA),
  ];
}

/** Why an upload can't be offered to the boards, or null if it can. */
export function uploadError(data: Bytes): string | null {
  const images = splitImages(data);
  if (typeof images === "string") {
    return images;
  }
  for (const image of images) {
    if (image.length === 0) {
      return "Image is empty";
    }
    if (image.length % FIRMWARE_PAGE_SIZE !== 0) {
      return `Image size must be a multiple of ${FIRMWARE_PAGE_SIZE} bytes`;
    }
    if (image.length > FIRMWARE_MAX_SIZE) {
      return `Image is larger than ${FIRMWARE_MAX_SIZE} bytes`;
    }
  }
  return null;
}

/**
 * The image to send a board that asked for `slot` (any other value is slot
 * A), from a valid upload; null if the upload has none for it. A buffer of
 * its own, not a view: workerd sends a view as a stream, with no
 * Content-Length.
 */
export function slotImage(upload: Bytes, slot: string | undefined): ArrayBuffer | null {
  const images = splitImages(upload);
  if (typeof images === "string") {
    return null;
  }
  return (slot === "b" ? images[1] : images[0])?.slice().buffer ?? null;
}
