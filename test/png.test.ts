import { describe, expect, it } from "vitest";
import { crc32, inspectPng } from "./browser/page/png.ts";

// A valid 1x1 PNG, written out so that the checker is not tested against its own CRC code.
const VALID = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), character => character.charCodeAt(0));

function changed(change: (copy: Uint8Array) => Uint8Array): Uint8Array {
  return change(Uint8Array.from(VALID));
}

function problem(bytes: Uint8Array): string {
  try {
    inspectPng(bytes);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : "";
  }
  return "no problem";
}

describe("crc32", () => {
  it("matches the standard check values", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
  });
});

describe("inspectPng", () => {
  it("accepts a valid PNG and reports its size and chunks", () => {
    expect(inspectPng(VALID)).toEqual({ width: 1, height: 1, chunks: ["IHDR", "IDAT", "IEND"] });
  });

  it("works on a view into a larger buffer", () => {
    const outer = new Uint8Array(VALID.length + 10);
    outer.set(VALID, 5);
    expect(inspectPng(outer.subarray(5, 5 + VALID.length)).width).toBe(1);
  });

  it("refuses a wrong signature, an empty file and a truncated one", () => {
    expect(problem(changed(copy => { copy[1] = 0x51; return copy; }))).toContain("signature");
    expect(problem(new Uint8Array(0))).toContain("signature");
    expect(problem(VALID.subarray(0, 20))).toContain("ends inside");
    expect(problem(VALID.subarray(0, VALID.length - 6))).toContain("ends inside");
  });

  it("refuses a flipped bit in any chunk", () => {
    for (const index of [16, 20, 30, 45, 60]) expect(problem(changed(copy => { copy[index] = (copy[index] ?? 0) ^ 1; return copy; })), String(index)).toMatch(/CRC|IHDR|declares|ends inside/u);
  });

  it("refuses bytes after IEND, a missing IEND, and a missing IDAT", () => {
    expect(problem(changed(copy => Uint8Array.of(...copy, 0)))).toMatch(/ends inside|follow/u);
    expect(problem(VALID.subarray(0, VALID.length - 12))).toContain("no IEND");
    const idatStart = 8 + 25;
    const idatLength = new DataView(VALID.buffer).getUint32(idatStart) + 12;
    expect(problem(Uint8Array.of(...VALID.subarray(0, idatStart), ...VALID.subarray(idatStart + idatLength)))).toContain("no image data");
  });

  it("refuses a PNG whose first chunk is not IHDR", () => {
    const idatStart = 8 + 25;
    const idatLength = new DataView(VALID.buffer).getUint32(idatStart) + 12;
    const reordered = Uint8Array.of(...VALID.subarray(0, 8), ...VALID.subarray(idatStart, idatStart + idatLength), ...VALID.subarray(8, idatStart), ...VALID.subarray(idatStart + idatLength));
    expect(problem(reordered)).toContain("not IHDR");
  });
});
