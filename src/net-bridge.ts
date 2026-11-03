import type { EmscriptenSockets, NetHost, NetTlsSession } from "./host-types.ts";
import { cipherOf, decodeCertificate } from "./x509.ts";

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
  /**
   * A TLS client session for `serverName`, offering the ALPN protocols, trusting `trust` (PEM bundles or DER
   * certificates) in addition to the VM's /etc/ssl/cert.pem; the value is its handle.
   */
  tlsOpen(serverName: unknown, alpn: unknown, trust?: unknown): NetOutcome<number>;
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
  /**
   * What the handshake settled, as JSON: `{ "version": "TLSv1.3" | "TLSv1.2" | null, "cipher": [name, version, bits] |
   * null, "chain": <certificates> }`, `cipher` as CPython's `cipher()` returns it (src/x509.ts).
   */
  tlsPeer(handle: unknown): NetOutcome<string>;
  /** The server's certificate in DER, empty before the handshake verified it. */
  tlsPeerCertificate(handle: unknown): NetOutcome<Uint8Array>;
  /** Queues close_notify. */
  tlsClose(handle: unknown): NetOutcome<null>;
  /** Releases a session; releasing an unknown handle does nothing. */
  tlsFree(handle: unknown): void;
  /** Releases every session the program left open (when the module stops). */
  freeAll(): void;
  /** A DER certificate decoded as CPython's getpeercert() shows it, as JSON whose arrays are tuples (src/x509.ts). */
  decodeCertificate(der: unknown): NetOutcome<string>;
  /**
   * Sets the receive timeout of the socket on descriptor `fd` (`kit.emscripten.network`'s `receiveTimeout`), in seconds
   * as Python's `settimeout` takes them: None blocks, 0 and anything shorter than a millisecond wait one millisecond, and
   * anything else is rounded up to whole milliseconds and capped at a day.
   */
  receiveTimeout(fd: unknown, seconds: unknown): NetOutcome<null>;
  /** Connects `receiveTimeout` to Pyodide's sockets, once `kit.emscripten.network` has connected them to the VM. */
  attachSockets(sockets: EmscriptenSockets): void;
}

/** The largest number of TLS sessions a program may hold at once. */
export const MAX_TLS_SESSIONS = 64;
const MAX_PLAINTEXT = 1024 * 1024;
/** The longest receive timeout `kit.emscripten.network` takes: a day. */
export const MAX_RECEIVE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

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

/** Python's timeout in seconds as `receiveTimeout`'s milliseconds; undefined for one Python would not accept. */
export function receiveTimeoutMs(seconds: unknown): number | null | undefined {
  if (seconds === null || seconds === undefined) return null;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.max(1, Math.ceil(seconds * 1000)), MAX_RECEIVE_TIMEOUT_MS);
}

export function netBridge(host: { readonly net: NetHost }, errnoOf: (error: unknown) => number): NetBridge {
  const sessions = new Map<number, NetTlsSession>();
  let sockets: EmscriptenSockets | undefined;
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
    tlsOpen: (serverName, alpn, trust) => {
      if (typeof serverName !== "string" || serverName === "") return refused("EINVAL", "TLS needs the server's name");
      const protocols = Array.isArray(alpn) ? Array.from<unknown>(alpn).filter((item): item is string => typeof item === "string") : [];
      const anchors = Array.isArray(trust) ? Array.from<unknown>(trust) : [];
      if (!anchors.every((item): item is Uint8Array => item instanceof Uint8Array)) return refused("EINVAL", "trusted authorities must be bytes");
      if (sessions.size >= MAX_TLS_SESSIONS) return refused("EMFILE", `a program may hold ${String(MAX_TLS_SESSIONS)} TLS sessions at once`);
      return attempt(() => {
        const session = host.net.tls({ serverName, alpn: protocols, ...(anchors.length === 0 ? {} : { trust: anchors }) });
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
    tlsPeer: handle => withSession(handle, session => {
      const version = session.protocolVersion(), suite = session.cipherSuite();
      return JSON.stringify({ version, cipher: version === null || suite === null ? null : cipherOf(suite, version), chain: session.peerCertificates().length });
    }),
    tlsPeerCertificate: handle => withSession(handle, session => session.peerCertificates()[0] ?? new Uint8Array()),
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
    decodeCertificate: der => {
      const bytes = bytesOf(der);
      return bytes === undefined ? refused("EINVAL", "a certificate must be bytes") : attempt(() => JSON.stringify(decodeCertificate(bytes)));
    },
    receiveTimeout: (fd, seconds) => {
      const ms = receiveTimeoutMs(seconds);
      if (typeof fd !== "number" || ms === undefined) return refused("EINVAL", "a receive timeout needs a descriptor and None or a number of seconds");
      if (sockets === undefined) return refused("ENOTSOCK", "Pyodide's sockets are not connected to the VM");
      const target = sockets;
      return attempt(() => { target.receiveTimeout(fd, ms); return null; });
    },
    attachSockets: given => { sockets = given; },
  };
}
