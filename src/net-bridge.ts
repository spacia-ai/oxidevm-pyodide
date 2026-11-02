import type { NetHost, NetTlsSession } from "./host-types.ts";

/**
 * The module's network for Python (engine ADR 0029): names through the VM's resolver and TLS sessions of the engine's
 * TLS client, both synchronous, for `socket.getaddrinfo` (src/python/socket-patch.ts) and `ssl` (src/python/ssl-patch.ts).
 * The bytes travel on the program's own sockets, which `kit.emscripten.network` connects to the VM. Every answer is a
 * plain object Python reads without catching JavaScript errors: `{ ok: true, value }`, or `{ ok: false, code, failure,
 * errno, message }` with the `NetError`'s code, its TLS failure (`unknown-issuer`, `name-mismatch`, ...), the Linux errno
 * the kit gives it, and its message.
 */
export type NetOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly failure: string | null; readonly errno: number; readonly message: string };

export interface NetBridge {
  /** The VM resolver's addresses for a name (IPv4 and IPv6, in its order). */
  resolve(name: unknown): NetOutcome<string[]>;
  /** A TLS client session for `serverName`, offering the ALPN protocols; the value is its handle. */
  tlsOpen(serverName: unknown, alpn: unknown): NetOutcome<number>;
  /** Feeds ciphertext from the peer; a verification failure is the outcome's failure. */
  tlsReceive(handle: unknown, ciphertext: unknown): NetOutcome<null>;
  /** The ciphertext waiting for the peer (empty when none). */
  tlsTake(handle: unknown): NetOutcome<Uint8Array>;
  /** Queues plaintext for the peer. */
  tlsSend(handle: unknown, plaintext: unknown): NetOutcome<null>;
  /** Up to `max` bytes of plaintext from the peer (empty when none waits). */
  tlsPlaintext(handle: unknown, max: unknown): NetOutcome<Uint8Array>;
  /** The session's state and its negotiated ALPN protocol. */
  tlsStatus(handle: unknown): NetOutcome<{ readonly state: string; readonly alpn: string | null }>;
  /** Queues close_notify. */
  tlsClose(handle: unknown): NetOutcome<null>;
  /** Releases a session; releasing an unknown handle does nothing. */
  tlsFree(handle: unknown): void;
  /** Releases every session the program left open (when the module stops). */
  freeAll(): void;
}

/** The largest number of TLS sessions a program may hold at once. */
export const MAX_TLS_SESSIONS = 64;
const MAX_PLAINTEXT = 1024 * 1024;

function failed(error: unknown, errnoOf: (error: unknown) => number): NetOutcome<never> {
  const code: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  const failure: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "tlsFailure") : undefined;
  return {
    ok: false, code: typeof code === "string" ? code : "EIO", failure: typeof failure === "string" ? failure : null,
    errno: errnoOf(error), message: error instanceof Error ? error.message : String(error),
  };
}

function refused(code: string, message: string): NetOutcome<never> {
  return { ok: false, code, failure: null, errno: 22, message };
}

function bytesOf(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}

export function netBridge(host: { readonly net: NetHost }, errnoOf: (error: unknown) => number): NetBridge {
  const sessions = new Map<number, NetTlsSession>();
  let next = 1;
  const attempt = <T>(work: () => T): NetOutcome<T> => {
    try {
      return { ok: true, value: work() };
    } catch (error: unknown) {
      return failed(error, errnoOf);
    }
  };
  const withSession = <T>(handle: unknown, work: (session: NetTlsSession) => T): NetOutcome<T> => {
    const session = typeof handle === "number" ? sessions.get(handle) : undefined;
    return session === undefined ? refused("EBADF", "no such TLS session") : attempt(() => work(session));
  };
  return {
    resolve: name => typeof name === "string" && name !== "" ? attempt(() => [...host.net.resolveSync(name)]) : refused("EINVAL", "a name to resolve is needed"),
    tlsOpen: (serverName, alpn) => {
      if (typeof serverName !== "string" || serverName === "") return refused("EINVAL", "TLS needs the server's name");
      const protocols = Array.isArray(alpn) ? Array.from<unknown>(alpn).filter((item): item is string => typeof item === "string") : [];
      if (sessions.size >= MAX_TLS_SESSIONS) return refused("EMFILE", `a program may hold ${String(MAX_TLS_SESSIONS)} TLS sessions at once`);
      return attempt(() => {
        const session = host.net.tls({ serverName, alpn: protocols });
        const handle = next++;
        sessions.set(handle, session);
        return handle;
      });
    },
    tlsReceive: (handle, ciphertext) => {
      const bytes = bytesOf(ciphertext);
      return bytes === undefined ? refused("EINVAL", "ciphertext must be bytes") : withSession(handle, session => { session.receive(bytes); return null; });
    },
    tlsTake: handle => withSession(handle, session => session.takeTls()),
    tlsSend: (handle, plaintext) => {
      const bytes = bytesOf(plaintext);
      return bytes === undefined ? refused("EINVAL", "plaintext must be bytes") : withSession(handle, session => { session.send(bytes); return null; });
    },
    tlsPlaintext: (handle, max) => withSession(handle, session => session.takePlaintext(typeof max === "number" && max > 0 ? Math.min(max, MAX_PLAINTEXT) : MAX_PLAINTEXT)),
    tlsStatus: handle => withSession(handle, session => ({ state: session.state(), alpn: session.alpn() })),
    tlsClose: handle => withSession(handle, session => { session.close(); return null; }),
    tlsFree: handle => {
      const session = typeof handle === "number" ? sessions.get(handle) : undefined;
      if (session === undefined || typeof handle !== "number") return;
      sessions.delete(handle);
      session.free();
    },
    freeAll: () => {
      for (const session of sessions.values()) session.free();
      sessions.clear();
    },
  };
}
