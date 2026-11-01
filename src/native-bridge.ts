import type { Host } from "@oxidevm/sdk/wasm";
import { ModuleError } from "./errors.ts";
import type { AsyncFiles } from "./host-types.ts";

/** The most bytes the JSON text of a native command's arguments may take. */
export const MAX_ARGUMENT_JSON_BYTES = 64 * 1024;

const EINTR = 4;

/**
 * A native run that a signal interrupted while the module waited for the program (EINTR); the program has been killed.
 * Python looks at `code`: when the signal was Ctrl+C, it raises KeyboardInterrupt instead.
 */
export class NativeInterrupted extends Error {
  readonly code = "EINTR";

  constructor(options?: ErrorOptions) {
    super("Interrupted system call", options);
    this.name = "NativeInterrupted";
  }
}

/** What running a native program needs: the process and pipe operations the manifest declares, the kit and the lifetime. */
export interface NativeHost {
  readonly files: Pick<AsyncFiles, "read" | "writeAll" | "close">;
  readonly process: Pick<Host<"process.spawn">["process"], "spawn" | "wait" | "signal">;
  readonly kit: Pick<Host["kit"], "runNative" | "errno">;
  /** The module's lifetime: it ends when the module stops, and any running child is killed. */
  readonly signal: AbortSignal;
}

function decodeArguments(json: unknown): readonly string[] {
  if (typeof json !== "string") throw new ModuleError("native-request", "Native arguments must be sent as JSON text");
  if (new TextEncoder().encode(json).length > MAX_ARGUMENT_JSON_BYTES) throw new ModuleError("native-request", "Native arguments exceed 64 KiB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error: unknown) {
    throw new ModuleError("native-request", "Native arguments are not valid JSON", { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((item: unknown) => typeof item === "string")) {
    throw new ModuleError("native-request", "Native arguments must be a nonempty list of strings without NUL characters");
  }
  return parsed.map(String);
}

/**
 * The JS half of `oxidevm.run`. It takes what Python sends (the arguments as JSON text, the input text and the timeout
 * in milliseconds), checks it as untrusted, and hands it to the kit's `runNative`, which owns the limits (64 arguments
 * without NUL characters, an absolute command, 5 MiB of input, 1 ms to 180 s, 1 MiB of each output) and kills the child
 * on timeout, on cancellation and when the module ends. The answer is JSON text with `pid`, `returncode`, `stdout` and
 * `stderr`.
 */
export function nativeRunner(host: NativeHost): (argumentsJSON: unknown, input: unknown, timeoutMs: unknown) => Promise<string> {
  return async (argumentsJSON, input, timeoutMs) => {
    const argv = decodeArguments(argumentsJSON);
    if (typeof input !== "string") throw new ModuleError("native-request", "Native text input must be a string");
    if (typeof timeoutMs !== "number") throw new ModuleError("native-request", "Native timeout must be a number");
    try {
      return JSON.stringify(await host.kit.runNative(host, { argv, input, timeoutMs, signal: host.signal }));
    } catch (error: unknown) {
      if (host.kit.errno.of(error) === EINTR) throw new NativeInterrupted({ cause: error });
      throw error;
    }
  };
}
