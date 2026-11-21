// Geometry of one Waveshare 13.3" (K) panel and of the two lines of text drawn
// on it. These match the original Flask server so the boards look the same.

export const SCREEN_WIDTH = 960;
export const SCREEN_HEIGHT = 680;

// 1 bit per pixel, rows top to bottom, most significant bit first. A set bit is
// a text (white) pixel. This is exactly what the device firmware expects.
export const SCREEN_BYTES = (SCREEN_WIDTH / 8) * SCREEN_HEIGHT;

export const SCREEN_COUNT = 3;
export const LINES_PER_SCREEN = 2;
export const LINE_COUNT = SCREEN_COUNT * LINES_PER_SCREEN;

export const LINE_HEIGHT = SCREEN_HEIGHT * 0.45;
export const HORIZ_PADDING = 50;
export const MAX_FONT_SIZE = LINE_HEIGHT * 0.9;
export const MAX_LINE_WIDTH = SCREEN_WIDTH - 2 * HORIZ_PADDING;

// Bebas Neue isn't visually centered on its em box, so nudge it up.
export const LINE_OFFSET = 15;

export const LINE1_CENTER_Y = LINE_HEIGHT / 2;
export const LINE2_CENTER_Y = SCREEN_HEIGHT - LINE_HEIGHT / 2;

export type Lines = [string, string, string, string, string, string];

export const EMPTY_LINES: Lines = ["", "", "", "", "", ""];

/** The two lines shown on a screen (screens are numbered from 1). */
export function linesForScreen(lines: Lines, screen: number): [string, string] {
  const i = (screen - 1) * LINES_PER_SCREEN;
  return [lines[i] ?? "", lines[i + 1] ?? ""];
}

export function isLines(value: unknown): value is Lines {
  return (
    Array.isArray(value) &&
    value.length === LINE_COUNT &&
    value.every((line) => typeof line === "string")
  );
}
