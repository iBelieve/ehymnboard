/** A bundle as the build makes it (cmake/ota_image.py bundle) */
export function bundle(
  a: Uint8Array,
  b: Uint8Array,
  lengths: [number, number] = [a.length, b.length],
) {
  const header = new Uint8Array(16);
  header.set(new TextEncoder().encode("EHBOTA2\0"));
  const view = new DataView(header.buffer);
  view.setUint32(8, lengths[0], true);
  view.setUint32(12, lengths[1], true);
  const out = new Uint8Array(16 + a.length + b.length);
  out.set(header);
  out.set(a, 16);
  out.set(b, 16 + a.length);
  return out;
}
