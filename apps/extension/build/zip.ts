import { crc32, deflateRawSync } from "node:zlib";

// A small ZIP writer, so the store package needs no new dependency. Deflate for every file, names sorted and a fixed
// modification time, so the same files always make the same bytes. Plain ZIP (no zip64, no encryption), which is what the
// Chrome Web Store takes for an extension. Names are UTF-8.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// 2026-01-01 00:00:00 in DOS date and time. Fixed on purpose.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const u16 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
const u32 = (n: number) => Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

export function zip(entries: ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of sorted) {
    if (e.name.startsWith("/") || e.name.includes("..") || e.name.includes("\\"))
      throw new Error(`bad name in zip: ${e.name}`);
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.from(e.data);
    const packed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const head = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(8),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(packed.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      name,
    ]);
    parts.push(head, packed);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(8),
        u16(DOS_TIME),
        u16(DOS_DATE),
        u32(crc),
        u32(packed.length),
        u32(raw.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += head.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(sorted.length),
    u16(sorted.length),
    u32(dir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...parts, dir, end]);
}
