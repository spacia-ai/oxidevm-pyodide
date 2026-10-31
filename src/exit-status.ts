/** The highest status a command adapter may return. 120 to 124 belong to the module runner and 125 to the engine. */
export const MAX_ADAPTER_STATUS = 119;

const STATUS_MODULUS = 256;

/**
 * The exit status a Python `SystemExit` asks for. Like the operating system, it keeps the low eight bits (so
 * `sys.exit(-1)` is a failure, never a success), and then limits the result to what an adapter may return.
 * Anything that is not an integer is a failure.
 */
export function exitStatus(requested: unknown): number {
  let status: number;
  if (typeof requested === "bigint") {
    const modulus = BigInt(STATUS_MODULUS);
    status = Number(((requested % modulus) + modulus) % modulus);
  } else if (typeof requested === "number" && Number.isSafeInteger(requested)) {
    status = ((requested % STATUS_MODULUS) + STATUS_MODULUS) % STATUS_MODULUS;
  } else {
    return 1;
  }
  return Math.min(status, MAX_ADAPTER_STATUS);
}
