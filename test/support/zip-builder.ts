import { crc32, deflateRawSync } from "node:zlib";

export interface ZipFixtureEntry {
  readonly name: string;
  readonly content: string | Uint8Array;
  /** `stored` (the default) or `deflated`. */
  readonly method?: "stored" | "deflated";
}

/** Builds a small zip file in memory, with no extras, for tests of the reader. */
export function buildZip(entries: readonly ZipFixtureEntry[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): void => { parts.push(bytes); offset += bytes.length; };
  const u16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
  const u32 = (value: number): number[] => [...u16(value & 0xffff), ...u16(value >>> 16)];
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const raw = typeof entry.content === "string" ? new TextEncoder().encode(entry.content) : entry.content;
    const method = entry.method === "deflated" ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const checksum = crc32(raw);
    const local = [...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(method), ...u16(0), ...u16(0), ...u32(checksum), ...u32(data.length), ...u32(raw.length), ...u16(name.length), ...u16(0)];
    directory.push(Uint8Array.of(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(method), ...u16(0), ...u16(0), ...u32(checksum), ...u32(data.length), ...u32(raw.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name));
    push(Uint8Array.of(...local, ...name));
    push(data);
  }
  const start = offset;
  for (const record of directory) push(record);
  push(Uint8Array.of(...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(offset - start), ...u32(start), ...u16(0)));
  const all = new Uint8Array(offset);
  let position = 0;
  for (const part of parts) { all.set(part, position); position += part.length; }
  return all;
}
