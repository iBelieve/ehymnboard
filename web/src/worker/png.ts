import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../shared/screen";

// Encodes a screen's 1-bit buffer as a PNG, as Flask served at /images/N.png.
// The buffer is already PNG's 1-bit grayscale layout (rows of bytes, most
// significant bit first, set = white), so each row only needs a filter byte.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ROW_BYTES = SCREEN_WIDTH / 8;

export async function screenToPng(buffer: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
  const bits = new Uint8Array(buffer);
  const raw = new Uint8Array((ROW_BYTES + 1) * SCREEN_HEIGHT);
  for (let y = 0; y < SCREEN_HEIGHT; y++) {
    // Filter type 0 (none), then the row as is.
    raw.set(bits.subarray(y * ROW_BYTES, (y + 1) * ROW_BYTES), y * (ROW_BYTES + 1) + 1);
  }
  const compressed = await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
  ).arrayBuffer();

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, SCREEN_WIDTH);
  view.setUint32(4, SCREEN_HEIGHT);
  header.set([1, 0, 0, 0, 0], 8); // bit depth 1, grayscale, deflate, no filter, no interlace

  return concat([
    new Uint8Array(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(compressed)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
