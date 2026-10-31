import { crc32, inflateRawSync } from "node:zlib";

/** One file of a zip archive. */
export interface ZipEntry {
  readonly name: string;
  /** The size of the content once inflated. */
  readonly size: number;
  /** Inflates the content and checks it against the archive's CRC. */
  read(): Uint8Array;
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
const END_RECORD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
/** The most one entry may inflate to; the entries read here are licence texts, so this is generous. */
export const MAX_ENTRY_BYTES = 8 * 1024 ** 2;

function broken(problem: string): never {
  throw new Error(`not a readable zip file: ${problem}`);
}

/**
 * Reads the list of files of a zip archive (a wheel is one) without any dependency. It understands stored and deflated
 * entries, not zip64 or encryption, and treats the archive as untrusted: every offset is checked against the file, and an
 * entry that would inflate beyond `MAX_ENTRY_BYTES` is refused.
 */
export function readZip(bytes: Uint8Array): readonly ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let position = bytes.length - END_RECORD_BYTES; position >= Math.max(0, bytes.length - END_RECORD_BYTES - MAX_COMMENT_BYTES); position -= 1) {
    if (view.getUint32(position, true) === END_OF_DIRECTORY) { end = position; break; }
  }
  if (end < 0) return broken("it has no end-of-directory record");
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directoryOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff) return broken("zip64 archives are not supported");
  if (directoryOffset + directorySize > end) return broken("the directory lies outside the file");
  const entries: ZipEntry[] = [];
  let position = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > bytes.length || view.getUint32(position, true) !== DIRECTORY_ENTRY) return broken(`directory entry ${String(index)} is damaged`);
    const method = view.getUint16(position + 10, true), checksum = view.getUint32(position + 16, true);
    const compressedSize = view.getUint32(position + 20, true), size = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true), extraLength = view.getUint16(position + 30, true), commentLength = view.getUint16(position + 32, true);
    const localOffset = view.getUint32(position + 42, true);
    if (position + 46 + nameLength > bytes.length) return broken(`directory entry ${String(index)} is cut off`);
    const name = new TextDecoder().decode(bytes.subarray(position + 46, position + 46 + nameLength));
    position += 46 + nameLength + extraLength + commentLength;
    entries.push({
      name, size,
      read() {
        if (size > MAX_ENTRY_BYTES) throw new Error(`${name} is larger than ${String(MAX_ENTRY_BYTES)} bytes inflated`);
        if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_ENTRY) return broken(`${name} has a damaged local header`);
        const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
        if (start + compressedSize > bytes.length) return broken(`${name} is cut off`);
        const stored = bytes.subarray(start, start + compressedSize);
        if (method !== 0 && method !== 8) throw new Error(`${name} uses compression method ${String(method)}, which is not supported`);
        const content = method === 0 ? stored : inflateRawSync(stored, { maxOutputLength: MAX_ENTRY_BYTES });
        if (content.length !== size) throw new Error(`${name} inflates to ${String(content.length)} bytes, not the ${String(size)} its directory entry says`);
        if (crc32(content) !== checksum) throw new Error(`${name} does not match its CRC`);
        return content;
      },
    });
  }
  return entries;
}
