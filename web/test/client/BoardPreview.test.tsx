import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { BoardPreview } from "../../src/client/BoardPreview";
import { SCREEN_BYTES } from "../../src/shared/screen";

test("each screen's bits become an image, most significant bit first", () => {
  const one = new Uint8Array(SCREEN_BYTES);
  one[0] = 0x80;
  const lastPixel = new Uint8Array(SCREEN_BYTES);
  lastPixel[SCREEN_BYTES - 1] = 0x01;
  const { container } = render(
    <BoardPreview screens={[one, lastPixel, new Uint8Array(SCREEN_BYTES).fill(0xff)]} />,
  );
  const hrefs = [...container.querySelectorAll("image")].map((image) => image.getAttribute("href"));
  // The first pixel, the last pixel (bit 0 of the last byte), and every pixel.
  expect(hrefs).toEqual([
    "data:test,1,0",
    `data:test,1,${SCREEN_BYTES * 8 - 1}`,
    `data:test,${SCREEN_BYTES * 8},0`,
  ]);
});

test("a screen with no bits yet is drawn black", () => {
  const { container } = render(
    <BoardPreview screens={[undefined, new Uint8Array(SCREEN_BYTES), undefined]} />,
  );
  expect(container.querySelectorAll("image")).toHaveLength(1);
  // The two blank screens (the dividers are the board's brown).
  expect(container.querySelectorAll('rect[fill="#000"]')).toHaveLength(2);
});
