import { describe, expect, it } from "vitest";
import { exitStatus, MAX_ADAPTER_STATUS } from "../src/exit-status.ts";

describe("exitStatus", () => {
  it("keeps the statuses an adapter may return", () => {
    expect([0, 1, 2, 42, 118, 119].map(exitStatus)).toEqual([0, 1, 2, 42, 118, 119]);
  });

  it("limits larger statuses to 119, because 120 to 125 belong to the runner and the engine", () => {
    expect(MAX_ADAPTER_STATUS).toBe(119);
    expect([120, 121, 125, 126, 200, 255].map(exitStatus)).toEqual([119, 119, 119, 119, 119, 119]);
  });

  it("wraps like an operating system exit status before limiting, so a failure never turns into success", () => {
    expect(exitStatus(256)).toBe(0);
    expect(exitStatus(257)).toBe(1);
    expect(exitStatus(-1)).toBe(119);
    expect(exitStatus(-255)).toBe(1);
    expect(exitStatus(-256)).toBe(0);
    expect(exitStatus(1_000_001)).toBe(exitStatus(1_000_001 % 256));
  });

  it("reads integers Python returns as BigInt when they exceed the safe range", () => {
    expect(exitStatus(3n)).toBe(3);
    expect(exitStatus(2n ** 64n)).toBe(0);
    expect(exitStatus(2n ** 64n + 7n)).toBe(7);
    expect(exitStatus(-(2n ** 64n) - 1n)).toBe(119);
  });

  it("treats a number beyond the safe range, which is no longer exact, as a failure", () => {
    for (const value of [2 ** 53, 2 ** 60, -(2 ** 60), 1e300]) expect(exitStatus(value), String(value)).toBe(1);
    // The largest exact integer still wraps (its low byte is 255) and is then limited like any other status.
    expect(exitStatus(Number.MAX_SAFE_INTEGER)).toBe(119);
    expect(exitStatus(Number.MAX_SAFE_INTEGER - 255)).toBe(0);
  });

  it("treats anything that is not an integer as a failure", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, "0", null, undefined, {}, true]) {
      expect(exitStatus(value)).toBe(1);
    }
  });
});
