import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { getFont } from "../src/shared/font";
import { fitFontSize, renderScreen } from "../src/shared/render";
import { SCREEN_BYTES, SCREEN_HEIGHT, SCREEN_WIDTH } from "../src/shared/screen";

// Rendered by the old Flask server (server/app.py at commit 02ece7f, Pillow)
// for the same lines. Regenerate with test/fixtures/flask/generate.py.
const fixtures = new URL("./fixtures/flask/", import.meta.url);
type Case = { lines: [string, string]; sizes: [number | null, number | null] };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- our own fixture
const cases = JSON.parse(readFileSync(new URL("cases.json", fixtures), "utf8")) as Case[];

function flaskBuffer(i: number): Uint8Array {
  return new Uint8Array(gunzipSync(readFileSync(new URL(`case${i}.bin.gz`, fixtures))));
}

function isSet(buffer: Uint8Array, x: number, y: number) {
  return (buffer[y * (SCREEN_WIDTH / 8) + (x >> 3)]! & (0x80 >> (x & 7))) !== 0;
}

/** Bounding box of the set pixels in rows [fromY, toY). */
function bbox(buffer: Uint8Array, fromY: number, toY: number) {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -1, -1];
  for (let y = fromY; y < toY; y++) {
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      if (isSet(buffer, x, y)) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return [minX, minY, maxX, maxY];
}

function popcount(buffer: Uint8Array) {
  let count = 0;
  for (let byte of buffer) {
    for (; byte; byte >>= 1) {
      count += byte & 1;
    }
  }
  return count;
}

describe("matches the Flask server's rendering", () => {
  const font = getFont();

  test.each(cases.map((c, i) => [i, c] as const))("case %i %j", (i, { lines, sizes }) => {
    const expected = flaskBuffer(i);
    const actual = renderScreen(font, lines[0], lines[1]);

    expect(actual.length).toBe(SCREEN_BYTES);

    // Same font size for each line.
    expect(lines.map((line) => (line ? fitFontSize(font, line) : null))).toEqual(sizes);

    // Same placement: each line's bounding box within a pixel.
    for (const [from, to] of [
      [0, SCREEN_HEIGHT / 2],
      [SCREEN_HEIGHT / 2, SCREEN_HEIGHT],
    ] as const) {
      const a = bbox(actual, from, to);
      const e = bbox(expected, from, to);
      if (e[2] === -1) {
        expect(a).toEqual(e); // an empty line stays empty
        continue;
      }
      a.forEach((value, k) => expect(Math.abs(value - e[k]!)).toBeLessThanOrEqual(1));
    }

    // Same shapes: Pillow uses FreeType's hinted rasterizer, so edges differ
    // by a pixel here and there, but nothing more.
    const diff = actual.map((byte, k) => byte ^ expected[k]!);
    expect(popcount(diff)).toBeLessThan(popcount(expected) * 0.08);
  });
});

test("blank lines render a blank screen", () => {
  expect(renderScreen(getFont(), "", "").every((byte) => byte === 0)).toBe(true);
});

test("line breaks and control characters render as spaces, like Flask's clean_line", () => {
  const font = getFont();
  expect(renderScreen(font, "LSB\n657", "Kyrie \tEleison")).toEqual(
    renderScreen(font, "LSB 657", "Kyrie  Eleison"),
  );
});
