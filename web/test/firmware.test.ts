import { describe, expect, test } from "vitest";
import { FIRMWARE_MAX_SIZE, slotImage, uploadError } from "../src/worker/firmware";
import { bundle } from "./bundle";

/** What a board would download */
function bytes(image: ArrayBuffer | null) {
  return image && new Uint8Array(image);
}

const A = new Uint8Array(512).fill(0xa);
const B = new Uint8Array(768).fill(0xb);

describe("bundles", () => {
  test("serve each slot its own image", () => {
    const upload = bundle(A, B);
    expect(uploadError(upload)).toBeNull();
    expect(bytes(slotImage(upload, "a"))).toEqual(A);
    expect(bytes(slotImage(upload, "b"))).toEqual(B);
  });

  test("serve slot A's to a board that doesn't name a slot", () => {
    const upload = bundle(A, B);
    expect(bytes(slotImage(upload, undefined))).toEqual(A);
    expect(bytes(slotImage(upload, "c"))).toEqual(A);
  });

  test("are checked image by image", () => {
    expect(uploadError(bundle(A, new Uint8Array(0)))).toBe("Image is empty");
    expect(uploadError(bundle(new Uint8Array(100), B))).toMatch(/multiple of 256/);
    expect(uploadError(bundle(A, new Uint8Array(FIRMWARE_MAX_SIZE + 256)))).toMatch(/larger/);
  });

  test("must be whole", () => {
    expect(uploadError(bundle(A, B).subarray(0, 1000))).toMatch(/cut short/);
    expect(uploadError(bundle(A, B, [A.length, B.length - 256]))).toMatch(/extra bytes/);
    expect(slotImage(bundle(A, B).subarray(0, 1000), "a")).toBeNull();
  });
});

describe("a single image, from before the A/B bootloader", () => {
  test("is slot A's alone", () => {
    expect(uploadError(A)).toBeNull();
    expect(bytes(slotImage(A, undefined))).toEqual(A);
    expect(bytes(slotImage(A, "a"))).toEqual(A);
    expect(slotImage(A, "b")).toBeNull();
  });

  test("is checked as before", () => {
    expect(uploadError(new Uint8Array(0))).toBe("Image is empty");
    expect(uploadError(new Uint8Array(100))).toMatch(/multiple of 256/);
    expect(uploadError(new Uint8Array(1001 * 1024))).toMatch(/larger/);
  });
});
