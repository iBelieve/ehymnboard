import { useMemo } from "react";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../shared/screen";

// The cross at the top of the wooden board.
const CROSS_PATH =
  "M312.533,109.467C312.533,107.512 313.338,105.569 314.72,104.187C316.102,102.805 318.045,102 320,102C321.955,102 323.897,102.805 325.28,104.187C326.662,105.569 327.467,107.512 327.467,109.467C329.421,109.467 331.364,110.271 332.746,111.654C334.129,113.036 334.933,114.979 334.933,116.933C334.933,118.888 334.129,120.831 332.746,122.213C331.364,123.595 329.421,124.4 327.467,124.4L327.467,142.533L345.6,142.533C345.6,140.579 346.405,138.636 347.787,137.254C349.169,135.871 351.112,135.067 353.067,135.067C355.021,135.067 356.964,135.871 358.346,137.254C359.729,138.636 360.533,140.579 360.533,142.533C362.488,142.533 364.431,143.338 365.813,144.72C367.195,146.103 368,148.045 368,150C368,151.955 367.195,153.897 365.813,155.28C364.431,156.662 362.488,157.467 360.533,157.467C360.533,159.421 359.729,161.364 358.346,162.746C356.964,164.129 355.021,164.933 353.067,164.933C351.112,164.933 349.169,164.129 347.787,162.746C346.405,161.364 345.6,159.421 345.6,157.467L327.467,157.467L327.467,207.6C329.421,207.6 331.364,208.405 332.746,209.787C334.129,211.169 334.933,213.112 334.933,215.067C334.933,217.021 334.129,218.964 332.746,220.346C331.364,221.729 329.421,222.533 327.467,222.533C327.467,224.488 326.662,226.431 325.28,227.813C323.897,229.195 321.955,230 320,230C318.045,230 316.102,229.195 314.72,227.813C313.338,226.431 312.533,224.488 312.533,222.533C310.578,222.533 308.636,221.729 307.254,220.346C305.871,218.964 305.067,217.021 305.067,215.067C305.067,213.112 305.871,211.169 307.254,209.787C308.636,208.405 310.578,207.6 312.533,207.6L312.533,157.467L294.4,157.467C294.4,159.421 293.595,161.364 292.213,162.746C290.831,164.129 288.888,164.933 286.933,164.933C284.978,164.933 283.036,164.129 281.654,162.746C280.271,161.364 279.467,159.421 279.467,157.467C277.512,157.467 275.569,156.662 274.187,155.28C272.805,153.897 272,151.955 272,150C272,148.045 272.805,146.103 274.187,144.72C275.569,143.338 277.512,142.533 279.467,142.533C279.467,140.579 280.271,138.636 281.654,137.254C283.036,135.871 284.978,135.067 286.933,135.067C288.888,135.067 290.831,135.871 292.213,137.254C293.595,138.636 294.4,140.579 294.4,142.533L312.533,142.533L312.533,124.4C310.578,124.4 308.636,123.595 307.254,122.213C305.871,120.831 305.067,118.888 305.067,116.933C305.067,114.979 305.871,113.036 307.254,111.654C308.636,110.271 310.578,109.467 312.533,109.467Z";

/** A screen's 1-bit buffer as a PNG data URL (white text on black). */
function screenToDataUrl(buffer: Uint8Array): string {
  const canvas = document.createElement("canvas");
  canvas.width = SCREEN_WIDTH;
  canvas.height = SCREEN_HEIGHT;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);

  for (let i = 0; i < SCREEN_WIDTH * SCREEN_HEIGHT; i++) {
    const on = (buffer[i >> 3]! & (0x80 >> (i & 7))) !== 0;
    const value = on ? 255 : 0;
    image.data[i * 4] = value;
    image.data[i * 4 + 1] = value;
    image.data[i * 4 + 2] = value;
    image.data[i * 4 + 3] = 255;
  }

  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

// Where each screen sits on the board, in the drawing's units.
const SCREEN_Y = [304, 728, 1152];
const DIVIDER_Y = [500, 924, 1348];

/** The wooden hymn board with its three screens showing these buffers. */
export function BoardPreview({ screens }: { screens: (Uint8Array | undefined)[] }) {
  const urls = useMemo(() => screens.map((s) => (s ? screenToDataUrl(s) : undefined)), [screens]);

  return (
    <svg
      // Fills its grid cell and centres the drawing in it, as the old admin's
      // board did (without a size the SVG hugs the cell's left edge).
      width="100%"
      height="100%"
      viewBox="0 0 640 1592"
      className="z-10 py-16 max-lg:px-16"
      role="img"
      aria-label="Preview of the hymn board"
    >
      <path
        d="M0,320C-0,143.269 143.269,0 320,0C496.731,0 640,143.269 640,320L640,1592L0,1592L0,320Z"
        fill="#855e42"
      />
      <path d={CROSS_PATH} fill="#e8b85f" />
      {SCREEN_Y.map((y, i) =>
        urls[i] ? (
          <image
            key={y}
            href={urls[i]}
            x={32}
            y={y}
            width={SCREEN_WIDTH * 0.6}
            height={SCREEN_HEIGHT * 0.6}
          />
        ) : (
          <rect
            key={y}
            x={32}
            y={y}
            width={SCREEN_WIDTH * 0.6}
            height={SCREEN_HEIGHT * 0.6}
            fill="#000"
          />
        ),
      )}
      {DIVIDER_Y.map((y) => (
        <rect key={y} x={16} y={y} width={608} height={16} fill="#855e42" />
      ))}
    </svg>
  );
}
