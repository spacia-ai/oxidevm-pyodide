import type { ClientSockets, FileDescriptor, KitErrno } from "./host-types.ts";
import { LINUX_ERRORS, textFor } from "./linux-errors.ts";

/** Most sockets a program may hold open at once. */
export const MAX_OPEN_SOCKETS = 32;
/** The most one `recv` returns. */
export const MAX_RECV_BYTES = 1024 ** 2;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** The longest Unix socket path Linux accepts (`sun_path` is 108 bytes, with the terminating NUL). */
const MAX_UNIX_PATH_BYTES = 107;

/**
 * A socket operation that failed. `code` is the symbolic errno name; Python looks it up in its own `errno` module
 * (Emscripten numbers errors differently from Linux) and raises the `OSError` subclass that fits, such as
 * `ConnectionRefusedError`.
 */
export class SocketFailure extends Error {
  readonly code: string;

  constructor(code: string, text: string, options?: ErrorOptions) {
    super(text, options);
    this.name = "SocketFailure";
    this.code = code;
  }
}

function failureFor(code: string, cause?: unknown): SocketFailure {
  return new SocketFailure(code, textFor(code), cause === undefined ? undefined : { cause });
}

/** What the bridge needs of the host. */
export interface SocketHost {
  readonly sockets: ClientSockets;
  readonly kit: { readonly errno: Pick<KitErrno, "of"> };
  /** The module's lifetime: it ends when the module stops. */
  readonly signal: AbortSignal;
}

/** The JS half of `oxidevm.connect_unix` and `oxidevm.connect_tcp`. Every argument arrives from Python and is checked. */
export interface SocketBridge {
  connect(kind: unknown, target: unknown, port: unknown, timeoutMs: unknown): Promise<number>;
  send(handle: unknown, data: unknown, timeoutMs: unknown): Promise<void>;
  recv(handle: unknown, size: unknown, timeoutMs: unknown): Promise<Uint8Array>;
  close(handle: unknown): Promise<void>;
  /** Closes every socket that is still open; the module calls it when the program ends. */
  closeAll(): Promise<void>;
}

type Address = Parameters<ClientSockets["connect"]>[1];

function integer(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new SocketFailure("EINVAL", `${what} must be an integer from ${String(min)} to ${String(max)}`);
  return value;
}

function decodeAddress(kind: unknown, target: unknown, port: unknown): Address {
  if (typeof target !== "string" || target === "" || target.includes("\0")) throw new SocketFailure("EINVAL", "The address must be text without NUL characters");
  if (kind === "unix") {
    if (!target.startsWith("/") || new TextEncoder().encode(target).length > MAX_UNIX_PATH_BYTES) throw new SocketFailure("EINVAL", `A Unix socket path must be absolute and at most ${String(MAX_UNIX_PATH_BYTES)} bytes`);
    return { family: "unix", path: target };
  }
  if (kind !== "tcp") throw new SocketFailure("EINVAL", "The socket kind must be unix or tcp");
  const number = integer(port, "The port", 1, 65535);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(target)) return { family: "ipv4", address: target, port: number };
  if (/^[0-9A-Fa-f:.]+$/u.test(target) && target.includes(":")) return { family: "ipv6", address: target, port: number };
  throw new SocketFailure("EINVAL", "The host must be an IPv4 or IPv6 address");
}

export function socketBridge(host: SocketHost): SocketBridge {
  const open = new Map<number, FileDescriptor>();
  let last = 0;

  /** The signal for one operation: it ends when the module stops or, when `timeoutMs` is not 0, when the time is up. */
  function limit(timeoutMs: unknown): { readonly signal: AbortSignal; readonly timedOut: () => boolean } {
    const milliseconds = integer(timeoutMs, "The timeout", 0, MAX_TIMEOUT_MS);
    const timeout = milliseconds === 0 ? undefined : AbortSignal.timeout(milliseconds);
    return { signal: timeout === undefined ? host.signal : AbortSignal.any([host.signal, timeout]), timedOut: () => timeout?.aborted === true };
  }
  /** Turns whatever a host operation threw into the failure Python will see. */
  function translate(error: unknown, timedOut: boolean): SocketFailure {
    if (error instanceof SocketFailure) return error;
    const errno = host.kit.errno.of(error);
    const entry = errno === undefined ? undefined : LINUX_ERRORS.get(errno);
    if (entry !== undefined) return failureFor(entry.code, error);
    if (timedOut) return failureFor("ETIMEDOUT", error);
    if (host.signal.aborted) return new SocketFailure("EINTR", "The module is stopping", { cause: error });
    return new SocketFailure("EIO", error instanceof Error ? error.message : "Input/output error", { cause: error });
  }
  function descriptorOf(handle: unknown): FileDescriptor {
    const fd = typeof handle === "number" ? open.get(handle) : undefined;
    if (fd === undefined) throw failureFor("EBADF");
    return fd;
  }
  async function release(fd: FileDescriptor): Promise<void> {
    await host.sockets.close(fd).catch(() => undefined);
  }

  return {
    async connect(kind, target, port, timeoutMs) {
      const address = decodeAddress(kind, target, port);
      if (open.size >= MAX_OPEN_SOCKETS) throw new SocketFailure("EMFILE", `A program may hold at most ${String(MAX_OPEN_SOCKETS)} sockets open`);
      const { signal, timedOut } = limit(timeoutMs);
      let fd: FileDescriptor;
      try {
        fd = await host.sockets.socket(address.family);
      } catch (error: unknown) {
        throw translate(error, false);
      }
      try {
        await host.sockets.connect(fd, address, { signal });
      } catch (error: unknown) {
        await release(fd);
        throw translate(error, timedOut());
      }
      last += 1;
      open.set(last, fd);
      return last;
    },
    async send(handle, data, timeoutMs) {
      const fd = descriptorOf(handle);
      if (!(data instanceof Uint8Array)) throw new SocketFailure("EINVAL", "The data must be bytes");
      const { signal, timedOut } = limit(timeoutMs);
      try {
        for (let offset = 0; offset < data.length;) {
          const written = await host.sockets.write(fd, data.subarray(offset), { signal });
          if (written <= 0) throw failureFor("EPIPE");
          offset += written;
        }
      } catch (error: unknown) {
        throw translate(error, timedOut());
      }
    },
    async recv(handle, size, timeoutMs) {
      const fd = descriptorOf(handle);
      const count = integer(size, "The size", 1, MAX_RECV_BYTES);
      const { signal, timedOut } = limit(timeoutMs);
      try {
        return await host.sockets.read(fd, count, { signal });
      } catch (error: unknown) {
        throw translate(error, timedOut());
      }
    },
    async close(handle) {
      if (typeof handle !== "number") return;
      const fd = open.get(handle);
      if (fd === undefined) return;
      open.delete(handle);
      await release(fd);
    },
    async closeAll() {
      const descriptors = [...open.values()];
      open.clear();
      await Promise.all(descriptors.map(release));
    },
  };
}
