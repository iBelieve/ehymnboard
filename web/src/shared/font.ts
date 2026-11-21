import { parse, type Font } from "opentype.js";
// Inlined as a data URL so the Worker and the browser load it the same way,
// synchronously and without a network request.
import fontDataUrl from "../../fonts/BebasNeue-Regular.ttf?inline";

let font: Font | undefined;

/** Bebas Neue, the typeface the boards have always used. */
export function getFont(): Font {
  if (!font) {
    const base64 = fontDataUrl.slice(fontDataUrl.indexOf(",") + 1);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    font = parse(bytes.buffer);
  }
  return font;
}
