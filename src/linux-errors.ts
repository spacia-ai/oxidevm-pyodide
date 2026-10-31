/** A Linux x86-64 errno: its symbolic name and the text `strerror` gives. */
export interface LinuxErrorInfo {
  readonly code: string;
  readonly text: string;
}

/**
 * The errno values this module reports to people or to Python by name, with the text Linux gives. The host reports a
 * Linux number; Python's `errno` module numbers errors the Emscripten way, so Python receives the name and looks it up.
 */
export const LINUX_ERRORS: ReadonlyMap<number, LinuxErrorInfo> = new Map([
  [1, { code: "EPERM", text: "Operation not permitted" }],
  [2, { code: "ENOENT", text: "No such file or directory" }],
  [4, { code: "EINTR", text: "Interrupted system call" }],
  [5, { code: "EIO", text: "Input/output error" }],
  [9, { code: "EBADF", text: "Bad file descriptor" }],
  [11, { code: "EAGAIN", text: "Resource temporarily unavailable" }],
  [12, { code: "ENOMEM", text: "Cannot allocate memory" }],
  [13, { code: "EACCES", text: "Permission denied" }],
  [20, { code: "ENOTDIR", text: "Not a directory" }],
  [21, { code: "EISDIR", text: "Is a directory" }],
  [22, { code: "EINVAL", text: "Invalid argument" }],
  [24, { code: "EMFILE", text: "Too many open files" }],
  [27, { code: "EFBIG", text: "File too large" }],
  [32, { code: "EPIPE", text: "Broken pipe" }],
  [40, { code: "ELOOP", text: "Too many levels of symbolic links" }],
  [88, { code: "ENOTSOCK", text: "Socket operation on non-socket" }],
  [93, { code: "EPROTONOSUPPORT", text: "Protocol not supported" }],
  [97, { code: "EAFNOSUPPORT", text: "Address family not supported by protocol" }],
  [98, { code: "EADDRINUSE", text: "Address already in use" }],
  [99, { code: "EADDRNOTAVAIL", text: "Cannot assign requested address" }],
  [100, { code: "ENETDOWN", text: "Network is down" }],
  [101, { code: "ENETUNREACH", text: "Network is unreachable" }],
  [103, { code: "ECONNABORTED", text: "Software caused connection abort" }],
  [104, { code: "ECONNRESET", text: "Connection reset by peer" }],
  [105, { code: "ENOBUFS", text: "No buffer space available" }],
  [106, { code: "EISCONN", text: "Transport endpoint is already connected" }],
  [107, { code: "ENOTCONN", text: "Transport endpoint is not connected" }],
  [110, { code: "ETIMEDOUT", text: "Connection timed out" }],
  [111, { code: "ECONNREFUSED", text: "Connection refused" }],
  [113, { code: "EHOSTUNREACH", text: "No route to host" }],
]);

/** The text for a symbolic name, or the name itself when it is not one of the listed errors. */
export function textFor(code: string): string {
  for (const entry of LINUX_ERRORS.values()) if (entry.code === code) return entry.text;
  return code;
}
