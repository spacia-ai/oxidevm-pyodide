import type { Host } from "@oxidevm/sdk/wasm";
import type { FileDescriptor } from "../../src/host-types.ts";

/** The VM's process id type (a branded number). */
export type ProcessId = Awaited<ReturnType<Host<"process.info">["process"]["info"]>>["pid"];

function isDescriptor(value: number): value is FileDescriptor {
  return Number.isSafeInteger(value) && value >= 0;
}
function isProcessId(value: number): value is ProcessId {
  return Number.isSafeInteger(value) && value > 0;
}

/** A plain number as the host's branded descriptor; the predicate is the only place the brand is granted. */
export function descriptor(value: number): FileDescriptor {
  if (!isDescriptor(value)) throw new RangeError(`${String(value)} is not a descriptor`);
  return value;
}

export function processId(value: number): ProcessId {
  if (!isProcessId(value)) throw new RangeError(`${String(value)} is not a process id`);
  return value;
}
