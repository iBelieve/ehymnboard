import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { getFont } from "../src/shared/font";
import { fitFontSize, renderScreen } from "../src/shared/render";
import { SCREEN_BYTES, SCREEN_HEIGHT, SCREEN_WIDTH } from "../src/shared/screen";

// Reference screens, drawn by this rasterizer and checked bit for bit. The
// first eight started out matching the old Flask server (Pillow) to within a
// pixel of placement, which the boards showed for years; the rest were never
// compared with it. After a deliberate change to the rasterizer, rewrite them
// in web/ with
//
//     UPDATE_RENDER_FIXTURES=1 pnpm vitest run test/render.test.ts
//
// and look at the screens it says it wrote before committing them.
//
// Each is a binary PBM (P4) file: a short header, then the screen buffer
// exactly as the board gets it. PBM draws a set bit black, so the text shows
// black on white in an image viewer.
const fixtures = new URL("./fixtures/render/", import.meta.url);
const update = process.env["UPDATE_RENDER_FIXTURES"] === "1";
const PBM_HEADER = `P4\n${SCREEN_WIDTH} ${SCREEN_HEIGHT}\n`;

type Case = { name: string; lines: [string, string]; sizes: [number | null, number | null] };

const cases: Case[] = [
  // The cases the Flask comparison covered
  { name: "hymn-number", lines: ["657", "LSB 657"], sizes: [275, 275] },
  { name: "top-only", lines: ["123", ""], sizes: [275, null] },
  { name: "bottom-only", lines: ["", "PSALM 23"], sizes: [null, 275] },
  { name: "verses", lines: ["1-4, 7", "LSB 708"], sizes: [275, 275] },
  { name: "wide-line", lines: ["A", "WWWWWWWWWWWWWWWWWWWW"], sizes: [275, 76] },
  { name: "words", lines: ["Introit", "Gradual"], sizes: [275, 275] },
  { name: "narrow-letters", lines: ["H", "Kyrie"], sizes: [275, 275] },
  { name: "reading", lines: ["2:18", "1 Cor 13:4-7"], sizes: [275, 216] },
  // Long text, shrunk to fit
  {
    name: "long-text",
    lines: ["Lutheran Service Book", "The Church's One Foundation"],
    sizes: [114, 90],
  },
  // The widest line that still fits at full size (856 of 860 px), and one
  // just too wide for it (863 px at full size, 860.09 at 274)
  { name: "widest-at-full-size", lines: ["AGNUS DEI", "HYMN 100"], sizes: [275, 273] },
  { name: "punctuation", lines: ["—", "?!"], sizes: [275, 275] },
  { name: "accents", lines: ["Té Deum", "ÉÇÜ"], sizes: [275, 275] },
  // ✝ and ☩ aren't in Bebas Neue, so they're drawn as its missing-glyph shape
  { name: "missing-glyphs", lines: ["€ ✝ ☩", ""], sizes: [275, null] },
];

function fixtureUrl(name: string) {
  return new URL(`${name}.pbm`, fixtures);
}

function readFixture(name: string): Uint8Array {
  const file = readFileSync(fixtureUrl(name));
  const header = new TextDecoder().decode(file.subarray(0, PBM_HEADER.length));
  expect(header, `${name}.pbm isn't a ${SCREEN_WIDTH}x${SCREEN_HEIGHT} PBM`).toBe(PBM_HEADER);
  return new Uint8Array(file.subarray(PBM_HEADER.length));
}

/** Writes a reference screen unless it's unchanged; says whether it wrote it. */
function writeFixture(name: string, buffer: Uint8Array): boolean {
  const file = Buffer.concat([Buffer.from(PBM_HEADER), buffer]);
  if (existsSync(fixtureUrl(name)) && readFileSync(fixtureUrl(name)).equals(file)) {
    return false;
  }
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(fixtureUrl(name), file);
  return true;
}

/** How many pixels differ between two screen buffers. */
function differingPixels(a: Uint8Array, b: Uint8Array) {
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    for (let byte = a[i]! ^ b[i]!; byte; byte >>= 1) {
      count += byte & 1;
    }
  }
  return count;
}

describe("matches the reference screens", () => {
  const font = getFont();

  test.each(cases)("$name: $lines", ({ name, lines, sizes }) => {
    const actual = renderScreen(font, lines[0], lines[1]);
    expect(actual.length).toBe(SCREEN_BYTES);

    expect(lines.map((line) => (line ? fitFontSize(font, line) : null))).toEqual(sizes);
    // Every case has text, so a blank screen is a broken rasterizer
    expect(actual.some((byte) => byte !== 0)).toBe(true);

    if (update) {
      if (writeFixture(name, actual)) {
        console.log(`wrote ${name}.pbm: look at it before committing it`);
      }
      return;
    }
    expect(
      existsSync(fixtureUrl(name)),
      `no ${name}.pbm: write it with UPDATE_RENDER_FIXTURES=1`,
    ).toBe(true);
    const expected = readFixture(name);
    expect(expected.length).toBe(SCREEN_BYTES);
    expect(
      differingPixels(actual, expected),
      `${name} differs from ${name}.pbm (pixels that differ)`,
    ).toBe(0);
  });
});

test("there's one reference screen per case, and no others", () => {
  const files = readdirSync(fixtures).filter((file) => file.endsWith(".pbm"));
  expect(files.toSorted()).toEqual(cases.map(({ name }) => `${name}.pbm`).toSorted());
});

test("blank lines render a blank screen", () => {
  expect(renderScreen(getFont(), "", "").every((byte) => byte === 0)).toBe(true);
});

test("line breaks and control characters render as spaces, like Flask's clean_line", () => {
  const font = getFont();
  expect(renderScreen(font, "LSB\n657", "Kyrie\u2028\tEleison")).toEqual(
    renderScreen(font, "LSB 657", "Kyrie  Eleison"),
  );
});
