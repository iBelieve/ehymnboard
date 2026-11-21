// Renders a screen's two lines of text into the 1-bit buffer the device
// displays. Pure TypeScript (opentype.js for glyph outlines plus a small
// scanline fill), so the Worker and the browser preview run the same code and
// produce the same bits.

import type { Font, PathCommand } from "opentype.js";
import {
  LINE1_CENTER_Y,
  LINE2_CENTER_Y,
  LINE_OFFSET,
  MAX_FONT_SIZE,
  MAX_LINE_WIDTH,
  SCREEN_BYTES,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
} from "./screen";

const ROW_BYTES = SCREEN_WIDTH / 8;

// Each curve is split into this many straight segments. Glyphs here are at
// most ~275px tall, so 16 keeps the error well under a pixel.
const CURVE_STEPS = 16;

export function measureText(font: Font, text: string, size: number): number {
  return font.getAdvanceWidth(text, size, { kerning: true });
}

/**
 * The largest whole font size (up to MAX_FONT_SIZE) at which the text is
 * narrower than MAX_LINE_WIDTH, the same rule the Flask server used.
 */
export function fitFontSize(font: Font, text: string): number {
  // Advance width scales linearly with size, so solve instead of looping.
  const unitWidth = measureText(font, text, 1);
  let size = Math.min(Math.floor(MAX_FONT_SIZE), Math.ceil(MAX_LINE_WIDTH / unitWidth) - 1);
  while (size > 1 && measureText(font, text, size) >= MAX_LINE_WIDTH) {
    size--;
  }
  return Math.max(size, 1);
}

export function renderScreen(font: Font, line1: string, line2: string): Uint8Array {
  const buffer = new Uint8Array(SCREEN_BYTES);
  drawCenteredLine(buffer, font, line1, LINE1_CENTER_Y);
  drawCenteredLine(buffer, font, line2, LINE2_CENTER_Y);
  return buffer;
}

function drawCenteredLine(buffer: Uint8Array, font: Font, text: string, centerY: number) {
  if (!text) {
    return;
  }

  const size = fitFontSize(font, text);
  const x = (SCREEN_WIDTH - measureText(font, text, size)) / 2;
  // Pillow placed the top of the ascender at y; opentype.js wants the baseline.
  const top = centerY - size / 2 - LINE_OFFSET;
  const baseline = top + Math.floor((font.ascender * size) / font.unitsPerEm);

  const path = font.getPath(text, x, baseline, size, { kerning: true });
  fillPath(buffer, flatten(path.commands));
}

type Point = [number, number];

/** Turns path commands into closed polygons of straight edges. */
function flatten(commands: PathCommand[]): Point[][] {
  const polygons: Point[][] = [];
  let current: Point[] = [];
  let start: Point = [0, 0];
  let pen: Point = [0, 0];

  const close = () => {
    if (current.length > 2) {
      polygons.push(current);
    }
    current = [];
  };

  for (const cmd of commands) {
    switch (cmd.type) {
      case "M":
        close();
        start = pen = [cmd.x, cmd.y];
        current.push(pen);
        break;
      case "L":
        pen = [cmd.x, cmd.y];
        current.push(pen);
        break;
      case "Q": {
        const [x0, y0] = pen;
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS;
          const u = 1 - t;
          current.push([
            u * u * x0 + 2 * u * t * cmd.x1 + t * t * cmd.x,
            u * u * y0 + 2 * u * t * cmd.y1 + t * t * cmd.y,
          ]);
        }
        pen = [cmd.x, cmd.y];
        break;
      }
      case "C": {
        const [x0, y0] = pen;
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS;
          const u = 1 - t;
          current.push([
            u * u * u * x0 + 3 * u * u * t * cmd.x1 + 3 * u * t * t * cmd.x2 + t * t * t * cmd.x,
            u * u * u * y0 + 3 * u * u * t * cmd.y1 + 3 * u * t * t * cmd.y2 + t * t * t * cmd.y,
          ]);
        }
        pen = [cmd.x, cmd.y];
        break;
      }
      case "Z":
        pen = start;
        close();
        break;
    }
  }
  close();

  return polygons;
}

/**
 * Sets every pixel whose center is inside the polygons (nonzero winding rule),
 * like FreeType's monochrome rasterizer.
 */
function fillPath(buffer: Uint8Array, polygons: Point[][]) {
  type Edge = { x0: number; y0: number; x1: number; y1: number; dir: number };
  const edges: Edge[] = [];
  let minY = Infinity;
  let maxY = -Infinity;

  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i++) {
      const [ax, ay] = polygon[i]!;
      const [bx, by] = polygon[(i + 1) % polygon.length]!;
      if (ay === by) {
        continue;
      }
      edges.push(
        ay < by
          ? { x0: ax, y0: ay, x1: bx, y1: by, dir: 1 }
          : { x0: bx, y0: by, x1: ax, y1: ay, dir: -1 },
      );
      minY = Math.min(minY, ay, by);
      maxY = Math.max(maxY, ay, by);
    }
  }

  const firstRow = Math.max(0, Math.floor(minY));
  const lastRow = Math.min(SCREEN_HEIGHT - 1, Math.ceil(maxY));
  const crossings: { x: number; dir: number }[] = [];

  for (let row = firstRow; row <= lastRow; row++) {
    const y = row + 0.5;
    crossings.length = 0;

    for (const e of edges) {
      // Half-open so a vertex shared by two edges is counted once.
      if (y >= e.y0 && y < e.y1) {
        crossings.push({ x: e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dir: e.dir });
      }
    }
    crossings.sort((a, b) => a.x - b.x);

    let winding = 0;
    for (let i = 0; i < crossings.length - 1; i++) {
      winding += crossings[i]!.dir;
      if (winding !== 0) {
        // Pixels whose centers (col + 0.5) fall in [left, right).
        const from = Math.max(0, Math.ceil(crossings[i]!.x - 0.5));
        const to = Math.min(SCREEN_WIDTH - 1, Math.ceil(crossings[i + 1]!.x - 0.5) - 1);
        for (let col = from; col <= to; col++) {
          buffer[row * ROW_BYTES + (col >> 3)]! |= 0x80 >> (col & 7);
        }
      }
    }
  }
}
