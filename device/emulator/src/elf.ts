/*
 * eHymnBoard device emulator
 * Copyright (C) 2026  Michael Spencer <sonrisesoftware@gmail.com>

 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.

 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.

 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Reads function addresses from a 32-bit little-endian ELF's symbol table.
export function elfSymbols(elf: Uint8Array): Map<string, number> {
  const v = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (v.getUint32(0) !== 0x7f454c46 || elf[4] !== 1 || elf[5] !== 1) {
    throw new Error("not a 32-bit little-endian ELF");
  }
  const shoff = v.getUint32(0x20, true);
  const shentsize = v.getUint16(0x2e, true);
  const shnum = v.getUint16(0x30, true);
  const section = (i: number) => {
    const o = shoff + i * shentsize;
    return {
      type: v.getUint32(o + 4, true),
      offset: v.getUint32(o + 16, true),
      size: v.getUint32(o + 20, true),
      link: v.getUint32(o + 24, true),
      entsize: v.getUint32(o + 36, true),
    };
  };
  const SHT_SYMTAB = 2;
  const symbols = new Map<string, number>();
  for (let i = 0; i < shnum; i++) {
    const s = section(i);
    if (s.type !== SHT_SYMTAB) {
      continue;
    }
    const strtab = section(s.link);
    for (let o = s.offset; o < s.offset + s.size; o += s.entsize) {
      const nameOff = v.getUint32(o, true);
      const value = v.getUint32(o + 4, true);
      let end = strtab.offset + nameOff;
      while (elf[end] !== 0) {
        end++;
      }
      const name = new TextDecoder().decode(elf.subarray(strtab.offset + nameOff, end));
      if (name) {
        symbols.set(name, value);
      }
    }
  }
  return symbols;
}
