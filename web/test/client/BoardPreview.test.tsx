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
  expect(hrefs).toEqual(["data:test,1", "data:test,1", `data:test,${SCREEN_BYTES * 8}`]);
});

test("a screen with no bits yet is drawn black", () => {
  const { container } = render(
    <BoardPreview screens={[undefined, new Uint8Array(SCREEN_BYTES), undefined]} />,
  );
  expect(container.querySelectorAll("image")).toHaveLength(1);
  // The two blank screens, then the three dividers.
  expect(container.querySelectorAll('rect[fill="#000"]')).toHaveLength(2);
});
