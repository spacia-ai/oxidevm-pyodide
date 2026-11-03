/** Why the module stopped before or while running a script. The set is closed so that callers can switch over it. */
export type ModuleErrorCode =
  | "lock-invalid"
  | "package-unknown"
  | "package-not-shipped"
  | "workspace-unavailable"
  | "native-request"
  | "socket-request"
  | "signal-raise"
  | "interpreter-imports";

/** A failure of this module's own code, as opposed to one in the Python program it runs. */
export class ModuleError extends Error {
  readonly code: ModuleErrorCode;

  constructor(code: ModuleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModuleError";
    this.code = code;
  }
}
