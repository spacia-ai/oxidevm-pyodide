import { isRecord } from "../../src/records.ts";

/** One field of a decoded JSON object, or `undefined` when the value is not an object or has no such field. */
export function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
