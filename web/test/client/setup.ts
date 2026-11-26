// happy-dom has no canvas, which BoardPreview draws each screen on. This one
// keeps the pixels it's given, and its data URL says how many are white and
// which is the first (-1 for none), so a test can tell which image a screen
// shows and in what order its bits were read.
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

const pixels = new WeakMap<HTMLCanvasElement, Uint8ClampedArray>();

function fakeContext(canvas: HTMLCanvasElement) {
  return {
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: (image: { data: Uint8ClampedArray }) => pixels.set(canvas, image.data),
  };
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the two methods BoardPreview calls
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
  return fakeContext(this);
} as unknown as HTMLCanvasElement["getContext"];

HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement) {
  const data = pixels.get(this) ?? new Uint8ClampedArray();
  let white = 0;
  let first = -1;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) {
      if (white === 0) first = i / 4;
      white++;
    }
  }
  return `data:test,${white},${first}`;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
