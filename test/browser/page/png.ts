/** What a PNG file declares, once every chunk has been checked. */
export interface PngInfo {
  readonly width: number;
  readonly height: number;
  /** The chunk types in file order, for example IHDR, IDAT, IEND. */
  readonly chunks: readonly string[];
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** The CRC-32 that PNG uses, of the bytes of a chunk's type and data. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Checks that bytes are a complete, well-formed PNG: the signature, every chunk with a correct length and CRC, an IHDR
 * first, at least one IDAT, an IEND last and nothing after it. It does not decompress the image, so it proves the file is
 * intact, not that the pixels are right. Throws an `Error` that says what is wrong.
 */
export function inspectPng(bytes: Uint8Array): PngInfo {
  if (bytes.length < SIGNATURE.length || !SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new Error("not a PNG: the signature is wrong");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: string[] = [];
  let width = 0, height = 0, offset = SIGNATURE.length;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error(`the PNG ends inside a chunk header at byte ${String(offset)}`);
    const length = view.getUint32(offset);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) throw new Error(`the PNG ends inside a ${String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))} chunk`);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (view.getUint32(end) !== crc32(bytes.subarray(offset + 4, end))) throw new Error(`the ${type} chunk at byte ${String(offset)} has a wrong CRC`);
    if (chunks.length === 0 && type !== "IHDR") throw new Error(`the first chunk is ${type}, not IHDR`);
    if (type === "IHDR") {
      if (chunks.length > 0 || length !== 13) throw new Error("the IHDR chunk is misplaced or has the wrong length");
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (width === 0 || height === 0) throw new Error("the PNG declares an empty image");
    }
    chunks.push(type);
    offset = end + 4;
    if (type === "IEND") {
      if (length !== 0) throw new Error("the IEND chunk has data");
      if (offset !== bytes.length) throw new Error(`${String(bytes.length - offset)} bytes follow the IEND chunk`);
    }
  }
  if (chunks.at(-1) !== "IEND") throw new Error("the PNG has no IEND chunk");
  if (!chunks.includes("IDAT")) throw new Error("the PNG has no image data");
  return { width, height, chunks };
}
